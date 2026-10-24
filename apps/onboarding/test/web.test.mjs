import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped event handlers with a minimal DOM; full form interaction is also
// exercised in the browser audit. These tests guard recovery and API sequencing.
class Element {
  constructor(id) { this.id = id; this.hidden = false; this.children = []; this.dataset = {}; this.textContent = ''; this.value = ''; this.tagName = id; this.elements = {}; this.checked = false; }
  append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll(selector) { const nodes = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]); return selector === '*' ? nodes : selector === '[data-field]' ? nodes.filter((child) => child.dataset.field) : nodes.filter((child) => child.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll('*').find((child) => selector === `[data-field="${child.dataset.field}"]`); }
}
async function page(route, storage = new Map()) {
  const ids = new Map(), calls = [], timers = new Map(); let timerId = 0;
  const element = (id) => { if (!ids.has(id)) ids.set(id, new Element(id)); return ids.get(id); };
  const sections = ['home', 'project', 'admin', 'join', 'own', 'existing', 'verification', 'profile', 'reset-view'].map(element);
  const context = vm.createContext({
    document: { getElementById: element, createElement: (tag) => new Element(tag), querySelectorAll: (selector) => selector === 'main>section' ? sections : [] },
    FormData: class { constructor(form) { return Object.entries(form.input)[Symbol.iterator](); } },
    fetch: async (path, options) => {
      calls.push(path);
      const value = await route(path, options?.body ? JSON.parse(options.body) : undefined);
      return { ok: !(value instanceof Error), json: async () => value instanceof Error ? { error: value.message } : value };
    },
    location: { hash: '' }, history: { replaceState() {} }, navigator: { clipboard: { async writeText() {} } },
    setInterval: (fn) => { timers.set(++timerId, fn); return timerId; }, clearInterval: (id) => timers.delete(id),
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  });
  vm.runInContext(await readFile(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { element, calls, settle, storage, context, tick: async () => { const next = timers.entries().next().value; if (next) { timers.delete(next[0]); await next[1](); await settle(); } }, activate: async (node) => { node.onclick(); await settle(); }, submit: async (id, input) => {
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
    if (path === '/api/admin-prepare' || path.startsWith('/api/discovery')) return { id: 'discovery', draft_id: 'draft', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/admin-complete') { persisted = true; return new Error('接入中断'); }
    if (path === '/api/admin-draft?id=draft') return { profile: created };
    if (path === '/api/profile?id=new') return created;
    assert.fail(path);
  });
  await p.submit('admin-form', { repo: '/fixture/project', agent_id: 'alice', capabilities: 'backend', test_argv: '["npm","test"]', bot_id: 'fixture', secret: 'fixture' });
  await p.click('confirm-code');
  assert.equal(p.element('profile-title').textContent, 'alice · 管理员'); assert.ok(p.calls.includes('/api/profile?id=new'));
  assert.match(p.element('notice').textContent, /接入中断.*继续接入/);
});

test('invalid admin test command is rejected server-side before starting a bot', async () => {
  const p = await page((path) => path === '/api/overview' ? { profiles: [] } : path === '/api/admin-prepare' ? new Error('请确认验证命令') : assert.fail(path));
  await p.submit('admin-form', { repo: '/fixture', display_name: 'Alice', test_command: '', bot_id: 'fixture', secret: 'fixture' });
  assert.match(p.element('notice').textContent, /验证命令/); assert.ok(!p.calls.includes('/api/discovery'));
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

const resetPreview = (kind) => ({ id: 'member', kind, agent_id: 'bob', repo: '/fixture/bob', title: '重置', preview_token: 'preview', effects: ['fixture effect'], requires_pause: ['project', 'conversation'].includes(kind) });
async function resetPage(extra) {
  return page((path, input) => {
    if (path === '/api/overview') return { profiles: [member('ready')] };
    if (path.startsWith('/api/profile?')) return member('ready');
    if (path === '/api/reset-preview') return resetPreview(input.kind);
    return extra(path, input);
  });
}
async function openMember(p) { await p.activate(p.element('profiles').children[0].children[1]); }

test('web reset previews effects before confirmation and requires exact name and paused heartbeat', async () => {
  const received = []; const p = await resetPage((path, input) => { if (path === '/api/reset') { received.push(input); return { id: 'member', kind: 'conversation', message: 'done', backup_path: '/fixture/backup' }; } assert.fail(path); });
  await openMember(p); await p.click('reset-conversation'); assert.equal(p.element('reset-view').hidden, false); assert.equal(p.element('reset-effects').children[0].textContent, 'fixture effect');
  p.element('reset-confirmation').value = 'wrong'; await p.submit('reset-form', {}); assert.match(p.element('notice').textContent, /Agent 名称/); assert.equal(received.length, 0);
  p.element('reset-confirmation').value = 'bob'; await p.submit('reset-form', {}); assert.match(p.element('notice').textContent, /暂停/); assert.equal(received.length, 0);
  p.element('reset-paused').checked = true; await p.submit('reset-form', {}); assert.equal(received.length, 1); assert.equal(received[0].preview_token, 'preview'); assert.equal(received[0].heartbeat_paused, true); assert.equal(p.element('profile').hidden, false);
});

test('web robot update clears Secret after discovery and saves only after verified group proof', async () => {
  const received = []; let verified = false;
  const p = await resetPage((path, input) => {
    if (path === '/api/reset-discovery') { received.push(input); return { id: 'proof', status: 'authenticated', message: '协作 接入 123456' }; }
    if (path === '/api/discovery?id=proof') return { id: 'proof', status: verified ? 'verified' : 'authenticated' };
    if (path === '/api/reset') { received.push(input); return { id: 'member', kind: 'robot', message: 'saved', backup_path: '/fixture/backup' }; }
    assert.fail(path);
  });
  await openMember(p); await p.click('reset-robot'); assert.equal(p.element('reset-pause-label').hidden, true);
  p.element('reset-secret').value = 'fixture-new-secret'; await p.click('reset-connect'); assert.equal(p.element('reset-secret').value, ''); assert.equal(p.element('reset-code').textContent, '协作 接入 123456');
  p.element('reset-confirmation').value = 'bob'; await p.submit('reset-form', {}); assert.equal(received.length, 1); assert.match(p.element('notice').textContent, /验证码/);
  verified = true; await p.submit('reset-form', {}); assert.equal(received.length, 2); assert.equal(received[1].discovery_id, 'proof'); assert.equal(received[1].secret, undefined);
});

test('web cancellation cancels the exact preview and restores the profile without resetting', async () => {
  const calls = []; const p = await resetPage((path, input) => { calls.push([path, input]); if (path === '/api/reset-cancel') return { cancelled: true }; assert.fail(path); });
  await openMember(p); await p.click('reset-project'); await p.click('reset-cancel'); assert.equal(p.element('profile').hidden, false); assert.equal(calls.length, 1); assert.equal(calls[0][1].preview_token, 'preview');
});

test('web restoration is available from the removed projects list', async () => {
  const p = await page((path, input) => {
    if (path === '/api/overview') return { profiles: [], removed_profiles: [member('removed')] };
    if (path === '/api/reset-preview') { assert.equal(input.kind, 'restore'); return resetPreview('restore'); }
    assert.fail(path);
  });
  assert.equal(p.element('removed-projects').hidden, false); await p.activate(p.element('removed-profiles').children[0].children[1]);
  assert.equal(p.element('reset-view').hidden, false); assert.equal(p.element('reset-pause-label').hidden, true); assert.equal(p.element('reset-submit').textContent, '确认恢复');
});

test('verified group proof automatically advances once without a Continue click', async () => {
  let verifies = 0;
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [] };
    if (path === '/api/import') return member('imported');
    if (path.startsWith('/api/discovery')) return { id: 'proof', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/verify') { verifies++; return member('waiting'); }
    if (path === '/api/profile?id=member' || path === '/api/progress') return member('waiting');
    assert.fail(path);
  });
  await p.submit('join-form', importInput()); await p.tick();
  assert.equal(p.element('profile').hidden, false); assert.equal(verifies, 1); await p.tick(); assert.equal(verifies, 1);
  assert.equal(p.element('setup-steps').children.length, 6);
  assert.match(p.element('next-step').textContent, /自动等待管理员/);
  assert.doesNotMatch([...p.storage.values()].join(''), /password|fixture-password|secret/);
});

test('automatic profile refresh keeps unsaved review form edits across policy updates', async () => {
  let version = 1;
  const profile = () => ({ ...ownAdmin(), version, routes: { backend: ['alice'] }, requests: [], members: [], binding_prompt: 'short', detailed_binding_prompt: 'long' });
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [profile()] };
    if (path === '/api/profile?id=admin' || path === '/api/progress') return profile();
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]);
  const rules = p.element('review-rules').children[0]; rules.querySelector('[data-field="required"]').checked = false;
  await p.tick(); assert.equal(p.element('review-rules').children[0], rules); assert.equal(rules.querySelector('[data-field="required"]').checked, false);
  version = 2; await p.tick(); assert.equal(p.element('review-rules').children[0], rules); assert.match(p.element('review-policy-note').textContent, /编辑已保留/);
  assert.equal(p.element('binding-text').textContent, 'short'); assert.equal(p.element('binding-details').textContent, 'long');
});

