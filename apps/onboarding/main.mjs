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
import { alive } from '../peer/process.mjs';
const entry = fileURLToPath(import.meta.url);
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
    await lock.writeFile(JSON.stringify({ pid: process.pid, url: app.url, started_at: new Date().toISOString() }) + '\n'); await lock.close();
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
export async function runLocalSetup({ open = true, home = workspaceHome(), cwd = process.cwd(), foreground = false, startup = true } = {}) {
  home = resolve(home); await savePrivate(join(home, 'context.json'), { cwd: resolve(cwd) });
  let state = await serviceState(home);
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
