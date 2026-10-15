import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPeerConfig } from '../../apps/peer/runtime.mjs';
import { git } from '../../packages/peer/store.mjs';
import { bindingPrompt } from './setup-desktop-project.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const legacyHashes = new Set(['46543ca4fe00836f0ae0d7d7c12ea2756c9ab0220f01d29c391d608c5e405c53', '6e4d1ea6a644fb3078c541e40bcc9e8bf5069462994152f3ec2fc3aa5fedd5fa', 'f98ad425e2ea3c8ab6fb86febef7d9cb288029ef55bea6937dda6de8b467fece']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const inside = (parent, child) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('../') && !isAbsolute(path); };
async function plainPath(base, path) {
  let current = base;
  for (const part of relative(base, path).split('/').filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('协作配置或 Skill 是符号链接，请先手动检查；未覆盖文件。');
  }
}
async function privateWrite(path, contents) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' }); await rename(temporary, path); await chmod(path, 0o600); }
  finally { await rm(temporary, { force: true }); }
}
// Only recognize our generated MCP entry. Never replace another identity's entry.
export async function installedProjectConfig({ repoPath, agentId }) {
  const repo = await realpath(repoPath);
  const path = join(repo, '.codex/config.toml'); await plainPath(repo, path);
  const before = await readFile(path, 'utf8');
  const server = `team-collab-${agentId}`;
  const headers = [...before.matchAll(/^\s*\[([^\]\n]+)\][^\n]*$/gm)];
  if (headers.some((item) => item[1].startsWith(`mcp_servers.${server}.`))) throw new Error('协作 MCP 有自定义嵌套配置，请手动检查；未覆盖文件。');
  const matching = headers.filter((item) => item[1] === `mcp_servers.${server}`);
  if (matching.length !== 1) throw new Error('未找到唯一的已安装协作 MCP，请先完成项目接入。');
  const header = matching[0]; const end = headers.find((item) => item.index > header.index)?.index ?? before.length;
  const section = before.slice(header.index, end);
  const argsLine = section.match(/^args\s*=\s*(\[[^\n]+\])\s*$/m);
  const commandLine = section.match(/^command\s*=\s*("[^\n]+")\s*$/m);
  let args, command;
  try { args = JSON.parse(argsLine?.[1]); command = JSON.parse(commandLine?.[1]); } catch { /* reject below */ }
  if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== 'string' || !args[0].endsWith('/apps/peer/mcp-main.mjs') || !isAbsolute(args[1] || '') || typeof command !== 'string' || !command) throw new Error('协作 MCP 不是可识别的安装配置，请手动检查；未覆盖文件。');
  const keys = section.split(/\r?\n/).filter((line) => line.trim() && !/^\s*(?:#|\[)/.test(line));
  if (keys.length !== 2) throw new Error('协作 MCP 有自定义设置，请手动检查；未覆盖文件。');
  return { repo, path, before, section, config_path: args[1], command, args };
}
export async function refreshProject({ configPath }) {
  if (!isAbsolute(configPath || '')) throw new Error('usage: codex-collab refresh-project /absolute/private-peer.json');
  const { config } = await readPeerConfig(configPath);
  if (config.execution_mode !== 'desktop_poll' || config.auto_execute !== false) throw new Error('refresh-project 需要 desktop_poll 配置且 SDK 已关闭。');
  const installed = await installedProjectConfig({ repoPath: config.repo, agentId: config.agent_id });
  const { repo, path: configFile, before, section } = installed;
  if (await git(repo, 'rev-parse', '--show-toplevel') !== repo || await realpath(installed.config_path) !== await realpath(configPath)) throw new Error('项目 MCP 已绑定其他配置，请使用该 MCP 实际使用的个人配置路径；未更换身份。');
  const skillFile = join(repo, '.agents/skills/team-collab-desktop/SKILL.md');
  await plainPath(repo, skillFile);
  if (await git(repo, 'ls-files', '--', '.codex/config.toml', '.agents/skills/team-collab-desktop')) throw new Error('协作配置或 Skill 已提交到项目 Git，请手动合并；未覆盖共享文件。');
  const oldSkill = await readFile(skillFile, 'utf8');
  const template = await readFile(join(root, 'packages/codex-kit/templates/.agents/skills/team-collab-desktop/SKILL.md'), 'utf8');
  if (oldSkill !== template && !legacyHashes.has(hash(oldSkill))) throw new Error('协作 Skill 已自定义，请手动合并自然语言处理说明；未覆盖文件。');
  const nextSection = section.replace(/^command\s*=.*$/m, `command = ${JSON.stringify(process.execPath)}`).replace(/^args\s*=.*$/m, `args = ${JSON.stringify([join(root, 'apps/peer/mcp-main.mjs'), installed.config_path])}`);
  const next = before.replace(section, () => nextSection);
  if (inside(repo, resolve(config.data_dir))) throw new Error('个人数据目录必须位于项目仓库之外。');
  await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
  const dataDir = await realpath(config.data_dir);
  if (inside(repo, dataDir)) throw new Error('个人数据目录必须位于项目仓库之外。');
  const prompt = join(dataDir, 'desktop-binding-prompt.txt');
  const changed = next !== before || oldSkill !== template;
  let backup = null;
  if (changed) {
    backup = join(dataDir, `project-refresh-${randomUUID()}.json`);
    await writeFile(backup, JSON.stringify({ repo, config_toml: before, skill: oldSkill, created_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    try { await privateWrite(configFile, next); await privateWrite(skillFile, template); }
    catch (error) { await privateWrite(configFile, before); await privateWrite(skillFile, oldSkill); throw error; }
  }
  await privateWrite(prompt, bindingPrompt(config.agent_id, repo));
  return { agent_id: config.agent_id, repo, changed, mcp_config: configFile, skill: skillFile, backup, binding_prompt: prompt,
    next_step: '重新加载项目 MCP；把 binding_prompt 内容发送到原绑定对话，以更新原协作 heartbeat。', heartbeat_updated: false };
}