test('refresh restores a draft using only its identifier and resumes proof automatically', async () => {
  const storage = new Map([['codex-collab-onboarding', JSON.stringify({ draft_id: 'draft' })]]);
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [], drafts: [{ id: 'draft', agent_id: 'alice' }] };
    if (path === '/api/admin-draft?id=draft' || path === '/api/discovery?id=proof') return { id: 'proof', draft_id: 'draft', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/admin-complete' || path === '/api/profile?id=admin') return ownAdmin();
    assert.fail(path);
  }, storage);
  assert.equal(p.element('verification').hidden, false); await p.tick(); assert.equal(p.element('profile').hidden, false);
  assert.equal(JSON.parse(storage.get('codex-collab-onboarding')).profile_id, 'admin');
});

test('a delayed automatic response cannot replace a different selected profile', async () => {
  let release;
  const alice = ownAdmin(); const bob = member('ready');
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [alice, bob] };
    if (path === '/api/profile?id=admin') return alice;
    if (path === '/api/profile?id=member') return bob;
    if (path === '/api/progress') return new Promise((resolve) => { release = () => resolve(alice); });
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]); const pendingTick = p.tick(); await p.settle();
  await p.activate(p.element('profiles').children[1].children[1]); release(); await pendingTick;
  assert.equal(p.element('profile-title').textContent, 'bob · 成员');
});

