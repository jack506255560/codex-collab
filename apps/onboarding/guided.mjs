import { resolveRemote } from '../../packages/peer/repository.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git } from '../../packages/peer/store.mjs';
import { SetupError } from './errors.mjs';

export const responsibilities = {
  frontend: ['frontend'], backend: ['backend'], fullstack: ['frontend', 'backend'],
  testing: ['testing'], docs: ['docs'], general: ['general'],
};
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
export function memberFields(input) {
  if (input.display_name != null && typeof input.display_name !== 'string' || input.agent_id != null && typeof input.agent_id !== 'string') throw new SetupError('成员名称和内部 Agent ID 应是文字。');
  const displayName = (input.display_name || input.agent_id || '').trim();
  if (!displayName || displayName.length > 80 || /[\x00-\x1f\x7f]/.test(displayName)) throw new SetupError('请填写成员或机器人名称，最多 80 个字符。');
  const agentId = input.agent_id?.trim() || displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || `agent-${randomBytes(4).toString('hex')}`;
  if (!idPattern.test(agentId)) throw new SetupError('内部 Agent ID 请使用英文、数字、下划线或连字符。');
  const raw = input.capabilities || responsibilities[input.responsibility || 'general'];
  const caps = typeof raw === 'string' ? raw.split(/[\s,，]+/).filter(Boolean) : raw;
  if (!Array.isArray(caps) || !caps.length || caps.length > 16 || caps.some((cap) => typeof cap !== 'string' || !idPattern.test(cap))) throw new SetupError('自定义职责标签请使用英文、数字、下划线或连字符。');
  return { agent_id: agentId, display_name: displayName, capabilities: [...new Set(caps)] };
}

// Convert a confirmed command to argv. Never add a shell or evaluate substitutions.
export function commandArgv(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000 || /[\x00\r\n]/.test(command)) throw new SetupError('请确认验证命令，例如 npm test 或 go test ./...。');
  const argv = []; let word = '', quote = null, escaped = false, started = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { argv.push(word); word = ''; started = false; } continue; }
    if (/[;&|<>`$()]/.test(char)) throw new SetupError('验证命令请填写一个程序及参数，不支持管道、重定向或命令拼接。多个检查请写进项目测试脚本。');
    word += char; started = true;
  }
  if (quote || escaped) throw new SetupError('验证命令的引号或转义未闭合。');
  if (started) argv.push(word);
  if (!argv.length || argv.length > 32 || argv.some((part) => !part || part.length > 2000)) throw new SetupError('验证命令参数无效。');
  return argv;
}
export function displayCommand(argv) {
  return argv.map((part) => /^[\w./:@=-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ');
}
export async function recommendTests(repo) {
  const files = new Set(await readdir(repo)); const commands = [];
  if (files.has('test.sh')) commands.push(['sh', 'test.sh']);
  if (files.has('package.json')) {
    try { const value = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')); if (typeof value.scripts?.test === 'string' && value.scripts.test.trim()) commands.push(['npm', 'test']); } catch { /* A suggestion never executes or repairs project files. */ }
  }
  if (files.has('go.mod')) commands.push(['go', 'test', './...']);
  if (files.has('Cargo.toml')) commands.push(['cargo', 'test']);
  return commands.map((argv) => ({ argv, command: displayCommand(argv) }));
}
export function suggestedRepo(remote, agentId) {
  if (typeof remote !== 'string' || !remote.trim()) throw new SetupError('请填写业务仓库地址。');
  const name = remote.split(/[/:]/).at(-1).replace(/\.git$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'project';
  return join(homedir(), 'codex-projects', `${name}-${agentId}`);
}
function validCloneRemote(remote) {
  if (typeof remote !== 'string' || !remote || remote.length > 4000 || /[\x00-\x1f\x7f]/.test(remote) || remote.startsWith('-')) throw new SetupError('仓库地址无效。');
  if (isAbsolute(remote)) return;
  if (/\s/.test(remote)) throw new SetupError('仓库地址不能包含空白字符。'); // Also supports a team's local/offline Git mirror.
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(remote)) return;
  let url; try { url = new URL(remote); } catch { throw new SetupError('请使用 HTTPS 或 SSH 仓库地址。'); }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash || url.protocol !== 'ssh:' && url.username) throw new SetupError('请使用 HTTPS 或 SSH 仓库地址，并通过本机 Git 登录；不要在地址中填写 Token。');
}
const inside = (parent, child) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith('../') && !isAbsolute(path); };
export async function cloneRepository({ remote, destination, privateHome }) {
  validCloneRemote(remote);
  if (typeof destination !== 'string' || !isAbsolute(destination)) throw new SetupError('请选择新 clone 的本机绝对路径。');
  const target = resolve(destination);
  privateHome = await realpath(privateHome).catch((error) => { if (error.code === 'ENOENT') return resolve(privateHome); throw error; });
  // Keep the private workspace outside the target repo and vice versa.
  if (inside(target, privateHome) || inside(privateHome, target)) throw new SetupError('项目目录和本机私有配置目录不能相互包含。');
  let existing; try { existing = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.isSymbolicLink()) throw new SetupError('拉取目录不能是符号链接，请选择独立目录。');
    try {
      const actual = await realpath(target);
      if (await git(actual, 'rev-parse', '--show-toplevel') === actual && !!await resolveRemote(actual, { expectedRemote: remote })) return actual;
    } catch { /* Reject existing unrelated folders instead of overwriting them. */ }
    throw new SetupError('目标目录已存在，请选择新的目录，或切换到使用已有项目。');
  }
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target)); const actualTarget = join(parent, basename(target));
  if (inside(actualTarget, privateHome) || inside(privateHome, actualTarget)) throw new SetupError('项目目录和本机私有配置目录不能相互包含。');
  await mkdir(actualTarget, { mode: 0o700 });
  const staging = join(parent, `.collab-clone-${randomUUID()}`);
  try {
    await git(parent, '-c', 'protocol.ext.allow=never', 'clone', '--', remote, staging);
    if ((await readdir(actualTarget)).length) throw new SetupError('拉取目录出现其他文件，请选择新目录后重试。');
    await rename(staging, actualTarget);
    return actualTarget;
  } catch (error) {
    if (error instanceof SetupError) throw error;
    const detail = `${error.stderr || ''}\n${error.message || ''}`.toLowerCase();
    if (/permission denied|authentication failed|could not read username|repository not found|403|401/.test(detail)) throw new SetupError('拉取仓库失败，请先完成本机 Git 登录并确认仓库读取权限。');
    throw new SetupError('拉取仓库未完成，请检查仓库地址、网络和本机 Git 权限后重试。');
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rmdir(actualTarget).catch(() => {}); // Only remove our empty reservation, never project files.
  }
}
