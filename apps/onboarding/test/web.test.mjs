import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the shipped event handlers with a minimal DOM; full form interaction is also
// exercised in the browser audit. These tests guard recovery and API sequencing.
class Element {
  constructor(id) { this.id = id; this.hidden = false; this.children = []; this.dataset = {}; this.textContent = ''; this.value = ''; this.tagName = id; this.elements = {}; this.checked = false; }
  setAttribute(name, value) { this[name] = value; }
  removeAttribute(name) { delete this[name]; }
  append(...children) { for (const child of children) child.parent = this; this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  querySelectorAll(selector) { const nodes = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]); return selector === '*' ? nodes : selector === '[data-field]' ? nodes.filter((child) => child.dataset.field) : nodes.filter((child) => child.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll('*').find((child) => selector === `[data-field="${child.dataset.field}"]`); }
}
async function page(route, storage = new Map(), { href = 'http://localhost/', appearance = false, themeStorage = new Map() } = {}) {
  const ids = new Map(), calls = [], copied = [], timers = new Map(); let timerId = 0;
  const element = (id) => { if (!ids.has(id)) ids.set(id, new Element(id)); return ids.get(id); };
  const sections = ['home', 'personal', 'project', 'admin', 'join', 'own', 'existing', 'verification', 'profile', 'reset-view'].map(element);
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const viewLinks = [...html.matchAll(/<(?:button|a)\b[^>]*\bdata-view="([^"]+)"[^>]*>/g)].map(([tag, view], index) => {
    const link = element(/\bid="([^"]+)"/.exec(tag)?.[1] || `view-link-${index}`); link.dataset.view = view; return link;
  });
  element('admin-form').elements.repo = element('admin-repo');
  element('admin-form').elements.display_name = element('admin-display-name');
  const themeChoices = ['day', 'night'].map((theme) => { const choice = new Element(`theme-${theme}`); choice.dataset.themeChoice = theme; return choice; });
  const context = vm.createContext({
    document: { body: appearance ? element('body') : undefined, getElementById: element, createElement: (tag) => new Element(tag), querySelectorAll: (selector) => selector === 'main>section' ? sections : selector === '[data-theme-choice]' ? themeChoices : selector === '[data-view]' ? viewLinks : [] },
    FormData: class { constructor(form) { return Object.entries(form.input)[Symbol.iterator](); } },
    fetch: async (path, options) => {
      calls.push(path);
      const value = await route(path, options?.body ? JSON.parse(options.body) : undefined);
      return { ok: !(value instanceof Error), json: async () => value instanceof Error ? { error: value.message } : value };
    },
    location: { hash: '', href }, URL, localStorage: { getItem: (key) => themeStorage.get(key) ?? null, setItem: (key, value) => themeStorage.set(key, value) },
    history: { replaceState() {} }, navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    setInterval: (fn) => { timers.set(++timerId, fn); return timerId; }, clearInterval: (id) => timers.delete(id),
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    sessionStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  });
  vm.runInContext(await readFile(new URL('../web/app.js', import.meta.url), 'utf8'), context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  return { element, calls, copied, settle, storage, themeStorage, themeChoices, context, tick: async () => { const next = timers.entries().next().value; if (next) { timers.delete(next[0]); await next[1](); await settle(); } }, activate: async (node) => { node.onclick({ preventDefault() {} }); await settle(); }, submit: async (id, input) => {
    const target = { input, elements: Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { value, checked: value === true }])) };
    element(id).onsubmit({ preventDefault() {}, target }); await settle(); return target;
  }, click: async (id) => { element(id).onclick(); await settle(); } };
}
const member = (phase) => ({ id: 'member', agent_id: 'bob', role: 'member', repo: '/fixture/bob', phase });
const importInput = () => ({ file: { text: async () => '{}' }, password: 'fixture-password', repo: '/fixture/bob' });