test('batch rows submit explicit flags and reveal passwords only through delivery', async () => {
  const p = await page((path, input) => {
    if (path === '/api/overview') return { profiles: [ownAdmin()] };
    if (path === '/api/profile?id=admin') return ownAdmin();
    if (path === '/api/issue-batch') {
      assert.equal(input.members.length, 1); assert.equal(input.members[0].display_name, 'Bob'); assert.equal(input.members[0].prefer, false);
      return { assignments: [{ agent_id: 'bob', invite_id: 'invite' }] };
    }
    if (path === '/api/delivery') return { agent_id: 'bob', display_name: 'Bob', password: 'fixture-delivery-password', instructions: 'import invite' };
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]);
  const row = p.element('assignment-rows').children[0];
  row.querySelector('[data-field="display_name"]').value = 'Bob'; row.querySelector('[data-field="secret"]').value = 'fixture-bot-secret'; row.querySelector('[data-field="prefer"]').checked = false;
  await p.submit('batch-form', {}); assert.equal(p.element('delivery-password').value, 'fixture-delivery-password');
  assert.equal(p.element('assignment-rows').children[0].querySelector('[data-field="secret"]').value, '');
  assert.doesNotMatch([...p.storage.values()].join(''), /password|secret/); await p.click('hide-delivery'); assert.equal(p.element('delivery-password').value, '');
});


