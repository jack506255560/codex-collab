import { isAbsolute, resolve } from 'node:path';
import { SetupManager } from './manager.mjs';
import { selectProfile, workspaceHome, profiles } from './workspace.mjs';
import { configureStartup, startupStatus } from './startup.mjs';
import { serviceState } from './main.mjs';

// Preserve the original explicit peer.json interface for scripts and advanced users.
export async function resolveCommand(args, { home = workspaceHome(), cwd = process.cwd() } = {}) {
  const [command, ...input] = args;
  let selector; const rest = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '--profile') { if (!input[i + 1]) throw new Error('--profile 需要项目 ID 或 Agent ID。'); selector = input[++i]; }
    else rest.push(input[i]);
  }
  if (rest[0] && (isAbsolute(rest[0]) || rest[0].endsWith('.json'))) return { command, configPath: resolve(rest.shift()), args: rest };
  const profile = await selectProfile({ home, cwd, selector });
  return { command, configPath: profile.config_path, profile, args: rest };
}
export async function workspaceCommand(args, { home = workspaceHome() } = {}) {
  if (args[0] === 'projects') {
    console.log(JSON.stringify((await profiles(home)).map(({ id, agent_id, repo, phase }) => ({ id, agent_id, repo, phase })), null, 2)); return true;
  }
  if (args[0] === 'autostart') {
    if (!['on', 'off', 'status'].includes(args[1])) throw new Error('usage: codex-collab autostart on|off|status');
    console.log(JSON.stringify(args[1] === 'status' ? await startupStatus(home) : await configureStartup({ home, enabled: args[1] === 'on' }), null, 2)); return true;
  }
  if (args[0] === 'service-status') {
    const state = await serviceState(home);
    console.log(JSON.stringify({ online: !!state, pid: state?.pid || null, startup: await startupStatus(home) }, null, 2)); return true;
  }
  return false;
}
export async function guidedCommand(resolved, { home = workspaceHome() } = {}) {
  if (resolved.command === 'repair' && !resolved.profile) {
    const { refreshProject } = await import('../../scripts/peer/refresh-project.mjs');
    console.log(JSON.stringify(await refreshProject({ configPath: resolved.configPath }), null, 2)); return true;
  }
  if (!['doctor', 'repair'].includes(resolved.command) || !resolved.profile) return false;
  const manager = new SetupManager({ home });
  try {
    const value = resolved.command === 'repair' ? await manager.repair({ id: resolved.profile.id }) : await manager.diagnostics({ id: resolved.profile.id });
    console.log(JSON.stringify(value, null, 2));
    if (resolved.command === 'doctor' && value.checks.some((check) => !check.ok)) process.exitCode = 1;
  } finally { manager.close(); }
  return true;
}
