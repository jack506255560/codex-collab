import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { git } from '../../packages/peer/store.mjs';
import { SetupError } from './errors.mjs';

// One persistent workspace per OS user, shared by npm, source and login services.
// Working directories and the legacy CODEX_COLLAB_HOME must not fork real profiles.
export const workspaceHome = () => resolve(join(homedir(), '.config/codex-collab/workspace'));
export async function browseLocal({ path = homedir(), kind = 'directory' } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || !['directory', 'config'].includes(kind)) throw new SetupError('请选择本机文件夹。');
  try {
    const current = await realpath(path), entries = await readdir(current, { withFileTypes: true });
    const items = entries.filter((entry) => entry.isDirectory() && !['.git', 'node_modules', '.Trash'].includes(entry.name) || kind === 'config' && entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
    return { path: current, parent: resolve(current, '..'), entries: items.map((entry) => ({ name: entry.name, path: join(current, entry.name), directory: entry.isDirectory() })) };
  } catch { throw new SetupError('无法打开这个文件夹，请返回上一级，或选择有访问权限的文件夹。'); }
}
export async function localDefaults(cwd = process.cwd(), knownRepos = [], { codexHome = join(homedir(), '.codex') } = {}) {
  let repo = '';
  try { repo = await git(cwd, 'rev-parse', '--show-toplevel'); } catch { /* Opening outside a project is supported. */ }
  // Only inspect explicitly known projects, not arbitrary folders on the disk.
  const candidates = [repo, ...knownRepos];
  const config = await readFile(join(codexHome, 'config.toml'), 'utf8').catch(() => '');
  for (const match of config.matchAll(/^\s*\[projects\.("(?:[^"\\]|\\.)*")\]\s*$/gm)) {
    try { const path = JSON.parse(match[1]); if (isAbsolute(path)) candidates.push(path); } catch { /* Ignore unsupported TOML spellings. */ }
  }
  const projects = [...new Set((await Promise.all([...new Set(candidates.filter(Boolean))].slice(0, 40).map(async (path) => {
    try { return await git(path, 'rev-parse', '--show-toplevel'); } catch { return null; }
  }))).filter(Boolean))];
  return { repo, display_name: userInfo().username, projects };
}
export async function profiles(home = workspaceHome()) {
  const root = join(home, 'profiles'); const result = [];
  const entries = await readdir(root).catch((error) => { if (error.code === 'ENOENT') return []; throw error; });
  for (const id of entries) {
    if (!/^[a-f0-9-]{36}$/.test(id)) continue;
    const state = JSON.parse(await readFile(join(root, id, 'setup.json'), 'utf8'));
    if (state.phase !== 'removed') result.push({ ...state, config_path: state.existing_config || join(root, id, 'peer.json') });
  }
  return result;
}
export async function selectProfile({ home = workspaceHome(), selector, cwd = process.cwd() } = {}) {
  let choices = (await profiles(home)).filter((state) => state.phase === 'ready');
  if (selector) choices = choices.filter((state) => state.id === selector || state.agent_id === selector);
  else {
    const { repo } = await localDefaults(cwd);
    if (repo) {
      const matches = [];
      for (const state of choices) if (await realpath(state.repo).catch(() => '') === repo) matches.push(state);
      if (matches.length) choices = matches;
    }
  }
  if (choices.length === 1) return choices[0];
  if (!choices.length) throw new Error('未找到已接入项目。请先运行 codex-collab setup 完成接入。');
  throw new Error(`找到多个接入，请使用 --profile <项目ID> 选择：\n${choices.map((state) => `${state.id}  ${state.agent_id}  ${state.repo}`).join('\n')}`);
}
