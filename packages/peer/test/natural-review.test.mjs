import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { reviewContext, validReviewContext, assertReviewIntent, explicitReviewDecision } from '../natural-review.mjs';
import { generateIdentity, digest, makeSigner } from '../config.mjs';
import { reduceInbox } from '../inbox.mjs';

function fixture({ content = '通过，交给 Bob 继续。', count = 1, sender = 'alice-user' } = {}) {
  const key = generateIdentity();
  const team = { schema_version: 2, repo: 'fixture', reviewer: 'alice', default_route: 'docs', agents: { alice: { role: 'admin', capabilities: ['docs'], max_concurrent_tasks: 1, public_key: key.public_key, wecom_userid: 'alice-user' } }, routes: { docs: ['alice'] }, policy: { claim_timeout_ms: 10, lease_ms: 1000, clock_skew_ms: 0, max_attempts: 2 } };
  const context = Array.from({ length: count }, (_, i) => ({ task_id: `T-TASK${i + 1}`, expected_seq: 14, title: `说明${i + 1}`, commit: 'a'.repeat(40), stage: 0 }));
  const messageKey = 'inbox-message:alice:fixture';
  const spec = { schema_version: 1, id: `N-${digest(['alice', messageKey]).slice(0, 32).toUpperCase()}`, repo: team.repo, target_agent: 'alice', chat_id: 'group', sender_id: sender, content, message_key: messageKey, admin_dispatch: false, review_context: context };
  return { team, request: { spec, events: [] }, context, review: { task_id: context[0]?.task_id, expected_seq: 14, decision: 'approved' }, sign: makeSigner(team, 'alice', key.private_key) };
}

test('review scope includes only this authenticated owner, assigned group and pinned identity', () => {
  const f = fixture();
  const task = { spec: { id: 'T-TASK1', title: 'Docs', source: { channel: 'wecom', chat_id: 'group' } }, state: { status: 'review', assignee: 'alice', seq: 14, stage: 0, checkpoint: { commit: 'a'.repeat(40) } } };
  assert.equal(reviewContext([task], 'alice', 'alice-user', 'group', f.team).length, 1);
  assert.deepEqual(reviewContext([task], 'alice', 'another-user', 'group', f.team), []);
  assert.deepEqual(reviewContext([task], 'alice', 'alice-user', 'another-group', f.team), []);
  assert.deepEqual(reviewContext([{ ...task, team: { agents: { alice: { wecom_userid: 'former-owner' } } } }], 'alice', 'alice-user', 'group', f.team), []);
  assert.equal(validReviewContext(f.context), true);
  for (const value of [[...f.context, ...f.context], [{ ...f.context[0], expected_seq: 0 }], [{ ...f.context[0], command: 'approve' }], [{ ...f.context[0], commit: 'bad' }], [null], {}]) assert.equal(validReviewContext(value), false);
});

test('natural review requires explicit human consent, frozen target and current owner', () => {
  const f = fixture();
  assert.equal(assertReviewIntent(f.request, f.review, 'alice', f.team).task_id, 'T-TASK1');
  for (const patch of [{ expected_seq: 15 }, { task_id: 'T-OTHER' }, { decision: 'complete' }, { command: 'approve' }]) assert.throws(() => assertReviewIntent(f.request, { ...f.review, ...patch }, 'alice', f.team));
  for (const content of ['收到', '请检查测试通过后继续', '如果测试通过，就批准', '先别通过', '通过？', '通过吗', '请帮我解释通过的含义', '通过，不过先等等', '没问题，暂不交接', 'OK，但稍等一下']) {
    assert.throws(() => assertReviewIntent({ ...f.request, spec: { ...f.request.spec, content } }, f.review, 'alice', f.team), /explicit/);
  }
  const forged = { ...f.request, spec: { ...f.request.spec, sender_id: 'another-user' } };
  assert.throws(() => assertReviewIntent(forged, f.review, 'alice', f.team), /owner/);
  const wrongRevision = { ...f.request, spec: { ...f.request.spec, content: 'T-TASK1 R-13，通过' } };
  assert.throws(() => assertReviewIntent(wrongRevision, f.review, 'alice', f.team), /revision/);
});

