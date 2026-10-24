import { createPublicKey } from 'node:crypto';
import { basename, join } from 'node:path';
import { digest, readPrivateJson } from '../../packages/peer/config.mjs';
import { remoteIdentity, teamBaseBranch } from '../../packages/peer/repository.mjs';
import { readRegistry, validateHistory } from '../../packages/peer/registry.mjs';
import { SetupError } from './errors.mjs';

export function projectId(state) {
  return digest(state.remote && state.root_hash
    ? { repository: remoteIdentity(state.remote), root: state.root_hash }
    : { profile: state.id });
}
export function groupProjects(states) {
  const groups = new Map();
  for (const state of states) {
    if (state.phase === 'removed') continue;
    const id = projectId(state);
    if (!groups.has(id)) {
      const repository = state.remote ? remoteIdentity(state.remote) : '';
      groups.set(id, { id, name: basename(repository || state.repo || '').replace(/\.git$/, '') || '协作项目', repository, profile_ids: [], local_agent_count: 0 });
    }
    groups.get(id).profile_ids.push(state.id);
  }
  for (const group of groups.values()) {
    group.profile_ids.sort();
    group.local_agent_count = new Set(states.filter((state) => group.profile_ids.includes(state.id)).map((state) => state.agent_id)).size;
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

// Project navigation aggregates local connections. It never creates a new team or
// changes the authorization of the existing per-agent operations.
export async function projectView(manager, id, { localOnly = false } = {}) {
  const states = await manager.localStates();
  const project = groupProjects(states).find((value) => value.id === id);
  if (!project) throw new SetupError('未找到这个项目，请从“我的项目”重新打开。');
  const local = states.filter((state) => project.profile_ids.includes(state.id));
  const candidates = local.filter((state) => state.phase === 'ready').sort((a, b) => (a.role === 'admin' ? 0 : 1) - (b.role === 'admin' ? 0 : 1));
  let team, synced = false;
  if (!localOnly) {
    for (const state of candidates) {
      try { team = (await manager.profileStore(state)).team; synced = true; break; }
      catch { /* Try another local connection without exposing Git/SDK errors. */ }
    }
  }
  if (!team) {
    let latest;
    const use = (history) => { if (history && (!latest || history.latest.version > latest.version)) latest = history.latest; };
    for (const state of [...candidates, ...local.filter((value) => value.phase !== 'ready')]) {
      try {
        const registry = await readRegistry(join(state.data_dir || join(manager.path(state.id), 'data'), 'peer-ledger'), state.root_hash);
        use(registry);
      } catch { /* The next source must also pass signature verification. */ }
      try {
        const history = state.bundle?.history || (state.genesis ? [state.genesis] : null);
        if (history) use(validateHistory(history, state.root_hash));
      } catch { /* Unverified membership never reaches the project roster. */ }
    }
    team = latest?.team;
  }
  const identities = new Map();
  for (const state of local) {
    try {
      const identity = await readPrivateJson(state.identity_path);
      identities.set(state.id, createPublicKey(identity.private_key).export({ type: 'spki', format: 'pem' }));
    } catch { /* Missing local identity is visible as a connection problem. */ }
  }
  const matching = (state, agent) => identities.get(state.id) && identities.get(state.id) === agent.public_key;
  const owners = new Set(local.flatMap((state) => {
    const agent = team?.agents[state.agent_id];
    return agent && matching(state, agent) && agent.wecom_userid ? [agent.wecom_userid] : [];
  }));
  const connections = new Map();
  for (const state of local) {
    let detail;
    try { detail = await manager.detail(state.id, { localOnly: true }); } catch { /* Keep broken local connections recoverable. */ }
    connections.set(state.id, { id: state.id, repo: state.repo, phase: state.phase, display_name: state.display_name || state.agent_id,
      has_error: !!state.last_error || state.phase === 'ready' && !detail,
      can_receive_tasks: detail?.can_receive_tasks === true, runner_online: detail?.runner?.online === true,
      bound: !!detail?.desktop?.binding, poll_recent: detail?.poll_recent === true });
  }
  const included = new Set();
  const agents = Object.entries(team?.agents || {}).map(([agentId, agent]) => {
    const own = local.filter((state) => state.agent_id === agentId && matching(state, agent));
    for (const state of own) included.add(state.id);
    return { agent_id: agentId, role: agent.role, capabilities: agent.capabilities, mine: own.length > 0 || !!agent.wecom_userid && owners.has(agent.wecom_userid),
      registered: true, connections: own.map((state) => connections.get(state.id)) };
  });
  for (const state of local) {
    if (included.has(state.id)) continue;
    agents.push({ agent_id: state.agent_id, role: state.role, capabilities: [], mine: true, registered: false,
      identity_conflict: !!team?.agents[state.agent_id], connections: [connections.get(state.id)] });
  }
  agents.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  const admin = candidates.find((state) => team?.agents[state.agent_id]?.role === 'admin' && matching(state, team.agents[state.agent_id]));
  return { ...project, agents, admin_profile_id: admin?.id || null, base_branch: team ? teamBaseBranch(team) : null,
    sync_status: synced ? 'synced' : team ? 'cached' : 'pending',
    sync_error: !localOnly && !synced && candidates.length > 0 ? '团队同步暂未成功，正在显示本机已验证的记录。请检查 Git 连接后刷新。' : null };
}
