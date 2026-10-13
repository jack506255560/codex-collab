import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped event handlers with a minimal DOM; full form interaction is also
// exercised in the browser audit. These tests guard recovery and API sequencing.
class Element {
  constructor(id) { this.id = id; this.hidden = false; this.children = []; this.dataset = {}; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return []; }
}
async function page(route) {
  const ids = new Map(), calls = [];
  const element = (id) => { if (!ids.has(id)) ids.set(id, new Element(id)); return ids.get(id); };
  const sections = ['home', 'admin', 'join', 'own', 'existing', 'verification', 'profile'].map(element);
  const context = vm.createContext({
    document: { getElementById: element, createElement: (tag) => new Element(tag), querySelectorAll: (selector) => selector === 'main>section' ? sections : [] },
    FormData: class { constructor(form) { return Object.entries(form.input)[Symbol.iterator](); } },
    fetch: async (path, options) => {
      calls.push(path);
      const value = await route(path, options?.body ? JSON.parse(options.body) : undefined);
      return { ok: !(value instanceof Error), json: async () => value instanceof Error ? { error: value.message } : value };
    },
    location: { hash: '' }, history: { replaceState() {} }, navigator: { clipboard: { async writeText() {} } },
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(await readFile(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { element, calls, settle, activate: async (node) => { node.onclick(); await settle(); }, submit: async (id, input) => {
    const target = { input, elements: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { value, checked: value === true }])) };
    element(id).onsubmit({ preventDefault() {}, target }); await settle(); return target;
  }, click: async (id) => { element(id).onclick(); await settle(); } };
}
const member = (phase) => ({ id: 'member', agent_id: 'bob', role: 'member', repo: '/fixture/bob', phase });
const importInput = () => ({ file: { text: async () => '{}' }, password: 'fixture-password', repo: '/fixture/bob' });

test('reimporting waiting and ready members opens existing progress without reconnecting discovery', async () => {
  for (const phase of ['waiting', 'configuring', 'verified', 'ready']) {
    const p = await page((path) => path === '/api/overview' ? { profiles: [] } : path === '/api/import' || path.startsWith('/api/profile?') ? member(phase) : assert.fail(`unexpected ${path}`));
    const form = await p.submit('join-form', importInput());
    assert.equal(p.element('profile').hidden, false); assert.equal(p.element('verification').hidden, true);
    assert.equal(form.elements.password.value, ''); assert.ok(!p.calls.includes('/api/discovery'));
    assert.equal(p.element('notice').textContent, '');
  }
});

test('failed first discovery preserves imported profile with a visible reconnect action', async () => {
  const p = await page((path) => path === '/api/overview' ? { profiles: [] } : path === '/api/discovery' ? new Error('连接失败') : member('imported'));
  await p.submit('join-form', importInput());
  assert.equal(p.element('profile').hidden, false); assert.equal(p.element('notice').textContent, '连接失败');
  assert.equal(p.element('progress').children[1].textContent, '连接分配的机器人');
});

test('successful verification followed by unavailable profile reports load error without resubmitting verification', async () => {
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [] };
    if (path === '/api/import') return member('imported');
    if (path.startsWith('/api/discovery')) return { id: 'discovery', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/verify') return member('waiting');
    if (path.startsWith('/api/profile?')) return new Error('本机状态暂时无法读取');
    assert.fail(path);
  });
  await p.submit('join-form', importInput()); await p.click('confirm-code');
  assert.equal(p.element('notice').textContent, '本机状态暂时无法读取');
  assert.equal(p.calls.filter((path) => path === '/api/verify').length, 1);
  assert.equal(p.calls.filter((path) => path === '/api/overview').length, 1);
});

test('interrupted verified enrollment opens persisted state and preserves the original actionable error', async () => {
  let persisted = false;
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: persisted ? [member('verified')] : [] };
    if (path === '/api/import') return member('imported');
    if (path.startsWith('/api/discovery')) return { id: 'discovery', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/verify') { persisted = true; return new Error('Git 权限不足'); }
    if (path.startsWith('/api/profile?')) return member('verified');
    assert.fail(path);
  });
  await p.submit('join-form', importInput()); await p.click('confirm-code');
  assert.equal(p.element('profile').hidden, false); assert.match(p.element('notice').textContent, /Git 权限不足.*继续接入/);
});

