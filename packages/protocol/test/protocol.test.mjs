import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceTask, validateTaskSpec } from '../src/index.mjs';

const spec = {
  schema_version: 1, id: 'T-001', repo: 'jack506255560/codex-collab-demo',
  title: 'Add uppercase greeting', base_branch: 'main', acceptance: ['sh test.sh passes']
};
const event = (seq, type, extra = {}) => ({
  schema_version: 1, event_id: `event-${seq}`, task_id: spec.id, seq, type,
  actor_id: 'alice', occurred_at: '2026-10-08T00:00:00Z', idempotency_key: `key-${seq}`, ...extra
});

test('a complete reviewed task retains its owner and sequence', () => {
  const events = [
    event(1, 'created'), event(2, 'assigned', { assignee: 'bob' }),
    event(3, 'run_started'), event(4, 'progress'),
    event(5, 'review_requested', { assignee: 'bob' }), event(6, 'reviewed', { decision: 'approved' }),
    event(7, 'completed', { refs: { commit: 'abc123', tests: 'sh test.sh passed' } })
  ];
  assert.deepEqual(reduceTask(spec, events), { id: 'T-001', status: 'completed', assignee: 'bob', seq: 7 });
});

test('review changes requested returns to blocked then can be reassigned', () => {
  const events = [event(1, 'created'), event(2, 'assigned', { assignee: 'bob' }),
    event(3, 'run_started'), event(4, 'review_requested', { assignee: 'bob' }),
    event(5, 'reviewed', { decision: 'changes_requested' }),
    event(6, 'assigned', { assignee: 'bob' })];
  assert.equal(reduceTask(spec, events).status, 'assigned');
});

test('rejects invalid ordering, duplicates and unsupported schema', () => {
  assert.throws(() => reduceTask(spec, [event(2, 'created')]), /sequence/);
  assert.throws(() => reduceTask(spec, [event(1, 'created'), event(2, 'created')]), /invalid transition/);
  assert.throws(() => reduceTask(spec, [event(1, 'created'), event(2, 'assigned', { assignee: 'bob', event_id: 'event-1' })]), /duplicate/);
  assert.throws(() => validateTaskSpec({ ...spec, schema_version: 2 }), /unsupported/);
});

test('cannot complete without review and evidence', () => {
  assert.throws(() => reduceTask(spec, [event(1, 'created'), event(2, 'completed')]), /invalid transition/);
  const events = [event(1, 'created'), event(2, 'assigned', { assignee: 'bob' }),
    event(3, 'run_started'), event(4, 'review_requested', { assignee: 'bob' }),
    event(5, 'reviewed', { decision: 'approved' }), event(6, 'completed')];
  assert.throws(() => reduceTask(spec, events), /evidence/);
});

test('desktop creator can hand off an open task, and the next agent may be assigned', () => {
  const handoff = event(2, 'handoff', { summary: 'Feature A tested; implement feature B',
    refs: { branch: 'codex/alice-feature', commit: 'a'.repeat(40), tests: 'sh test.sh passed' } });
  assert.equal(reduceTask(spec, [event(1, 'created'), handoff]).status, 'waiting');
  assert.deepEqual(reduceTask(spec, [event(1, 'created'), handoff, event(3, 'assigned', { assignee: 'bob' })]),
    { id: spec.id, status: 'assigned', assignee: 'bob', seq: 3 });
  assert.throws(() => reduceTask(spec, [event(1, 'created'), event(2, 'handoff', { summary: 'no proof' })]), /handoff requires/);
});
