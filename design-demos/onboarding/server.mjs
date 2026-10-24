import http from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
const server = http.createServer(async (request, response) => {
  const route = routes[new URL(request.url, 'http://localhost').pathname];
  if (!route) { response.writeHead(404); response.end(); return; }
  try {
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(await readFile(new URL(route[0], import.meta.url)));
  } catch { response.writeHead(500); response.end('Unable to load demo'); }
});
server.listen(Number(process.env.DEMO_PORT || 0), '127.0.0.1', () => console.log(`DEMO_URL=http://127.0.0.1:${server.address().port}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
