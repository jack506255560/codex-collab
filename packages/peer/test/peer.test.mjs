import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateIdentity, validateTeam } from '../config.mjs';
import { PeerGitStore } from '../store.mjs';
import { PeerService } from '../service.mjs';
import { Conflict, reducePeerTask } from '../protocol.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function run(cwd, args) {
  execFileSync(args[0], args.slice(1), { cwd, stdio: 'ignore' });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-peer-'));
  const bare = join(root, 'origin.git');
  const seed = join(root, 'seed');
  run(root, ['git', 'init', '--bare', bare]);
  run(root, ['git', 'clone', bare, seed]);
  git(seed, 'config', 'user.name', 'fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid');
  run(seed, ['sh', '-c', 'printf "fixture\\n" > README.md && git add README.md && git commit -m init']);
  run(seed, ['git', 'push', 'origin', 'HEAD:refs/heads/main']);
  const ids = Object.fromEntries(['alice', 'bob', 'carol'].map((id) => [id, generateIdentity()]));
  const team = {
    schema_version: 2, repo: 'fixture/repo', reviewer: 'alice', default_route: 'backend',
    agents: Object.fromEntries(Object.entries(ids).map(([id, identity]) => [id, {
      role: id === 'alice' ? 'admin' : 'member', capabilities: ['backend'], max_concurrent_tasks: 1, public_key: identity.public_key,
    }])),
    routes: { backend: ['bob', 'carol'] },
    policy: { claim_timeout_ms: 100, lease_ms: 300, clock_skew_ms: 10, max_attempts: 3 },
  };
  const now = { value: 1_700_000_000_000 };
  const make = async (id, dir) => new PeerService(await new PeerGitStore({ repo: seed, dataDir: join(root, dir), team, agentId: id, privateKey: ids[id].private_key, clock: () => now.value }).init());
  return { root, bare, seed, team, now, make, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('peer ledger signs events and candidate takes over after lease expiry', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const bob = await f.make('bob', 'bob-data');
    const carol = await f.make('carol', 'carol-data');
    const created = await alice.create({ title: 'fallback', description: 'fixture', acceptance: ['pass'], workflow: ['backend'] }, 'create-1');
    assert.equal(created.state.status, 'open');
    assert.equal((await bob.nextJob()).spec.id, created.spec.id);
    const claimed = await bob.claim(created.spec.id, 'bob-claim');
    const token = { lease_id: claimed.state.lease.id, epoch: claimed.state.epoch };
    assert.equal(claimed.state.assignee, 'bob');
    assert.equal(await carol.nextJob(), null);

    f.now.value = Date.parse(claimed.state.lease.expires_at) + f.team.policy.clock_skew_ms + f.team.policy.claim_timeout_ms;
    const takeover = await carol.claim(created.spec.id, 'carol-claim');
    assert.equal(takeover.state.assignee, 'carol');
    assert.equal(takeover.state.epoch, 2);
    assert.deepEqual(takeover.state.failed_agents, ['bob']);
    await assert.rejects(bob.report(created.spec.id, { type: 'progress', summary: 'stale' }, token, 'stale-progress'), /expired or superseded/);
    assert.equal((await carol.read(created.spec.id)).state.assignee, 'carol');
  } finally { await f.cleanup(); }
});

test('two peer clones race to claim and Git fast-forward leaves one winner', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const bob = await f.make('bob', 'bob-data');
    const carol = await f.make('carol', 'carol-data');
    const task = await alice.create({ title: 'race', acceptance: ['pass'] }, 'create-race');
    f.now.value += f.team.policy.claim_timeout_ms;
    assert.equal((await carol.nextJob()).spec.id, task.spec.id);
    const results = await Promise.allSettled([bob.claim(task.spec.id, 'bob-race'), carol.claim(task.spec.id, 'carol-race')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason instanceof Conflict).length, 1);
    const final = await alice.read(task.spec.id);
    assert.equal(final.state.status, 'running');
    assert.ok(['bob', 'carol'].includes(final.state.assignee));
    assert.equal(final.state.seq, 2);
  } finally { await f.cleanup(); }
});

test('tampered signed peer event is rejected during replay', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const task = await alice.create({ title: 'signature', acceptance: ['pass'] }, 'create-signature');
    const tampered = structuredClone(task.events);
    tampered[0].summary = 'changed';
    assert.throws(() => reducePeerTask(task.spec, tampered, f.team), /invalid peer event identity\/signature/);
  } finally { await f.cleanup(); }
});

test('desktop-created task stays reserved until its creator publishes a handoff', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const bob = await f.make('bob', 'bob-data');
    git(f.seed, 'checkout', '-b', 'codex/desktop');
    run(f.seed, ['sh', '-c', 'printf "desktop change\\n" > desktop.txt && git add desktop.txt && git commit -m desktop-change']);
    run(f.seed, ['git', 'push', 'origin', 'HEAD:refs/heads/codex/desktop']);
    const commit = git(f.seed, 'rev-parse', 'HEAD');

    const task = await alice.create({ title: 'desktop first stage', acceptance: ['pass'], workflow: ['backend', 'backend'], execution_mode: 'desktop' }, 'desktop-create');
    assert.equal(task.state.status, 'desktop');
    assert.equal(await bob.nextJob(), null);
    f.now.value += 10000;
    assert.equal(await bob.nextJob(), null);
    await assert.rejects(bob.claim(task.spec.id), /not eligible/);
    await assert.rejects(bob.handoff(task.spec.id, { summary: 'spoof', refs: { branch: 'codex/desktop', commit, tests: 'pass' } }, task.state.seq), /expired or superseded/);

    const handed = await alice.handoff(task.spec.id, { summary: 'Desktop stage is implemented and tested.', refs: { branch: 'codex/desktop', commit, tests: 'fixture: pass' } }, task.state.seq, 'desktop-handoff');
    assert.equal(handed.state.status, 'waiting');
    assert.equal(handed.state.stage, 1);
    assert.equal((await bob.nextJob()).spec.id, task.spec.id);
    const claimed = await bob.claim(task.spec.id, 'desktop-next-claim');
    assert.equal(claimed.state.assignee, 'bob');
  } finally { await f.cleanup(); }
});

