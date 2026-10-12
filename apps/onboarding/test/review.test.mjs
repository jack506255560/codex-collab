import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../../scripts/peer/cli.mjs', import.meta.url));
import { fixture, git } from './helpers.mjs';
import { loadRuntime } from '../../peer/runtime.mjs';
import { DesktopExecutor } from '../../peer/desktop.mjs';
import { dispatchPeerWecom, formatPeerNotification, PeerNotificationRelay } from '../../peer/wecom.mjs';

async function joinBob(f, admin, { capabilities = 'backend', commands = true } = {}) {
  const invite = await f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities, bot_id: 'bot-bob', secret: 'fixture-secret', password: 'long-fixture-password', commands_enabled: commands });
  const exported = await f.manager.exportedBundle(admin.id, invite.invite_id);
  const profile = await f.manager.importBundle({ content: exported.content, password: 'long-fixture-password', repo: f.repos.bob });
  await f.manager.verifyMember({ id: profile.id, discovery_id: await f.verify({ profile_id: profile.id }, 'owner-bob') });
  const request = (await f.manager.detail(admin.id)).requests[0];
  await f.manager.approve({ id: admin.id, request_id: request.request_id });
  return f.manager.resume(profile.id);
}
async function edit(job, name, content) {
  await writeFile(join(job.worktree, name), content);
  git(job.worktree, 'add', name); git(job.worktree, 'commit', '-m', 'review fixture');
  return git(job.worktree, 'rev-parse', 'HEAD');
}
async function group(service, config, id, content, userid = 'owner-alice', msgid = content) {
  let response;
  const accepted = await dispatchPeerWecom({ body: { chattype: 'group', msgtype: 'text', chatid: 'group', from: { userid }, msgid, text: { content } } }, { service, config, reply: async (_, text) => { response = text; } });
  return { accepted, response };
}