test('refresh restores an imported member and approval automatically opens binding instructions', async () => {
  const storage = new Map([['codex-collab-onboarding', JSON.stringify({ profile_id: 'member' })]]);
  let phase = 'imported', approved = false, verifies = 0;
  const profile = () => ({ ...member(phase), display_name: 'Bob', binding_prompt: 'enable Bob', detailed_binding_prompt: 'details' });
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [profile()] };
    if (path === '/api/profile?id=member') return profile();
    if (path.startsWith('/api/discovery')) return { id: 'proof', status: 'verified', message: '协作 接入 123456' };
    if (path === '/api/verify') { verifies++; phase = 'waiting'; return profile(); }
    if (path === '/api/progress') { if (approved) phase = 'ready'; return profile(); }
    assert.fail(path);
  }, storage);
  assert.equal(p.element('verification').hidden, false);
  await p.tick(); assert.equal(verifies, 1); assert.match(p.element('next-step').textContent, /自动等待管理员/);
  await p.tick(); assert.equal(p.element('binding').hidden, true);
  approved = true; await p.tick(); assert.equal(p.element('binding').hidden, false);
  assert.equal(p.element('binding-text').textContent, 'enable Bob'); assert.equal(p.element('profile-title').textContent, 'Bob（bob） · 成员');
  assert.equal(verifies, 1); assert.ok(!p.calls.includes('/api/import'));
  assert.equal(storage.get('codex-collab-onboarding'), JSON.stringify({ profile_id: 'member' }));
});

test('legacy delivery shows actionable recovery instead of an empty password, then displays the replacement', async () => {
  const admin = { ...ownAdmin(), exports: [{ invite_id: 'old-invite', agent_id: 'bob', display_name: 'Bob', expires_at: '2026-10-20' }] };
  const p = await page((path, input) => {
    if (path === '/api/overview') return { profiles: [admin] };
    if (path === '/api/profile?id=admin') return admin;
    if (path === '/api/delivery') return { agent_id: 'bob', display_name: 'Bob', password: input.invite_id === 'old-invite' ? null : 'fixture-new-password', can_reissue: true, bot_id: 'bot-bob', instructions: 'import latest invite' };
    if (path === '/api/reissue-invite') {
      assert.equal(input.id, 'admin'); assert.equal(input.invite_id, 'old-invite'); assert.equal(input.secret, 'fixture-bot-secret');
      return { invite_id: 'new-invite' };
    }
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]);
  await p.activate(p.element('exports').children[0].children[1]);
  assert.equal(p.element('delivery-password-label').hidden, true); assert.equal(p.element('copy-password').hidden, true);
  assert.match(p.element('delivery-password-note').textContent, /未保存密码.*重新生成/);
  assert.equal(p.element('reissue-invite').hidden, false);
  await p.click('reissue-invite'); assert.equal(p.element('reissue-form').hidden, false);
  assert.equal(p.element('reissue-bot-id').value, 'bot-bob'); p.element('reissue-secret').value = 'fixture-bot-secret';
  await p.submit('reissue-form', {});
  assert.equal(p.element('reissue-secret').value, ''); assert.equal(p.element('reissue-form').hidden, true);
  assert.equal(p.element('delivery-password').value, 'fixture-new-password'); assert.equal(p.element('delivery-password-label').hidden, false);
  assert.match(p.element('delivery-download').href, /invite=new-invite/); assert.match(p.element('notice').textContent, /旧包已失效/);
  assert.doesNotMatch([...p.storage.values()].join(''), /fixture|secret|password/);
});

test('reissue failure clears secret and preserves the current delivery, and approved invites offer no reissue', async () => {
  for (const approved of [false, true]) {
    const admin = { ...ownAdmin(), exports: [{ invite_id: 'old-invite', agent_id: 'bob', expires_at: '2026-10-20' }] };
    const p = await page((path) => {
      if (path === '/api/overview') return { profiles: [admin] };
      if (path === '/api/profile?id=admin') return admin;
      if (path === '/api/delivery') return { agent_id: 'bob', display_name: 'Bob', password: null, can_reissue: !approved, bot_id: 'bot-bob', instructions: 'invite' };
      if (path === '/api/reissue-invite') return new Error('Git 发布失败，请重试');
      assert.fail(path);
    });
    await p.activate(p.element('profiles').children[0].children[1]); await p.activate(p.element('exports').children[0].children[1]);
    assert.equal(p.element('reissue-invite').hidden, approved);
    if (approved) { assert.match(p.element('delivery-password-note').textContent, /成员已获批准/); continue; }
    await p.click('reissue-invite'); p.element('reissue-secret').value = 'fixture-bot-secret';
    await p.submit('reissue-form', {});
    assert.equal(p.element('reissue-secret').value, ''); assert.equal(p.element('delivery-panel').hidden, false);
    assert.equal(p.element('notice').textContent, 'Git 发布失败，请重试');
    await p.click('reissue-cancel'); assert.equal(p.element('reissue-form').hidden, true);
  }
});

