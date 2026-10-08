import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitTaskStore } from '../src.mjs';

function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(); }

test('git store creates, deduplicates, serializes and replays events in a separate branch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-collab-'));
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, 'config', 'user.name', 'Test User');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    execFileSync('sh', ['-c', 'echo fixture > README.md && git add README.md && git commit -m init'], { cwd: repo });
    git(repo, 'branch', 'agent-collab');
    // branch above was created before the ledger commit; seed a usable tasks directory on collab.
    git(repo, 'worktree', 'add', join(root, 'seed'), 'agent-collab');
    execFileSync('sh', ['-c', 'mkdir -p .agent-collab/tasks && echo ledger > .agent-collab/README.md && git add .agent-collab && git commit -m ledger'], { cwd: join(root, 'seed') });
    git(repo, 'worktree', 'remove', join(root, 'seed'));
    const store = await new GitTaskStore({ repo, dataDir: join(root, 'data') }).init();
    const spec = { schema_version: 1, id: 'T-001', repo: 'demo', title: 'Example', base_branch: 'main', acceptance: ['pass tests'] };
    const created = await store.create(spec, 'alice', 'create-1');
    assert.equal(created.state.status, 'open');
    assert.equal((await store.create(spec, 'alice', 'create-1')).events.length, 1);
    const assigned = await store.append('T-001', { type: 'assigned', assignee: 'bob' }, 'alice', 'assign-1', 1);
    assert.equal(assigned.state.assignee, 'bob');
    assert.equal((await store.append('T-001', { type: 'assigned', assignee: 'bob' }, 'alice', 'assign-1', 1)).events.length, 2);
    await assert.rejects(store.append('T-001', { type: 'run_started' }, 'bob', 'run-stale', 1), /stale/);
    const runs = await Promise.allSettled([
      store.append('T-001', { type: 'run_started' }, 'bob', 'run-1', 2),
      store.append('T-001', { type: 'run_started' }, 'bob', 'run-2', 2)
    ]);
    assert.deepEqual(runs.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.equal((await store.read('T-001')).state.status, 'running');
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
  } finally { await rm(root, { recursive: true, force: true }); }
});
