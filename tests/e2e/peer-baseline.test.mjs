import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as repositoryFixture, git } from '../../apps/onboarding/test/helpers.mjs';
import { generateIdentity } from '../../packages/peer/config.mjs';
import { buildTeamPolicy, createMemberConfig } from '../../scripts/peer/onboarding.mjs';
import { loadRuntime } from '../../apps/peer/runtime.mjs';
import { DesktopExecutor } from '../../apps/peer/desktop.mjs';
import { PeerRunner } from '../../apps/peer/runner.mjs';

async function fixture() {
  const f = await repositoryFixture();
  try {
    git(f.remote, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
    git(f.repos.other, 'push', 'origin', 'HEAD:develop', ':main');
    const identities = { alice: generateIdentity(), bob: generateIdentity() };
    const team = buildTeamPolicy({ repo: 'fixture', baseBranch: 'develop', reviewer: 'alice', defaultRoute: 'frontend', agents: Object.entries(identities).map(([id, key]) => ({ id, publicKey: key.public_key, role: id === 'alice' ? 'admin' : 'member', capabilities: ['frontend', 'backend'], wecomUserid: `owner-${id}` })), routes: { frontend: ['alice', 'bob'], backend: ['bob', 'alice'] }, policy: { claim_timeout_ms: 10, lease_ms: 900000, clock_skew_ms: 0, max_attempts: 5 } });
    const teamPath = join(f.root, 'team.json'); await writeFile(teamPath, JSON.stringify(team));
    const peers = {};
    for (const [id, alias] of [['alice', 'company'], ['bob', 'upstream']]) {
      git(f.repos[id], 'remote', 'rename', 'origin', alias);
      const identityPath = join(f.root, `${id}.private.json`), configPath = join(f.root, `${id}.config.json`);
      await writeFile(identityPath, JSON.stringify({ agent_id: id, private_key: identities[id].private_key }), { mode: 0o600 });
      await createMemberConfig({ teamPath, identityPath, repoPath: f.repos[id], dataDir: join(f.root, `${id}-data`), configPath });
      const runtime = await loadRuntime(configPath);
      peers[id] = { ...runtime, desktop: new DesktopExecutor(runtime.service, runtime.config) };
      await peers[id].desktop.bind(`conversation-${id}`);
    }
    let revision = 0;
    const advance = async () => {
      await writeFile(join(f.repos.other, 'drift.txt'), `${++revision}\n`);
      git(f.repos.other, 'add', 'drift.txt'); git(f.repos.other, 'commit', '-m', `advance baseline ${revision}`);
      git(f.repos.other, 'push', 'origin', 'HEAD:develop'); return git(f.repos.other, 'rev-parse', 'HEAD');
    };
    return { ...f, peers, advance };
  } catch (error) { await f.cleanup(); throw error; }
}
async function commit(job, filename, content) {
  await writeFile(join(job.worktree, filename), content); git(job.worktree, 'add', filename); git(job.worktree, 'commit', '-m', 'stage');
  return git(job.worktree, 'rev-parse', 'HEAD');
}
const taskInput = (title) => ({ title, acceptance: ['fixed tests pass'], workflow: ['frontend', 'backend'], execution_mode: 'desktop_poll' });

test('queued task pins original commit and hands off exact code between different remote aliases', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers;
    const initial = git(f.repos.alice, 'rev-parse', 'HEAD');
    const fetchHead = join(f.repos.alice, '.git', 'FETCH_HEAD'); await writeFile(fetchHead, 'preserve source fetch head\n');
    await writeFile(join(f.repos.alice, 'private-note.txt'), 'untracked local file\n');
    await writeFile(join(f.repos.alice, 'test.sh'), 'set -eu\n# local pending edits\n');
    const sourceStatus = git(f.repos.alice, 'status', '--porcelain');
    const created = await alice.service.create(taskInput('pinned'), 'pinned');
    assert.equal(created.spec.schema_version, 3); assert.equal(created.spec.base_branch, 'develop'); assert.equal(created.spec.base_commit, initial);
    const nextTip = await f.advance();
    assert.equal((await alice.service.create(taskInput('newer'), 'newer')).spec.base_commit, nextTip);
    const first = await alice.desktop.poll('conversation-alice');
    assert.equal(first.task.spec.id, created.spec.id); assert.equal(git(first.job.worktree, 'rev-parse', 'HEAD'), initial);
    const checkpoint = await commit(first.job, 'alice.txt', 'frontend complete\n');
    const handed = await alice.desktop.finish('conversation-alice', created.spec.id, 'Frontend done');
    assert.equal(handed.state.status, 'waiting'); assert.equal(handed.state.checkpoint.commit, checkpoint);
    await f.advance();
    const second = await bob.desktop.poll('conversation-bob');
    assert.equal(git(second.job.worktree, 'rev-parse', 'HEAD'), checkpoint);
    await commit(second.job, 'bob.txt', 'backend complete\n');
    assert.equal((await bob.desktop.finish('conversation-bob', created.spec.id, 'Backend done')).state.status, 'review');
    assert.equal(git(f.repos.alice, 'rev-parse', 'HEAD'), initial);
    assert.equal(git(f.repos.alice, 'status', '--porcelain'), sourceStatus);
    assert.equal(await readFile(fetchHead, 'utf8'), 'preserve source fetch head\n');
    assert.equal(git(f.remote, 'rev-parse', 'develop'), git(f.repos.other, 'rev-parse', 'HEAD'));
  } finally { await f.cleanup(); }
});

