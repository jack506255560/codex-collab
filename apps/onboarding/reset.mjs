import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SetupError } from './errors.mjs';
import { readPeerConfig, loadRuntime } from '../peer/runtime.mjs';
import { PrivateDesktopState } from '../peer/private-state.mjs';
import { alive, readRunnerLock } from '../peer/process.mjs';
import { writeRunnerIntent } from '../peer/intent.mjs';
import { installedProjectConfig } from '../../scripts/peer/refresh-project.mjs';
import { bindingPrompt } from '../../scripts/peer/setup-desktop-project.mjs';
import { digest, readPrivateJson } from '../../packages/peer/config.mjs';
import { git } from '../../packages/peer/store.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const kinds = { conversation: '重新绑定对话', robot: '更新机器人凭据', project: '移除本机接入', restore: '恢复本机接入' };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const legacySkill = 'f98ad425e2ea3c8ab6fb86febef7d9cb288029ef55bea6937dda6de8b467fece';
const inside = (parent, child) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('../') && !isAbsolute(path); };
async function optional(path) { return readFile(path, 'utf8').catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error)); }
async function plain(base, path) {
  if (!inside(base, path)) throw new SetupError('配置路径不属于当前项目。');
  let current = base;
  for (const part of relative(base, path).split('/').filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (!entry) break;
    if (entry.isSymbolicLink()) throw new SetupError('协作配置或 Skill 是符号链接，请先手动检查。');
  }
}
async function replace(path, contents) {
  if (contents === null) { await rm(path, { force: true }); return; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, contents, { flag: 'wx', mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600); }
  finally { await rm(temp, { force: true }); }
}
const json = (value) => JSON.stringify(value, null, 2) + '\n';