test('administrator failure recovers new persisted profile despite canonical path differences', async () => {
  let persisted = false;
  const old = { id: 'old', agent_id: 'alice', role: 'admin', repo: '/old/project', phase: 'ready' };
  const created = { id: 'new', agent_id: 'alice', role: 'admin', repo: '/private/fixture/project', phase: 'configuring' };
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: persisted ? [old, created] : [old] };
    if (path.startsWith('/api/discovery')) return { id: 'discovery', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/admin') { persisted = true; return new Error('接入中断'); }
    if (path === '/api/profile?id=new') return created;
    assert.fail(path);
  });
  await p.submit('admin-form', { repo: '/fixture/project', agent_id: 'alice', capabilities: 'backend', test_argv: '["npm","test"]', bot_id: 'fixture', secret: 'fixture' });
  await p.click('confirm-code');
  assert.equal(p.element('profile-title').textContent, 'alice · 管理员'); assert.ok(p.calls.includes('/api/profile?id=new'));
  assert.match(p.element('notice').textContent, /接入中断.*继续接入/);
});

test('invalid test argv is rejected before connecting a bot or sending credentials', async () => {
  for (const test_argv of ['bad json', '{}', '[]', '[1]', '[""]', '["npm",null]']) {
    const p = await page((path) => path === '/api/overview' ? { profiles: [] } : assert.fail(`unexpected ${path}`));
    await p.submit('admin-form', { repo: '/fixture', agent_id: 'alice', capabilities: 'backend', test_argv, bot_id: 'fixture', secret: 'fixture' });
    assert.match(p.element('notice').textContent, /JSON 字符串数组/);
    assert.deepEqual(p.calls, ['/api/overview']);
  }
});


const ownAdmin = (exports = []) => ({ id: 'admin', agent_id: 'alice', role: 'admin', repo: '/fixture/alice', phase: 'ready', exports,
  owners: [{ agent_ids: ['alice'], is_you: true }] });
const ownInput = () => ({ repo: '/fixture/bob', agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture', prefer: false });

test('own bot form connects and verifies without an export or password and clears its secret', async () => {
  const p = await page((path, body) => {
    if (path === '/api/overview') return { profiles: [ownAdmin()] };
    if (path === '/api/profile?id=admin') return ownAdmin();
    if (path === '/api/own-agent') {
      assert.equal(body.id, 'admin'); assert.equal(body.prefer, false);
      assert.equal(body.secret, 'fixture'); assert.equal(body.password, undefined);
      return member('imported');
    }
    if (path.startsWith('/api/discovery')) return { id: 'discovery', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/verify') { assert.equal(body.id, 'member'); return member('ready'); }
    if (path === '/api/profile?id=member') return member('ready');
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]); await p.click('add-own-agent');
  assert.equal(p.element('own').hidden, false); assert.equal(p.element('profile').hidden, true);
  const form = await p.submit('own-form', ownInput());
  assert.equal(form.elements.secret.value, ''); assert.equal(p.element('verification').hidden, false);
  await p.click('confirm-code');
  assert.equal(p.element('profile-title').textContent, 'bob · 成员');
  assert.ok(!p.calls.some((path) => path.startsWith('/api/export') || path === '/api/import' || path === '/api/approve'));
  assert.equal(p.element('notice').textContent, '');
});

test('failed own bot publication exposes the saved continuation and clears the secret', async () => {
  let saved = false;
  const p = await page((path, body) => {
    const admin = ownAdmin(saved ? [{ agent_id: 'bob', invite_id: 'own-invite', own_agent: true }] : []);
    if (path === '/api/overview') return { profiles: [admin] };
    if (path === '/api/profile?id=admin') return admin;
    if (path === '/api/own-agent') { saved = true; return new Error('网络暂时不可用'); }
    if (path === '/api/own-agent-resume') { assert.deepEqual(body, { id: 'admin', invite_id: 'own-invite' }); return member('imported'); }
    if (path === '/api/discovery') return { id: 'discovery', status: 'connecting', message: '协作 接入 123456' };
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]); await p.click('add-own-agent');
  const form = await p.submit('own-form', ownInput());
  assert.equal(form.elements.secret.value, ''); assert.equal(p.element('profile').hidden, false);
  assert.equal(p.element('notice').textContent, '网络暂时不可用');
  const continuation = p.element('exports').children[0].children[1];
  assert.equal(continuation.textContent, '继续接入我的机器人');
  await p.activate(continuation);
  assert.equal(p.element('verification').hidden, false); assert.equal(p.element('notice').textContent, '');
});

test('resuming a ready own bot opens its saved profile without reconnecting verification', async () => {
  const admin = ownAdmin([{ agent_id: 'bob', invite_id: 'own-invite', own_agent: true }]);
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [admin] };
    if (path === '/api/profile?id=admin') return admin;
    if (path === '/api/own-agent-resume' || path === '/api/profile?id=member') return member('ready');
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]);
  await p.activate(p.element('exports').children[0].children[1]);
  assert.equal(p.element('profile-title').textContent, 'bob · 成员');
  assert.ok(!p.calls.includes('/api/discovery')); assert.equal(p.element('notice').textContent, '');
});
