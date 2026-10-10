#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { copyFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadRuntime, readPeerConfig } from '../../apps/peer/runtime.mjs';
import { alive, readRunnerLock } from '../../apps/peer/process.mjs';
import { git } from '../../packages/peer/store.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [command, configArg, ...args] = process.argv.slice(2);
if (!command || !configArg) throw new Error('usage: node scripts/peer/cli.mjs install|doctor|probe|start|stop|status|list|read|review|complete|reopen|desktop-status|desktop-unbind /abs/peer.json [task-id] [decision/reason]');
const configPath = resolve(configArg);
const { config } = await readPeerConfig(configPath);
const pidPath = join(config.data_dir, 'runner.pid.json');
async function running() {
  const state = await readRunnerLock(pidPath);
  return state && alive(state.pid) ? state : null;
}

switch (command) {
  case 'probe': {
    try {
      const { probeProvider } = await import('../../apps/peer/provider.mjs');
      console.log(JSON.stringify(await probeProvider(config), null, 2));
    } catch {
      console.error('Codex SDK provider probe failed or timed out; check local model/auth/proxy configuration. No bot connection was opened.');
      process.exitCode = 1;
    }
    break;
  }
  case 'desktop-status': case 'desktop-unbind': {
    const { DesktopExecutor } = await import('../../apps/peer/desktop.mjs');
    const { service } = await loadRuntime(configPath);
    const desktop = new DesktopExecutor(service, config);
    console.log(JSON.stringify(command === 'desktop-status' ? await desktop.status() : await desktop.unbind(args[0]), null, 2));
    break;
  }
  case 'install': {
    const codexHome = resolve(config.codex_home || process.env.CODEX_HOME || join(homedir(), '.codex'));
    const skillName = config.execution_mode === 'desktop_poll' ? 'team-collab-desktop' : 'team-collab';
    const skill = join(codexHome, 'skills', skillName);
    await mkdir(skill, { recursive: true });
    await copyFile(join(root, `packages/codex-kit/templates/.agents/skills/${skillName}/SKILL.md`), join(skill, 'SKILL.md'));
    const example = join(codexHome, 'team-collab-peer.toml.example');
    const toml = `[mcp_servers.team-collab-peer]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, 'apps/peer/mcp-main.mjs'))}, ${JSON.stringify(configPath)}]\n`;
    await writeFile(example, '# Merge this block into the active Codex config; existing config and provider settings are unchanged.\n' + toml);
    console.log(JSON.stringify({ skill, mcp_example: example, config_modified: false }, null, 2));
    break;
  }
  case 'doctor': {
    const origin = await git(config.repo, 'remote', 'get-url', 'origin');
    const main = await git(config.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main');
    if (!main) throw new Error('shared origin needs a main branch');
    execFileSync('git', ['-C', config.repo, 'check-ref-format', 'refs/heads/agent-collab'], { stdio: 'ignore' });
    console.log(JSON.stringify({ identity: config.agent_id, auto_execute: config.auto_execute !== false, execution_session: config.execution_mode === 'desktop_poll' ? 'bound desktop heartbeat; adapter never launches SDK (check desktop-status and app heartbeat separately)' : 'new Runner-owned SDK thread; not an existing desktop conversation', config: 'valid; private key matches policy', git: 'shared origin and main readable', origin_configured: !!origin, wecom: config.wecom ? 'configured; live authentication not checked' : 'disabled', codex_provider: config.execution_mode === 'desktop_poll' ? 'uses the existing desktop conversation model; no SDK provider is launched by this adapter' : 'not tested; uses selected CODEX_HOME/provider configuration', test_argv: config.test_argv || ['sh', 'test.sh'] }, null, 2));
    break;
  }
  case 'start': {
    const current = await running();
    if (current) { console.log(`Runner already online (PID ${current.pid})`); break; }
    await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
    const logPath = join(config.data_dir, 'runner.log');
    const log = await open(logPath, 'a', 0o600);
    const child = spawn(process.execPath, [join(root, 'apps/peer/main.mjs'), configPath], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    child.unref(); await log.close();
    let state;
    for (let i = 0; i < 100; i++) { await delay(100); state = await running(); if (state || !alive(child.pid)) break; }
    if (!state) throw new Error(`Runner did not start; inspect private log ${logPath}`);
    console.log(`Runner started (PID ${state.pid}); private log: ${logPath}`);
    break;
  }
  case 'status': {
    const state = await running();
    let wecom = config.wecom ? 'not_authenticated' : 'disabled';
    if (state && config.wecom) {
      try {
        const health = JSON.parse(await readFile(join(config.data_dir, 'wecom-health.json'), 'utf8'));
        if (health.pid === state.pid && new Date(health.updated_at).getTime() >= new Date(state.started_at).getTime() && ['connecting', 'authenticated', 'reconnecting', 'disconnected', 'failed'].includes(health.status)) wecom = health.status;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    console.log(JSON.stringify({ identity: config.agent_id, execution_mode: config.execution_mode || 'legacy', auto_execute: config.auto_execute !== false, online: !!state, wecom, pid: state?.pid || null, log: join(config.data_dir, 'runner.log') }, null, 2));
    break;
  }
  case 'stop': {
    const state = await running();
    if (!state) { console.log('Runner offline'); break; }
    if (state.config !== configPath) throw new Error('PID configuration mismatch; refusing to signal');
    const ps = execFileSync('ps', ['-p', String(state.pid), '-o', 'command='], { encoding: 'utf8' });
    if (!ps.includes(join(root, 'apps/peer/main.mjs')) || !ps.includes(configPath)) throw new Error('PID does not belong to this peer Runner; refusing to signal');
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 300 && alive(state.pid); i++) await delay(100);
    if (alive(state.pid)) throw new Error('Runner still stopping; do not start a second bot connection');
    await rm(pidPath, { force: true }); console.log('Runner stopped');
    break;
  }
  case 'list': case 'read': case 'review': case 'complete': case 'reopen': {
    const { service } = await loadRuntime(configPath);
    let task;
    if (command === 'list') task = await service.list();
    if (command === 'read') task = await service.read(args[0]);
    if (command === 'review') {
      if (!['approved', 'changes_requested'].includes(args[1])) throw new Error('review task-id approved|changes_requested');
      task = await service.report(args[0], { type: 'reviewed', decision: args[1] });
    }
    if (command === 'complete') task = await service.report(args[0], { type: 'completed' });
    if (command === 'reopen') task = await service.report(args[0], { type: 'reopened', summary: args.slice(1).join(' ') });
    console.log(JSON.stringify(task, null, 2)); break;
  }
  default: throw new Error('unknown peer command');
}
