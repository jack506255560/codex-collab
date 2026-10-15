import { mkdir, readFile, writeFile, stat, rm, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPeerConfig } from '../../apps/peer/runtime.mjs';
import { git } from '../../packages/peer/store.mjs';
const tools = fileURLToPath(new URL('../../', import.meta.url));
const absent = async (path) => { try { await stat(path); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
const readOptional = async (path) => { try { return await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

export function bindingPrompt(agentId, repo) {
  return `使用 $team-collab-desktop，启用当前项目的团队协作，将 ${agentId} 机器人绑定到当前对话。项目：${repo}`;
}
export function detailedBindingPrompt(agentId, repo) {
  return `请把当前已有 Codex 对话设为 ${agentId} 的企微协作执行对话，不要新建独立执行线程。\n项目：${repo}\n读取 ${join(repo, '.agents/skills/team-collab-desktop/SKILL.md')}。\n1. 用本项目 MCP 的 get_identity 确认身份是 ${agentId}，execution_mode 是 desktop_poll；若不匹配，停止并提示重新加载 MCP。\n2. 获取当前真实对话 ID：优先使用已提供的应用上下文，或当前终端 CODEX_THREAD_ID（如果存在）；不可猜 ID 或读取/修改应用数据库。没有可用 ID 时请让我复制当前对话 ID/链接。\n3. 调用 bind_desktop_thread 绑定当前真实对话，然后用应用 automation_update 工具在当前已有对话创建一个 heartbeat：每分钟检查（仅当工具接受该周期；否则说明限制），不要创建 cron、新对话或后台 SDK。先查现有 automation，避免重复；不要修改无关 automation 或 CC Switch。\n4. heartbeat 的保存提示词必须包含 ${agentId}、当前真实 thread_id 和该 skill 路径；每次 get_identity → poll_desktop_task。job=null 且 requests 为空 时保持安静；有任务就只在本对话和返回的隔离 worktree 执行本阶段，主动续租、测试、明确提交，然后 finish_desktop_task；失败时按 skill 处理。requests 非空时按 Skill 理解群消息，调用 resolve_desktop_request 创建任务、转达明确的真人审核、追问或回答；使用 team_context 的现有路由、能力与默认分工，不能猜测不存在的同事。解决后再次 poll 开始工作。真人自然语言审核仅能通过 request.review_context 中的固定版本转达；多任务、语义不清或版本变化时先追问，不得自行批准、完成或合并。复用或更新当前对话已有的协作 heartbeat，避免重复创建。禁止启动 SDK/CLI 代替当前对话。仅新任务、结果、失败或需我操作时通知。\n5. 创建完成后立即调用一次 poll_desktop_task 验证，无任务应正常返回，不要创建测试任务。告诉我绑定身份、对话 ID 和 heartbeat 状态；若工具不可用明确说明未启用自动轮询。\n`;
}

// An explicit project attachment: preserve unrelated TOML settings, keep a local
// rollback record, and never rewrite global Codex/provider/auth settings.
export async function setupDesktopProject({ configPath, repo }) {
  if (!isAbsolute(configPath || '') || !isAbsolute(repo || '')) throw new Error('absolute config/project paths required');
  const { config } = await readPeerConfig(configPath);
  if (config.execution_mode !== 'desktop_poll' || config.auto_execute !== false) throw new Error('source config must be desktop_poll with SDK disabled');
  repo = await realpath(repo);
  if (await git(repo, 'rev-parse', '--show-toplevel') !== repo || await git(repo, 'status', '--porcelain')) throw new Error('project must be a clean Git clone root; no user changes are overwritten');
  const origin = await git(config.repo, 'remote', 'get-url', 'origin');
  const oldOrigin = await git(repo, 'remote', 'get-url', 'origin');
  const main = (await git(config.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main')).split(/\s/)[0];
  if (await git(repo, 'rev-parse', 'refs/heads/main') !== main) throw new Error('project main must match the test remote before attachment');
  const configFile = join(repo, '.codex', 'config.toml');
  const before = await readOptional(configFile);
  const serverName = `team-collab-${config.agent_id}`;
  if (before?.includes(`[mcp_servers.${serverName}.`)) throw new Error('nested MCP settings need manual review; config was not modified');
  const block = `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(tools, 'apps/peer/mcp-main.mjs'))}, ${JSON.stringify(join(dirname(configPath), `${config.agent_id}-desktop-peer.json`))}]\n`;
  const pattern = new RegExp(`^\\[mcp_servers\\.${serverName}\\][^]*?(?=^\\[|$(?![^]))`, 'm');
  const toml = pattern.test(before || '') ? before.replace(pattern, block + '\n') : (before || '') + '\n' + block;
  const skillDir = join(repo, '.agents', 'skills', 'team-collab-desktop');
  const desktopConfig = join(dirname(configPath), `${config.agent_id}-desktop-peer.json`);
  const backup = join(dirname(configPath), `${config.agent_id}-project-backup.json`);
  const prompt = join(dirname(configPath), `${config.agent_id}-bind-prompt.txt`);
  for (const path of [skillDir, desktopConfig, backup, prompt]) if (!await absent(path)) throw new Error('desktop attachment already exists; inspect the local backup before reconfiguring');
  const excludePath = await git(repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  const oldExclude = await readFile(excludePath, 'utf8');
  await writeFile(backup, JSON.stringify({ repo, old_origin: oldOrigin, config_toml: before, git_exclude: oldExclude, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  try {
    await writeFile(desktopConfig, JSON.stringify({ ...config, repo }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
    await writeFile(configFile, toml, { mode: 0o600 });
    await mkdir(skillDir, { recursive: true, mode: 0o700 });
    await writeFile(join(skillDir, 'SKILL.md'), await readFile(join(tools, 'packages/codex-kit/templates/.agents/skills/team-collab-desktop/SKILL.md')), { mode: 0o600, flag: 'wx' });
    await writeFile(excludePath, `${oldExclude}\n/.codex/config.toml\n/.agents/skills/team-collab-desktop/\n/.codex-collab-worktrees/\n`);
    await git(repo, 'remote', 'set-url', 'origin', origin);
    await writeFile(prompt, bindingPrompt(config.agent_id, repo), { mode: 0o600, flag: 'wx' });
    return { agent_id: config.agent_id, repo, desktop_config: desktopConfig, binding_prompt: prompt, backup, sdk_enabled: false, heartbeat_created: false };
  } catch (error) {
    await git(repo, 'remote', 'set-url', 'origin', oldOrigin);
    await writeFile(excludePath, oldExclude);
    if (before === null) await rm(configFile, { force: true }); else await writeFile(configFile, before, { mode: 0o600 });
    await rm(skillDir, { recursive: true, force: true });
    for (const path of [desktopConfig, prompt]) await rm(path, { force: true });
    // Keep the 0600 rollback record for inspection after a partial failure.
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await setupDesktopProject({ configPath: process.argv[2], repo: process.argv[3] }), null, 2)); }
  catch { console.error('Desktop attachment failed; check clean project/main and private rollback record. Secrets were not printed.'); process.exitCode = 1; }
}
