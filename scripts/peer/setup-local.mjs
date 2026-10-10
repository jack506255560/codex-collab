import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, generateIdentity, validateTeam } from '../../packages/peer/config.mjs';
import { readPeerConfig } from '../../apps/peer/runtime.mjs';

const tools = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inside = (parent, child) => { const rel = relative(parent, child); return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
const privateJson = (dest, value) => writeFile(dest, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

export async function setupLocal({ demo, out = join(homedir(), '.codex-collab-peer-test'), ownerUserId, mode = 'desktop', wecomFrom }) {
  if (!demo || !isAbsolute(demo) || !isAbsolute(out) || !['desktop', 'automatic', 'desktop-poll'].includes(mode)) throw new Error('absolute demo/output paths and mode desktop|automatic|desktop-poll required');
  if (ownerUserId !== undefined && (typeof ownerUserId !== 'string' || !ownerUserId.trim() || ownerUserId.length > 200)) throw new Error('invalid owner userid');
  // Explicitly reuse only local bot settings; never copy signing keys or shared task history.
  const reused = {};
  if (wecomFrom !== undefined) {
    if (!['automatic', 'desktop-poll'].includes(mode) || !isAbsolute(wecomFrom)) throw new Error('wecomFrom requires automatic mode or desktop-poll mode and an absolute private directory');
    const oldTeams = [];
    for (const id of ['alice', 'bob']) {
      const { config, team } = await readPeerConfig(join(wecomFrom, `${id}-peer.json`));
      if (config.agent_id !== id || !config.wecom) throw new Error('source directory needs configured Alice and Bob bots');
      oldTeams.push(team);
      const { bot_id, secret, chat_ids } = config.wecom;
      reused[id] = { wecom: { bot_id, secret, chat_ids }, ...(config.codex_home ? { codex_home: config.codex_home } : {}) };
    }
    if (digest(oldTeams[0]) !== digest(oldTeams[1])) throw new Error('source agents must share one pinned team policy');
    if (reused.alice.wecom.bot_id === reused.bob.wecom.bot_id) throw new Error('Alice and Bob must use distinct bot IDs');
    ownerUserId ||= oldTeams[0].agents.alice.wecom_userid;
    if (!ownerUserId) throw new Error('source Alice bot needs a pinned owner');
  }
  if (ownerUserId !== undefined && (typeof ownerUserId !== 'string' || !ownerUserId.trim() || ownerUserId.length > 200)) throw new Error('invalid owner userid');
  const source = await realpath(demo);
  const root = join(await realpath(dirname(resolve(out))), basename(resolve(out)));
  if (inside(source, root) || inside(await realpath(tools), root)) throw new Error('keep the private test directory outside both source repositories');
  git('-C', source, 'rev-parse', '--verify', 'refs/heads/main^{commit}');
  // Exclusive directory creation prevents rerunning over existing keys or task state.
  await mkdir(root, { mode: 0o700 });
  const origin = join(root, 'origin.git');
  git('clone', '--bare', '--no-local', '--single-branch', '--branch', 'main', source, origin);
  git('-C', origin, 'config', '--remove-section', 'remote.origin');
  const identities = Object.fromEntries(['alice', 'bob'].map((id) => [id, generateIdentity()]));
  const team = validateTeam({ schema_version: 2, repo: 'local/codex-collab-demo', reviewer: 'alice', default_route: 'frontend',
    agents: Object.fromEntries(Object.entries(identities).map(([id, keys]) => [id, { role: id === 'alice' ? 'admin' : 'member', capabilities: ['frontend', 'backend'], max_concurrent_tasks: 1, public_key: keys.public_key, ...(id === 'alice' && ownerUserId ? { wecom_userid: ownerUserId.trim() } : {}) }])),
    routes: mode !== 'desktop' ? { frontend: ['alice', 'bob'], backend: ['bob', 'alice'] } : { frontend: ['bob'], backend: ['bob'] }, policy: { claim_timeout_ms: mode === 'desktop-poll' ? 180000 : 60000, lease_ms: mode === 'desktop-poll' ? 900000 : 180000, clock_skew_ms: 5000, max_attempts: 3 } });
  const teamPath = join(root, 'team.json');
  await writeFile(teamPath, JSON.stringify(team, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const skillTemplate = await readFile(join(tools, mode === 'desktop-poll' ? 'packages/codex-kit/templates/.agents/skills/team-collab-desktop/SKILL.md' : 'packages/codex-kit/templates/.agents/skills/team-collab/SKILL.md'), 'utf8');
  const configs = {};
  const repos = {};
  for (const id of ['alice', 'bob']) {
    const repo = join(root, `${id}-repo`); const dataDir = join(root, `${id}-data`);
    git('clone', '--no-local', origin, repo);
    git('-C', repo, 'config', 'user.name', `Collab local ${id}`);
    git('-C', repo, 'config', 'user.email', `${id}@collab-test.invalid`);
    await mkdir(dataDir, { mode: 0o700 });
    await privateJson(join(root, `${id}.private.json`), { agent_id: id, private_key: identities[id].private_key });
    const configPath = join(root, `${id}-peer.json`);
    await privateJson(configPath, { schema_version: 2, agent_id: id, repo, data_dir: dataDir, team_file: teamPath, private_key: identities[id].private_key, test_argv: ['sh', 'test.sh'], auto_execute: mode === 'automatic', ...(mode === 'desktop-poll' ? { execution_mode: 'desktop_poll' } : {}), ...(reused[id]?.codex_home ? { codex_home: reused[id].codex_home } : {}), ...(reused[id]?.wecom ? { wecom: { ...reused[id].wecom, commands_enabled: id === 'alice', ...(mode === 'desktop-poll' ? { execution_mode: 'desktop_poll' } : {}) } } : {}) });
    const codexDir = join(repo, '.codex'); await mkdir(codexDir, { recursive: true, mode: 0o700 });
    await writeFile(join(codexDir, 'config.toml'), `[mcp_servers.team-collab-${id}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(tools, 'apps/peer/mcp-main.mjs'))}, ${JSON.stringify(configPath)}]\n`, { mode: 0o600, flag: 'wx' });
    const skillName = mode === 'desktop-poll' ? 'team-collab-desktop' : 'team-collab-peer';
    const skillDir = join(repo, '.agents', 'skills', skillName);
    await mkdir(join(skillDir, 'references'), { recursive: true, mode: 0o700 });
    await writeFile(join(skillDir, 'SKILL.md'), mode === 'desktop-poll' ? skillTemplate : skillTemplate.replace('name: team-collab\n', 'name: team-collab-peer\n') + '\nFor this local peer test, read [the peer protocol](references/peer.md), not legacy central-service instructions.\n', { flag: 'wx', mode: 0o600 });
    await writeFile(join(skillDir, 'references', 'peer.md'), await readFile(join(tools, 'docs/peer.md')), { flag: 'wx', mode: 0o600 });
    const excludePath = join(repo, '.git', 'info', 'exclude');
    const exclude = await readFile(excludePath, 'utf8');
    await writeFile(excludePath, exclude + `\n/.codex/config.toml\n/.agents/skills/${skillName}/\n/.codex-collab-worktrees/\n`);
    configs[id] = configPath; repos[id] = repo;
  }
  const result = { mode, root, shared_origin: origin, repos, configs, starts_processes: false, modifies_cc_switch: false, github_pushes: false, alice_owner_configured: !!ownerUserId, bob_bot_mode: mode === 'desktop-poll' ? 'commands disabled; bound desktop heartbeat executes tasks' : 'commands disabled; task execution depends on auto_execute', wecom_reused: !!wecomFrom, must_stop_previous_bot_connections: !!wecomFrom };
  await privateJson(join(root, 'local-test.json'), result);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = { ownerUserId: process.env.WECOM_OWNER_USERID };
    const flags = { '--demo': 'demo', '--out': 'out', '--mode': 'mode', '--wecom-from': 'wecomFrom' };
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      if (!flags[args[i]] || !args[i + 1]) throw new Error('usage: node scripts/peer/setup-local.mjs --demo /abs/demo [--out /abs/new-directory] [--mode desktop|automatic|desktop-poll] [--wecom-from /abs/existing-private-directory]; optionally set WECOM_OWNER_USERID before initialization');
      options[flags[args[i]]] = args[i + 1];
    }
    console.log(JSON.stringify(await setupLocal(options), null, 2));
  } catch (error) {
    console.error(error.code === 'EEXIST' ? 'Test directory already exists; use a new --out directory. Existing keys and tasks were not overwritten.' : 'Local setup failed; check arguments, local main branch, filesystem access and Git. No GitHub operation is performed.');
    process.exitCode = 1;
  }
}