test('night is the first-run wizard theme while explicit and saved choices are respected', async () => {
  const fresh = await page((path) => path === '/api/overview' ? { profiles: [] } : assert.fail(path), new Map(), { appearance: true });
  assert.equal(fresh.element('body').dataset.theme, 'night');
  assert.equal(fresh.themeChoices[0]['aria-pressed'], 'false');
  assert.equal(fresh.themeChoices[1]['aria-pressed'], 'true');
  assert.equal(fresh.themeStorage.get('codex-collab-theme'), 'night');

  const saved = new Map([['codex-collab-theme', 'day']]);
  const returning = await page((path) => path === '/api/overview' ? { profiles: [] } : assert.fail(path), new Map(), { appearance: true, themeStorage: saved });
  assert.equal(returning.element('body').dataset.theme, 'day');
  assert.equal(returning.themeChoices[0]['aria-pressed'], 'true');

  const urlChoice = await page((path) => path === '/api/overview' ? { profiles: [] } : assert.fail(path), new Map(), { appearance: true, href: 'http://localhost/?theme=night', themeStorage: saved });
  assert.equal(urlChoice.element('body').dataset.theme, 'night');
  assert.equal(urlChoice.themeChoices[1]['aria-pressed'], 'true');

  const legacyTheme = await page((path) => path === '/api/overview' ? { profiles: [] } : assert.fail(path), new Map(), { appearance: true, href: 'http://localhost/?theme=studio' });
  assert.equal(legacyTheme.element('body').dataset.theme, 'day');
});

test('empty home offers two working entry points, hides duplicate actions and does not invent a detected project', async () => {
  const p = await page((path) => path === '/api/overview' ? { profiles: [], projects: [] } : assert.fail(path));
  assert.equal(p.element('home-start-options').hidden, false);
  assert.equal(p.element('profiles').hidden, true);
  assert.equal(p.element('profiles').children.length, 0);
  assert.equal(p.element('home-actions').hidden, true);
  assert.equal(p.element('detected-project').hidden, true);
  await p.activate(p.element('home-start-admin'));
  assert.equal(p.element('personal').hidden, true);
  assert.equal(p.element('personal-existing').hidden, true);
  assert.equal(p.element('admin').hidden, false);
  assert.equal(p.element('home').hidden, true);
  await p.click('admin-back');
  assert.equal(p.element('home').hidden, false);
  await p.activate(p.element('home-start-join'));
  assert.equal(p.element('join').hidden, false);
  assert.deepEqual(p.calls, ['/api/overview', '/api/overview']);
});

test('empty home shows the detected repository as plain text and keeps unsaved project selection', async () => {
  const detected = '/fixture/project with spaces/<product>';
  let overview = { profiles: [], defaults: { repo: detected, display_name: 'Alice' } };
  const p = await page((path) => path === '/api/overview' ? overview : assert.fail(path));
  assert.equal(p.element('detected-project').hidden, false);
  assert.equal(p.element('detected-project-path').textContent, detected);
  assert.equal(p.element('admin-form').elements.repo.value, detected);
  assert.equal(p.element('admin-form').elements.display_name.value, 'Alice');
  await p.activate(p.element('home-start-admin'));
  p.element('admin-form').elements.repo.value = '/fixture/another-project';
  await p.click('admin-back');
  assert.equal(p.element('admin-form').elements.repo.value, '/fixture/another-project');
  overview = { profiles: [], defaults: { repo: '' } };
  await p.context.overview();
  assert.equal(p.element('detected-project').hidden, true);
  assert.equal(p.element('detected-project-path').textContent, '');
});

test('project, unfinished draft and legacy profile homes retain existing actions and can return to empty state', async () => {
  for (const existing of [
    { projects: [{ id: 'project-one', name: 'product' }], profiles: [] },
    { projects: [], profiles: [], drafts: [{ id: 'draft-one', agent_id: 'alice' }] },
    { profiles: [{ id: 'legacy', agent_id: 'alice', role: 'admin', repo: '/fixture/product' }] },
  ]) {
    let overview = existing;
    const p = await page((path) => path === '/api/overview' ? overview : assert.fail(path));
    assert.equal(p.element('home-start-options').hidden, true);
    assert.equal(p.element('profiles').hidden, false);
    assert.equal(p.element('profiles').children.length, 1);
    assert.equal(p.element('home-actions').hidden, false);
    assert.equal(p.element('personal-existing').hidden, false);
    overview = { profiles: [], projects: [] };
    await p.context.overview();
    assert.equal(p.element('home-start-options').hidden, false);
    assert.equal(p.element('profiles').hidden, true);
    assert.equal(p.element('profiles').children.length, 0);
    assert.equal(p.element('home-actions').hidden, true);
    assert.equal(p.element('personal-existing').hidden, true);
  }
});

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
  assert.equal(p.element('profile-title').textContent, 'alice · 我的机器人'); assert.ok(p.calls.includes('/api/profile?id=new'));
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
  assert.equal(p.element('profile-title').textContent, 'bob · 我的机器人');
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
  assert.equal(p.element('profile-title').textContent, 'bob · 我的机器人');
  assert.ok(!p.calls.includes('/api/discovery')); assert.equal(p.element('notice').textContent, '');
});

