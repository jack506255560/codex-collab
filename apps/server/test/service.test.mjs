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


test('new group tasks and assignments default to WeCom while API-only tasks keep no group provenance', async () => {
  const current = { spec: { id: 'T-001' }, state: { seq: 1 } };
  const calls = [];
  const store = { read: async () => current, create: async (spec) => ({ spec }), append: async (...args) => { calls.push(args); return current; } };
  const service = new CollaborationService(store, { repoId: 'demo' });
  const input = { title: 'fixture', acceptance: ['ok'] };
  for (const channel of [undefined, 'wecom']) {
    const task = await service.create(admin, { ...input, chatId: 'group-1', channel });
    assert.deepEqual(task.spec.source, { chat_id: 'group-1', channel: 'wecom' });
    await service.assign(admin, 'T-001', 'bob', undefined, 'group-1', channel);
    assert.equal(calls.at(-1)[1].channel, 'wecom');
    assert.equal(calls.at(-1)[1].chat_id, 'group-1');
  }
  assert.deepEqual((await service.create(admin, input)).spec.source, {});
  await service.assign(admin, 'T-001', 'bob');
  assert.equal(Object.hasOwn(calls.at(-1)[1], 'channel'), false);
  assert.equal(Object.hasOwn(calls.at(-1)[1], 'chat_id'), false);
});

test('unsupported channels cannot be written through create, assign or report', async () => {
  let writes = 0;
  const current = { spec: { id: 'T-001' }, state: { seq: 1 } };
  const store = { read: async () => current, create: async () => { writes++; }, append: async () => { writes++; } };
  const service = new CollaborationService(store, { repoId: 'demo' });
  for (const channel of ['other-im', '', null, 123]) {
    await assert.rejects(service.create(admin, { title: 'fixture', acceptance: ['ok'], chatId: 'group-1', channel }), /only the wecom/);
    await assert.rejects(service.assign(admin, 'T-001', 'bob', undefined, 'group-1', channel), /only the wecom/);
    await assert.rejects(service.report(admin, 'T-001', { type: 'progress', channel }, 1), /only the wecom/);
  }
  assert.equal(writes, 0);
});
