import { createServer } from 'node:http';
import { URL } from 'node:url';
import { handleMcpHttp } from './mcp.mjs';

const send = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 128 * 1024) throw Object.assign(new Error('request too large'), { status: 413 });
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

export function startHttp({ service, accounts, host = '127.0.0.1', port = 38765 }) {
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/health' && req.method === 'GET') return send(res, 200, { ok: true, service: 'codex-collab' });
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
      const user = bearer && accounts.token(bearer[1]);
      if (!user) return send(res, 401, { error: 'valid personal bearer token required' });
      if (pathname === '/mcp') return handleMcpHttp(req, res, service, user);
      if (pathname === '/api/tasks' && req.method === 'GET') return send(res, 200, await service.list());
      if (pathname === '/api/tasks' && req.method === 'POST') {
        const input = await readJson(req);
        return send(res, 201, await service.create(user, input, req.headers['idempotency-key']));
      }
      const match = /^\/api\/tasks\/([A-Z][A-Z0-9-]{1,63})(?:\/(assign|events|claim))?$/.exec(pathname);
      if (match && req.method === 'GET' && !match[2]) return send(res, 200, await service.read(match[1]));
      if (match && req.method === 'POST' && match[2] === 'assign') {
        const input = await readJson(req);
        return send(res, 200, await service.assign(user, match[1], input.assignee, req.headers['idempotency-key']));
      }
      if (match && req.method === 'POST' && match[2] === 'events') {
        const { expected_seq, ...payload } = await readJson(req);
        return send(res, 200, await service.report(user, match[1], payload, expected_seq, req.headers['idempotency-key']));
      }
      if (match && req.method === 'POST' && match[2] === 'claim') {
        const { expected_seq } = await readJson(req);
        return send(res, 200, await service.claim(user, match[1], expected_seq));
      }
      if (pathname === '/api/jobs/next' && req.method === 'GET') return send(res, 200, await service.nextJob(user));
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : /stale task revision|duplicate|invalid transition/.test(error.message) ? 409 : 500);
      if (status === 500) console.error('request failed:', error);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : error.message });
      else res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