test('stage review rejects stale approvals; rejection resumes exact code with feedback; final owner approves', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(), member = await joinBob(f, admin);
    const alice = await loadRuntime(admin.config_path), bob = await loadRuntime(member.config_path);
    const a = new DesktopExecutor(alice.service, alice.config), b = new DesktopExecutor(bob.service, bob.config);
    await a.bind('alice-thread'); await b.bind('bob-thread');
    const task = await alice.service.create({ title: 'review flow', acceptance: ['pass'], workflow: ['frontend', 'backend'], execution_mode: 'desktop_poll', chatId: 'group' });
    const first = await a.poll('alice-thread'); const rejectedSha = await edit(first.job, 'frontend.txt', 'first\n');
    const review = await a.finish('alice-thread', task.spec.id, 'Frontend ready');
    assert.equal(review.state.status, 'stage_review'); assert.equal(review.state.assignee, 'alice');
    assert.equal((await b.poll('bob-thread')).job, null);
    await assert.rejects(alice.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /R-sequence/);
    await assert.rejects(bob.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }, {}, undefined, review.state.seq), /pinned human reviewer/);
    await assert.rejects(alice.service.report(task.spec.id, { type: 'reviewed', decision: 'changes_requested' }, {}, undefined, review.state.seq), /requires feedback/);
    const cfg = { ...alice.config.wecom, execution_mode: 'desktop_poll' };
    assert.match((await group(alice.service, cfg, task.spec.id, `协作 审核 ${task.spec.id} 通过`)).response, /版本号/);
    assert.match((await group(alice.service, cfg, task.spec.id, `协作 审核 ${task.spec.id} R-${review.state.seq} 退回`)).response, /修改意见/);
    const key = 'reject-once';
    const result = await group(alice.service, cfg, task.spec.id, `协作 审核 ${task.spec.id} R-${review.state.seq} 退回 | Add keyboard support`, 'owner-alice', key);
    assert.match(result.response, /open/);
    const redo = await a.poll('alice-thread');
    assert.equal(redo.job.source_commit, rejectedSha); assert.equal(redo.review_feedback, 'Add keyboard support'); assert.equal(redo.task.state.stage, 0);
    await edit(redo.job, 'frontend.txt', 'first\nkeyboard support\n');
    const second = await a.finish('alice-thread', task.spec.id, 'Keyboard support added');
    assert.equal(second.state.status, 'stage_review');
    assert.match((await group(alice.service, cfg, task.spec.id, `协作 审核 ${task.spec.id} R-${review.state.seq} 通过`)).response, /版本已变化/);
    assert.equal((await bob.service.read(task.spec.id)).state.status, 'stage_review');
    const approval = `协作 审核 ${task.spec.id} R-${second.state.seq} 通过`;
    assert.match((await group(alice.service, cfg, task.spec.id, approval, 'owner-alice', 'approve-once')).response, /waiting/);
    const seq = (await alice.service.read(task.spec.id)).state.seq;
    await group(alice.service, cfg, task.spec.id, approval, 'owner-alice', 'approve-once');
    assert.equal((await alice.service.read(task.spec.id)).state.seq, seq, 'duplicate command never advances another stage');
    const next = await b.poll('bob-thread'); assert.equal(next.job.source_commit, second.state.checkpoint.commit);
    await edit(next.job, 'backend.txt', 'done\n'); const final = await b.finish('bob-thread', task.spec.id, 'Backend ready');
    assert.equal(final.state.assignee, 'bob');
    const notification = formatPeerNotification(final, 'review_requested', 'bob', final.team);
    assert.match(notification, /bob <@owner-bob>/); assert.match(notification, new RegExp(`R-${final.state.seq}`));
    assert.match(notification, /分支：codex\//); assert.match(notification, /测试：sh test.sh: pass/);
    await assert.rejects(alice.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }, {}, undefined, final.state.seq), /pinned human reviewer/);
    const { stdout } = await exec(process.execPath, [cli, 'review', member.config_path, task.spec.id, 'approved', `R-${final.state.seq}`]);
    const approved = JSON.parse(stdout); assert.equal(approved.state.status, 'approved');
    await assert.rejects(bob.service.report(task.spec.id, { type: 'completed' }), /administrator/);
    assert.equal((await alice.service.report(task.spec.id, { type: 'completed' })).state.status, 'completed');
    assert.equal(git(f.repos.alice, 'rev-parse', 'origin/main'), git(f.repos.alice, 'rev-parse', 'main'));
    const sent = []; const relay = new PeerNotificationRelay(bob.service, async (_, type) => sent.push(type));
    await relay.poll(); await relay.poll(); assert.equal(sent.filter((t) => t === 'review_requested').length, 1); assert.equal(sent.filter((t) => t === 'reviewed').length, 1);
    assert.match(formatPeerNotification(approved, 'reviewed', 'bob', approved.team), /请管理员/);
  } finally { await f.cleanup(); }
});

test('review rules are signed, versioned, admin-only and pinned per task; enrollment covers new routes', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const alice = await loadRuntime(admin.config_path);
    const old = await alice.service.create({ title: 'pinned', acceptance: ['pass'], workflow: ['frontend', 'backend'], execution_mode: 'desktop_poll' });
    const before = await f.manager.detail(admin.id);
    assert.equal(before.policy_schema_version, 3); assert.equal(before.members[0].verified_owner, true);
    const rules = structuredClone(before.review_rules); rules.frontend = { required: false, reviewer: 'admin', notify: 'none' };
    const updated = await f.manager.setReviewRules({ id: admin.id, expected_version: before.version, review_rules: rules });
    assert.equal(updated.version, before.version + 1);
    const same = await f.manager.setReviewRules({ id: admin.id, expected_version: updated.version, review_rules: rules }); assert.equal(same.version, updated.version);
    await assert.rejects(f.manager.setReviewRules({ id: admin.id, expected_version: before.version, review_rules: rules }), /已更新/);
    await assert.rejects(f.manager.setReviewRules({ id: admin.id, expected_version: updated.version, review_rules: {} }), /规则无效/);
    await assert.rejects(f.manager.setReviewRules({ id: admin.id, expected_version: updated.version, review_rules: { ...rules, frontend: { required: true, reviewer: 'member:unknown', notify: 'none' } } }), /规则无效/);
    const member = await joinBob(f, admin, { capabilities: 'qa' });
    const grown = await f.manager.detail(admin.id); assert.deepEqual(grown.review_rules.qa, { required: true, reviewer: 'owner', notify: 'owner' });
    await assert.rejects(f.manager.setReviewRules({ id: member.id, expected_version: grown.version, review_rules: grown.review_rules }), /只有已接入的管理员/);
    const pinned = await alice.service.read(old.spec.id); assert.equal(pinned.team.review_rules.frontend.required, true);
    const desktop = new DesktopExecutor(alice.service, alice.config); await desktop.bind('policy-thread');
    const original = await desktop.poll('policy-thread'); assert.equal(original.task.spec.id, old.spec.id);
    await edit(original.job, 'old.txt', 'old policy\n'); const review = await desktop.finish('policy-thread', old.spec.id, 'old ready');
    assert.equal(review.state.status, 'stage_review');
    await alice.service.report(old.spec.id, { type: 'cancelled' });
    const fresh = await alice.service.create({ title: 'new policy', acceptance: ['pass'], workflow: ['frontend', 'backend'], execution_mode: 'desktop_poll' }); assert.equal(fresh.team.review_rules.frontend.required, false);
    const latest = await desktop.poll('policy-thread'); assert.equal(latest.task.spec.id, fresh.spec.id);
    await edit(latest.job, 'new.txt', 'new policy\n'); const handed = await desktop.finish('policy-thread', fresh.spec.id, 'new ready'); assert.equal(handed.state.status, 'waiting'); assert.equal(handed.state.stage, 1);
  } finally { await f.cleanup(); }
});

