import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { startSetupServer } from '../server.mjs';
test('wizard APIs require local Host, matching Origin and personal cookie, reject malformed data and redact errors', async () => {
  let closed = false;
  const manager = { close() { closed = true; }, exclusive(fn) { return fn(); }, overview: async () => ({ profiles: [] }), setReviewRules: async (input) => ({ saved: input.expected_version }), beginDiscovery: async () => { throw new Error('credentials SECRET'); } };
  const app = await startSetupServer({ manager });
  const post = (path, body, extra = {}) => fetch(`${app.origin}/api/${path}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${app.origin}/api/overview`)).status, 401);
    assert.equal((await post('session', { token: app.token }, { Origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await post('session', { token: 'bad' })).status, 401);
    const badHost = await new Promise((resolve, reject) => { const req = http.request(app.origin + '/api/overview', { headers: { Host: 'evil.invalid' } }, (response) => { response.resume(); resolve(response.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(badHost, 403);
    const response = await post('session', { token: app.token }); assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
    const headers = { Cookie: cookie.split(';')[0] };
    assert.deepEqual(await (await fetch(`${app.origin}/api/overview`, { headers })).json(), { profiles: [] });
    assert.equal((await post('discovery', {}, { ...headers, 'Content-Type': 'text/plain' })).status, 403);
    assert.equal((await post('review-rules', { expected_version: 3 })).status, 401);
    assert.deepEqual(await (await post('review-rules', { expected_version: 3 }, headers)).json(), { saved: 3 });
    const failure = await post('discovery', {}, headers); assert.equal(failure.status, 400); assert.doesNotMatch(await failure.text(), /SECRET|credentials/);
    assert.equal((await post('constructor', {}, headers)).status, 404);
    assert.equal((await post('discovery', { content: 'x'.repeat(760000) }, headers)).status, 413);
    const page = await fetch(app.origin); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await page.text(), /连接我的机器人/);
  } finally { await app.close(); }
  assert.equal(closed, true);
});


test('own-agent endpoints enforce session and Origin before passing input to the manager', async () => {
  const calls = [];
  const manager = { close() {}, exclusive(fn) { return fn(); },
    async createOwnAgent(input) { calls.push(['create', input]); return { id: 'bob', phase: 'imported' }; },
    async resumeOwnAgent(input) { calls.push(['resume', input]); return { id: 'bob', phase: 'ready' }; } };
  const app = await startSetupServer({ manager });
  const post = (path, headers = {}) => fetch(`${app.origin}/api/${path}`, { method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ id: 'admin', invite_id: 'invite' }) });
  try {
    for (const path of ['own-agent', 'own-agent-resume']) assert.equal((await post(path)).status, 401);
    const session = await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) });
    const headers = { Cookie: session.headers.get('set-cookie').split(';')[0] };
    for (const path of ['own-agent', 'own-agent-resume']) assert.equal((await post(path, { ...headers, Origin: 'https://evil.invalid' })).status, 403);
    assert.equal(calls.length, 0);
    assert.deepEqual(await (await post('own-agent', headers)).json(), { id: 'bob', phase: 'imported' });
    assert.deepEqual(await (await post('own-agent-resume', headers)).json(), { id: 'bob', phase: 'ready' });
    assert.deepEqual(calls, [['create', { id: 'admin', invite_id: 'invite' }], ['resume', { id: 'admin', invite_id: 'invite' }]]);
  } finally { await app.close(); }
});

