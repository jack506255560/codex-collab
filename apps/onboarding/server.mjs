import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SetupError } from './errors.mjs';
import { SetupManager } from './manager.mjs';
const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function startSetupServer({ manager = new SetupManager(), port = 0 } = {}) {
  const token = randomBytes(32).toString('hex'); const cookieName = `collab_${randomBytes(8).toString('hex')}`; let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== new URL(origin).host) return json(403, { error: '本机访问地址无效。' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(fileURLToPath(new URL(`./web/${file}`, import.meta.url)))); return;
      }
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/json')) return json(403, { error: '请通过本机向导操作。' });
      if (req.headers.origin && req.headers.origin !== origin) return json(403, { error: '访问来源无效。' });
      let body = {};
      if (req.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 750000) { json(413, { error: '文件太大。' }); req.resume(); return; } chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
        catch { return json(400, { error: '请求格式无效。' }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/session') {
        if (!same(body.token, token)) return json(401, { error: '请从终端重新打开向导链接。' });
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`); return json(200, { ok: true });
      }
      const session = (req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!same(session, token)) return json(401, { error: '请从终端重新打开向导链接。' });
      if (req.method === 'GET' && url.pathname === '/api/overview') return json(200, await manager.overview());
      if (req.method === 'GET' && url.pathname === '/api/discovery') return json(200, manager.discovery.view(url.searchParams.get('id')));
      if (req.method === 'GET' && url.pathname === '/api/profile') return json(200, await manager.exclusive(() => manager.detail(url.searchParams.get('id'), { localOnly: url.searchParams.get('local') === '1' })));
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const value = await manager.exclusive(() => manager.exportedBundle(url.searchParams.get('id'), url.searchParams.get('invite')));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${value.filename}"` }); res.end(value.content); return;
      }
      const actions = { discovery: () => manager.beginDiscovery(body), admin: () => manager.createAdmin(body), import: () => manager.importBundle(body), existing: () => manager.importExisting(body), verify: () => manager.verifyMember(body), resume: () => manager.resume(body.id), issue: () => manager.issueBundle(body), approve: () => manager.approve(body), runner: () => manager.runner(body), 'review-rules': () => manager.setReviewRules(body) };
      const key = url.pathname.replace('/api/', ''); const action = Object.hasOwn(actions, key) ? actions[key] : null;
      if (req.method === 'POST' && url.pathname.startsWith('/api/') && action) return json(200, await manager.exclusive(action));
      return json(404, { error: '操作不存在。' });
    } catch (error) {
      // Tool/SDK/Git exceptions may include credentials or private input: do not reflect them.
      const safe = error instanceof SetupError ? error.message : '操作未完成。请检查本机 Git 权限、文件和机器人连接，然后重试。';
      json(400, { error: safe });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: `${origin}/#${token}`, close: async () => { manager.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
