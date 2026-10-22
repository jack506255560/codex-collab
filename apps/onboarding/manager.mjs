import { defaultReviewRules } from '../../packages/peer/review.mjs';
import { SetupError } from './errors.mjs';
import { createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRunnerIntent, writeRunnerIntent } from '../peer/intent.mjs';
import { localDefaults, workspaceHome } from './workspace.mjs';
import { startupStatus } from './startup.mjs';
import { fileURLToPath } from 'node:url';
import { canonical, digest, generateIdentity, readPrivateJson, validateTeam } from '../../packages/peer/config.mjs';
import { PeerGitStore, git } from '../../packages/peer/store.mjs';
import { approveEnrollment, enrollmentRequest, invitationFile, invitationRecord, policyVersion, recordHash, registryPath, requestFile, validateEnrollment, validateHistory, validateInvitation, versionFile, readRegistry } from '../../packages/peer/registry.mjs';
import { attachProject, buildTeamPolicy, createMemberConfig, diagnosePeer, getOrCreateIdentityFiles } from '../../scripts/peer/onboarding.mjs';
import { installedProjectConfig, refreshProject } from '../../scripts/peer/refresh-project.mjs';
import { bindingPrompt, detailedBindingPrompt } from '../../scripts/peer/setup-desktop-project.mjs';
import { readPeerConfig, loadRuntime } from '../peer/runtime.mjs';
import { DesktopExecutor } from '../peer/desktop.mjs';
import { alive, readRunnerLock } from '../peer/process.mjs';
import { BotDiscovery } from './discovery.mjs';
import { ResetActions } from './reset.mjs';
import { encryptBundle, decryptBundle, remoteIdentity } from './bundle.mjs';
import { cloneRepository, commandArgv, memberFields, recommendTests, suggestedRepo } from './guided.mjs';
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || path !== '..' && !path.startsWith('../') && !isAbsolute(path); };
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function savePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path); await chmod(path, 0o600);
}
function testArgv(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32 || value.some((part) => typeof part !== 'string' || !part || part.length > 2000)) throw new SetupError('验证命令应是 JSON 字符串数组，例如 ["npm","test"]。');
  return value;
}
function capabilities(value) {
  const list = typeof value === 'string' ? value.split(/[\s,，]+/).filter(Boolean) : value;
  if (!Array.isArray(list) || !list.length || list.length > 16 || list.some((cap) => !idPattern.test(cap))) throw new SetupError('职责标签请使用英文、数字、下划线或连字符。');
  return [...new Set(list)];
}
function gitFailure(error) {
  const detail = `${error?.stderr || ''}\n${error?.message || ''}`.toLowerCase();
  if (error?.killed || error?.code === 'ETIMEDOUT' || /timed out|timeout/.test(detail)) {
    return new SetupError('Git 访问远程仓库超时，请检查网络或代理后重试。');
  }
  if (/authentication failed|could not read username|permission denied|access denied|repository not found|403|401/.test(detail)) {
    return new SetupError('无法访问远程仓库，请检查 GitHub 登录状态、仓库地址和读写权限。不要把 Token 或 Secret 填入向导。');
  }
  if (/could not resolve host|failed to connect|network is unreachable|connection refused|network failure/.test(detail)) {
    return new SetupError('无法连接远程仓库，请检查网络或代理后重试。');
  }
  return new SetupError('Git 无法读取远程仓库，请检查 origin 地址、Git 权限和网络后重试。');
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function mcpSection(text, serverName) {
  let active = false; const lines = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      active = line.trim() === `[mcp_servers.${serverName}]`;
      if (active) lines.push(line);
      continue;
    }
    if (active) lines.push(line);
  }
  return lines.join('\n');
}
function projectMcpConfigured(projectConfig, configPath, config) {
  const paths = [configPath];
  if (config.execution_mode === 'desktop_poll') paths.push(join(dirname(configPath), `${config.agent_id}-desktop-peer.json`));
  const section = mcpSection(projectConfig, `team-collab-${config.agent_id}`);
  return !/^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(section) && paths.some((path) => section.includes(JSON.stringify(path)));
}
async function ensureRepo(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new SetupError('请选择业务仓库的本机绝对路径。');
  let repo;
  try { repo = await realpath(path); } catch { throw new SetupError('请选择存在的业务仓库目录。'); }
  try {
    if (await git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new SetupError('请选择 Git 仓库根目录。');
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('请选择 Git 仓库根目录。');
  }
  let remote;
  try { remote = await git(repo, 'remote', 'get-url', 'origin'); }
  catch (error) {
    const detail = `${error?.stderr || ''}\n${error?.message || ''}`.toLowerCase();
    if (/no such remote|does not appear to be a git repository/.test(detail)) throw new SetupError('该目录没有名为 origin 的远程仓库，请先配置 GitHub origin。');
    throw gitFailure(error);
  }
  let main;
  try { main = await git(repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main'); }
  catch (error) { throw gitFailure(error); }
  if (!main) {
    let heads;
    try { heads = await git(repo, 'ls-remote', '--heads', 'origin'); }
    catch (error) { throw gitFailure(error); }
    if (!heads) throw new SetupError(`远程仓库为空，未找到 origin/main。请先在终端执行：\ngit -C ${shellQuote(repo)} push -u origin main`);
    throw new SetupError(`远程仓库可访问，但没有 main 分支。请先将本地 main 推送到 origin：\ngit -C ${shellQuote(repo)} push -u origin main`);
  }
  return { repo, remote };
}
function validateBundle(value) {
  if (!value || value.schema_version !== 1 || value.kind !== 'codex-collab-invite' || typeof value.remote !== 'string' || !value.remote || !value.history || !value.invitation || !value.wecom || typeof value.wecom.secret !== 'string' || !value.wecom.secret) throw new SetupError('接入包格式无效。');
  const history = validateHistory(value.history, value.root_hash);
  validateInvitation(value.invitation, history); testArgv(value.test_argv);
  if (Date.now() > Date.parse(value.invitation.expires_at)) throw new SetupError('接入包已过期，请管理员重新生成。');
  const claim = createPublicKey(value.claim_private_key).export({ type: 'spki', format: 'pem' });
  if (claim !== value.invitation.claim_public_key || value.wecom.bot_id !== value.invitation.bot_id) throw new SetupError('接入包验证失败。');
  return { bundle: value, history };
}

export class SetupManager {
  constructor({ home = workspaceHome(), discovery = new BotDiscovery(), runCli } = {}) {
    this.home = resolve(home); this.discovery = discovery; this.queue = Promise.resolve(); this.resets = new ResetActions(this);
    this.runCli = runCli || (async (command, config) => {
      try {
        const result = await promisify(execFile)(process.execPath, [join(packageRoot, 'scripts/peer/cli.mjs'), command, config], { timeout: 35000, maxBuffer: 200000 });
        return result.stdout.trim();
      } catch { throw new Error(`本机 ${command} 操作未完成，请检查项目 Git 权限或 Runner 日志。`); }
    });
  }
  async exclusive(fn) { const action = this.queue.then(fn); this.queue = action.catch(() => {}); return action; }
  path(id) { if (!uuidPattern.test(id || '')) throw new SetupError('无效项目标识。'); return join(this.home, 'profiles', id); }
  async state(id) { return readPrivateJson(join(this.path(id), 'setup.json')); }
  async save(state) { return savePrivate(join(this.path(state.id), 'setup.json'), state); }
  async profileStore(state, { enrollmentOnly = false } = {}) {
    const identity = await readPrivateJson(state.identity_path);
    const initial = state.bootstrap_team;
    return new PeerGitStore({ repo: state.repo, dataDir: state.data_dir || join(this.path(state.id), 'data'), team: initial,
      agentId: state.agent_id, privateKey: identity.private_key, registryRoot: state.root_hash, enrollmentOnly }).init();
  }
  async overview() {
    await mkdir(join(this.home, 'profiles'), { recursive: true, mode: 0o700 });
    const entries = (await readdir(join(this.home, 'profiles'))).filter((id) => uuidPattern.test(id));
    const profiles = [], removed_profiles = [];
    for (const id of entries) {
      const state = await this.state(id);
      (state.phase === 'removed' ? removed_profiles : profiles).push({ id, agent_id: state.agent_id, role: state.role, display_name: state.display_name || state.agent_id, repo: state.repo, phase: state.phase, error: state.last_error || null });
    }
    const drafts = [];
    for (const file of await readdir(join(this.home, 'drafts')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      if (!uuidPattern.test(file.replace(/\.json$/, ''))) continue;
      const draft = await readPrivateJson(join(this.home, 'drafts', file));
      if (!draft.profile_id) drafts.push({ id: draft.id, agent_id: draft.input.agent_id, display_name: draft.input.display_name, repo: draft.input.repo });
    }
    let context = {}; try { context = await readPrivateJson(join(this.home, 'context.json')); } catch {}
    return { profiles, removed_profiles, drafts, defaults: await localDefaults(context.cwd || this.home), startup: await startupStatus(this.home) };
  }
  async checkBotAvailable(botId) {
    for (const profile of (await this.overview()).profiles) {
      const state = await this.state(profile.id);
      const lock = await readRunnerLock(join(state.data_dir || join(this.path(profile.id), 'data'), 'runner.pid.json'));
      if (state.wecom?.bot_id === botId && lock && alive(lock.pid)) throw new SetupError('此机器人已有本机 Runner 连接，请先在项目状态中停止机器人连接。');
    }
  }
  async beginDiscovery(input) {
    let credentials = input;
    if (input.profile_id) {
      const state = await this.state(input.profile_id);
      if (state.discovery_id && !input.reconnect) { try { const session = this.discovery.view(state.discovery_id); if (!['failed', 'expired', 'disconnected'].includes(session.status)) return session; } catch {} }
      if (!state.bundle) throw new SetupError('此项目没有待验证的接入包。');
      credentials = { ...state.bundle.wecom, chat_ids: state.bundle.invitation.chat_ids };
    }
    await this.checkBotAvailable(credentials.bot_id);
    if (input.repo) {
      const { repo } = await ensureRepo(input.repo);
      const toml = await readFile(join(repo, '.codex/config.toml'), 'utf8').catch(() => '');
      for (const match of toml.matchAll(/"((?:[^"\\]|\\.)*\.json)"/g)) {
        try {
          const path = JSON.parse(match[0]); const { config } = await readPeerConfig(path);
          const lock = await readRunnerLock(join(config.data_dir, 'runner.pid.json'));
          if (config.wecom?.bot_id === credentials.bot_id && lock && alive(lock.pid)) throw new SetupError('此项目原有机器人仍在连接，请先停止原 Runner 或导入已有配置。');
        } catch (error) { if (error instanceof SetupError) throw error; }
      }
    }
    const session = this.discovery.begin(credentials);
    if (input.profile_id) { const state = await this.state(input.profile_id); state.discovery_id = session.id; await this.save(state); }
    return session;
  }
  async prepareProject(input) {
    const path = input.repo_mode === 'clone'
      ? await cloneRepository({ remote: input.remote, destination: input.destination || suggestedRepo(input.remote, memberFields({ ...input, display_name: input.display_name || input.agent_id || 'owner' }).agent_id), privateHome: this.home }) : input.repo;
    const selected = await ensureRepo(path);
    if (inside(selected.repo, this.home)) throw new SetupError('本机配置目录必须在业务仓库之外。');
    return { ...selected, tests: await recommendTests(selected.repo) };
  }
  draftPath(id) { if (!uuidPattern.test(id || '')) throw new SetupError('无效创建记录。'); return join(this.home, 'drafts', `${id}.json`); }
  async prepareAdmin(input) {
    const fields = memberFields(input);
    if (typeof input.bot_id !== 'string' || !input.bot_id.trim() || typeof input.secret !== 'string' || !input.secret.trim()) throw new SetupError('请填写机器人 Bot ID 和 Secret。');
    if (input.team_name != null && (typeof input.team_name !== 'string' || input.team_name.length > 80 || /[\x00-\x1f\x7f]/.test(input.team_name))) throw new SetupError('团队名称最多 80 个字符。');
    const argv = input.test_command ? commandArgv(input.test_command) : testArgv(input.test_argv);
    const selected = await this.prepareProject(input);
    for (const profile of (await this.overview()).profiles) if (profile.repo === selected.repo) throw new SetupError('这个 clone 已接入其他身份，请选择独立 clone。');
    const draft = { id: randomUUID(), input: { ...fields, repo: selected.repo, test_argv: argv, team_name: input.team_name?.trim() || null,
      bot_id: input.bot_id, secret: input.secret } };
    await savePrivate(this.draftPath(draft.id), draft);
    return this.adminDraft({ id: draft.id });
  }
  async adminDraft({ id, reconnect = false }) {
    const draft = await readPrivateJson(this.draftPath(id));
    if (draft.profile_id) return { profile: await this.detail(draft.profile_id, { localOnly: true }) };
    let session;
    if (draft.discovery_id && !reconnect) { try { session = this.discovery.view(draft.discovery_id); if (['failed', 'expired', 'disconnected'].includes(session.status)) session = null; } catch {} }
    if (!session) {
      session = await this.beginDiscovery({ bot_id: draft.input.bot_id, secret: draft.input.secret, repo: draft.input.repo });
      draft.discovery_id = session.id; await savePrivate(this.draftPath(id), draft);
    }
    return { ...session, draft_id: id, agent_id: draft.input.agent_id, repo: draft.input.repo };
  }
  async completeAdmin({ draft_id, discovery_id }) {
    const draft = await readPrivateJson(this.draftPath(draft_id));
    if (draft.profile_id) return this.detail(draft.profile_id, { localOnly: true });
    if (draft.discovery_id !== discovery_id) throw new SetupError('请使用当前创建流程的群验证码。');
    return this.createAdmin({ ...draft.input, discovery_id }, { onSaved: async (id) => {
      draft.profile_id = id; delete draft.input.secret; await savePrivate(this.draftPath(draft_id), draft);
    } });
  }
  async progress({ id, sync = false }) {
    const state = await this.state(id);
    if (['initializing', 'verified', 'waiting', 'configuring'].includes(state.phase) && !state.last_error) return this.resume(id);
    return this.detail(id, { localOnly: !sync || state.phase !== 'ready' });
  }
  async createAdmin(input, { onSaved } = {}) {
    const fields = memberFields(input), agentId = fields.agent_id;
    const caps = fields.capabilities; const argv = input.test_command ? commandArgv(input.test_command) : testArgv(input.test_argv || ['sh', 'test.sh']);
    const { repo, remote } = await ensureRepo(input.repo);
    if (inside(repo, this.home)) throw new SetupError('本机配置目录必须在业务仓库之外。');
    for (const profile of (await this.overview()).profiles) if (profile.repo === repo) throw new SetupError('这个 clone 已接入其他身份，请选择独立 clone。');
    const proof = this.discovery.consume(input.discovery_id);
    const id = randomUUID(); const directory = this.path(id);
    const identity = await getOrCreateIdentityFiles(agentId, join(this.home, 'identities'));
    const team = buildTeamPolicy({ repo: input.repo_id?.trim() || remote, reviewer: agentId, defaultRoute: caps[0],
      agents: [{ id: agentId, role: 'admin', capabilities: caps, publicKey: await readFile(identity.public_key_file, 'utf8'), wecomUserid: proof.userid }],
      routes: Object.fromEntries(caps.map((cap) => [cap, [agentId]])) });
    team.schema_version = 3; team.review_rules = defaultReviewRules(team.routes);
    const record = policyVersion(team, null, agentId, (await readPrivateJson(identity.private_key_file)).private_key);
    const state = { id, role: 'admin', agent_id: agentId, display_name: fields.display_name, team_name: input.team_name || null, repo, remote, identity_path: identity.private_key_file, bootstrap_team: team,
      root_hash: recordHash(record), genesis: record, test_argv: argv,
      wecom: { bot_id: proof.bot_id, secret: proof.secret, chat_ids: [proof.chatid], commands_enabled: true, allow_admin_commands: true }, phase: 'initializing' };
    await this.save(state);
    if (onSaved) await onSaved(id);
    return this.resume(id);
  }
  async importExisting({ config_path }) {
    if (typeof config_path !== 'string' || !isAbsolute(config_path)) throw new SetupError('请选择已有配置的完整路径。');
    const { config, team } = await readPeerConfig(config_path);
    if (config.execution_mode !== 'desktop_poll') throw new SetupError('目前向导导入需要已有 desktop_poll 配置。');
    for (const profile of (await this.overview()).profiles) if (profile.repo === config.repo) {
      const existing = await this.state(profile.id); if (existing.existing_config === resolve(config_path)) return this.resume(profile.id);
      throw new SetupError('该项目已导入。');
    }
    const lock = await readRunnerLock(join(config.data_dir, 'runner.pid.json'));
    if (lock && alive(lock.pid)) throw new SetupError('请先用原配置停止该机器人的 Runner，再导入；原有对话绑定会保留。');
    if (!config.wecom) throw new SetupError('已有配置需要包含企业微信机器人。');
    const identity = { schema_version: 1, agent_id: config.agent_id, private_key: config.private_key };
    const id = randomUUID(); const identityPath = join(this.path(id), 'identity.json');
    await savePrivate(identityPath, identity);
    let genesis, rootHash = config.team_registry_root;
    const store = await new PeerGitStore({ repo: config.repo, dataDir: config.data_dir, team, agentId: config.agent_id, privateKey: config.private_key, registryRoot: rootHash }).init();
    if (!rootHash) {
      const firstPath = join(store.checkout, '.agent-collab/team/versions/000001.json');
      if (await exists(firstPath)) {
        const first = JSON.parse(await readFile(firstPath, 'utf8'));
        if (digest(first.team) !== digest(team)) throw new SetupError('仓库团队根策略与本机已信任策略不一致，请联系管理员。');
        rootHash = recordHash(first); await readRegistry(store.checkout, rootHash);
      } else {
        if (team.agents[config.agent_id].role !== 'admin') throw new SetupError('请先由旧团队管理员导入，之后成员也可导入原配置。');
        genesis = policyVersion(team, null, config.agent_id, config.private_key); rootHash = recordHash(genesis);
        await store.registryTransaction(async () => {
          await store.listLocal();
          if (await exists(firstPath)) {
            if (canonical(JSON.parse(await readFile(firstPath, 'utf8'))) !== canonical(genesis)) throw new SetupError('仓库已有另一团队版本，请重新导入同步。');
            return { value: null };
          }
          return { files: [[versionFile(genesis), genesis]], value: null };
        });
      }
    }
    const state = { id, role: team.agents[config.agent_id].role, agent_id: config.agent_id, repo: config.repo,
      remote: await git(config.repo, 'remote', 'get-url', 'origin'), identity_path: identityPath, bootstrap_team: team, root_hash: rootHash,
      test_argv: config.test_argv || ['sh', 'test.sh'], wecom: config.wecom, phase: 'ready', existing_config: resolve(config_path), data_dir: config.data_dir, attached: true };
    await savePrivate(join(this.path(id), 'peer.json'), { ...config, team_registry_root: rootHash });
    // Existing MCP processes keep using this path and the same private desktop state.
    await savePrivate(resolve(config_path), { ...config, team_registry_root: rootHash });
    await this.save(state); await this.runCli('start', resolve(config_path)); return this.detail(id, { localOnly: true });
  }
  async refreshAttachment(state, configPath) {
    try {
      const installed = await installedProjectConfig({ repoPath: state.repo, agentId: state.agent_id, allowMissing: true });
      if (installed.missing) { await refreshProject({ configPath }); return; }
      const source = (await readPeerConfig(configPath)).config;
      const bound = (await readPeerConfig(installed.config_path)).config;
      if (bound.agent_id !== source.agent_id || bound.private_key !== source.private_key ||
          await realpath(bound.repo) !== await realpath(source.repo) || resolve(bound.data_dir) !== resolve(source.data_dir)) throw new SetupError('项目 MCP 使用其他身份或数据目录，请手动检查原绑定。');
      await refreshProject({ configPath: installed.config_path });
    } catch (error) { throw new SetupError(error.message); }
  }
  async resume(id) {
    const state = await this.state(id);
    const wasReady = state.phase === 'ready';
    if (state.phase === 'removed') throw new SetupError('该项目已移除，请从首页恢复接入。');
    try {
      if (state.role === 'admin' && state.phase === 'initializing') {
        const bootstrap = new PeerGitStore({ repo: state.repo, dataDir: join(this.path(id), 'data'), team: state.bootstrap_team, agentId: state.agent_id,
          privateKey: (await readPrivateJson(state.identity_path)).private_key });
        await bootstrap.init();
        await bootstrap.registryTransaction(async () => {
          const path = join(bootstrap.checkout, versionFile(state.genesis));
          if (await exists(path)) {
            if (canonical(JSON.parse(await readFile(path, 'utf8'))) !== canonical(state.genesis)) throw new SetupError('仓库已有另一团队，请导入该团队的接入包。');
            return { value: null };
          }
          await bootstrap.listLocal(); // Existing tasks must replay against this exact genesis policy before adoption.
          return { files: [[versionFile(state.genesis), state.genesis]], value: null };
        });
        state.phase = 'configuring'; await this.save(state);
      }
      if (state.role === 'member' && ['verified', 'waiting'].includes(state.phase)) {
        let store = await this.profileStore(state, { enrollmentOnly: true });
        if (store.registry.revoked_invites.has(state.bundle.invitation.invite_id)) throw new SetupError('这份接入包已被替换，请重新导入最新接入包并使用新密码。');
        if (state.phase === 'verified') {
          await store.registryTransaction(async (history) => {
            const invitation = JSON.parse(await readFile(join(store.checkout, invitationFile(state.request.invite_id)), 'utf8'));
            if (canonical(invitation) !== canonical(state.bundle.invitation)) throw new SetupError('仓库邀请与接入包不一致。');
            const approved = history.records.some((record) => record.enrollment?.invite_id === invitation.invite_id && record.enrollment.request_id === state.request.request_id)
              && history.latest.team.agents[state.agent_id]?.public_key === state.request.public_key;
            validateEnrollment(state.request, invitation, history, { allowExpired: approved });
            const path = requestFile(state.request.request_id);
            if (await exists(join(store.checkout, path))) {
              if (canonical(JSON.parse(await readFile(join(store.checkout, path), 'utf8'))) !== canonical(state.request)) throw new SetupError('入队申请内容冲突。');
              return { value: null };
            }
            return { files: [[path, state.request]], value: null };
          });
          state.phase = 'waiting'; await this.save(state);
        }
        if (!store.team.agents[state.agent_id] && state.own_admin_id) {
          const admin = await this.state(state.own_admin_id);
          const invite = state.bundle.invitation;
          if (admin.role !== 'admin' || admin.phase !== 'ready' || admin.agent_id !== invite.actor_id || admin.root_hash !== state.root_hash ||
            !invite.owner_userid || invite.owner_userid !== store.team.agents[admin.agent_id]?.wecom_userid || state.request.wecom_userid !== invite.owner_userid) throw new SetupError('本人机器人接入身份不一致，请通过原管理员项目继续。');
          await this.approve({ id: admin.id, request_id: state.request.request_id });
          store = await this.profileStore(state, { enrollmentOnly: true });
        }
        const member = store.team.agents[state.agent_id];
        const identity = await readPrivateJson(state.identity_path);
        if (!member) return this.detail(id, { localOnly: true });
        if (member.public_key !== createPublicKey(identity.private_key).export({ type: 'spki', format: 'pem' })) throw new SetupError('管理员已批准另一个身份，请联系管理员。');
        state.bootstrap_team = store.team; state.phase = 'configuring'; await this.save(state);
      }
      if (state.phase === 'configuring') {
        const store = await this.profileStore(state);
        const teamPath = join(this.path(id), 'team.json'); await savePrivate(teamPath, store.team);
        const configPath = join(this.path(id), 'peer.json');
        if (!await exists(configPath)) await createMemberConfig({ teamPath, identityPath: state.identity_path, repoPath: state.repo,
          dataDir: join(this.path(id), 'data'), configPath, testArgv: state.test_argv });
        const config = await readPrivateJson(configPath);
        await savePrivate(configPath, { ...config, team_registry_root: state.root_hash, wecom: state.wecom });
        await diagnosePeer(configPath, { testPush: true });
        if (!state.attached) {
          const existing = await readFile(join(state.repo, '.codex', 'config.toml'), 'utf8').catch(() => '');
          if (projectMcpConfigured(existing, configPath, await readPrivateJson(configPath))) await this.refreshAttachment(state, configPath);
          else await attachProject({ configPath, repoPath: state.repo });
          state.attached = true; await this.save(state);
        }
        await savePrivate(join(this.path(id), 'binding.json'), { prompt: bindingPrompt(state.agent_id, state.repo) });
        state.phase = 'ready'; state.last_error = null; await this.save(state);
      }
      if (state.phase === 'ready') {
        await this.refreshAttachment(state, state.existing_config || join(this.path(id), 'peer.json'));
        await savePrivate(join(this.path(id), 'binding.json'), { prompt: bindingPrompt(state.agent_id, state.repo) });
        const configPath = state.existing_config || join(this.path(id), 'peer.json');
        const { config } = await readPeerConfig(configPath);
        const intent = await readRunnerIntent(config.data_dir);
        if (intent?.enabled) await this.runCli('recover', configPath);
        else if (!intent && !wasReady) { await writeRunnerIntent(config.data_dir, true); await this.runCli('start', configPath); }
      }
      state.last_error = null; await this.save(state);
      return this.detail(id, { localOnly: true });
    } catch (error) {
      state.last_error = error instanceof SetupError ? error.message : '接入未完成，可检查 Git 权限／项目配置后点击继续。'; await this.save(state);
      if (error instanceof SetupError) throw error;
      throw new SetupError(state.last_error);
    }
  }
  readBundle({ content, password }) {
    if (typeof content !== 'string' || content.length > 500000) throw new SetupError('请选择管理员提供的接入包。');
    let envelope;
    try { envelope = JSON.parse(content); } catch { throw new SetupError('接入包文件不是有效 JSON，请重新下载管理员提供的文件。'); }
    return validateBundle(decryptBundle(envelope, password)).bundle;
  }
  async inspectBundle(input) {
    const bundle = this.readBundle(input), invite = bundle.invitation;
    return { agent_id: invite.agent_id, display_name: bundle.display_name || invite.agent_id, team_name: bundle.team_name || null,
      remote: bundle.remote, capabilities: invite.capabilities, bot_id: invite.bot_id, suggested_repo: suggestedRepo(bundle.remote, invite.agent_id) };
  }
  async importBundle(input) {
    const bundle = this.readBundle(input);
    // An interrupted import resumes its original profile without making another clone.
    for (const profile of (await this.overview()).profiles) {
      const state = await this.state(profile.id);
      if (state.bundle?.invitation.invite_id === bundle.invitation.invite_id) return this.detail(profile.id, { localOnly: true });
    }
    const repo = input.repo_mode === 'clone'
      ? await cloneRepository({ remote: bundle.remote, destination: input.destination || suggestedRepo(bundle.remote, bundle.invitation.agent_id), privateHome: this.home }) : input.repo;
    return this.importAssignment(bundle, repo);
  }
  async importAssignment(value, repo, ownAdminId) {
    const { bundle, history } = validateBundle(value);
    const selected = await ensureRepo(repo);
    if (inside(selected.repo, this.home)) throw new SetupError('本机配置目录必须在业务仓库之外。');
    if (remoteIdentity(selected.remote) !== remoteIdentity(bundle.remote)) throw new SetupError('该目录的 origin 与邀请仓库不一致，请选择正确仓库；工具不会改写 origin。');
    let recovered;
    for (const profile of (await this.overview()).profiles) {
      const current = await this.state(profile.id);
      if (current.bundle?.invitation.invite_id === bundle.invitation.invite_id) return this.detail(current.id, { localOnly: true });
      if (current.repo !== selected.repo) continue;
      const oldId = current.bundle?.invitation.invite_id;
      const replacement = history.records.find((record) => record.invitation_replacement?.old_invite_id === oldId && record.invitation_replacement.new_invite_id === bundle.invitation.invite_id);
      if (!replacement || current.agent_id !== bundle.invitation.agent_id || current.root_hash !== bundle.root_hash ||
        current.role !== 'member' || !['imported', 'verified', 'waiting'].includes(current.phase)) throw new SetupError('这个 clone 已接入其他身份，请选择独立 clone。');
      const latest = await this.profileStore(current, { enrollmentOnly: true });
      if (!latest.registry.revoked_invites.has(oldId) || latest.team.agents[current.agent_id]) throw new SetupError('旧接入尚未被替换或成员已经获批准，请检查管理员配置。');
      validateInvitation(bundle.invitation, latest.registry);
      const published = JSON.parse(await readFile(join(latest.checkout, invitationFile(bundle.invitation.invite_id)), 'utf8'));
      if (canonical(published) !== canonical(bundle.invitation)) throw new SetupError('仓库邀请与接入包不一致。');
      await savePrivate(join(this.path(current.id), 'replaced-invitations', `${oldId}.json`), current);
      recovered = current;
    }
    const id = recovered?.id || randomUUID(); const identity = await getOrCreateIdentityFiles(bundle.invitation.agent_id, join(this.home, 'identities'));
    const state = { id, role: 'member', agent_id: bundle.invitation.agent_id, display_name: bundle.display_name || bundle.invitation.agent_id, team_name: bundle.team_name || null, repo: selected.repo, remote: selected.remote, identity_path: identity.private_key_file,
      bootstrap_team: history.latest.team, root_hash: bundle.root_hash, bundle, test_argv: bundle.test_argv, phase: 'imported',
      ...(ownAdminId ? { own_admin_id: ownAdminId } : {}) };
    await this.save(state); return this.detail(id, { localOnly: true });
  }
  async verifyMember({ id, discovery_id }) {
    const state = await this.state(id); if (state.phase !== 'imported') return this.detail(id, { localOnly: true });
    const proof = this.discovery.consume(discovery_id); const invite = state.bundle.invitation;
    if (proof.bot_id !== invite.bot_id || !invite.chat_ids.includes(proof.chatid)) throw new SetupError('请使用分配的机器人和指定协作群验证。');
    if (invite.owner_userid !== undefined && proof.userid !== invite.owner_userid) throw new SetupError('请用初始化团队时的同一个企业微信账号验证自己的新机器人。');
    const identity = await readPrivateJson(state.identity_path);
    state.request = enrollmentRequest({ invite, publicKey: createPublicKey(identity.private_key).export({ type: 'spki', format: 'pem' }), userid: proof.userid,
      chatid: proof.chatid, requestId: randomUUID(), privateKey: identity.private_key, claimPrivateKey: state.bundle.claim_private_key });
    state.wecom = { bot_id: proof.bot_id, secret: proof.secret, chat_ids: invite.chat_ids, commands_enabled: invite.commands_enabled, allow_admin_commands: true,
      default_workflow: [invite.capabilities[0]] };
    state.phase = 'verified'; await this.save(state); return this.resume(id);
  }
  async issueBatch({ id, members }) {
    const state = await this.state(id);
    if (state.role !== 'admin' || state.phase !== 'ready') throw new SetupError('请先完成管理员接入。');
    if (!Array.isArray(members) || !members.length || members.length > 25) throw new SetupError('每次请分配 1 到 25 个机器人。');
    const store = await this.profileStore(state), identity = await readPrivateJson(state.identity_path);
    const ids = new Set([state.agent_id]), bots = new Set([state.wecom.bot_id]);
    const prepared = members.map((input) => {
      const fields = memberFields(input);
      if (ids.has(fields.agent_id) || store.team.agents[fields.agent_id]) throw new SetupError(`成员 ${fields.agent_id} 已存在或在本次分配中重复。`);
      if (typeof input.bot_id !== 'string' || !input.bot_id.trim() || typeof input.secret !== 'string' || !input.secret.trim()) throw new SetupError('请为每位成员填写独立机器人的 Bot ID 和 Secret。');
      const botId = input.bot_id.trim();
      if (bots.has(botId)) throw new SetupError('本次分配的机器人重复；每个 Agent 必须使用独立机器人。');
      ids.add(fields.agent_id); bots.add(botId);
      const password = input.password || randomBytes(18).toString('base64url');
      encryptBundle({}, password); // Validate the whole batch before any invitation is published.
      return { ...fields, bot_id: botId, secret: input.secret, commands_enabled: input.commands_enabled !== false,
        prefer: input.prefer !== false, password, claim: generateIdentity(), invite_id: randomUUID() };
    });
    await store.registryTransaction(async (history) => {
      for (const item of prepared) if (history.latest.team.agents[item.agent_id]) throw new SetupError(`成员 ${item.agent_id} 已存在，请刷新工作台。`);
      const existing = await readdir(join(store.checkout, registryPath, 'invitations')).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
      for (const file of existing) {
        const invite = JSON.parse(await readFile(join(store.checkout, registryPath, 'invitations', file), 'utf8'));
        if (history.revoked_invites.has(invite.invite_id)) continue;
        validateInvitation(invite, history);
        if (prepared.some((item) => (item.agent_id === invite.agent_id || item.bot_id === invite.bot_id) && item.invite_id !== invite.invite_id) &&
            (Date.now() < Date.parse(invite.expires_at) || history.records.some((record) => record.enrollment?.invite_id === invite.invite_id))) throw new SetupError('成员或机器人已有有效接入包，请使用已生成的文件。');
      }
      const files = [];
      for (const item of prepared) {
        const invitation = invitationRecord({ invite_id: item.invite_id, agent_id: item.agent_id, capabilities: item.capabilities,
          bot_id: item.bot_id, chat_ids: state.wecom.chat_ids, commands_enabled: item.commands_enabled, prefer: item.prefer,
          claim_public_key: item.claim.public_key, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }, history.latest, state.agent_id, identity.private_key);
        const bundle = { schema_version: 1, kind: 'codex-collab-invite', root_hash: state.root_hash, remote: state.remote,
          history: history.records, invitation, claim_private_key: item.claim.private_key, display_name: item.display_name, team_name: state.team_name || null,
          wecom: { bot_id: item.bot_id, secret: item.secret }, test_argv: state.test_argv };
        await savePrivate(join(this.path(id), 'exports', `${item.invite_id}.json`), { invitation, display_name: item.display_name,
          encrypted: encryptBundle(bundle, item.password), delivery_password: item.password });
        files.push([invitationFile(item.invite_id), invitation]);
      }
      return { files, value: null };
    });
    return { assignments: prepared.map((item) => ({ invite_id: item.invite_id, agent_id: item.agent_id,
      display_name: item.display_name, filename: `${item.agent_id}-collab-invite.json`, password: item.password })) };
  }
  async reissueBundle({ id, invite_id, secret }) {
    const state = await this.state(id);
    if (state.role !== 'admin' || state.phase !== 'ready' || !uuidPattern.test(invite_id || '')) throw new SetupError('只有已接入的管理员可重新生成接入包。');
    if (typeof secret !== 'string' || !secret.trim() || secret.length > 2000) throw new SetupError('请在本机填写该机器人的 Secret。');
    const saved = await readPrivateJson(join(this.path(id), 'exports', `${invite_id}.json`));
    if (!saved.encrypted || saved.own_bundle) throw new SetupError('本人机器人无需重新生成分发接入包。');
    const store = await this.profileStore(state), identity = await readPrivateJson(state.identity_path);
    // Persist a stable replacement before publication so retries survive a lost Git acknowledgment.
    const directory = join(this.path(id), 'exports');
    let candidate;
    for (const file of await readdir(directory)) {
      const value = await readPrivateJson(join(directory, file));
      if (value.replaces_invite_id === invite_id) { candidate = value; break; }
    }
    const newId = candidate?.invitation.invite_id || randomUUID();
    const claim = candidate ? null : generateIdentity(), password = candidate?.delivery_password || randomBytes(18).toString('base64url');
    await store.registryTransaction(async (history) => {
      const replacement = history.records.find((record) => record.invitation_replacement?.old_invite_id === invite_id);
      if (replacement) {
        if (replacement.invitation_replacement.new_invite_id !== newId || !candidate) throw new SetupError('该接入包已由其他操作替换，请刷新并使用最新接入包。');
        const published = JSON.parse(await readFile(join(store.checkout, invitationFile(newId)), 'utf8'));
        validateInvitation(published, history);
        if (canonical(published) !== canonical(candidate.invitation)) throw new SetupError('恢复记录与仓库邀请不一致，请检查本机文件。');
        return { value: null };
      }
      validateInvitation(saved.invitation, history);
      if (history.latest.team.agents[saved.invitation.agent_id] || history.records.some((record) => record.enrollment?.invite_id === invite_id)) throw new SetupError('该成员已获批准，请使用原配置或更新机器人凭据，无需重新生成接入包。');
      const originalPath = invitationFile(invite_id);
      if (await exists(join(store.checkout, originalPath))) {
        const original = JSON.parse(await readFile(join(store.checkout, originalPath), 'utf8'));
        if (canonical(original) !== canonical(saved.invitation)) throw new SetupError('原接入包与仓库邀请不一致。');
      }
      const invitation = candidate?.invitation || invitationRecord({ ...saved.invitation, invite_id: newId,
        claim_public_key: claim.public_key, expires_at: new Date(Date.now() + 7 * 86400000).toISOString() }, history.latest, state.agent_id, identity.private_key);
      validateInvitation(invitation, history);
      if (Date.now() > Date.parse(invitation.expires_at)) throw new SetupError('恢复接入包已过期，请检查本机恢复记录。');
      const version = policyVersion(history.latest.team, history.latest, state.agent_id, identity.private_key, undefined,
        { old_invite_id: invite_id, new_invite_id: newId });
      // Use the latest history on CAS retries; the encryption password and claim key stay stable.
      const previousBundle = candidate ? decryptBundle(candidate.encrypted, password) : null;
      const bundle = { schema_version: 1, kind: 'codex-collab-invite', root_hash: state.root_hash, remote: state.remote,
        history: [...history.records, version], invitation, claim_private_key: previousBundle?.claim_private_key || claim.private_key,
        display_name: saved.display_name || saved.invitation.agent_id, team_name: state.team_name || null,
        wecom: { bot_id: invitation.bot_id, secret }, test_argv: state.test_argv };
      candidate = { invitation, display_name: bundle.display_name, encrypted: encryptBundle(bundle, password),
        delivery_password: password, replaces_invite_id: invite_id };
      await savePrivate(join(directory, `${newId}.json`), candidate);
      return { files: [[invitationFile(newId), invitation], [versionFile(version), version]], value: null };
    });
    return { invite_id: newId, agent_id: candidate.invitation.agent_id };
  }
  async delivery({ id, invite_id }) {
    const state = await this.state(id);
    if (state.role !== 'admin' || state.phase !== 'ready' || !uuidPattern.test(invite_id || '')) throw new SetupError('只有管理员可查看已分配的接入说明。');
    const saved = await this.publishAssignment(id, invite_id);
    if (!saved.encrypted) throw new SetupError('本人机器人直接在本机接入，无需分发接入包。');
    return { agent_id: saved.invitation.agent_id, display_name: saved.display_name || saved.invitation.agent_id, password: saved.delivery_password || null,
      can_reissue: !saved.approved, bot_id: saved.invitation.bot_id,
      password_missing: !saved.delivery_password,
      instructions: `已为你分配 ${saved.display_name || saved.invitation.agent_id} 协作机器人。\n1. 安装 Node.js 20 或以上版本及 Git。\n2. 执行 npx xuym-codex-collab@latest setup 打开接入向导。\n3. 导入我提供的加密接入包，使用单独发送的密码，选择已有项目或自动拉取。\n4. 按页面提示在群里确认身份；批准后自动完成配置。\n5. 在目标 Codex 项目对话发送页面提供的启用指令。` };
  }
  async issueBundle(input, { ownRepo } = {}) {
    if (!ownRepo) return (await this.issueBatch({ id: input.id, members: [input] })).assignments[0];
    const state = await this.state(input.id); if (state.role !== 'admin' || state.phase !== 'ready') throw new SetupError('请先完成管理员接入。');
    const agentId = input.agent_id?.trim(); if (!idPattern.test(agentId || '') || agentId === state.agent_id) throw new SetupError('请填写要加入的成员名称。');
    const caps = capabilities(input.capabilities); const store = await this.profileStore(state);
    if (store.team.agents[agentId]) throw new SetupError('成员已存在，请复用原有接入配置。');
    if (typeof input.bot_id !== 'string' || !input.bot_id.trim() || typeof input.secret !== 'string' || !input.secret) throw new SetupError('请填写该成员机器人的 Bot ID 和 Secret。');
    if (input.bot_id.trim() === state.wecom.bot_id) throw new SetupError('每个 Agent 必须使用独立机器人。');
    const ownerUserid = ownRepo ? store.team.agents[state.agent_id]?.wecom_userid : undefined;
    if (ownRepo && !ownerUserid) throw new SetupError('请先验证管理员的企业微信本人身份。');
    if (!ownRepo) encryptBundle({}, input.password); // Validate password before publishing an invitation.
    const claim = generateIdentity(); const identity = await readPrivateJson(state.identity_path);
    const inviteId = randomUUID();
    const bundle = await store.registryTransaction(async (history) => {
      const files = await readdir(join(store.checkout, registryPath, 'invitations')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const file of files) {
        const existing = JSON.parse(await readFile(join(store.checkout, registryPath, 'invitations', file), 'utf8'));
        if (history.revoked_invites.has(existing.invite_id)) continue;
        validateInvitation(existing, history);
        if (existing.invite_id === inviteId) return { value: { invitation: existing } };
        if ((existing.agent_id === agentId || existing.bot_id === input.bot_id.trim()) && (Date.now() < Date.parse(existing.expires_at) || history.records.some((record) => record.enrollment?.invite_id === existing.invite_id))) throw new SetupError('该成员或机器人已有有效接入包，请使用已生成的文件。');
      }
      const invitation = invitationRecord({ invite_id: inviteId, agent_id: agentId, capabilities: caps,
        bot_id: input.bot_id.trim(), chat_ids: state.wecom.chat_ids, commands_enabled: input.commands_enabled !== false,
        prefer: input.prefer !== false, claim_public_key: claim.public_key, expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
        ...(ownRepo ? { owner_userid: ownerUserid } : {}) }, history.latest, state.agent_id, identity.private_key);
      const value = { schema_version: 1, kind: 'codex-collab-invite', root_hash: state.root_hash, remote: state.remote,
        history: history.records, invitation, claim_private_key: claim.private_key,
        wecom: { bot_id: invitation.bot_id, secret: input.secret }, test_argv: state.test_argv };
      // Save export before push: a lost acknowledgment can be retried from disk.
      await savePrivate(join(this.path(input.id), 'exports', `${inviteId}.json`), ownRepo
        ? { invitation, own_bundle: value, own_repo: ownRepo }
        : { invitation, encrypted: encryptBundle(value, input.password) });
      return { files: [[invitationFile(inviteId), invitation]], value };
    });
    return { invite_id: bundle.invitation.invite_id, agent_id: agentId, filename: `${agentId}-collab-invite.json` };
  }
  async publishAssignment(id, inviteId) {
    if (!uuidPattern.test(inviteId || '')) throw new SetupError('无效邀请标识。');
    const state = await this.state(id); const bundle = await readPrivateJson(join(this.path(id), 'exports', `${inviteId}.json`));
    const store = await this.profileStore(state);
    if (bundle.replaces_invite_id) {
      const replacement = store.registry.records.find((record) => record.invitation_replacement?.old_invite_id === bundle.replaces_invite_id);
      if (!replacement || replacement.invitation_replacement.new_invite_id !== inviteId || !store.registry.revoked_invites.has(bundle.replaces_invite_id)) {
        throw new SetupError('接入包替换尚未发布到仓库，请返回原接入包并重试“重新生成”。');
      }
    }
    await store.registryTransaction(async (history) => {
      if (history.revoked_invites.has(inviteId)) throw new SetupError('这份接入包已被替换，请下载最新接入包并使用新密码。');
      const path = invitationFile(inviteId); if (await exists(join(store.checkout, path))) return { value: null };
      validateInvitation(bundle.invitation, history);
      if (history.latest.team.agents[bundle.invitation.agent_id] || Date.now() > Date.parse(bundle.invitation.expires_at)) throw new SetupError('邀请已失效，请重新生成。');
      const files = await readdir(join(store.checkout, registryPath, 'invitations')).catch(() => []);
      for (const file of files) {
        const other = JSON.parse(await readFile(join(store.checkout, registryPath, 'invitations', file), 'utf8'));
        if (history.revoked_invites.has(other.invite_id)) continue;
        validateInvitation(other, history);
        if ((other.agent_id === bundle.invitation.agent_id || other.bot_id === bundle.invitation.bot_id) && (Date.now() < Date.parse(other.expires_at) || history.records.some((record) => record.enrollment?.invite_id === other.invite_id))) throw new SetupError('邀请与另一已发布的接入包冲突。');
      }
      return { files: [[path, bundle.invitation]], value: null };
    });
    const published = JSON.parse(await readFile(join(store.checkout, invitationFile(inviteId)), 'utf8'));
    if (canonical(published) !== canonical(bundle.invitation)) throw new SetupError('邀请尚未发布成功，请重新生成接入包。');
    return { ...bundle, approved: !!store.team.agents[bundle.invitation.agent_id] };
  }
  async exportedBundle(id, inviteId) {
    const bundle = await this.publishAssignment(id, inviteId);
    if (!bundle.encrypted) throw new SetupError('本人机器人无需下载接入包，请点击继续接入我的机器人。');
    return { content: JSON.stringify(bundle.encrypted, null, 2), filename: `${bundle.invitation.agent_id}-collab-invite.json` };
  }
  async createOwnAgent(input) {
    const state = await this.state(input.id);
    if (state.role !== 'admin' || state.phase !== 'ready') throw new SetupError('请从已接入的管理员项目添加自己的机器人。');
    if (!idPattern.test(input.agent_id?.trim() || '')) throw new SetupError('请填写新 Agent 名称。');
    const repo = input.repo_mode === 'clone' ? await cloneRepository({ remote: state.remote, destination: input.destination || suggestedRepo(state.remote, input.agent_id.trim()), privateHome: this.home }) : input.repo;
    const selected = await ensureRepo(repo);
    if (inside(selected.repo, this.home)) throw new SetupError('本机配置目录必须在业务仓库之外。');
    if (remoteIdentity(selected.remote) !== remoteIdentity(state.remote)) throw new SetupError('新 Agent 必须选择同一业务仓库的另一个 clone。');
    const files = await readdir(join(this.path(input.id), 'exports')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
    for (const file of files) {
      const saved = await readPrivateJson(join(this.path(input.id), 'exports', file));
      if (saved.own_bundle && saved.invitation.agent_id === input.agent_id?.trim()) {
        if (saved.own_repo !== selected.repo || saved.invitation.bot_id !== input.bot_id?.trim()) throw new SetupError('这个 Agent 已有本人接入配置，请从已生成的配置继续。');
        return this.resumeOwnAgent({ id: input.id, invite_id: saved.invitation.invite_id });
      }
    }
    for (const profile of (await this.overview()).profiles) if (profile.repo === selected.repo) throw new SetupError('这个 clone 已接入其他身份，请选择独立 clone。');
    const issued = await this.issueBundle({ ...input, commands_enabled: true }, { ownRepo: selected.repo });
    return this.resumeOwnAgent({ id: input.id, invite_id: issued.invite_id });
  }
  async resumeOwnAgent({ id, invite_id }) {
    const state = await this.state(id);
    if (state.role !== 'admin' || state.phase !== 'ready') throw new SetupError('请从原管理员项目继续接入。');
    if (!uuidPattern.test(invite_id || '')) throw new SetupError('无效邀请标识。');
    for (const profile of (await this.overview()).profiles) {
      const existing = await this.state(profile.id);
      if (existing.own_admin_id === id && existing.bundle?.invitation.invite_id === invite_id) return this.detail(profile.id, { localOnly: true });
    }
    const saved = await this.publishAssignment(id, invite_id);
    if (!saved.own_bundle || !saved.own_repo || saved.invitation.owner_userid !== state.bootstrap_team.agents[state.agent_id]?.wecom_userid) throw new SetupError('这不是当前管理员的本人机器人配置。');
    return this.importAssignment(saved.own_bundle, saved.own_repo, id);
  }
  async approve({ id, request_id }) {
    if (!uuidPattern.test(request_id || '')) throw new SetupError('无效申请标识。');
    const state = await this.state(id); if (state.role !== 'admin') throw new SetupError('需要管理员确认。');
    const store = await this.profileStore(state); const identity = await readPrivateJson(state.identity_path);
    await store.registryTransaction(async (history) => {
      const request = JSON.parse(await readFile(join(store.checkout, requestFile(request_id)), 'utf8'));
      const invite = JSON.parse(await readFile(join(store.checkout, invitationFile(request.invite_id)), 'utf8'));
      const version = approveEnrollment(request, invite, history, state.agent_id, identity.private_key);
      return version ? { files: [[versionFile(version), version]], value: version.version } : { value: history.latest.version };
    });
    // Local config is a cache; registry refresh also occurs in already running peers.
    const configPath = state.existing_config || join(this.path(id), 'peer.json');
    const { config } = await readPeerConfig(configPath);
    await savePrivate(config.team_file, store.team);
    return this.detail(id);
  }
  async setReviewRules({ id, expected_version, review_rules }) {
    const state = await this.state(id);
    if (state.role !== 'admin' || state.phase !== 'ready') throw new SetupError('只有已接入的管理员可设置审核规则。');
    if (!Number.isSafeInteger(expected_version) || expected_version < 1) throw new SetupError('请刷新工作台后再保存审核规则。');
    const rules = structuredClone(review_rules);
    const store = await this.profileStore(state); const identity = await readPrivateJson(state.identity_path);
    await store.registryTransaction(async (history) => {
      if (history.latest.team.agents[state.agent_id]?.role !== 'admin') throw new SetupError('需要管理员权限。');
      if (history.latest.version !== expected_version) throw new SetupError('团队规则已更新，请刷新工作台后重新设置。');
      const team = { ...structuredClone(history.latest.team), schema_version: 3, review_rules: rules };
      try { validateTeam(team); } catch { throw new SetupError('审核规则无效：每个职责都需要规则，指定同事必须已验证企业微信本人身份。'); }
      if (canonical(team) === canonical(history.latest.team)) return { value: history.latest.version };
      const version = policyVersion(team, history.latest, state.agent_id, identity.private_key);
      return { files: [[versionFile(version), version]], value: version.version };
    });
    const { config } = await readPeerConfig(state.existing_config || join(this.path(id), 'peer.json'));
    await savePrivate(config.team_file, store.team);
    return this.detail(id);
  }
  async detail(id, { localOnly = false } = {}) {
    const state = await this.state(id); const result = { id, agent_id: state.agent_id, display_name: state.display_name || state.agent_id, team_name: state.team_name || null, role: state.role, repo: state.repo, phase: state.phase, own_agent: !!state.own_admin_id, error: state.last_error || null };
    if (state.phase === 'imported') result.assignment = { capabilities: state.bundle.invitation.capabilities, bot_id: state.bundle.invitation.bot_id,
      expires_at: state.bundle.invitation.expires_at };
    if (state.role === 'admin' && state.phase === 'ready' && !localOnly) {
      const store = await this.profileStore(state); const owners = new Map();
      result.members = Object.entries(store.team.agents).map(([id, agent]) => {
        if (agent.wecom_userid) {
          const group = owners.get(agent.wecom_userid) || []; group.push(id); owners.set(agent.wecom_userid, group);
        }
        return { id, capabilities: agent.capabilities, role: agent.role, verified_owner: !!agent.wecom_userid };
      });
      result.owners = [...owners].map(([userid, agent_ids]) => ({ agent_ids, is_you: userid === store.team.agents[state.agent_id]?.wecom_userid }));
      result.routes = store.team.routes; result.review_rules = store.team.review_rules || null; result.policy_schema_version = store.team.schema_version; result.version = store.registry.latest.version; result.requests = [];
      const files = await readdir(join(store.checkout, registryPath, 'requests')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const file of files) {
        try {
          const request = JSON.parse(await readFile(join(store.checkout, registryPath, 'requests', file), 'utf8'));
          const invite = JSON.parse(await readFile(join(store.checkout, invitationFile(request.invite_id)), 'utf8'));
          validateEnrollment(request, invite, store.registry);
          if (!store.registry.records.some((record) => record.enrollment?.invite_id === request.invite_id)) result.requests.push({ request_id: request.request_id, agent_id: request.agent_id,
            capabilities: invite.capabilities, userid: request.wecom_userid, public_key_fingerprint: digest(request.public_key).slice(0, 16) });
        } catch { /* Invalid/untrusted repository request never reaches the approval UI. */ }
      }
      result.exports = [];
      const exported = await readdir(join(this.path(id), 'exports')).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
      for (const file of exported) {
        const value = await readPrivateJson(join(this.path(id), 'exports', file));
        if (store.registry.revoked_invites.has(value.invitation.invite_id)) continue;
        if (value.replaces_invite_id && !store.registry.records.some((record) => record.invitation_replacement?.old_invite_id === value.replaces_invite_id && record.invitation_replacement.new_invite_id === value.invitation.invite_id)) continue;
        result.exports.push({ invite_id: value.invitation.invite_id, agent_id: value.invitation.agent_id,
          filename: `${value.invitation.agent_id}-collab-invite.json`, display_name: value.display_name || value.invitation.agent_id, expires_at: value.invitation.expires_at, own_agent: !!value.own_bundle });
      }
    }
    if (state.phase === 'ready') {
      result.config_path = state.existing_config || join(this.path(id), 'peer.json'); result.binding_prompt = bindingPrompt(state.agent_id, state.repo); result.detailed_binding_prompt = detailedBindingPrompt(state.agent_id, state.repo);
      const config = (await readPeerConfig(result.config_path)).config;
      const skillName = config.execution_mode === 'desktop_poll' ? 'team-collab-desktop' : 'team-collab';
      const projectConfig = await readFile(join(state.repo, '.codex', 'config.toml'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
      const installedSkill = await readFile(join(state.repo, '.agents', 'skills', skillName, 'SKILL.md'), 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
      result.project_setup = { mcp_configured: projectMcpConfigured(projectConfig, result.config_path, config), skill_installed: !!installedSkill.trim() };
      const lock = await readRunnerLock(join(config.data_dir, 'runner.pid.json'));
      result.runner = { online: !!lock && alive(lock.pid), wecom: 'offline' };
      if (result.runner.online) {
        try { const health = JSON.parse(await readFile(join(config.data_dir, 'wecom-health.json'), 'utf8')); if (health.pid === lock.pid) result.runner.wecom = health.status; } catch {}
      }
      const desktop = new DesktopExecutor({ agentId: config.agent_id, store: { clock: Date.now } }, config);
      result.desktop = await desktop.status();
      result.connection_enabled = (await readRunnerIntent(config.data_dir))?.enabled ?? result.runner.online;
      result.last_poll_at = result.desktop.last_poll_at || null;
      result.poll_observed = !!result.last_poll_at;
      result.poll_recent = !!result.last_poll_at && Date.now() - Date.parse(result.last_poll_at) < 180000;
      result.can_receive_tasks = result.project_setup.mcp_configured && result.project_setup.skill_installed && result.runner.online && result.runner.wecom === 'authenticated' && !!result.desktop.binding && result.poll_recent;
      result.heartbeat_confirmed = false;
    }
    return result;
  }
  async runner({ id, command }) {
    const state = await this.state(id); if (state.phase !== 'ready' || !['start', 'stop'].includes(command)) throw new SetupError('无效连接操作。');
    try {
      if (command === 'start' && [...this.discovery.sessions.values()].some((session) => session.bot_id === state.wecom?.bot_id && ['connecting', 'authenticated'].includes(session.status))) throw new SetupError('机器人正在验证，请先取消验证，再启动连接。');
      const configPath = state.existing_config || join(this.path(id), 'peer.json');
      const { config } = await readPeerConfig(configPath);
      await writeRunnerIntent(config.data_dir, command === 'start');
      await this.runCli(command, configPath);
      state.last_error = null; await this.save(state);
    } catch (error) {
      if (error instanceof SetupError) throw error;
      state.last_error = `机器人${command === 'start' ? '启动' : '停止'}未完成，请检查本机 Runner 日志后重试。`;
      await this.save(state); throw new SetupError(state.last_error);
    }
    return this.detail(id, { localOnly: true });
  }
  async diagnostics({ id }) {
    const value = await this.detail(id, { localOnly: true });
    const checks = [];
    const add = (key, label, ok, action) => checks.push({ key, label, ok: !!ok, action: ok ? null : action });
    add('setup', '本机接入', value.phase === 'ready', '先继续完成群身份验证和管理员确认。');
    if (value.phase === 'ready') {
      add('mcp', '项目 MCP', value.project_setup.mcp_configured, '点击修复本机配置，然后在 Codex 中重新加载项目 MCP。');
      add('skill', '接入 Skill', value.project_setup.skill_installed, '点击修复本机配置，恢复工具生成的 Skill。');
      add('runner', '后台机器人进程', value.runner.online, value.connection_enabled ? '连接已启用，后台将尝试恢复；也可以点击启动机器人连接。' : '连接已停止。需要接任务时点击启动机器人连接。');
      add('wecom', '企业微信认证', value.runner.wecom === 'authenticated', '等待认证；若持续失败，请检查网络或通过更新机器人凭据重新验证。');
      add('binding', '目标 Codex 对话', !!value.desktop.binding, '复制启用指令，发送到你选定的 Codex 对话。');
      add('poll', '对话实际轮询', value.poll_recent, '在绑定对话中执行启用指令，并确认该对话的协作自动化已启用。');
      try { await diagnosePeer(value.config_path, { testPush: true }); add('git', 'Git 读取与推送权限', true); }
      catch { add('git', 'Git 读取与推送权限', false, '请完成本机 Git 登录，确认 origin/main 可读并具有推送权限。'); }
    }
    const startup = await startupStatus(this.home);
    return { id, checks, ready: value.can_receive_tasks === true, startup, heartbeat_confirmed: false,
      note: '检查使用真实进程、认证和轮询记录，不创建测试任务。未来能否自动唤醒仍需在 Codex 中确认自动化。' };
  }
  async repair({ id }) {
    const state = await this.state(id);
    if (state.phase !== 'ready') throw new SetupError('请先完成本机接入。');
    const configPath = state.existing_config || join(this.path(id), 'peer.json');
    await this.refreshAttachment(state, configPath);
    return { id, repaired: true, next_step: '本机生成配置已更新。请在 Codex 重新加载项目 MCP，并在原绑定对话中执行启用指令。' };
  }
  resetPreview(input) { return this.resets.preview(input); }
  resetDiscovery(input) { return this.resets.discover(input); }
  resetCancel(input) { return this.resets.cancel(input); }
  reset(input) { return this.resets.apply(input); }
  close() { this.discovery.closeAll(); }
}
