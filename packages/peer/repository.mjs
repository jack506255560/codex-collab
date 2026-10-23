import { git } from './git.mjs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Full refs are passed as individual argv entries; reject refspec/revision syntax.
export function isBranchName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && value !== 'HEAD' && value !== '@' && !value.startsWith('-') && !value.endsWith('.')
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
    && value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'));
}
export const isCommit = (value) => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
export const teamBaseBranch = (team) => team.base_branch ?? 'main';
export function remoteIdentity(remote) {
  if (remote.startsWith('file:')) { try { return resolve(fileURLToPath(remote)); } catch { return remote; } }
  if (isAbsolute(remote)) return resolve(remote);
  const scp = remote.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  try {
    const url = new URL(remote);
    if (['https:', 'http:', 'ssh:'].includes(url.protocol)) return `${url.hostname.toLowerCase()}${url.port && !(url.protocol === 'ssh:' && url.port === '22') ? `:${url.port}` : ''}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`;
  } catch { /* Local paths and scp-style SSH addresses are also supported. */ }
  if (scp && !remote.startsWith('/')) return `${scp[1].toLowerCase()}/${scp[2].replace(/\/+$/g, '').replace(/\.git$/, '')}`;
  return remote;
}
export class RepositoryError extends Error {}
function absoluteRemote(repo, url) {
  return isAbsolute(url) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || /^(?:[^@/]+@)?[^:/]+:/.test(url) ? url : resolve(repo, url);
}

export async function resolveRemote(repo, { remoteName, expectedRemote, allowSelection = false, legacyOrigin = false } = {}) {
  const names = (await git(repo, 'remote')).split('\n').filter(Boolean);
  if (!names.length) throw new RepositoryError('该项目尚未配置远程仓库，请先添加业务仓库的 Git 远程地址。');
  const remotes = await Promise.all(names.map(async (name) => ({ name, url: absoluteRemote(repo, await git(repo, 'remote', 'get-url', name)) })));
  let candidates = remotes;
  if (remoteName) {
    if (typeof remoteName !== 'string' || !names.includes(remoteName)) throw new RepositoryError('选择的远程不存在，请重新检查项目。');
    candidates = remotes.filter((remote) => remote.name === remoteName);
  }
  if (expectedRemote) {
    candidates = candidates.filter((remote) => remoteIdentity(remote.url) === remoteIdentity(absoluteRemote(repo, expectedRemote)));
    if (!candidates.length) throw new RepositoryError('该目录的远程与邀请仓库不一致，请选择正确仓库；工具不会改写远程配置。');
  }
  if (legacyOrigin && !remoteName && !expectedRemote && candidates.some(({ name }) => name === 'origin')) candidates = candidates.filter(({ name }) => name === 'origin');
  if (new Set(candidates.map((remote) => remoteIdentity(remote.url))).size > 1) {
    if (allowSelection) return { remote_name: null, remote: null, remotes: candidates.map(({ name }) => name), selection_required: 'remote' };
    throw new RepositoryError('项目有多个不同的远程仓库，请先检查项目并选择用于协作的远程。');
  }
  const selected = candidates.find((remote) => remote.name === 'origin') || candidates[0];
  const pushUrls = (await git(repo, 'remote', 'get-url', '--push', '--all', selected.name)).split('\n').filter(Boolean);
  if (pushUrls.some((url) => remoteIdentity(absoluteRemote(repo, url)) !== remoteIdentity(selected.url))) throw new RepositoryError('所选远程的拉取和推送地址指向不同仓库，请选择读写同一团队仓库的远程。');
  return { remote_name: selected.name, remote: selected.url, push_url: absoluteRemote(repo, pushUrls[0] || selected.url), remotes: remotes.map(({ name }) => name) };
}

export async function inspectRepository(repo, { remoteName, expectedRemote, baseBranch, allowSelection = false, legacyOrigin = false } = {}) {
  const selected = await resolveRemote(repo, { remoteName, expectedRemote, allowSelection, legacyOrigin });
  if (selected.selection_required) return { ...selected, branches: [], base_branch: null };
  if (baseBranch !== undefined && baseBranch !== '' && (!isBranchName(baseBranch) || baseBranch === 'agent-collab')) throw new RepositoryError('请选择有效的业务基准分支，不能使用协作账本分支。');
  const refs = await git(repo, 'ls-remote', '--symref', selected.remote_name, 'HEAD', 'refs/heads/*');
  const heads = new Map(refs.split('\n').map((line) => line.match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?)\trefs\/heads\/(.+)$/)).filter(Boolean).map((match) => [match[2], match[1]]));
  const branches = [...heads.keys()].filter((name) => name !== 'agent-collab' && isBranchName(name)).sort();
  if (!branches.length) throw new RepositoryError('远程仓库为空或没有业务分支，请先推送业务代码分支，再重新检查项目。');
  const defaultBranch = refs.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
  const branch = baseBranch || (branches.includes(defaultBranch) ? defaultBranch : branches.length === 1 ? branches[0] : null);
  if (branch && !branches.includes(branch)) throw new RepositoryError('远程不存在所选基准分支，请重新检查项目并选择。');
  if (!branch && !allowSelection) throw new RepositoryError('远程默认分支无法确定，请先检查项目并选择业务基准分支。');
  return { ...selected, branches, base_branch: branch, base_commit: branch ? heads.get(branch) : null, ...(!branch ? { selection_required: 'branch' } : {}) };
}
