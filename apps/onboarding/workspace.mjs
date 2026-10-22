import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { git } from '../../packages/peer/store.mjs';

export const workspaceHome = () => resolve(process.env.CODEX_COLLAB_HOME || join(homedir(), '.config/codex-collab/workspace'));
export async function localDefaults(cwd = process.cwd()) {
  let repo = '';
  try { repo = await git(cwd, 'rev-parse', '--show-toplevel'); } catch { /* Opening outside a project is supported. */ }
  return { repo, display_name: userInfo().username };
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
  if (!choices.length) throw new Error('未找到已接入项目。请先运行 codex-collab 完成接入。');
  throw new Error(`找到多个接入，请使用 --profile <项目ID> 选择：\n${choices.map((state) => `${state.id}  ${state.agent_id}  ${state.repo}`).join('\n')}`);
}