const resetPreview = (kind) => ({ id: 'member', kind, agent_id: 'bob', repo: '/fixture/bob', title: '重置', preview_token: 'preview', effects: ['fixture effect'], requires_pause: kind === 'conversation' });
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

test('web project removal is a simple preview-and-confirm flow with automatic backup notice', async () => {
  const received = []; const p = await resetPage((path, input) => { if (path === '/api/reset') { received.push(input); return { id: 'member', kind: 'project', message: 'removed', backup_path: '/fixture/backup' }; } assert.fail(path); });
  await openMember(p); await p.click('reset-project');
  assert.equal(p.element('reset-pause-label').hidden, true); assert.equal(p.element('reset-confirmation-label').hidden, true);
  assert.equal(p.element('reset-submit').textContent, '确认移除本机接入');
  await p.submit('reset-form', {});
  assert.equal(received.length, 1); assert.equal(received[0].confirmation, true); assert.equal(received[0].heartbeat_paused, false);
  assert.match(p.element('notice').textContent, /本机恢复记录/);
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
  assert.equal(p.element('setup-steps').children.length, 5);
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
  assert.equal(p.element('profile-title').textContent, 'bob · 我的机器人');
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
  const initialRow = p.element('assignment-rows').children[0];
  assert.equal(initialRow.querySelector('[data-field="display_name"]').value, '协作助手 1');
  assert.equal(initialRow.querySelector('[data-field="responsibility"]').value, 'general');
  await p.click('add-assignment');
  await p.activate(initialRow.children.at(-1));
  await p.click('add-assignment');
  assert.deepEqual(p.element('assignment-rows').children.map((row) => row.querySelector('[data-field="display_name"]').value), ['协作助手 2', '协作助手 3']);
  await p.activate(p.element('assignment-rows').children[1].children.at(-1));
  const row = p.element('assignment-rows').children[0];
  row.querySelector('[data-field="display_name"]').value = 'Bob'; row.querySelector('[data-field="secret"]').value = 'fixture-bot-secret'; row.querySelector('[data-field="prefer"]').checked = false;
  await p.submit('batch-form', {}); assert.equal(p.element('delivery-password').value, 'fixture-delivery-password');
  assert.equal(p.element('assignment-rows').children[0].querySelector('[data-field="secret"]').value, '');
  assert.doesNotMatch([...p.storage.values()].join(''), /password|secret/); await p.click('hide-delivery'); assert.equal(p.element('delivery-password').value, '');
});


