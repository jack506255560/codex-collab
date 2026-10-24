import { spawn } from 'node:child_process';
import { chmod, mkdir, open as openFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startSetupServer } from './server.mjs';
import { SetupManager, savePrivate } from './manager.mjs';
import { RunnerSupervisor } from './supervisor.mjs';
import { workspaceHome } from './workspace.mjs';
import { configureStartup, startupStatus } from './startup.mjs';
import { alive, acquireRunnerControl } from '../peer/process.mjs';
const entry = fileURLToPath(import.meta.url);
const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const runtime = { version, entry, node: process.execPath };
const sameRuntime = (state) => Object.entries(runtime).every(([key, value]) => state.runtime?.[key] === value);
function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), { stdio: 'ignore' }); child.on('error', () => {}); child.unref();
}
export async function serviceState(home) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const state = JSON.parse(await readFile(join(home, 'wizard.json'), 'utf8')); return alive(state.pid) ? state : null; }
    catch (error) { if (error.code === 'ENOENT') return null; if (!(error instanceof SyntaxError)) throw error; }
    await delay(50);
  }
  throw new Error('本机工作台正在初始化，请稍后重试。');
}
export async function runService({ home = workspaceHome() } = {}) {
  process.umask(0o077); home = resolve(home); await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'wizard.json'); let lock;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { lock = await openFile(path, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await serviceState(home)) return null;
      await rm(path, { force: true });
    }
  }
  if (!lock) throw new Error('无法取得本机工作台锁。');
  let app, timer, stopping = false;
  try {
    const manager = new SetupManager({ home });
    app = await startSetupServer({ manager });
    await lock.writeFile(JSON.stringify({ pid: process.pid, url: app.url, started_at: new Date().toISOString(), runtime }) + '\n'); await lock.close();
    const supervisor = new RunnerSupervisor(manager);
    const tick = async () => {
      try { await manager.exclusive(() => supervisor.tick()); } catch { /* Local diagnostics show missing/invalid profiles without logging secrets. */ }
      if (!stopping) timer = setTimeout(tick, 15000);
    };
    timer = setTimeout(tick, 1000);
    const stop = async () => {
      if (stopping) return; stopping = true; clearTimeout(timer);
      await app.close(); const state = await serviceState(home); if (state?.pid === process.pid) await rm(path, { force: true });
    };
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    return { ...app, stop };
  } catch (error) { await lock.close().catch(() => {}); await rm(path, { force: true }); if (app) await app.close(); throw error; }
}
async function stopOutdatedService(home, state) {
  // A private lock can outlive its process. Authenticate the loopback service
  // before signalling a legacy PID; never terminate an unrelated process.
  let verified = false;
  try {
    const url = new URL(state.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !/^#[a-f0-9]{64}$/.test(url.hash)) throw new Error();
    const response = await fetch(`${url.origin}/api/session`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: url.hash.slice(1) }),
    });
    verified = response.ok && (await response.json()).ok === true;
  } catch { /* Keep private service URLs and network errors out of diagnostics. */ }
  if (!verified) throw new Error('无法确认旧版向导服务的身份，请检查后台服务后重试。');
  const current = await serviceState(home);
  if (!current || current.pid !== state.pid || current.url !== state.url) return;
  try { process.kill(state.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 150; attempt++) {
    if (!alive(state.pid)) return;
    await delay(100);
  }
  throw new Error('旧版向导服务尚未退出，请稍后重新运行 codex-collab setup。');
}
export async function runLocalSetup({ open = true, home = workspaceHome(), cwd = process.cwd(), foreground = false, startup = true } = {}) {
  home = resolve(home); await mkdir(home, { recursive: true, mode: 0o700 });
  // Serialize launchers so two setup commands cannot both stop a service that
  // another launcher has just upgraded. Runner processes keep their own locks.
  const release = await acquireRunnerControl(join(home, 'launcher'), entry);
  try {
    await savePrivate(join(home, 'context.json'), { cwd: resolve(cwd) });
    return await launchLocalSetup({ open, home, foreground, startup });
  } finally { await release(); }
}
async function launchLocalSetup({ open, home, foreground, startup }) {
  let state = await serviceState(home);
  if (state && !sameRuntime(state)) {
    await stopOutdatedService(home, state);
    state = await serviceState(home);
    if (state && !sameRuntime(state)) throw new Error('向导服务正在更新，请稍后重新运行 codex-collab setup。');
    console.log('已更新本机向导服务。');
  }
  if (foreground) {
    if (state) { console.log(`本机工作台已运行：${state.url}`); if (open) openBrowser(state.url); return; }
    const app = await runService({ home }); if (app) { console.log(`Codex Collab 工作台：${app.url}`); if (open) openBrowser(app.url); } return app;
  }
  const previous = await startupStatus(home);
  let registered = startup ? previous : { enabled: false };
  if (startup && (previous.enabled || previous.kind == null && previous.supported && !previous.error)) registered = await configureStartup({ home, start: !state });
  if (!state) {
    state = await serviceState(home);
    if (!state && !registered.enabled) {
      const log = await openFile(join(home, 'service.log'), 'a', 0o600); await chmod(join(home, 'service.log'), 0o600);
      const child = spawn(process.execPath, [entry, '--home', home], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
      let error; child.on('error', () => { error = true; }); child.unref(); await log.close();
      for (let i = 0; i < 100 && !state && !error; i++) { await delay(100); state = await serviceState(home); }
    } else for (let i = 0; i < 100 && !state; i++) { await delay(100); state = await serviceState(home); }
  }
  if (!state) throw new Error(`本机后台工作台未启动，请检查 ${join(home, 'service.log')}，或运行 codex-collab setup --foreground。`);
  console.log(`Codex Collab 工作台：${state.url}\n后台服务已运行，可以关闭终端和浏览器。${registered.enabled ? '登录时将自动恢复已开启的连接。' : '登录自启未启用。'}`);
  if (registered.error) console.log(registered.error);
  if (open) openBrowser(state.url);
  return state;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--home') throw new Error('Internal service requires --home.');
  runService({ home: args[1] }).catch(() => { console.error('Codex Collab 后台服务启动失败，请运行 codex-collab setup --foreground 排查。'); process.exitCode = 1; });
}