test('project check exposes ambiguous remote selection and preserves explicit baseline choice', async () => {
  let checked;
  const p = await page((path, input) => {
    if (path === '/api/overview') return { profiles: [] };
    if (path === '/api/project-check') { checked = input; return input.remote_name ? { repo: '/fixture/project', remote_name: 'team', remotes: ['team'], base_branch: input.base_branch || 'develop', branches: ['develop', 'release/stable'], tests: [] } : { repo: '/fixture/project', remotes: ['origin', 'team'], branches: [], selection_required: 'remote', tests: [] }; }
    assert.fail(path);
  });
  const form = p.element('admin-form'); form.elements.repo = p.element('admin-repo'); form.elements.repo.value = '/fixture/project';
  p.element('admin-repo-mode').value = 'existing';
  Object.defineProperty(form, 'input', { get: () => ({ repo_mode: p.element('admin-repo-mode').value, repo: form.elements.repo.value, remote_name: p.element('admin-remote-name').value, base_branch: p.element('admin-base-branch').value }) });
  await p.click('check-project');
  assert.equal(p.element('repository-options').hidden, false); assert.match(p.element('project-recommendation').textContent, /选择协作远程/);
  assert.deepEqual(p.element('admin-remote-name').children.map((node) => node.value), ['', 'origin', 'team']);
  p.element('admin-remote-name').value = 'team'; p.element('admin-remote-name').onchange(); await p.settle();
  assert.equal(checked.remote_name, 'team'); assert.equal(p.element('admin-base-branch').value, 'develop');
  p.element('admin-base-branch').value = 'release/stable'; p.element('admin-base-branch').onchange(); await p.settle();
  assert.equal(checked.base_branch, 'release/stable'); assert.match(p.element('project-recommendation').textContent, /team\/release\/stable/);
  p.element('admin-repo-mode').value = 'clone'; p.element('admin-repo-mode').onchange();
  assert.equal(p.element('admin-remote-name').value, ''); assert.equal(p.element('admin-base-branch').value, ''); assert.equal(p.element('repository-options').hidden, true);
});

test('admin repository settings save the loaded signed policy version and selected branch', async () => {
  const admin = { ...ownAdmin(), base_branch: 'main', remote_name: 'upstream' }; let saved;
  const p = await page((path, input) => {
    if (path === '/api/overview') return { profiles: [admin] };
    if (path === '/api/profile?id=admin') return admin;
    if (path === '/api/repository-settings') return { version: 7, branches: ['main', 'develop'], base_branch: 'main', default_branch: 'main' };
    if (path === '/api/repository-policy') { saved = input; admin.base_branch = input.base_branch; return admin; }
    assert.fail(path);
  });
  await p.activate(p.element('profiles').children[0].children[1]);
  await p.click('load-repository-settings'); assert.equal(p.element('repository-policy-form').hidden, false);
  p.element('team-base-branch').value = 'develop'; await p.submit('repository-policy-form', {});
  assert.equal(saved.id, 'admin'); assert.equal(saved.expected_version, 7); assert.equal(saved.base_branch, 'develop');
  assert.match(p.element('profile-repo').textContent, /upstream\/develop/); assert.match(p.element('notice').textContent, /已有任务保留/);
});

const projectFixture = () => ({ id: 'project-one', name: 'product', repository: 'example.invalid/team/product', local_agent_count: 2,
  admin_profile_id: 'alice-profile', base_branch: 'develop', sync_status: 'synced', agents: [
    { agent_id: 'alice', role: 'admin', capabilities: ['backend'], mine: true, registered: true,
      connections: [{ id: 'alice-profile', display_name: 'Alice', repo: '/fixture/alice', phase: 'ready', runner_online: true, bound: false }] },
    { agent_id: 'bob', role: 'member', capabilities: ['frontend'], mine: false, registered: true, connections: [] },
    { agent_id: 'carol', role: 'member', capabilities: ['testing'], mine: true, registered: true, connections: [] },
  ] });
