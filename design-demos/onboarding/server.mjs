import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let threeBuild;
try {
  threeBuild = new URL('.', pathToFileURL(require.resolve('three')));
} catch {
  console.error('Install demo dependencies first: npm install --prefix design-demos/onboarding');
  process.exit(1);
}
const routes = { '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/effects.js': ['effects.js', 'text/javascript; charset=utf-8'], '/effects.css': ['effects.css', 'text/css; charset=utf-8'], '/favicon.svg': ['../../apps/onboarding/web/favicon.svg', 'image/svg+xml'] };
routes['/vendor/three.module.js'] = [new URL('three.module.js', threeBuild), 'text/javascript; charset=utf-8'];
routes['/vendor/three.core.js'] = [new URL('three.core.js', threeBuild), 'text/javascript; charset=utf-8'];
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
