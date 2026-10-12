import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { makeSigner, readPrivateJson, validateTeam } from '../../packages/peer/config.mjs';
import { PeerGitStore } from '../../packages/peer/store.mjs';
import { PeerService } from '../../packages/peer/service.mjs';
export async function readPeerConfig(path) {
  if (!path) throw new Error('provide --config /absolute/path/to/private-peer.json');
  const config = await readPrivateJson(resolve(path));
  if (config.schema_version !== 2 || ![config.repo, config.data_dir, config.team_file].every((p) => typeof p === 'string' && isAbsolute(p)) || typeof config.agent_id !== 'string') throw new Error('peer config needs v2 and absolute repo/data_dir/team_file paths');
  const team = validateTeam(JSON.parse(await readFile(config.team_file, 'utf8')));
  if (config.codex_home !== undefined && (typeof config.codex_home !== 'string' || !isAbsolute(config.codex_home))) throw new Error('codex_home must be an absolute path');
  if (config.auto_execute !== undefined && typeof config.auto_execute !== 'boolean') throw new Error('auto_execute must be a boolean');
  if (config.execution_mode !== undefined && !['automatic', 'desktop', 'desktop_poll'].includes(config.execution_mode)) throw new Error('invalid configured execution_mode');
  if (config.execution_mode === 'desktop_poll' && config.auto_execute !== false) throw new Error('desktop_poll requires auto_execute=false to prevent SDK execution');
  if (config.wecom?.execution_mode !== undefined && !['automatic', 'desktop_poll'].includes(config.wecom.execution_mode)) throw new Error('invalid WeCom execution_mode');
  if (config.wecom && (typeof config.wecom.bot_id !== 'string' || !config.wecom.bot_id || typeof config.wecom.secret !== 'string' || !config.wecom.secret || !Array.isArray(config.wecom.chat_ids) || !config.wecom.chat_ids.length || config.wecom.chat_ids.some((id) => typeof id !== 'string' || !id) || config.wecom.commands_enabled !== undefined && typeof config.wecom.commands_enabled !== 'boolean' || config.wecom.commands_enabled !== false && !team.agents[config.agent_id]?.wecom_userid)) throw new Error('WeCom requires bot_id, secret, chat_ids and a pinned owner userid unless commands_enabled=false');
  if (config.wecom?.allow_admin_commands !== undefined && typeof config.wecom.allow_admin_commands !== 'boolean') throw new Error('allow_admin_commands must be boolean');
  if (config.wecom?.default_workflow !== undefined && (!Array.isArray(config.wecom.default_workflow) || !config.wecom.default_workflow.length || config.wecom.default_workflow.some((cap) => typeof cap !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(cap)))) throw new Error('default_workflow must contain capability IDs');
  if (config.team_registry_root !== undefined && !/^[a-f0-9]{64}$/.test(config.team_registry_root)) throw new Error('invalid team registry root');
  const testCommand = config.test_argv || ['sh', 'test.sh'];
  if (!Array.isArray(testCommand) || !testCommand.length || testCommand.some((v) => typeof v !== 'string' || !v)) throw new Error('test_argv must be a fixed argv array');
  makeSigner(team, config.agent_id, config.private_key);
  return { config, team };
}
export async function loadRuntime(path, options = {}) {
  const { config, team } = await readPeerConfig(path);
  const store = await new PeerGitStore({ registryRoot: config.team_registry_root, repo: config.repo, dataDir: config.data_dir, team, agentId: config.agent_id, privateKey: config.private_key, ...options }).init();
  return { config, team, store, service: new PeerService(store) };
}
