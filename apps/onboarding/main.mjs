import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { startSetupServer } from './server.mjs';
import { SetupManager } from './manager.mjs';
import { alive } from '../peer/process.mjs';
function openBrowser(url) {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  const child = spawn(command[0], command.slice(1), { stdio: 'ignore' }); child.on('error', () => {}); child.unref();
}
export async function runLocalSetup({ open = true, home = join(homedir(), '.config/codex-collab/workspace') } = {}) {
  home = resolve(home); await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'wizard.json'); let lock;
  try { lock = await (await import('node:fs/promises')).open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let previous; try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('本机向导正在初始化，请稍后重试。'); }
    if (alive(previous.pid)) { console.log(`本机向导已运行：${previous.url}`); if (open) openBrowser(previous.url); return; }
    await rm(path, { force: true }); return runLocalSetup({ open, home });
  }
  let app;
  try {
    app = await startSetupServer({ manager: new SetupManager({ home }) });
    await lock.writeFile(JSON.stringify({ pid: process.pid, url: app.url }) + '\n'); await lock.close();
    console.log(`Codex Collab 本机接入向导：${app.url}\n保持此终端运行。Ctrl-C 关闭向导；已启动的机器人 Runner 会继续运行。`);
    if (open) openBrowser(app.url);
    const stop = async () => { await app.close(); await rm(path, { force: true }); process.exit(0); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return app;
  } catch (error) { await lock.close().catch(() => {}); await rm(path, { force: true }); if (app) await app.close(); throw error; }
}
