import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { startSetupServer } from '../server.mjs';
test('wizard APIs require local Host, matching Origin and personal cookie, reject malformed data and redact errors', async () => {
  let closed = false;
  const manager = { close() { closed = true; }, exclusive(fn) { return fn(); }, overview: async () => ({ profiles: [] }), beginDiscovery: async () => { throw new Error('credentials SECRET'); } };
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
    const failure = await post('discovery', {}, headers); assert.equal(failure.status, 400); assert.doesNotMatch(await failure.text(), /SECRET|credentials/);
    assert.equal((await post('constructor', {}, headers)).status, 404);
    assert.equal((await post('discovery', { content: 'x'.repeat(760000) }, headers)).status, 413);
    const page = await fetch(app.origin); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.match(await page.text(), /管理员初始化/);
  } finally { await app.close(); }
  assert.equal(closed, true);
});