test('refresh restores an imported member and approval automatically opens binding instructions', async () => {
  const storage = new Map([['codex-collab-onboarding', JSON.stringify({ profile_id: 'member' })]]);
  let phase = 'imported', approved = false, verifies = 0;
  const profile = () => ({ ...member(phase), display_name: 'Bob', runner: { online: phase === 'ready' }, binding_prompt: 'enable Bob', detailed_binding_prompt: 'details' });
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
  assert.equal(p.element('binding-text').textContent, 'enable Bob'); assert.equal(p.element('profile-title').textContent, 'Bob（bob） · 我的机器人');
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
  assert.equal(p.element('profiles').children.length, 1);
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


// Supply the two real wizard stages to the shipped handlers. Most older tests
// intentionally exercise saved profiles directly without onboarding panels.
function guidedForm(p, name, data, fields = [[], []]) {
  const form = p.element(`${name}-form`);
  for (const [key, value] of Object.entries(data)) form.elements[key] = { value };
  if (name === 'admin') {
    for (const [key, id] of [['repo', 'admin-repo'], ['remote', 'admin-remote'], ['remote_name', 'admin-remote-name'], ['base_branch', 'admin-base-branch'], ['test_command', 'test-command']]) {
      form.elements[key] = p.element(id); form.elements[key].value = data[key] || '';
    }
    p.element('admin-repo-mode').value = data.repo_mode;
  }
  Object.defineProperty(form, 'input', { get: () => Object.fromEntries(Object.entries(form.elements).map(([key, input]) => [key, input.value])) });
  const panels = fields.map((inputs, index) => {
    const panel = new Element('div'); panel.hidden = index !== 0;
    panel.querySelectorAll = (selector) => selector === 'input, select, textarea' ? inputs : [];
    return panel;
  });
  form.querySelectorAll = (selector) => selector === '[data-wizard-panel]' ? panels : [];
  p.element(`${name}-step-progress`).append(...Array.from({ length: 4 }, () => new Element('span')));
  return { form, panels, advance: () => vm.runInContext(`advanceGuide('${name}')`, p.context) };
}
function requiredField(id, valid = false) {
  return { id, willValidate: true, valid, closest() { return null; }, checkValidity() { return this.valid; }, reportValidity() { this.reported = true; } };
}

test('project guide checks the repository on Continue, blocks ambiguous settings and preserves credentials on Back', async () => {
  let ambiguous = true, prepared = false;
  const p = await page((path, input) => {
    if (path === '/api/overview') return { profiles: [] };
    if (path === '/api/project-check') return { repo: input.repo, remote_name: ambiguous ? '' : 'team', remotes: ['team'], base_branch: ambiguous ? '' : 'develop', branches: ['develop'], tests: [{ command: 'npm test' }], selection_required: ambiguous };
    if (path === '/api/admin-prepare') { prepared = true; return { id: 'proof', draft_id: 'draft', status: 'authenticated', message: 'code' }; }
    assert.fail(path);
  });
  const repo = requiredField('admin-repo'), guide = guidedForm(p, 'admin', { repo_mode: 'existing', repo: '/fixture/project', secret: 'fixture-secret' }, [[repo], []]);
  assert.equal(await guide.advance(), false); assert.equal(repo.reported, true); assert.ok(!p.calls.includes('/api/project-check'));
  repo.valid = true;
  await assert.rejects(guide.advance(), /请选择协作远程/); assert.equal(guide.panels[0].hidden, false); assert.equal(p.element('project-options').open, true);
  ambiguous = false;
  assert.equal(await guide.advance(), false); assert.equal(guide.panels[0].hidden, true); assert.equal(guide.panels[1].hidden, false);
  assert.equal(p.element('admin-step-count').textContent, '02 / 04'); assert.equal(p.element('test-command').value, 'npm test'); assert.equal(prepared, false);
  await p.click('admin-back'); assert.equal(guide.panels[0].hidden, false); assert.equal(guide.form.elements.secret.value, 'fixture-secret');
  assert.equal(await guide.advance(), false); assert.equal(await guide.advance(), true); assert.equal(prepared, false);
});

test('automatic checks let a repository without test scripts continue without entering a command', async () => {
  const p = await page((path) => path === '/api/overview' ? { profiles: [] } : { repo: '/fixture/project', remote_name: 'team', remotes: ['team'], base_branch: 'main', branches: ['main'], tests: [] });
  const guide = guidedForm(p, 'admin', { repo_mode: 'existing', repo: '/fixture/project' });
  assert.equal(await guide.advance(), false);
  assert.equal(guide.panels[0].hidden, true); assert.equal(guide.panels[1].hidden, false);
  assert.equal(p.element('test-command').required, false); assert.equal(p.element('test-command').disabled, true);
  assert.match(p.element('test-command-status').textContent, /基础改动检查.*直接继续.*人工审核/);
  assert.equal(p.element('test-command-choices').hidden, true);
  assert.ok(!p.calls.includes('/api/admin-prepare'));
});

test('recommended checks show their source, allow switching and preserve a manually entered command', async () => {
  const tests = [{ command: 'pnpm test', label: '测试', source: 'package.json 的 scripts.test' }, { command: 'pnpm run lint', label: '代码规范检查', source: 'package.json 的 scripts.lint' }];
  const p = await page((path) => path === '/api/overview' ? { profiles: [] } : { repo: '/fixture/project', remote_name: 'team', remotes: ['team'], base_branch: 'main', branches: ['main'], tests });
  guidedForm(p, 'admin', { repo_mode: 'existing', repo: '/fixture/project' });
  await p.click('check-project');
  const choices = p.element('test-command-choices');
  assert.equal(choices.hidden, false); assert.equal(choices.children.length, 2); assert.equal(p.element('test-command').value, 'pnpm test');
  assert.match(choices.children[0].children[2].textContent, /scripts.test/); assert.equal(choices.children[0]['aria-pressed'], 'true');
  await p.activate(choices.children[1]);
  assert.equal(p.element('test-command').value, 'pnpm run lint'); assert.equal(choices.children[0]['aria-pressed'], 'false'); assert.equal(choices.children[1]['aria-pressed'], 'true');
  p.element('test-command').value = 'node scripts/check.mjs'; p.element('test-command').oninput();
  assert.ok(choices.children.every((choice) => choice['aria-pressed'] === 'false'));
  await p.click('check-project');
  assert.equal(p.element('test-command').value, 'node scripts/check.mjs');
  p.element('test-mode').value = 'auto'; p.element('test-mode').onchange();
  assert.equal(p.element('test-command').value, 'pnpm test'); assert.equal(p.element('test-command').disabled, true);
});

test('switching projects clears previous commands so the next project gets its own recommendation', async () => {
  const p = await page((path, input) => path === '/api/overview' ? { profiles: [] } : { repo: input.repo, remote_name: 'team', remotes: ['team'], base_branch: 'main', branches: ['main'], tests: [{ command: input.repo.endsWith('second') ? 'go test ./...' : 'npm test' }] });
  guidedForm(p, 'admin', { repo_mode: 'existing', repo: '/fixture/first' });
  await p.click('check-project'); assert.equal(p.element('test-command').value, 'npm test');
  p.element('admin-repo').value = '/fixture/second'; p.element('admin-repo').onchange();
  assert.equal(p.element('test-command').value, ''); assert.equal(p.element('test-command-choices').hidden, true);
  await p.click('check-project'); assert.equal(p.element('test-command').value, 'go test ./...');
});

test('member guide reads the invite before showing the destination and keeps failed invites on step one', async () => {
  let bad = true;
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [] };
    if (path === '/api/inspect-invite') return bad ? new Error('密码错误') : { agent_id: 'bob', display_name: 'Bob', capabilities: ['backend'], remote: 'fixture-remote', suggested_repo: '/fixture/bob' };
    assert.fail(path);
  });
  const guide = guidedForm(p, 'join', { file: { text: async () => '{}' }, password: 'fixture-password', destination: '' });
  guide.form.elements.file.files = [guide.form.elements.file.value];
  await assert.rejects(guide.advance(), /密码错误/); assert.equal(guide.panels[0].hidden, false);
  bad = false; assert.equal(await guide.advance(), false); assert.equal(guide.panels[1].hidden, false); assert.equal(guide.form.elements.destination.value, '/fixture/bob');
  assert.match(p.element('invite-summary').textContent, /Bob/); assert.equal(p.element('join-continue').textContent, '接入项目 →');
  assert.equal(await guide.advance(), true); assert.ok(!p.calls.includes('/api/import'));
});