test('independent clones initialize the ledger concurrently and retain independent task writes', async () => {
  const f = await fixture();
  try {
    const [alice, bob, carol] = await Promise.all([f.make('alice', 'alice-data'), f.make('bob', 'bob-data'), f.make('carol', 'carol-data')]);
    const written = await Promise.all([alice, bob, carol].map((service, i) => service.create({ title: `parallel ${i}`, acceptance: ['pass'] }, `parallel-create-${i}`)));
    assert.equal(new Set(written.map((task) => task.spec.id)).size, 3);
    assert.equal((await alice.list()).length, 3);
    assert.equal((await carol.list()).length, 3);
  } finally { await f.cleanup(); }
});

test('capacity is reevaluated after competing claims across tasks', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const [bob1, bob2] = await Promise.all([f.make('bob', 'bob-1'), f.make('bob', 'bob-2')]);
    const a = await alice.create({ title: 'capacity A', acceptance: ['pass'] }, 'capacity-a');
    const b = await alice.create({ title: 'capacity B', acceptance: ['pass'] }, 'capacity-b');
    const results = await Promise.allSettled([bob1.claim(a.spec.id), bob2.claim(b.spec.id)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await alice.list()).filter((task) => task.state.status === 'running').length, 1);
  } finally { await f.cleanup(); }
});

test('idempotent creation stays on its original task and never returns another task', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const input = { title: 'idempotent', acceptance: ['pass'] };
    const a = await alice.create(input, 'idempotent-create');
    const repeated = await alice.create(input, 'idempotent-create');
    assert.equal(repeated.spec.id, a.spec.id);
    assert.equal(repeated.state.seq, 1);
    await assert.rejects(alice.create({ ...input, id: 'T-OTHER' }, 'idempotent-create'), /another peer task/);
    assert.equal((await alice.list()).length, 1);
  } finally { await f.cleanup(); }
});

test('renewal prevents early takeover, failed candidates block, and admin may reopen', async () => {
  const f = await fixture();
  try {
    const alice = await f.make('alice', 'alice-data');
    const bob = await f.make('bob', 'bob-data');
    const carol = await f.make('carol', 'carol-data');
    const task = await alice.create({ title: 'failures', acceptance: ['pass'] });
    let claimed = await bob.claim(task.spec.id);
    const token = { lease_id: claimed.state.lease.id, epoch: claimed.state.epoch };
    f.now.value += 200;
    claimed = await bob.renew(task.spec.id, token);
    f.now.value += 150;
    assert.equal(await carol.nextJob(), null);
    await bob.report(task.spec.id, { type: 'run_failed', summary: 'Tests failed.' }, token);
    const next = await carol.claim(task.spec.id);
    const failed = await carol.report(task.spec.id, { type: 'run_failed', summary: 'Tests failed.' }, { lease_id: next.state.lease.id, epoch: next.state.epoch });
    assert.equal(failed.state.status, 'blocked');
    await assert.rejects(bob.report(task.spec.id, { type: 'reopened', summary: 'try again' }), /administrator/);
    const reopened = await alice.report(task.spec.id, { type: 'reopened', summary: 'Fixed local test configuration; retry.' });
    assert.equal(reopened.state.status, 'open');
    assert.equal(reopened.state.attempts, 0);
    assert.deepEqual(reopened.state.failed_agents, []);
  } finally { await f.cleanup(); }
});


test('pinned reviewer may execute a routed stage without granting review authority to members', async () => {
  const f = await fixture();
  try {
    f.team.routes.backend = ['alice', 'bob', 'carol'];
    assert.equal(validateTeam(f.team), f.team);
    const alice = await f.make('alice', 'alice-data');
    const bob = await f.make('bob', 'bob-data');
    const task = await alice.create({ title: 'reviewer implements a stage', acceptance: ['pass'] });
    assert.equal((await alice.nextJob()).spec.id, task.spec.id);
    assert.equal(await bob.nextJob(), null, 'fallback waits for the primary claim timeout');
    const claimed = await alice.claim(task.spec.id);
    assert.equal(claimed.state.assignee, 'alice');
    await assert.rejects(bob.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /administrator/);
    await assert.rejects(alice.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /pinned human reviewer/);
    const failed = await alice.report(task.spec.id, { type: 'run_failed', summary: 'Local execution failed.' }, { lease_id: claimed.state.lease.id, epoch: claimed.state.epoch });
    assert.deepEqual(failed.state.failed_agents, ['alice']);
    assert.equal((await bob.nextJob()).spec.id, task.spec.id, 'failure makes the next remaining candidate primary');
    const takeover = await bob.claim(task.spec.id);
    assert.equal(takeover.state.assignee, 'bob');
    assert.equal(takeover.state.epoch, 2);
  } finally { await f.cleanup(); }
});
