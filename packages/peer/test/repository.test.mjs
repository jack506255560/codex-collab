import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { inspectRepository, resolveRemote, remoteIdentity, isBranchName } from '../repository.mjs';
import { validateSpec } from '../protocol.mjs';
import { validateTeam } from '../config.mjs';
import { fixture, git } from '../../../apps/onboarding/test/helpers.mjs';

const initBare = (path, branch) => execFileSync('git', ['init', '--bare', `--initial-branch=${branch}`, path], { stdio: 'ignore' });

test('repository detection supports custom aliases, defaults, explicit baselines and relative local URLs', async () => {
  const f = await fixture();
  try {
    git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
    git(f.repos.alice, 'push', 'origin', 'HEAD:develop', 'HEAD:master', ':main');
    git(f.repos.alice, 'remote', 'rename', 'origin', 'upstream');
    git(f.repos.alice, 'remote', 'set-url', 'upstream', '../origin.git');
    const auto = await inspectRepository(f.repos.alice);
    assert.equal(auto.remote_name, 'upstream'); assert.equal(auto.remote, f.remote);
    assert.equal(auto.base_branch, 'develop'); assert.deepEqual(auto.branches, ['develop', 'master']);
    assert.equal(auto.base_commit, git(f.repos.alice, 'rev-parse', 'HEAD'));
    assert.equal((await inspectRepository(f.repos.alice, { baseBranch: 'master' })).base_branch, 'master');
    await assert.rejects(inspectRepository(f.repos.alice, { baseBranch: 'nonexistent' }), /不存在所选基准分支/);
  } finally { await f.cleanup(); }
});

test('ambiguous remotes require selection and invitations match repository identity across aliases', async () => {
  const f = await fixture();
  try {
    const fork = join(f.root, 'fork.git'); initBare(fork, 'main');
    git(f.repos.bob, 'remote', 'rename', 'origin', 'team'); git(f.repos.bob, 'remote', 'add', 'origin', fork);
    const pending = await inspectRepository(f.repos.bob, { allowSelection: true });
    assert.equal(pending.selection_required, 'remote'); assert.deepEqual(pending.remotes, ['origin', 'team']);
    await assert.rejects(inspectRepository(f.repos.bob), /多个不同/);
    const explicit = await inspectRepository(f.repos.bob, { remoteName: 'team' });
    assert.equal(explicit.base_branch, 'main'); assert.deepEqual(explicit.remotes, ['origin', 'team']);
    assert.equal((await resolveRemote(f.repos.bob, { legacyOrigin: true })).remote_name, 'origin');
    assert.equal((await inspectRepository(f.repos.bob, { expectedRemote: f.remote })).remote_name, 'team');
    await assert.rejects(resolveRemote(f.repos.bob, { remoteName: 'origin', expectedRemote: f.remote }), /邀请仓库不一致/);
    git(f.repos.bob, 'remote', 'set-url', '--push', 'team', fork);
    await assert.rejects(resolveRemote(f.repos.bob, { remoteName: 'team' }), /拉取和推送地址/);
  } finally { await f.cleanup(); }
});

test('missing remote HEAD falls back to a sole business branch and otherwise requires selection', async () => {
  const f = await fixture();
  try {
    git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
    git(f.repos.alice, 'push', 'origin', 'HEAD:agent-collab');
    assert.equal((await inspectRepository(f.repos.alice)).base_branch, 'main');
    git(f.repos.alice, 'push', 'origin', 'HEAD:release/stable');
    const pending = await inspectRepository(f.repos.alice, { allowSelection: true });
    assert.equal(pending.selection_required, 'branch'); assert.deepEqual(pending.branches, ['main', 'release/stable']);
    await assert.rejects(inspectRepository(f.repos.alice), /默认分支无法确定/);
    await assert.rejects(inspectRepository(f.repos.alice, { baseBranch: 'agent-collab' }), /账本分支/);
  } finally { await f.cleanup(); }
});

test('remote identity respects nonstandard ports and equates ordinary SSH and HTTPS repository addresses', () => {
  const expected = 'example.com/team/project';
  for (const url of ['git@example.com:team/project.git', 'https://example.com/team/project.git', 'ssh://git@example.com:22/team/project.git']) assert.equal(remoteIdentity(url), expected);
  assert.notEqual(remoteIdentity('ssh://git@example.com:2222/team/project.git'), expected);
});

test('task v3 validates branch and starting commit while historical v2 remains readable', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const store = await f.manager.profileStore(await f.manager.state(admin.id));
    const team = store.team;
    const spec = { schema_version: 3, id: 'T-REFS', repo: team.repo, title: 'test', acceptance: ['pass'], workflow: ['backend'], base_branch: 'main', base_commit: git(f.repos.alice, 'rev-parse', 'HEAD') };
    assert.doesNotThrow(() => validateSpec(spec, team));
    for (const base_branch of ['HEAD', '-main', 'a..b', 'a@{1}', 'a.lock', '.hidden/a', 'a/.hidden', 'a//b', 'a:b', 'main~1', 'main\n', 'a\\b', 'a/']) {
      assert.equal(isBranchName(base_branch), false); assert.throws(() => validateTeam({ ...team, base_branch }));
      assert.throws(() => validateSpec({ ...spec, base_branch }, team));
    }
    for (const base_commit of [undefined, 'abc', 'g'.repeat(40), '--all', '0'.repeat(39), 'A'.repeat(40)]) assert.throws(() => validateSpec({ ...spec, base_commit }, team));
    assert.throws(() => validateSpec({ ...spec, base_branch: 'develop' }, team));
    const { base_commit, ...v2 } = { ...spec, schema_version: 2 }; const { base_branch, ...legacyTeam } = team;
    assert.doesNotThrow(() => validateSpec(v2, legacyTeam));
    assert.throws(() => validateSpec(v2, team)); assert.throws(() => validateSpec({ ...v2, base_commit }, legacyTeam));
  } finally { await f.cleanup(); }
});