test('reset endpoints require browser session and exact Origin; private failures are sanitized', async () => {
  const calls = []; const manager = { close() {}, exclusive(fn) { return fn(); },
    async resetPreview(input) { calls.push(['preview', input]); return { preview_token: 'fixture-token' }; },
    async resetDiscovery(input) { calls.push(['discovery', { ...input, secret: '[redacted]' }]); throw new Error('PRIVATE-SECRET'); },
    async reset(input) { calls.push(['reset', input]); return { done: true }; },
    async resetCancel(input) { calls.push(['cancel', input]); return { cancelled: true }; } };
  const app = await startSetupServer({ manager }); const body = { id: 'profile', kind: 'project', preview_token: 'fixture-token', confirmation: 'alice' };
  const post = (path, headers = {}, input = body) => fetch(`${app.origin}/api/${path}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  try {
    for (const path of ['reset-preview', 'reset-discovery', 'reset', 'reset-cancel']) assert.equal((await post(path)).status, 401);
    const session = await post('session', {}, { token: app.token }); const headers = { Cookie: session.headers.get('set-cookie').split(';')[0] };
    for (const path of ['reset-preview', 'reset-discovery', 'reset', 'reset-cancel']) assert.equal((await post(path, { ...headers, Origin: 'https://evil.invalid' })).status, 403);
    assert.equal(calls.length, 0);
    assert.deepEqual(await (await post('reset-preview', headers)).json(), { preview_token: 'fixture-token' });
    assert.deepEqual(await (await post('reset', headers)).json(), { done: true });
    const failed = await post('reset-discovery', headers, { ...body, secret: 'PRIVATE-SECRET' }); assert.equal(failed.status, 400); assert.doesNotMatch(await failed.text(), /PRIVATE-SECRET/);
    assert.deepEqual(await (await post('reset-cancel', headers)).json(), { cancelled: true });
    assert.equal(calls.length, 4);
  } finally { await app.close(); }
});

test('guided routes require local session and Origin for project, draft, progress, batch and delivery operations', async () => {
  const calls = [], names = { 'project-check': 'prepareProject', 'admin-prepare': 'prepareAdmin', 'admin-complete': 'completeAdmin', 'admin-retry': 'adminDraft', 'inspect-invite': 'inspectBundle', progress: 'progress', 'issue-batch': 'issueBatch', delivery: 'delivery', diagnostics: 'diagnostics', repair: 'repair' };
  const manager = { close() {}, exclusive(fn) { return fn(); } };
  for (const method of Object.values(names)) manager[method] = async (input) => { calls.push([method, input]); return { ok: true }; };
  const app = await startSetupServer({ manager });
  const post = (path, headers = {}) => fetch(`${app.origin}/api/${path}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ id: 'fixture' }) });
  try {
    for (const path of Object.keys(names)) assert.equal((await post(path)).status, 401);
    assert.equal((await fetch(`${app.origin}/api/admin-draft?id=fixture`)).status, 401);
    const session = await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) });
    const Cookie = session.headers.get('set-cookie').split(';')[0];
    for (const path of Object.keys(names)) assert.equal((await post(path, { Cookie, Origin: 'https://evil.invalid' })).status, 403);
    assert.equal(calls.length, 0);
    for (const path of Object.keys(names)) assert.equal((await post(path, { Cookie })).status, 200);
    assert.equal((await fetch(`${app.origin}/api/admin-draft?id=fixture`, { headers: { Cookie } })).status, 200);
    assert.equal(calls.length, Object.keys(names).length + 1);
  } finally { await app.close(); }
});

test('reissue endpoint requires local authenticated browser and hides unexpected credential errors', async () => {
  const calls = [];
  const manager = { close() {}, exclusive(fn) { return fn(); }, async reissueBundle(input) {
    calls.push(input); if (input.secret === 'unsafe-failure-secret') throw new Error('SDK echoed unsafe-failure-secret');
    return { invite_id: 'replacement' };
  } };
  const app = await startSetupServer({ manager });
  const post = (path, input, headers = {}) => fetch(`${app.origin}/api/${path}`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  try {
    const input = { id: 'admin', invite_id: 'old', secret: 'fixture-secret' };
    assert.equal((await post('reissue-invite', input)).status, 401); assert.equal(calls.length, 0);
    const login = await post('session', { token: app.token }); const headers = { Cookie: login.headers.get('set-cookie').split(';')[0] };
    assert.equal((await post('reissue-invite', input, { ...headers, Origin: 'https://evil.invalid' })).status, 403); assert.equal(calls.length, 0);
    assert.deepEqual(await (await post('reissue-invite', input, headers)).json(), { invite_id: 'replacement' });
    assert.deepEqual(calls[0], input);
    const failed = await post('reissue-invite', { ...input, secret: 'unsafe-failure-secret' }, headers);
    assert.equal(failed.status, 400); assert.doesNotMatch(await failed.text(), /unsafe-failure-secret|SDK/);
  } finally { await app.close(); }
});

test('project read endpoint requires a browser session and passes the local-only option without permitting writes', async () => {
  const calls = [], manager = { close() {}, exclusive(fn) { return fn(); }, async project(id, options) { calls.push([id, options]); return { id, agents: [] }; } };
  const app = await startSetupServer({ manager });
  try {
    assert.equal((await fetch(`${app.origin}/api/project?id=fixture`)).status, 401); assert.equal(calls.length, 0);
    const session = await fetch(`${app.origin}/api/session`, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) });
    const headers = { Cookie: session.headers.get('set-cookie').split(';')[0] };
    assert.deepEqual(await (await fetch(`${app.origin}/api/project?id=fixture&local=1`, { headers })).json(), { id: 'fixture', agents: [] });
    assert.equal((await fetch(`${app.origin}/api/project?id=fixture`, { headers })).status, 200);
    assert.deepEqual(calls, [['fixture', { localOnly: true }], ['fixture', { localOnly: false }]]);
    assert.equal((await fetch(`${app.origin}/api/project`, { method: 'POST', headers: { ...headers, Origin: app.origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  } finally { await app.close(); }
});
