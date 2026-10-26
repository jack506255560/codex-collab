import { resolveRemote } from '../../packages/peer/repository.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  const displayName = (input.display_name || input.agent_id || '我的开发助手').trim();
  if (!displayName || displayName.length > 80 || /[\x00-\x1f\x7f]/.test(displayName)) throw new SetupError('请填写成员或机器人名称，最多 80 个字符。');
  const slug = displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  // Numbered Chinese defaults must not collide when the wizard is reopened.
  const botId = typeof input.bot_id === 'string' ? input.bot_id.trim() : '';
  const automaticId = !/[a-z]/.test(slug) && botId ? `agent-${createHash('sha256').update(botId).digest('hex').slice(0, 12)}` : slug;
  const agentId = input.agent_id?.trim() || automaticId || `agent-${randomBytes(4).toString('hex')}`;
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
  const add = (argv, source, label = '测试') => commands.push({ argv, command: displayCommand(argv), source, label });
  if (files.has('test.sh')) add(['sh', 'test.sh'], '项目根目录的 test.sh');
  if (files.has('package.json')) {
    try {
      const value = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
      const manager = /^(npm|pnpm|yarn|bun)@/.exec(value.packageManager)?.[1]
        || (files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : files.has('bun.lock') || files.has('bun.lockb') ? 'bun' : 'npm');
      for (const [name, label] of [['test', '测试'], ['check', '项目检查'], ['typecheck', '类型检查'], ['lint', '代码规范检查'], ['build', '构建检查']]) {
        const script = value.scripts?.[name];
        if (typeof script !== 'string' || !script.trim() || name === 'test' && /no test specified/i.test(script)) continue;
        add(name === 'test' ? [manager, 'test'] : [manager, 'run', name], `package.json 的 scripts.${name}`, label);
      }
    } catch { /* A suggestion never executes or repairs project files. */ }
  }
  if (files.has('go.mod')) add(['go', 'test', './...'], '项目根目录的 go.mod');
  if (files.has('Cargo.toml')) add(['cargo', 'test'], '项目根目录的 Cargo.toml');
  if (files.has('pom.xml')) add([files.has('mvnw') ? './mvnw' : 'mvn', 'test'], '项目根目录的 pom.xml');
  if (files.has('build.gradle') || files.has('build.gradle.kts')) add([files.has('gradlew') ? './gradlew' : 'gradle', 'test'], '项目根目录的 Gradle 构建配置');
  let pytestSource = ['pytest.ini', 'conftest.py'].find((file) => files.has(file));
  for (const file of ['pyproject.toml', 'tox.ini', 'setup.cfg']) {
    if (pytestSource || !files.has(file)) continue;
    try {
      if (/^\s*\[(?:tool\.pytest\.ini_options|pytest|tool:pytest)\]\s*$/m.test(await readFile(join(repo, file), 'utf8'))) pytestSource = file;
    } catch { /* An unreadable optional config must not block other suggestions. */ }
  }
  if (pytestSource) add(['python', '-m', 'pytest'], `${pytestSource} 中的 pytest 配置`);
  return [...commands.filter((item) => item.label === '测试'), ...commands.filter((item) => item.label !== '测试')];
}
// Resolve once at enrollment and share the same fixed check with every member.
// A repository with no test entry can still enroll. This is a whitespace check,
// NOT a substitute for functional tests; executors also check the committed diff.
export async function projectVerification(repo, input = {}) {
  if (input.test_mode != null && !['auto', 'custom'].includes(input.test_mode)) throw new SetupError('请选择自动检查或自定义检查。');
  if (input.test_mode === 'custom' || input.test_mode !== 'auto' && input.test_command?.trim()) return commandArgv(input.test_command);
  if (input.test_mode !== 'auto' && input.test_argv !== undefined) {
    const argv = input.test_argv;
    if (!Array.isArray(argv) || !argv.length || argv.length > 32 || argv.some((part) => typeof part !== 'string' || !part || part.length > 2000)) throw new SetupError('代码检查命令必须是非空字符串数组。');
    return argv;
  }
  return (await recommendTests(repo))[0]?.argv || ['git', 'diff', '--check'];
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