const descendants = (node) => [node, ...node.children.flatMap(descendants)];

test('home opens one project with a unified roster and local management, then returns from its robot', async () => {
  const project = projectFixture();
  const overview = { projects: [project], profiles: [{ id: 'alice-profile' }, { id: 'another-profile' }] };
  const p = await page((path) => path === '/api/overview' ? overview : path.startsWith('/api/project?') ? project
    : path.startsWith('/api/profile?') ? { ...member('ready'), id: 'alice-profile', project_id: project.id } : assert.fail(`unexpected ${path}`));
  assert.equal(p.element('profiles').children.length, 1); assert.equal(p.element('project-count').textContent, '1 个项目');
  await p.activate(p.element('profiles').children[0].children[1]);
  assert.equal(p.element('project').hidden, false); assert.equal(p.element('home').hidden, true);
  assert.equal(p.element('project-agents').children.length, 3);
  assert.equal(descendants(p.element('project-agents')).filter((node) => node.textContent === '我的').length, 2);
  assert.equal(descendants(p.element('project-agents').children[1]).filter((node) => node.tagName === 'button').length, 0);
  assert.equal(p.element('project-add-own').hidden, false);
  await p.tick();
  const robot = p.element('project-agents').children[0]; await p.tick();
  assert.equal(p.element('project-agents').children[0], robot, 'identical automatic refresh preserves DOM and focus');
  await p.activate(descendants(robot).find((node) => node.tagName === 'button'));
  assert.equal(p.element('profile').hidden, false); assert.equal(p.element('profile-back').hidden, false);
  await p.click('profile-back'); assert.equal(p.element('project').hidden, false);
  await p.click('project-back'); assert.equal(p.element('home').hidden, false);
});

test('saved project restores directly and add-own cancellation returns to the originating project', async () => {
  const project = projectFixture(), storage = new Map([['codex-collab-onboarding', JSON.stringify({ project_id: project.id })]]);
  const p = await page((path) => path === '/api/overview' ? { profiles: [], projects: [project] } : path.startsWith('/api/project?') ? project : assert.fail(`unexpected ${path}`), storage);
  assert.equal(p.element('project').hidden, false); assert.equal(p.element('project-title').textContent, 'product');
  await p.click('project-add-own'); assert.equal(p.element('own').hidden, false);
  await p.click('own-cancel'); assert.equal(p.element('project').hidden, false);
  assert.equal(p.calls.filter((path) => path.startsWith('/api/profile?')).length, 0);
});

test('member project hides administrative actions and background pages skip automatic project sync', async () => {
  const project = { ...projectFixture(), admin_profile_id: null };
  const p = await page((path) => path === '/api/overview' ? { profiles: [{ id: 'bob' }], projects: [project] } : project);
  await p.activate(p.element('profiles').children[0].children[1]);
  assert.equal(p.element('project-add-own').hidden, true); assert.equal(p.element('project-settings').hidden, true);
  p.context.document.visibilityState = 'hidden'; const count = p.calls.length; await p.tick(); assert.equal(p.calls.length, count);
  p.context.document.visibilityState = 'visible'; await p.tick(); assert.equal(p.calls.length, count + 1);
});

test('delayed project refresh cannot replace a different project selected by the user', async () => {
  const first = projectFixture(), second = { ...projectFixture(), id: 'project-two', name: 'another-project' };
  let resolve;
  const p = await page((path) => path === '/api/overview' ? { profiles: [{ id: 'alice' }], projects: [first, second] }
    : path.includes('id=project-two') ? second : path.includes('local=1') ? first : new Promise((done) => { resolve = done; }));
  await p.activate(p.element('profiles').children[0].children[1]);
  const refreshing = p.tick(); await p.settle();
  await p.context.loadProject(second.id); resolve({ ...first, name: 'stale' }); await refreshing;
  assert.equal(p.element('project-title').textContent, second.name);
});