test('candidate retry and natural request replay retain the accepted starting commit after baseline changes', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers;
    const request = await alice.service.receiveRequest({ chatId: 'group', messageId: 'new-request', senderId: 'owner-alice', content: 'implement a feature' });
    const resolution = { action: 'create_task', task: { title: 'natural pinned', acceptance: ['pass'], workflow: ['frontend'] } };
    const accepted = await alice.service.resolveRequest(request.spec.id, 1, resolution);
    const initial = accepted.task.spec.base_commit;
    const job = await alice.desktop.poll('conversation-alice');
    await alice.desktop.fail('conversation-alice', job.task.spec.id, 'Try next candidate');
    await f.advance();
    const replay = await alice.service.resolveRequest(request.spec.id, 1, resolution);
    assert.equal(replay.task.spec.base_commit, initial);
    const retry = await bob.desktop.poll('conversation-bob');
    assert.equal(retry.task.spec.base_commit, initial); assert.equal(git(retry.job.worktree, 'rev-parse', 'HEAD'), initial);
    assert.equal(retry.task.state.attempts, 2);
  } finally { await f.cleanup(); }
});

test('a force-rewritten baseline blocks old task execution instead of switching to unrelated code', async () => {
  const f = await fixture();
  try {
    const { alice } = f.peers;
    const task = await alice.service.create(taskInput('rewritten'), 'rewritten');
    const other = f.repos.other;
    git(other, 'checkout', '--orphan', 'replacement'); git(other, 'rm', '-rf', '.');
    await writeFile(join(other, 'replacement.txt'), 'unrelated history\n'); git(other, 'add', '.'); git(other, 'commit', '-m', 'replacement');
    git(other, 'push', '--force', 'origin', 'HEAD:develop');
    await assert.rejects(alice.desktop.poll('conversation-alice'), /preparation failed/);
    assert.equal((await alice.service.read(task.spec.id)).spec.base_commit, task.spec.base_commit);
    assert.equal(git(f.repos.alice, 'worktree', 'list', '--porcelain').split('worktree ').length, 2);
  } finally { await f.cleanup(); }
});

test('SDK runner starts from pinned commit and publishes through configured remote', async () => {
  const f = await fixture();
  try {
    const { alice } = f.peers;
    const task = await alice.service.create({ ...taskInput('runner pinned'), workflow: ['frontend'], execution_mode: 'automatic' }, 'runner-pinned');
    await f.advance(); let observed;
    const runner = new PeerRunner(alice.service, { ...alice.config, execution_mode: 'automatic', auto_execute: true }, { agentFactory: () => ({ startThread: ({ workingDirectory }) => ({ id: 'fake-sdk-thread', run: async () => { observed = git(workingDirectory, 'rev-parse', 'HEAD'); await commit({ worktree: workingDirectory }, 'sdk.txt', 'runner change\n'); } }) }) });
    const done = await runner.once();
    assert.equal(observed, task.spec.base_commit); assert.equal(done.state.status, 'review');
    assert.equal(git(f.remote, 'rev-parse', done.state.checkpoint.branch), done.state.checkpoint.commit);
  } finally { await f.cleanup(); }
});

test('Git CAS retry reuses one baseline snapshot when another peer wins publication', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers; let calls = 0;
    const snapshot = alice.store.snapshotBase.bind(alice.store);
    const original = git(f.repos.alice, 'rev-parse', 'HEAD');
    alice.store.snapshotBase = async () => {
      calls++; const accepted = await snapshot();
      await f.advance();
      await bob.service.create(taskInput('wins Git race'), 'wins-race');
      return accepted;
    };
    const task = await alice.service.create(taskInput('retry preserves baseline'), 'retry-preserves');
    assert.equal(calls, 1); assert.equal(task.spec.base_commit, original);
    assert.equal((await alice.service.list()).length, 2);
  } finally { await f.cleanup(); }
});