test('multiple reviews require title, task ID or list selection and never select the newest', () => {
  const f = fixture({ count: 2 });
  assert.throws(() => assertReviewIntent(f.request, f.review, 'alice', f.team), /multiple/);
  for (const content of ['说明1，通过', 'T-TASK1，通过']) {
    assert.equal(assertReviewIntent({ ...f.request, spec: { ...f.request.spec, content } }, f.review, 'alice', f.team).task_id, 'T-TASK1');
  }
  assert.throws(() => assertReviewIntent({ ...f.request, spec: { ...f.request.spec, content: 'T-TASK2，通过' } }, f.review, 'alice', f.team), /explicit task/);
  for (const content of ['说明1，第二个，通过', '说明1和说明2，通过', '第一个和第二个，通过', '第三个，通过', '第一个，通过']) {
    assert.throws(() => assertReviewIntent({ ...f.request, spec: { ...f.request.spec, content } }, f.review, 'alice', f.team), /selection/);
  }
  const clarified = { ...f.request, events: [{ type: 'clarified', response: '请选择：1. 说明1；2. 说明2。' }, { type: 'replied', content: '第一个' }] };
  assert.equal(assertReviewIntent(clarified, f.review, 'alice', f.team).task_id, 'T-TASK1');
  for (const content of ['第一个，通过', '第1个，通过']) assert.equal(assertReviewIntent({ ...clarified, events: [{ type: 'clarified', response: '1. 说明1；2. 说明2' }, { type: 'replied', content }] }, f.review, 'alice', f.team).task_id, 'T-TASK1');
  assert.throws(() => assertReviewIntent({ ...clarified, events: [{ type: 'replied', content: '第一个，不过先等等' }] }, f.review, 'alice', f.team), /explicit/);
  assert.throws(() => assertReviewIntent({ ...clarified, events: [{ type: 'replied', content: '先等等' }, { type: 'replied', content: '第一个' }] }, f.review, 'alice', f.team), /explicit/);
  const feedback = { ...f.request, spec: { ...f.request.spec, content: '说明1，先别通过' }, events: [{ type: 'clarified', response: '哪里需要修改？' }, { type: 'replied', content: '安装步骤再补一下' }] };
  assert.equal(assertReviewIntent(feedback, { ...f.review, decision: 'changes_requested', summary: '安装步骤再补一下' }, 'alice', f.team).task_id, 'T-TASK1');
});

test('rejection quotes actual human feedback; missing feedback and fabricated reasons cannot be submitted', () => {
  const f = fixture({ content: '先别通过，安装步骤再补一下。' });
  const review = { ...f.review, decision: 'changes_requested', summary: '安装步骤再补一下' };
  assert.equal(assertReviewIntent(f.request, review, 'alice', f.team).task_id, 'T-TASK1');
  assert.throws(() => assertReviewIntent(f.request, { ...review, summary: '通过' }, 'alice', f.team), /feedback/);
  assert.throws(() => assertReviewIntent(f.request, { ...review, summary: undefined }, 'alice', f.team), /feedback/);
  assert.throws(() => assertReviewIntent(f.request, { ...review, summary: '另一个修改意见' }, 'alice', f.team), /feedback/);
  assert.throws(() => assertReviewIntent({ ...f.request, spec: { ...f.request.spec, content: '退回' } }, { ...review, summary: '退回' }, 'alice', f.team), /feedback/);
  for (const input of ['通过，交给 Bob 继续', '没问题，继续', '可以了，继续吧', '验收通过']) assert.equal(explicitReviewDecision(input), 'approved');
});

test('signed inbox reducer binds human review evidence and rejects invalid payload or actor', () => {
  const f = fixture(); const now = '2026-10-15T00:00:00.000Z';
  const event = (seq, value) => f.sign({ schema_version: 1, request_id: f.request.spec.id, seq, event_id: randomUUID(), actor_id: 'alice', occurred_at: now, idempotency_key: `key-${seq}`, ...value });
  const received = event(1, { type: 'received', spec_hash: digest(f.request.spec), idempotency_key: f.request.spec.message_key });
  const payload = { type: 'reviewed', task_id: 'T-TASK1', review_seq: 15, decision: 'approved', task_event_hash: 'b'.repeat(64), response: '审核通过。' };
  assert.equal(reduceInbox(f.request.spec, [received, event(2, payload)], f.team).status, 'reviewed');
  for (const patch of [{ review_seq: 16 }, { task_id: 'T-OTHER' }, { task_event_hash: 'bad' }, { response: '' }, { content: 'extra' }, { review_seq: '15' }, { review_seq: 15.5 }, { summary: '' }]) assert.throws(() => reduceInbox(f.request.spec, [received, event(2, { ...payload, ...patch })], f.team));
  const another = { ...f.request.spec, sender_id: 'another-user' };
  assert.throws(() => reduceInbox(another, [], f.team), /review context/);
});
