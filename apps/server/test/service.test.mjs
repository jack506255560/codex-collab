import test from 'node:test';
import assert from 'node:assert/strict';
import { CollaborationService } from '../service.mjs';

const admin = { id: 'alice', role: 'admin' };
const bob = { id: 'bob', role: 'member' };
test('default reviewer is bound and self review, spoofed approval and missing evidence are rejected', async () => {
  const spec = { id: 'T-001', source: { reviewer: 'alice' } };
  const current = { spec, state: { status: 'running', assignee: 'bob', seq: 3 } };
  const calls = [];
  const store = { read: async () => current, append: async (...args) => { calls.push(args); return current; }, create: async (created) => ({ spec: created }) };
  const service = new CollaborationService(store, { repoId: 'demo', defaultReviewer: 'alice' });
  assert.equal((await service.create(bob, { title: 'fixture', acceptance: ['ok'] })).spec.source.reviewer, 'alice');
  await assert.rejects(service.assign(admin, 'T-001', 'alice'), /reviewer must be different/);
  await assert.rejects(service.report(bob, 'T-001', { type: 'reviewed', decision: 'approved' }, 3), /reviewer may review/);
  await assert.rejects(service.report(bob, 'T-001', { type: 'review_requested' }, 3), /requires branch/);
  await service.report(bob, 'T-001', { type: 'review_requested', refs: { branch: 'codex/x', commit: 'abc', tests: 'pass' } }, 3);
  assert.equal(calls.at(-1)[1].assignee, 'alice');
});