test('notification-only simulated teammate has admin review fallback', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const member = await joinBob(f, admin, { commands: false });
    const alice = await loadRuntime(admin.config_path), bob = await loadRuntime(member.config_path);
    const desktop = new DesktopExecutor(bob.service, bob.config); await desktop.bind('bob-thread');
    const task = await alice.service.create({ title: 'one human two bots', acceptance: ['pass'], workflow: ['backend'], execution_mode: 'desktop_poll' });
    const job = await desktop.poll('bob-thread'); await edit(job.job, 'backend.txt', 'done\n');
    const review = await desktop.finish('bob-thread', task.spec.id, 'Done'); assert.equal(review.state.assignee, 'alice');
    const detail = await f.manager.detail(admin.id); assert.equal(detail.members.find((m) => m.id === 'bob').verified_owner, false);
    await assert.rejects(f.manager.setReviewRules({ id: admin.id, expected_version: detail.version, review_rules: { ...detail.review_rules, backend: { required: true, reviewer: 'member:bob', notify: 'owner' } } }), /规则无效/);
    const approved = await alice.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }, {}, undefined, review.state.seq); assert.equal(approved.state.status, 'approved');
  } finally { await f.cleanup(); }
});


test('legacy imported team upgrades review rules for new tasks while keeping bindings and old task policy', async () => {
  const f = await fixture();
  try {
    const { setupLocal } = await import('../../../scripts/peer/setup-local.mjs');
    const { savePrivate } = await import('../manager.mjs');
    const { readPrivateJson } = await import('../../../packages/peer/config.mjs');
    const output = await setupLocal({ demo: f.repos.alice, out: join(f.root, 'legacy-upgrade'), mode: 'desktop-poll', ownerUserId: 'legacy-user' });
    const path = output.configs.alice, config = await readPrivateJson(path);
    await savePrivate(path, { ...config, wecom: { bot_id: 'legacy-alice', secret: 'fixture', chat_ids: ['group'] } });
    const runtime = await loadRuntime(path), desktop = new DesktopExecutor(runtime.service, runtime.config);
    await desktop.bind('same-thread'); const old = await runtime.service.create({ title: 'old', acceptance: ['pass'], execution_mode: 'desktop_poll' });
    const imported = await f.manager.importExisting({ config_path: path });
    const profile = await f.manager.detail(imported.id); assert.equal(profile.policy_schema_version, 2);
    const rules = Object.fromEntries(Object.keys(profile.routes).map((route) => [route, { required: true, reviewer: 'owner', notify: 'owner' }]));
    const updated = await f.manager.setReviewRules({ id: profile.id, expected_version: profile.version, review_rules: rules });
    assert.equal(updated.policy_schema_version, 3); assert.equal(updated.desktop.binding.thread_id, 'same-thread');
    const current = await loadRuntime(path); assert.equal((await current.service.read(old.spec.id)).team.schema_version, 2);
    assert.equal((await current.service.create({ title: 'new', acceptance: ['pass'], execution_mode: 'desktop_poll' })).team.schema_version, 3);
  } finally { await f.cleanup(); }
});
