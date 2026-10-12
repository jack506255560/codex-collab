import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, validateTeam, makeSigner, digest } from '../config.mjs';
import { reducePeerTask } from '../protocol.mjs';
import { defaultReviewRules, stageReviewer } from '../review.mjs';
function fixture() {
  const identities = Object.fromEntries(['admin', 'alice', 'bob'].map((id) => [id, generateIdentity()]));
  const team = { schema_version: 3, repo: 'fixture', reviewer: 'admin', default_route: 'frontend', agents: Object.fromEntries(Object.entries(identities).map(([id, key]) => [id, { role: id === 'admin' ? 'admin' : 'member', capabilities: ['frontend', 'backend'], max_concurrent_tasks: 1, public_key: key.public_key, wecom_userid: `${id}-user` }])), routes: { frontend: ['alice', 'bob'], backend: ['bob'] }, policy: { claim_timeout_ms: 100, lease_ms: 1000, clock_skew_ms: 10, max_attempts: 3 } };
  team.review_rules = defaultReviewRules(team.routes); validateTeam(team);
  const spec = { schema_version: 2, id: 'T-REVIEW', repo: 'fixture', title: 'Review', base_branch: 'main', acceptance: ['pass'], workflow: ['frontend', 'backend'] };
  const events = [], time = Date.parse('2026-10-12T00:00:00Z');
  const event = (id, value, offset = 0) => makeSigner(team, id, identities[id].private_key)({ schema_version: 2, task_id: spec.id, seq: events.length + 1, event_id: `e${events.length}`, idempotency_key: `key${events.length}`, actor_id: id, occurred_at: new Date(time + offset).toISOString(), ...value });
  const append = (id, value, offset = 0) => { events.push(event(id, value, offset)); return reducePeerTask(spec, events, team); };
  return { team, spec, events, event, append };
}
test('signed reducer enforces intermediate review gate and current executor owner after candidate takeover', () => {
  const f = fixture();
  f.append('admin', { type: 'created', spec_hash: digest(f.spec) });
  f.append('alice', { type: 'claimed', epoch: 1, lease_id: 'lease1', expires_at: '2026-10-12T00:00:01.000Z' });
  const token = { epoch: 2, lease_id: 'lease2' };
  f.append('bob', { type: 'claimed', ...token, expires_at: '2026-10-12T00:00:02.010Z' }, 1010);
  const refs = { branch: 'codex/review', commit: 'a'.repeat(40), tests: 'pass' };
  const direct = f.event('bob', { type: 'handoff', ...token, refs, summary: 'Done', next_stage: 1 }, 1010);
  assert.throws(() => reducePeerTask(f.spec, [...f.events, direct], f.team), /human stage review required/);
  const review = f.append('bob', { type: 'stage_review_requested', ...token, refs, summary: 'Done', next_stage: 1 }, 1010);
  assert.equal(review.assignee, 'bob'); assert.equal(review.review.executor_id, 'bob');
  const spoof = f.event('alice', { type: 'reviewed', decision: 'approved' }, 1010);
  assert.throws(() => reducePeerTask(f.spec, [...f.events, spoof], f.team), /pinned human reviewer/);
  assert.equal(f.append('bob', { type: 'reviewed', decision: 'approved' }, 1010).stage, 1);
});
test('v3 review rules reject missing routes, unsupported selectors and unverified member while v2 forbids gates', () => {
  const { team } = fixture();
  for (const rules of [{}, { ...team.review_rules, frontend: { required: true, reviewer: 'unknown', notify: 'none' } }, { ...team.review_rules, frontend: { required: true, reviewer: 'owner', notify: 'member:missing' } }]) assert.throws(() => validateTeam({ ...team, review_rules: rules }));
  assert.throws(() => validateTeam({ ...team, schema_version: 2 }), /v3/);
  assert.throws(() => validateTeam({ ...team, review_rules: undefined }), /v3/);
  assert.equal(stageReviewer(team, 'frontend', 'bob'), 'bob');
  delete team.agents.bob.wecom_userid; assert.equal(stageReviewer(team, 'frontend', 'bob'), 'admin');
});