test('copying the binding instruction does not finish setup until actual binding and poll progress arrive', async () => {
  const storage = new Map([['codex-collab-onboarding', JSON.stringify({ profile_id: 'member' })]]);
  const value = { ...member('ready'), runner: { online: true }, desktop: { binding: null }, poll_recent: false, can_receive_tasks: false, binding_prompt: 'enable Bob' };
  const p = await page((path) => path === '/api/overview' ? { profiles: [value] } : value, storage);
  assert.equal(p.element('profile-heading').textContent, '最后，连接你的对话。');
  assert.equal(p.element('profile-done').hidden, true);
  assert.equal(p.element('polling-help').hidden, true);
  await p.click('copy-binding'); assert.match(p.element('copy-binding').textContent, /已复制/); assert.equal(p.element('profile-heading').textContent, '最后，连接你的对话。');
  value.desktop.binding = { thread_id: 'fixture-thread' }; await p.tick();
  assert.equal(p.element('profile-heading').textContent, '对话已绑定。'); assert.equal(p.element('binding').hidden, true); assert.match(p.element('next-step').textContent, /等待实际轮询/);
  assert.equal(p.element('profile-done').hidden, true); assert.equal(p.element('polling-help').hidden, false);
  value.poll_recent = true; value.can_receive_tasks = true; await p.tick();
  assert.equal(p.element('profile-heading').textContent, '就这么简单。'); assert.equal(p.element('profile-art').dataset.state, 'success'); assert.equal(p.element('profile-step-progress').hidden, true);
  assert.equal(p.element('profile-done').hidden, false); assert.equal(p.element('polling-help').hidden, true);
  assert.equal(storage.get('codex-collab-onboarding'), JSON.stringify({ profile_id: 'member' }));
});