// Mutations are serialized by SetupManager and the same private lock used by MCP.
// A preview is a short-lived capability for one profile and one exact snapshot.
export class ResetActions {
  constructor(manager) { this.manager = manager; this.previews = new Map(); }
  async context(id, kind) {
    if (!Object.hasOwn(kinds, kind)) throw new SetupError('请选择有效的重置操作。');
    const state = await this.manager.state(id);
    if (kind === 'restore' ? state.phase !== 'removed' : state.phase === 'removed') throw new SetupError('项目状态已改变，请刷新工作台。');
    if (['conversation', 'robot'].includes(kind) && state.phase !== 'ready') throw new SetupError('请先完成项目接入，或选择移除本机接入。');
    const configPath = state.existing_config || join(this.manager.path(id), 'peer.json');
    const configText = await optional(configPath);
    const config = configText === null ? null : (await readPeerConfig(configPath, { allowDisabled: kind === 'restore' })).config;
    if (config && (config.agent_id !== state.agent_id || await realpath(config.repo) !== await realpath(state.repo))) throw new SetupError('私有配置与当前项目身份不一致，请先手动检查。');
    const dataDir = config?.data_dir || state.data_dir || join(this.manager.path(id), 'data');
    const actualData = await realpath(dataDir).catch((error) => error.code === 'ENOENT' ? resolve(dataDir) : Promise.reject(error));
    if (inside(await realpath(state.repo), actualData) || inside(await realpath(state.repo), this.manager.home)) throw new SetupError('个人配置与备份必须位于业务仓库之外。');
    for (const profile of (await this.manager.overview()).profiles) {
      if (profile.id === id) continue;
      const other = await this.manager.state(profile.id);
      if (resolve(other.data_dir || join(this.manager.path(other.id), 'data')) === resolve(dataDir) || other.repo === state.repo) throw new SetupError('其他本机项目正在使用此 clone 或数据目录，请先检查重复导入。');
    }
    return { state, config, configPath, dataDir, private: new PrivateDesktopState(dataDir) };
  }
  async configs(context, { allowDisabled = false } = {}) {
    const { state, config, configPath } = context;
    if (!config) return [];
    const paths = new Set([resolve(configPath)]);
    const local = join(this.manager.path(state.id), 'peer.json');
    if (await optional(local) !== null) paths.add(local);
    const toml = await optional(join(state.repo, '.codex/config.toml'));
    if (toml?.includes(`[mcp_servers.team-collab-${state.agent_id}]`)) {
      const installed = await installedProjectConfig({ repoPath: state.repo, agentId: state.agent_id });
      paths.add(installed.config_path);
    }
    if (allowDisabled && state.reset_backup) {
      const backup = await readPrivateJson(state.reset_backup);
      if (backup.kind !== 'project' || backup.state.id !== state.id) throw new SetupError('恢复记录与项目不一致，请先手动检查。');
      for (const path of backup.config_paths || []) paths.add(path);
    }
    const result = [];
    for (const path of paths) {
      if (inside(state.repo, path)) throw new SetupError('私有配置位于业务仓库内，请先手动移出。');
      const item = (await readPeerConfig(path, { allowDisabled })).config;
      if (item.agent_id !== state.agent_id || item.private_key !== config.private_key || await realpath(item.repo) !== await realpath(config.repo) || resolve(item.data_dir) !== resolve(config.data_dir)) throw new SetupError('项目 MCP 使用其他身份或数据目录，请先手动检查。');
      if ((await lstat(path)).isSymbolicLink()) throw new SetupError('私有配置是符号链接，请先手动检查。');
      result.push({ path, before: await readFile(path, 'utf8'), value: item });
    }
    return result;
  }
  async projectFiles(context, kind) {
    const { state } = context; const repo = await realpath(state.repo);
    if (await git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new SetupError('请选择 Git clone 的根目录。');
    const configFile = join(repo, '.codex/config.toml'); const skillDir = join(repo, '.agents/skills/team-collab-desktop'); const skillFile = join(skillDir, 'SKILL.md');
    await plain(repo, configFile); await plain(repo, skillFile);
    const before = await optional(configFile); const skill = await optional(skillFile);
    if (/^\s*\[mcp_servers\.team-collab-/m.test(before || '') && (before || '').match(/^\s*\[mcp_servers\.team-collab-([^\].\n]+)[^\n]*$/gm)?.some((line) => line.trim() !== `[mcp_servers.team-collab-${state.agent_id}]`)) throw new SetupError('该 clone 中还有其他协作身份，请先手动检查。');
    const hasMcp = before?.includes(`[mcp_servers.team-collab-${state.agent_id}]`) || before?.includes(`[mcp_servers.team-collab-${state.agent_id}.`);
    let installed = null;
    if (hasMcp) {
      installed = await installedProjectConfig({ repoPath: repo, agentId: state.agent_id });
      if (!context.config) throw new SetupError('无法验证原 MCP 身份，请恢复私有配置后重试。');
    }
    const skillEntries = await readdir(skillDir).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error));
    if (skillEntries.some((name) => name !== 'SKILL.md')) throw new SetupError('协作 Skill 目录包含自定义文件，请先手动处理。');
    let customSkill = false;
    if (skill !== null) {
      const template = await readFile(join(root, 'packages/codex-kit/templates/.agents/skills/team-collab-desktop/SKILL.md'), 'utf8');
      customSkill = skill !== template && hash(skill) !== legacySkill;
      if (customSkill && kind === 'restore') throw new SetupError('项目中已有其他协作 Skill，恢复操作不会覆盖它；请先手动检查。');
    }
    const touched = [hasMcp ? '.codex/config.toml' : null, skill !== null ? '.agents/skills/team-collab-desktop' : null].filter(Boolean);
    if (touched.length && await git(repo, 'ls-files', '--', ...touched)) throw new SetupError('协作配置或 Skill 已提交到项目 Git，请先手动处理共享文件。');
    if (kind === 'restore' && (hasMcp || skill !== null)) throw new SetupError('原项目已存在协作配置，请先处理当前接入，再恢复。');
    const result = [];
    if (installed) { const next = before.replace(installed.section, ''); result.push({ path: configFile, before, after: next.trim() ? next : null }); }
    if (skill !== null) result.push({ path: skillFile, before: skill, after: null });
    return { files: result, skillDir, configFile, skillFile, before, skill, customSkill };
  }
  async plan(context, kind, desktop) {
    const configs = await this.configs(context, { allowDisabled: kind === 'restore' });
    const project = ['project', 'restore'].includes(kind) ? await this.projectFiles(context, kind) : null;
    const lock = await readRunnerLock(join(context.dataDir, 'runner.pid.json'));
    if (lock && alive(lock.pid) && !configs.some((item) => resolve(item.path) === resolve(lock.config || ''))) throw new SetupError('Runner 配置与当前项目不一致，无法安全停止。');
    if (kind !== 'restore' && context.config) {
      try {
        const { service } = await loadRuntime(context.configPath);
        const tasks = await service.list();
        if (tasks.some((task) => task.state.status === 'running' && task.state.assignee === context.state.agent_id && Date.now() < Date.parse(task.state.lease.expires_at))) throw new SetupError('该机器人有任务正在运行，请等待本阶段结束或先在原对话报告失败，再重置。');
      } catch (error) {
        if (error instanceof SetupError) throw error;
        throw new SetupError('无法确认任务是否运行，请检查 Git 网络与权限后重试；未重置。');
      }
    }
    if (!context.config && Object.values(desktop.jobs).some((job) => ['claimed', 'prepared', 'executing'].includes(job.status))) throw new SetupError('私有配置缺失且本机有未结束任务，请先恢复配置。');
    return { configs, project, lock, fingerprint: digest({ state: context.state, configs, project, desktop: { binding: desktop.binding, disabled: desktop.disabled, jobs: desktop.jobs } }) };
  }
  async preview({ id, kind }) {
    const context = await this.context(id, kind);
    return context.private.locked(async (desktop) => {
      const plan = await this.plan(context, kind, desktop);
      const token = randomUUID();
      for (const [key, value] of this.previews) if (value.expires < Date.now()) this.previews.delete(key);
      this.previews.set(token, { id, kind, fingerprint: plan.fingerprint, expires: Date.now() + 600000 });
      const effects = {
        conversation: ['停止此机器人的本机连接；解除当前 Codex 对话绑定与轮询状态。', '保留机器人凭据和项目接入；在目标对话重新启用，然后启动机器人。'],
        robot: ['停止此机器人的本机连接；用新 Secret 在原协作群完成验证码验证。', '保持 Bot ID、群、本人身份和 Codex 对话绑定；保存后可重新启动连接。'],
        project: ['停止本机机器人连接并解除当前 Codex 对话绑定。', '移除本 clone 的协作 MCP 与 Skill；自定义 Skill 自动保存到本机恢复记录。', '项目代码、其他 MCP、模型配置、Git 历史、团队任务和其他电脑配置均保留，可从首页恢复本机接入。', 'Codex 聊天不会被删除；移除后，旧对话不再绑定这台电脑的协作接入。'],
        restore: ['恢复原成员身份与本 clone 的协作 MCP、Skill。', '机器人保持停止、对话保持未绑定；重新启用对话并启动连接。']
      }[kind];
      return { id, kind, title: kinds[kind], agent_id: context.state.agent_id, repo: context.state.repo, bot_id: context.config?.wecom?.bot_id || null,
        thread_id: desktop.binding?.thread_id || null, preview_token: token, effects, requires_pause: kind === 'conversation' };
    });
  }
  ticket(input, fingerprint) {
    const value = this.previews.get(input.preview_token);
    if (!value || value.id !== input.id || value.kind !== input.kind || value.expires < Date.now() || value.fingerprint !== fingerprint) throw new SetupError('项目配置或绑定已改变，或预览已过期，请重新预览。');
  }
  async stop(context, plan) {
    await writeRunnerIntent(context.dataDir, false);
    if (!plan.lock || !alive(plan.lock.pid)) return;
    try { await this.manager.runCli('stop', plan.lock.config); }
    catch { throw new SetupError('机器人停止失败，未修改配置；请检查 Runner 后重试。'); }
    const lock = await readRunnerLock(join(context.dataDir, 'runner.pid.json'));
    if (lock && alive(lock.pid)) throw new SetupError('机器人仍在停止，请稍后重试；未修改配置。');
  }
  async discover(input) {
    if (input.kind !== 'robot' || typeof input.secret !== 'string' || !input.secret.trim()) throw new SetupError('请填写新机器人 Secret。');
    const context = await this.context(input.id, input.kind);
    return context.private.locked(async (desktop) => {
      const plan = await this.plan(context, input.kind, desktop); this.ticket(input, plan.fingerprint);
      await this.stop(context, plan);
      await this.manager.checkBotAvailable(context.config.wecom.bot_id);
      const session = this.manager.discovery.begin({ bot_id: context.config.wecom.bot_id, secret: input.secret, chat_ids: context.config.wecom.chat_ids });
      this.previews.get(input.preview_token).discovery_id = session.id;
      return session;
    });
  }
  cancel({ id, preview_token }) {
    const ticket = this.previews.get(preview_token);
    if (!ticket || ticket.id !== id) return { cancelled: true };
    if (ticket.discovery_id) this.manager.discovery.cancel(ticket.discovery_id);
    this.previews.delete(preview_token);
    return { cancelled: true, runner_restarted: false };
  }
  async apply(input) {
    const context = await this.context(input.id, input.kind);
    if (input.kind === 'project') {
      if (input.confirmation !== true) throw new SetupError('请再次确认移除本机接入。');
    } else if (input.confirmation !== context.state.agent_id) throw new SetupError('请填写当前 Agent 名称确认操作。');
    if (input.kind === 'conversation' && input.heartbeat_paused !== true) throw new SetupError('请先在原 Codex 对话暂停协作轮询，再确认重置。');
    return context.private.locked(async (desktop) => {
      const plan = await this.plan(context, input.kind, desktop); this.ticket(input, plan.fingerprint);
      let proof;
      if (input.kind === 'robot') {
        const ticket = this.previews.get(input.preview_token);
        if (!ticket.discovery_id || ticket.discovery_id !== input.discovery_id) throw new SetupError('请先使用本次新凭据完成群验证码验证。');
        const view = this.manager.discovery.view(input.discovery_id);
        const { team } = await readPeerConfig(context.configPath);
        if (view.status !== 'verified' || !context.config.wecom.chat_ids.includes(view.proof?.chatid) || view.proof?.userid !== team.agents[context.state.agent_id].wecom_userid) throw new SetupError('请用原绑定本人账号，在原协作群完成验证码验证。');
        proof = this.manager.discovery.consume(input.discovery_id);
      }
      await this.stop(context, plan);
      const oldState = structuredClone(context.state); const oldDesktop = structuredClone(desktop);
      const nextState = { ...structuredClone(oldState), last_error: null }; const changes = [];
      if (input.kind === 'robot') {
        for (const item of plan.configs) changes.push({ path: item.path, before: item.before, after: json({ ...item.value, wecom: { ...item.value.wecom, secret: proof.secret } }) });
        nextState.wecom = { ...nextState.wecom, secret: proof.secret };
        if (nextState.bundle?.wecom) nextState.bundle.wecom.secret = proof.secret;
      } else if (input.kind === 'project') {
        changes.push(...plan.project.files);
        for (const item of plan.configs) changes.push({ path: item.path, before: item.before, after: json({ ...item.value, local_disabled: true }) });
        nextState.phase = 'removed';
      } else if (input.kind === 'restore') {
        const backup = await readPrivateJson(oldState.reset_backup);
        // Restore only the generated MCP section, preserving new unrelated settings.
        const original = backup.changes.find((item) => item.path === plan.project.configFile);
        if (original) {
          const section = backup.mcp_section;
          if (!section) throw new SetupError('恢复记录缺少 MCP 配置，请先手动检查。');
          const before = plan.project.before || '';
          changes.push({ path: plan.project.configFile, before: plan.project.before, after: `${before}${before && !before.endsWith('\n') ? '\n' : ''}${section}` });
        }
        const skill = backup.changes.find((item) => item.path === plan.project.skillFile);
        if (skill) changes.push({ path: skill.path, before: null, after: skill.before });
        for (const item of plan.configs) { const value = { ...item.value }; delete value.local_disabled; changes.push({ path: item.path, before: item.before, after: json(value) }); }
        nextState.phase = backup.state.phase;
      }
      const backupPath = join(this.manager.home, 'reset-backups', `${randomUUID()}.json`);
      const mcpSection = input.kind === 'project' && plan.project.files.some((item) => item.path === plan.project.configFile)
        ? (await installedProjectConfig({ repoPath: oldState.repo, agentId: oldState.agent_id })).section : null;
      await replace(backupPath, json({ schema_version: 1, created_at: new Date().toISOString(), kind: input.kind, state: oldState, desktop: oldDesktop, changes, config_paths: plan.configs.map((item) => item.path), mcp_section: mcpSection }));
      nextState.reset_backup = backupPath;
      if (input.kind !== 'robot') { desktop.binding = null; desktop.last_poll_at = null; desktop.poll_count = 0; desktop.disabled = input.kind === 'project'; }
      const applied = [];
      try {
        for (const change of changes) {
          if (await optional(change.path) !== change.before) throw new SetupError('文件已改变，请刷新后重新预览。');
          applied.push(change); await replace(change.path, change.after);
        }
        await context.private.write(desktop); await this.manager.save(nextState);
      } catch (error) {
        for (const change of applied.reverse()) await replace(change.path, change.before);
        await context.private.write(oldDesktop); await this.manager.save(oldState);
        throw error;
      }
      if (input.kind === 'project' && plan.project.skill !== null) await rmdir(plan.project.skillDir).catch((error) => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      await rm(join(context.dataDir, 'wecom-health.json'), { force: true });
      this.previews.delete(input.preview_token);
      return { id: input.id, kind: input.kind, done: true, backup_path: backupPath, runner_online: false, automation_paused: false,
        binding_prompt: bindingPrompt(oldState.agent_id, oldState.repo),
        message: input.kind === 'restore' ? '已恢复原身份的本机接入。重新加载项目 MCP，复制启用指令到目标 Codex 对话，然后启动机器人连接。' : input.kind === 'project' ? '已移除本机接入。项目代码与团队记录保留，可在首页恢复或接入其他身份。' : input.kind === 'robot' ? '新凭据已验证并保存。点击“启动机器人连接”恢复群连接。' : '已解除对话绑定。复制启用指令到目标 Codex 对话，完成绑定后启动机器人连接。' };
    });
  }
}
