import { createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIdentity, readPrivateJson, validateTeam } from '../../packages/peer/config.mjs';
import { readPeerConfig, loadRuntime } from '../../apps/peer/runtime.mjs';
import { git } from '../../packages/peer/store.mjs';
import { bindingPrompt } from './setup-desktop-project.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const absent = async (path) => { try { await stat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
const splitList = (value) => [...new Set(value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean))];
const isWithin = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export async function createIdentityFiles(agentId, directory = join(homedir(), '.config', 'codex-collab', 'identities')) {
  if (!idPattern.test(agentId || '') || !isAbsolute(directory)) throw new Error('provide a valid agent ID and absolute identity directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, `${agentId}.private.json`);
  const publicPath = join(directory, `${agentId}.public.pem`);
  const identity = generateIdentity();
  await writeFile(privatePath, JSON.stringify({ agent_id: agentId, private_key: identity.private_key }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(publicPath, identity.public_key, { mode: 0o644, flag: 'wx' });
    await chmod(privatePath, 0o600);
  } catch (error) {
    await rm(privatePath, { force: true });
    throw error;
  }
  return { agent_id: agentId, private_key_file: privatePath, public_key_file: publicPath };
}

export async function readPublicKeyFile(path) {
  const value = (await readFile(resolve(path), 'utf8')).trim();
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('public key must be Ed25519');
  return key.export({ type: 'spki', format: 'pem' });
}

async function getOrCreateIdentityFiles(agentId, directory) {
  if (!idPattern.test(agentId || '') || !isAbsolute(directory)) throw new Error('provide a valid agent ID and absolute identity directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privatePath = join(directory, `${agentId}.private.json`);
  const publicPath = join(directory, `${agentId}.public.pem`);
  const hasPrivate = !await absent(privatePath);
  const hasPublic = !await absent(publicPath);
  if (!hasPrivate && !hasPublic) return createIdentityFiles(agentId, directory);
  if (!hasPrivate) throw new Error(`public key exists without its private identity: ${publicPath}`);
  const identity = await readPrivateJson(privatePath);
  if (identity.agent_id !== agentId) throw new Error(`private identity file belongs to ${identity.agent_id}, not ${agentId}`);
  const publicKey = createPublicKey(identity.private_key).export({ type: 'spki', format: 'pem' });
  if (hasPublic && await readPublicKeyFile(publicPath) !== publicKey) throw new Error('existing public key does not match the local private identity');
  if (!hasPublic) await writeFile(publicPath, publicKey, { mode: 0o644, flag: 'wx' });
  await chmod(privatePath, 0o600);
  return { agent_id: agentId, private_key_file: privatePath, public_key_file: publicPath };
}

export function buildTeamPolicy({ repo, reviewer, defaultRoute, agents, routes, policy = {} }) {
  const team = validateTeam({
    schema_version: 2,
    repo,
    reviewer,
    default_route: defaultRoute,
    agents: Object.fromEntries(agents.map((agent) => [agent.id, {
      role: agent.role,
      capabilities: agent.capabilities,
      max_concurrent_tasks: agent.maxConcurrentTasks ?? 1,
      public_key: agent.publicKey,
      ...(agent.wecomUserid ? { wecom_userid: agent.wecomUserid } : {})
    }])),
    routes,
    policy: {
      claim_timeout_ms: 180000,
      lease_ms: 900000,
      clock_skew_ms: 5000,
      max_attempts: 3,
      ...policy
    }
  });
  return team;
}

export async function writeTeamPolicy(path, team) {
  if (!isAbsolute(path)) throw new Error('team file path must be absolute');
  validateTeam(team);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(team, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  return path;
}

export async function createMemberConfig({ teamPath, identityPath, repoPath, dataDir, configPath, testArgv = ['sh', 'test.sh'] }) {
  for (const path of [teamPath, identityPath, repoPath, dataDir, configPath]) {
    if (!path || !isAbsolute(path)) throw new Error('team, identity, repository, data and config paths must be absolute');
  }
  const team = validateTeam(JSON.parse(await readFile(teamPath, 'utf8')));
  const identity = await readPrivateJson(identityPath);
  if (!idPattern.test(identity.agent_id || '') || !team.agents[identity.agent_id]) throw new Error('identity is not registered in the team policy');
  const publicKey = createPublicKey(identity.private_key).export({ type: 'spki', format: 'pem' });
  if (publicKey !== team.agents[identity.agent_id].public_key) throw new Error('private identity does not match the public key pinned in team policy');
  if (!Array.isArray(testArgv) || !testArgv.length || testArgv.some((part) => typeof part !== 'string' || !part)) throw new Error('testArgv must be a non-empty argv array');
  const repo = await realpath(repoPath);
  if (await git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new Error('select the root directory of a Git project');
  const privatePaths = [dataDir, configPath, identityPath];
  if (privatePaths.some((path) => isWithin(repoPath, path) || isWithin(repo, path))) throw new Error('private identity, data and config files must stay outside the code repository');
  const origin = await git(repo, 'remote', 'get-url', 'origin');
  const main = await git(repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main');
  if (!main) throw new Error('the shared origin must have a readable main branch');
  const config = {
    schema_version: 2,
    agent_id: identity.agent_id,
    repo,
    data_dir: dataDir,
    team_file: teamPath,
    private_key: identity.private_key,
    execution_mode: 'desktop_poll',
    auto_execute: false,
    test_argv: testArgv
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await chmod(configPath, 0o600);
    await readPeerConfig(configPath);
  } catch (error) {
    await rm(configPath, { force: true });
    throw error;
  }
  return { config, team, origin };
}

export async function diagnosePeer(configPath, { testPush = false } = {}) {
  const { config, team } = await readPeerConfig(configPath);
  const origin = await git(config.repo, 'remote', 'get-url', 'origin');
  const main = await git(config.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main');
  if (!main) throw new Error('shared origin is missing refs/heads/main');
  const ledger = await git(config.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/agent-collab');
  let writeAccess = 'not checked';
  if (testPush) {
    const probe = `refs/heads/codex-collab-doctor/${process.pid}-${Date.now()}`;
    await git(config.repo, 'push', '--dry-run', 'origin', `HEAD:${probe}`);
    writeAccess = 'push dry-run passed; no remote ref was created';
  }
  return {
    agent_id: config.agent_id,
    mode: config.execution_mode,
    origin,
    team_repo: team.repo,
    checks: {
      identity: 'valid; private key matches team public key',
      repository: 'Git root with readable origin/main',
      ledger: ledger ? 'agent-collab exists' : 'not initialized; first start may create it',
      push_access: writeAccess,
      wecom: config.wecom ? 'configured; authentication requires starting the adapter' : 'not configured',
      codex_binding: 'manual; bind from the target Codex conversation and configure its heartbeat'
    }
  };
}

function mergeMcpToml(before, serverName, block) {
  const nested = new RegExp(`^\\[mcp_servers\\.${serverName}\\.`, 'm').test(before);
  if (nested) throw new Error('nested MCP configuration exists; review it manually before attaching');
  const section = new RegExp(`^\\[mcp_servers\\.${serverName}\\][^]*?(?=^\\[|$(?![^]))`, 'm');
  return section.test(before) ? before.replace(section, `${block}\n`) : `${before}${before.endsWith('\n') || !before ? '' : '\n'}\n${block}\n`;
}

export async function attachProject({ configPath, repoPath }) {
  const { config } = await readPeerConfig(configPath);
  const repo = await realpath(repoPath);
  if (await git(repo, 'rev-parse', '--show-toplevel') !== repo) throw new Error('project path must be a Git repository root');
  const skillName = config.execution_mode === 'desktop_poll' ? 'team-collab-desktop' : 'team-collab';
  const skillDir = join(repo, '.agents', 'skills', skillName);
  const skillFile = join(skillDir, 'SKILL.md');
  const configFile = join(repo, '.codex', 'config.toml');
  const trackedConfig = await git(repo, 'ls-files', '--error-unmatch', '.codex/config.toml').then(() => true).catch(() => false);
  if (trackedConfig) throw new Error('.codex/config.toml is tracked by the project; use the generated global MCP example instead of editing shared project settings');
  if (!(await absent(skillDir))) throw new Error(`${skillDir} already exists; refusing to overwrite an existing skill`);
  const before = await readFile(configFile, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const serverName = `team-collab-${config.agent_id}`;
  const block = `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, 'apps/peer/mcp-main.mjs'))}, ${JSON.stringify(configPath)}]`;
  const next = mergeMcpToml(before, serverName, block);
  const excludePath = await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  const oldExclude = await readFile(excludePath, 'utf8');
  const rules = [`/.codex/config.toml`, `/.agents/skills/${skillName}/`, '/.codex-collab-worktrees/'];
  const addedRules = rules.filter((rule) => !oldExclude.split(/\r?\n/).includes(rule));
  const template = await readFile(join(root, `packages/codex-kit/templates/.agents/skills/${skillName}/SKILL.md`), 'utf8');
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  await mkdir(dirname(skillFile), { recursive: true, mode: 0o700 });
  try {
    await writeFile(configFile, next, { mode: 0o600 });
    await chmod(configFile, 0o600);
    await writeFile(skillFile, template, { mode: 0o600, flag: 'wx' });
    if (addedRules.length) await writeFile(excludePath, `${oldExclude}${oldExclude.endsWith('\n') || !oldExclude ? '' : '\n'}${addedRules.join('\n')}\n`);
  } catch (error) {
    if (before) await writeFile(configFile, before, { mode: 0o600 });
    else await rm(configFile, { force: true });
    await rm(skillDir, { recursive: true, force: true });
    if (addedRules.length) await writeFile(excludePath, oldExclude);
    throw error;
  }
  return { repo, mcp_config: configFile, skill: skillFile };
}

export function createPrompts(input, output) {
  let rl = createInterface({ input, output });
  const ask = async (label, defaultValue) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue || '';
  };
  const required = async (label, defaultValue) => {
    while (true) {
      const answer = await ask(label, defaultValue);
      if (answer) return answer;
      output.write('需要填写此项。\n');
    }
  };
  const confirm = async (label, defaultYes = false) => {
    const answer = (await ask(`${label} (${defaultYes ? 'Y/n' : 'y/N'})`, '')).toLowerCase();
    return answer ? ['y', 'yes'].includes(answer) : defaultYes;
  };
  const secret = async (label) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') throw new Error('Secret 需要在交互式终端输入；请不要通过命令参数或管道传入。');
    rl.pause();
    rl.close();
    output.write(`${label}: `);
    emitKeypressEvents(input);
    const wasRaw = input.isRaw;
    let value = '';
    let onKeypress;
    try {
      input.setRawMode(true);
      input.resume();
      value = await new Promise((resolveSecret, rejectSecret) => {
        onKeypress = (character, key = {}) => {
          if (key.name === 'return' || key.name === 'enter') {
            input.off('keypress', onKeypress);
            resolveSecret(value);
          } else if (key.name === 'backspace' || key.name === 'delete') value = value.slice(0, -1);
          else if (key.ctrl && ['c', 'd'].includes(key.name) || character === '\u0003' || character === '\u0004') {
            input.off('keypress', onKeypress);
            rejectSecret(new Error('Setup cancelled.'));
          } else if (!key.ctrl && !key.meta && character) value += character;
        };
        input.on('keypress', onKeypress);
      });
    } finally {
      if (onKeypress) input.off('keypress', onKeypress);
      if (input.isTTY && typeof input.setRawMode === 'function') input.setRawMode(!!wasRaw);
      output.write('\n');
      rl = createInterface({ input, output });
    }
    if (!value) throw new Error('Secret cannot be empty.');
    return value;
  };
  const close = () => rl.close();
  return { ask, required, confirm, secret, close };
}

async function createAdminTeam(prompts, output) {
  output.write('\n管理员初始化：每位成员先在自己的电脑运行 identity create，再只分享 .public.pem。私钥不要发给管理员。\n\n');
  const id = await prompts.required('你的 agent ID');
  const identityDir = join(homedir(), '.config', 'codex-collab', 'identities');
  const identityPaths = await getOrCreateIdentityFiles(id, identityDir);
  output.write(`本机私钥：${identityPaths.private_key_file}\n交给团队策略使用的公钥：${identityPaths.public_key_file}\n`);
  const agents = [{ id, role: 'admin', capabilities: [], maxConcurrentTasks: 1, publicKey: await readPublicKeyFile(identityPaths.public_key_file) }];
  agents[0].capabilities = splitList(await prompts.required('你的能力标签（逗号分隔，例如 frontend,backend'));
  const wecomUserid = (await prompts.ask('你的企业微信 userid（不启用群命令可留空）')).trim();
  if (wecomUserid) agents[0].wecomUserid = wecomUserid;
  while (await prompts.confirm('添加一位成员？', true)) {
    const memberId = await prompts.required('成员 agent ID');
    if (agents.some((agent) => agent.id === memberId)) throw new Error(`duplicate agent ID: ${memberId}`);
    const publicPath = await prompts.required('成员提供的 .public.pem 文件路径');
    const capabilities = splitList(await prompts.required('成员能力标签（逗号分隔）'));
    const maxConcurrentTasks = Number(await prompts.ask('最大并发任务数（1-16）', '1'));
    const ownerId = (await prompts.ask('该成员的企业微信 userid（可留空）')).trim();
    agents.push({ id: memberId, role: 'member', capabilities, maxConcurrentTasks, publicKey: await readPublicKeyFile(publicPath), ...(ownerId ? { wecomUserid: ownerId } : {}) });
  }
  const capabilities = [...new Set(agents.flatMap((agent) => agent.capabilities))];
  const routes = {};
  for (const capability of capabilities) {
    const eligible = agents.filter((agent) => agent.capabilities.includes(capability)).map((agent) => agent.id);
    const order = splitList(await prompts.ask(`${capability} 的首选与候补顺序（逗号分隔）`, eligible.join(',')));
    routes[capability] = order;
  }
  const reviewer = await prompts.ask('人工审核管理员 agent ID', id);
  const defaultRoute = await prompts.ask('默认任务能力标签', capabilities[0]);
  const repo = await prompts.required('共享代码仓库标识（例如 owner/repo）');
  const teamPath = resolve(await prompts.ask('团队策略文件路径', join(homedir(), 'codex-collab-team.json')));
  const team = buildTeamPolicy({ repo, reviewer, defaultRoute, agents, routes });
  await writeTeamPolicy(teamPath, team);
  output.write(`\n团队策略已创建：${teamPath}\n只分发此 team.json；各成员仍须在自己的电脑运行 setup 并使用自己的私钥。\n`);
  return { teamPath, identityPath: identityPaths.private_key_file, agentId: id };
}

async function configureWeCom(prompts, configPath, config, team, output) {
  if (!(await prompts.confirm('现在配置这台电脑的企业微信机器人？', false))) return false;
  const botId = (await prompts.required('企业微信机器人 Bot ID')).trim();
  const secret = await prompts.secret('企业微信机器人 Secret（输入不回显）');
  const chatIds = splitList(await prompts.required('群 chatid（多个用逗号分隔；获取方式见 docs/onboarding.md）'));
  const canCommand = !!team.agents[config.agent_id].wecom_userid;
  const commandsEnabled = canCommand && await prompts.confirm('允许此机器人接收群内协作命令？', true);
  const next = { ...config, wecom: { bot_id: botId, secret, chat_ids: chatIds, commands_enabled: commandsEnabled } };
  const previous = await readFile(configPath, 'utf8');
  try {
    await writeFile(configPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await chmod(configPath, 0o600);
    await readPeerConfig(configPath);
  } catch (error) {
    await writeFile(configPath, previous, { mode: 0o600 });
    await chmod(configPath, 0o600);
    throw error;
  }
  if (!canCommand) output.write('团队策略尚未配置本成员的企业微信 userid；已设为仅通知。请管理员更新策略后再启用群命令。\n');
  return true;
}

async function joinTeam(prompts, output, initial = {}) {
  output.write('\n成员接入：私钥留在本机；共享仓库必须允许读取 main，并具备推送协作分支的权限。\n\n');
  const teamPath = resolve(initial.teamPath || await prompts.required('管理员提供的 team.json 路径'));
  const identityPath = resolve(initial.identityPath || await prompts.required('本机私有身份文件路径'));
  const identity = await readPrivateJson(identityPath);
  const repoPath = resolve(initial.repoPath || await prompts.required('目标代码仓库 clone 路径'));
  const agentId = identity.agent_id;
  const dataDir = resolve(await prompts.ask('本机协作数据目录', join(homedir(), '.local', 'share', 'codex-collab', agentId)));
  const configPath = resolve(await prompts.ask('本机私有配置文件', join(homedir(), '.config', 'codex-collab', `${agentId}.json`)));
  const rawArgv = await prompts.ask('固定验证命令 argv（JSON 数组，不经 shell 执行）', '["sh", "test.sh"]');
  let parsedArgv;
  try { parsedArgv = JSON.parse(rawArgv); }
  catch { throw new Error('固定验证命令必须是 JSON 字符串数组，例如 ["npm", "test"]'); }
  const { config, team, origin } = await createMemberConfig({ teamPath, identityPath, repoPath, dataDir, configPath, testArgv: parsedArgv });
  output.write(`\n身份 ${agentId} 已验证；共享 origin：${origin}\n执行模式：desktop_poll（不启动后台 Codex SDK）\n`);

  if (await prompts.confirm('把本项目接入 Codex MCP + Skill？（只写本机 project config，不改 origin）', true)) {
    const attached = await attachProject({ configPath, repoPath: config.repo });
    output.write(`MCP 配置：${attached.mcp_config}\nSkill：${attached.skill}\n`);
  }
  const promptPath = join(dataDir, 'bind-prompt.txt');
  await writeFile(promptPath, bindingPrompt(agentId, config.repo), { mode: 0o600, flag: 'wx' });
  await configureWeCom(prompts, configPath, config, team, output);

  const diagnosis = await diagnosePeer(configPath, { testPush: true });
  output.write('\n连接检查：\n');
  for (const [name, result] of Object.entries(diagnosis.checks)) output.write(`- ${name}: ${result}\n`);
  if (await prompts.confirm('现在初始化/同步共享 agent-collab 账本分支？首次初始化会向 origin 推送该分支。', true)) {
    await loadRuntime(configPath);
    output.write('共享账本分支已就绪。\n');
  }
  const { config: finalConfig } = await readPeerConfig(configPath);
  if (finalConfig.wecom && await prompts.confirm('现在启动本机 Runner/企微连接？请确认同一个 Bot 没有在其他进程连接。', false)) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/peer/cli.mjs'), 'start', configPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.status !== 0) throw new Error(`Runner 未能启动；请运行 codex-collab start ${configPath} 并检查本机私有日志。`);
    output.write(result.stdout.trim() + '\n');
  }
  output.write(`\n配置完成。下一步：在 Codex 打开该项目、重载 MCP，然后把此文件内容发到计划接活的对话：\n${promptPath}\n`);
  output.write('对话绑定和 heartbeat 必须在目标 Codex 对话中完成；MCP 不会自行唤醒闲置对话。\n');
  return { configPath, promptPath };
}

export async function runSetupWizard({ input = process.stdin, output = process.stdout, role } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('setup requires an interactive terminal; run codex-collab setup in Terminal.');
  const prompts = createPrompts(input, output);
  try {
    output.write('Codex Collab setup\n');
    let selectedRole = role;
    if (!selectedRole) {
      output.write('1. 初始化团队（管理员）\n2. 加入现有团队（成员）\n');
      const choice = await prompts.ask('选择 1 或 2', '2');
      if (!['1', '2'].includes(choice)) throw new Error('请选择 1（管理员）或 2（成员）');
      selectedRole = choice === '1' ? 'admin' : 'member';
    }
    let initial = {};
    if (selectedRole === 'admin') initial = await createAdminTeam(prompts, output);
    if (selectedRole !== 'admin' && selectedRole !== 'member') throw new Error('role must be admin or member');
    return await joinTeam(prompts, output, initial);
  } finally { prompts.close(); }
}