test('opening another robot collapses team settings while refreshing the same robot preserves them', async () => {
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [member('ready')] };
    if (path.startsWith('/api/profile?')) return member('ready');
    assert.fail(path);
  });
  p.element('admin-tools').open = true; p.element('connection-details').open = true;
  await vm.runInContext("loadProfile('member')", p.context);
  assert.equal(p.element('admin-tools').open, false); assert.equal(p.element('connection-details').open, false);
  p.element('admin-tools').open = true; p.element('connection-details').open = true;
  await vm.runInContext("loadProfile('member')", p.context);
  assert.equal(p.element('admin-tools').open, true); assert.equal(p.element('connection-details').open, true);
});


test('an unavailable profile cannot keep showing the previously selected robot as complete', async () => {
  const p = await page((path) => path === '/api/overview' ? { profiles: [] } : new Error('暂时无法读取'));
  p.element('profile-heading').textContent = '就这么简单。'; p.element('profile-art').dataset.state = 'success';
  await assert.rejects(vm.runInContext("loadProfile('unavailable')", p.context), /暂时无法读取/);
  assert.equal(p.element('profile-heading').textContent, '正在读取连接…'); assert.equal(p.element('profile-art').dataset.state, 'waiting');
  assert.equal(p.element('binding').hidden, true); assert.equal(p.element('profile-done').hidden, true); assert.equal(p.element('admin-tools').hidden, true);
});


test('selecting an already connected project opens its existing robot before asking for credentials or a test command', async () => {
  const value = { ...member('ready'), runner: { online: true }, binding_prompt: 'enable Bob' };
  const p = await page((path) => {
    if (path === '/api/overview') return { profiles: [value] };
    if (path === '/api/project-check') return { repo: value.repo, existing_profile: { id: value.id } };
    if (path === '/api/profile?id=member&local=1') return value;
    assert.fail(path);
  });
  const command = requiredField('test-command');
  const guide = guidedForm(p, 'admin', { repo_mode: 'existing', repo: value.repo, secret: 'unused-secret' }, [[command], []]);
  await p.activate(p.element('home-start-admin'));
  assert.equal(await guide.advance(), false);
  assert.equal(p.element('profile').hidden, false);
  assert.equal(p.element('admin').hidden, true);
  assert.equal(guide.form.elements.secret.value, '');
  assert.equal(command.reported, undefined);
  assert.ok(!p.calls.includes('/api/admin-prepare'));
  assert.match(p.element('notice').textContent, /已经接入/);
  assert.equal(p.storage.get('codex-collab-onboarding'), JSON.stringify({ profile_id: value.id }));
});

test('a stopped robot only offers restoring its connection as the primary next action', async () => {
  const value = { ...member('ready'), runner: { online: false }, desktop: { binding: null }, binding_prompt: 'enable Bob' };
  const storage = new Map([['codex-collab-onboarding', JSON.stringify({ profile_id: value.id })]]);
  const p = await page((path) => path === '/api/overview' ? { profiles: [value] } : value, storage);
  assert.equal(p.element('profile-start').hidden, false);
  assert.equal(p.element('binding').hidden, true);
  assert.equal(p.element('profile-done').hidden, true);
  assert.equal(p.element('polling-help').hidden, true);
  assert.match(p.element('next-step').textContent, /启动机器人连接/);
});

test('known projects and existing connections are selectable without typing paths', async () => {
  const p = await page((path) => path === '/api/overview' ? { profiles: [], defaults: { repo: '/fixture/alice', projects: ['/fixture/alice', '/fixture/bob'], configs: [{ agent_id: 'alice', repo: '/fixture/alice', config_path: '/private/alice-peer.json' }] } } : assert.fail(path));
  assert.deepEqual(p.element('admin-project-choice').children.map((option) => option.value), ['/fixture/alice', '/fixture/bob', '']);
  assert.equal(p.element('admin-existing-repo').hidden, true);
  p.element('admin-project-choice').value = '/fixture/bob'; p.element('admin-project-choice').onchange();
  assert.equal(p.element('admin-form').elements.repo.value, '/fixture/bob');
  p.element('admin-project-choice').value = ''; p.element('admin-project-choice').onchange();
  assert.equal(p.element('admin-existing-repo').hidden, false);
  assert.equal(p.element('existing-config-path').value, '/private/alice-peer.json');
  assert.equal(p.element('existing-config-manual').hidden, true);
  p.element('existing-config-choice').value = ''; p.element('existing-config-choice').onchange();
  assert.equal(p.element('existing-config-manual').hidden, false);
  assert.equal(p.element('existing-config-path').value, '');
});
