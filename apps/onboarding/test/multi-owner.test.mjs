import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, git } from './helpers.mjs';
import { generateIdentity, validateTeam } from '../../../packages/peer/config.mjs';
import { buildTeamPolicy } from '../../../scripts/peer/onboarding.mjs';
import { policyVersion, recordHash, validateHistory, invitationRecord, enrollmentRequest, approveEnrollment, validateEnrollment } from '../../../packages/peer/registry.mjs';
import { loadRuntime } from '../../peer/runtime.mjs';
import { DesktopExecutor } from '../../peer/desktop.mjs';
import { dispatchPeerWecom, formatPeerNotification } from '../../peer/wecom.mjs';

const ownInput = (f, admin) => ({ id: admin.id, repo: f.repos.bob, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-secret-bob' });
const frame = (text, id, userid = 'owner-alice') => ({ body: { chattype: 'group', chatid: 'group', msgtype: 'text', msgid: id, from: { userid }, text: { content: text } } });

async function enrollOwn(f, admin) {
  const profile = await f.manager.createOwnAgent(ownInput(f, admin));
  const proof = await f.verify({ profile_id: profile.id });
  return f.manager.verifyMember({ id: profile.id, discovery_id: proof });
}

test('one human may own distinct agents while duplicate keys and invalid owners remain rejected', () => {
  const alice = generateIdentity(), bob = generateIdentity();
  const team = buildTeamPolicy({ repo: 'fixture', reviewer: 'alice', defaultRoute: 'backend', agents: [
    { id: 'alice', role: 'admin', capabilities: ['backend'], publicKey: alice.public_key, wecomUserid: 'same-human' },
    { id: 'bob', role: 'member', capabilities: ['backend'], publicKey: bob.public_key, wecomUserid: 'same-human' },
  ], routes: { backend: ['alice', 'bob'] } });
  assert.equal(validateTeam(team), team);
  for (const owner of ['', ' ', null, 42, 'x'.repeat(201)]) {
    const invalid = structuredClone(team); invalid.agents.bob.wecom_userid = owner;
    assert.throws(() => validateTeam(invalid), /invalid WeCom owner/);
  }
  const duplicate = structuredClone(team); duplicate.agents.bob.public_key = alice.public_key;
  assert.throws(() => validateTeam(duplicate), /distinct Ed25519/);
});

test('self-owned invitations pin a proven account, preserve signature validation and keep agent roles independent', () => {
  const alice = generateIdentity(), bob = generateIdentity(), claim = generateIdentity();
  const team = buildTeamPolicy({ repo: 'fixture', reviewer: 'alice', defaultRoute: 'backend', agents: [{ id: 'alice', role: 'admin', capabilities: ['backend'], publicKey: alice.public_key, wecomUserid: 'same-human' }], routes: { backend: ['alice'] } });
  const root = policyVersion(team, null, 'alice', alice.private_key), history = validateHistory([root], recordHash(root));
  const input = { invite_id: randomUUID(), agent_id: 'bob', capabilities: ['backend'], bot_id: 'bot-bob', chat_ids: ['group'], commands_enabled: true, prefer: true, claim_public_key: claim.public_key, expires_at: new Date(Date.now() + 86400000).toISOString(), owner_userid: 'same-human' };
  const invite = invitationRecord(input, root, 'alice', alice.private_key);
  const request = (userid) => enrollmentRequest({ invite, publicKey: bob.public_key, userid, chatid: 'group', requestId: randomUUID(), privateKey: bob.private_key, claimPrivateKey: claim.private_key });
  assert.throws(() => validateEnrollment(request('other-human'), invite, history));
  assert.throws(() => invitationRecord({ ...input, owner_userid: 'other-human' }, root, 'alice', alice.private_key));
  assert.throws(() => invitationRecord({ ...input, commands_enabled: false }, root, 'alice', alice.private_key));
  const approved = approveEnrollment(request('same-human'), invite, history, 'alice', alice.private_key);
  const grown = validateHistory([root, approved], recordHash(root));
  assert.equal(grown.latest.team.agents.bob.wecom_userid, 'same-human');
  assert.equal(grown.latest.team.agents.bob.role, 'member');
  assert.notEqual(grown.latest.team.agents.alice.public_key, grown.latest.team.agents.bob.public_key);
  assert.throws(() => validateEnrollment(request('same-human'), { ...invite, owner_userid: 'tampered' }, history));
});

test('adding own bot uses a separate clone, rejects the wrong account and resumes without packages or duplicate identities', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    await assert.rejects(f.manager.createOwnAgent({ ...ownInput(f, admin), repo: f.repos.alice }), /独立 clone/);
    await assert.rejects(f.manager.createOwnAgent({ ...ownInput(f, admin), bot_id: 'bot-alice' }), /独立机器人/);
    const own = await f.manager.createOwnAgent(ownInput(f, admin));
    assert.equal(own.phase, 'imported'); assert.doesNotMatch(JSON.stringify(own), /fixture-secret|PRIVATE KEY/);
    const first = await f.manager.detail(admin.id);
    assert.equal(first.exports.length, 1); assert.equal(first.exports[0].own_agent, true);
    await assert.rejects(f.manager.exportedBundle(admin.id, first.exports[0].invite_id), /无需下载/);
    assert.equal((await f.manager.createOwnAgent(ownInput(f, admin))).id, own.id);
    await assert.rejects(f.manager.verifyMember({ id: own.id, discovery_id: await f.verify({ profile_id: own.id }, 'other-person') }), /同一个企业微信账号/);
    assert.equal((await f.manager.state(own.id)).phase, 'imported');
    const ready = await f.manager.verifyMember({ id: own.id, discovery_id: await f.verify({ profile_id: own.id }) });
    assert.equal(ready.phase, 'ready'); assert.equal(f.calls.length, 2);
    const bob = await loadRuntime(ready.config_path);
    assert.equal(bob.config.wecom.commands_enabled, true); assert.equal(bob.team.agents.bob.wecom_userid, 'owner-alice');
    assert.equal(bob.team.agents.bob.role, 'member');
    const dashboard = await f.manager.detail(admin.id);
    assert.deepEqual(dashboard.owners, [{ agent_ids: ['alice', 'bob'], is_you: true }]);
    assert.deepEqual(dashboard.requests, []);
    assert.equal((await f.manager.resumeOwnAgent({ id: admin.id, invite_id: first.exports[0].invite_id })).id, own.id);
    assert.equal((await f.manager.createOwnAgent(ownInput(f, admin))).id, own.id);
    await assert.rejects(f.manager.createOwnAgent({ ...ownInput(f, admin), id: own.id, repo: f.repos.other }), /管理员/);
    assert.equal(git(f.repos.alice, 'status', '--porcelain'), ''); assert.equal(git(f.repos.bob, 'status', '--porcelain'), '');
    assert.match(await readFile(join(f.repos.alice, '.codex/config.toml'), 'utf8'), /team-collab-alice/);
    assert.match(await readFile(join(f.repos.bob, '.codex/config.toml'), 'utf8'), /team-collab-bob/);
    const exportPath = join(f.manager.path(admin.id), 'exports', `${first.exports[0].invite_id}.json`);
    assert.equal((await stat(exportPath)).mode & 0o777, 0o600);
    assert.throws(() => git(bob.store.checkout, 'grep', '-l', 'fixture-secret-bob'));
    assert.throws(() => git(bob.store.checkout, 'grep', '-l', 'PRIVATE KEY'));
  } finally { await f.cleanup(); }
});

test('own bot registration retries a lost Git acknowledgment using the saved assignment', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const original = f.manager.profileStore.bind(f.manager);
    let inject = true;
    f.manager.profileStore = async (...args) => {
      const store = await original(...args), transact = store.registryTransaction.bind(store);
      store.registryTransaction = async (fn) => {
        const value = await transact(fn);
        if (inject) { inject = false; throw new Error('lost acknowledgment'); }
        return value;
      };
      return store;
    };
    await assert.rejects(f.manager.createOwnAgent(ownInput(f, admin)), /lost acknowledgment/);
    const exports = await readdir(join(f.manager.path(admin.id), 'exports')); assert.equal(exports.length, 1);
    const imported = await f.manager.createOwnAgent(ownInput(f, admin)); assert.equal(imported.phase, 'imported');
    const ready = await f.manager.verifyMember({ id: imported.id, discovery_id: await f.verify({ profile_id: imported.id }) });
    assert.equal(ready.phase, 'ready');
    assert.equal((await f.manager.detail(admin.id)).exports.length, 1);
  } finally { await f.cleanup(); }
});

test('same owner drives two bound conversations; reviews use the correct bot and completion requires the admin agent', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(), ready = await enrollOwn(f, admin);
    const alice = await loadRuntime(admin.config_path), bob = await loadRuntime(ready.config_path);
    const aliceDesktop = new DesktopExecutor(alice.service, alice.config), bobDesktop = new DesktopExecutor(bob.service, bob.config);
    await aliceDesktop.bind('thread-alice'); await bobDesktop.bind('thread-bob');
    const dispatch = (runtime, text, id, userid) => dispatchPeerWecom(frame(text, id, userid), { service: runtime.service, config: { ...runtime.config.wecom, execution_mode: 'desktop_poll' }, reply: async () => {} });
    assert.equal(await dispatch(alice, '协作 创建 [frontend>backend] two own agents | tests pass', 'create'), true);
    const [task] = await alice.service.list(); assert.equal(task.spec.workflow.length, 2);
    await assert.rejects(bobDesktop.poll('thread-alice'), /thread|binding/);
    const first = await aliceDesktop.poll('thread-alice');
    await writeFile(join(first.job.worktree, 'frontend.txt'), 'done\n'); git(first.job.worktree, 'add', 'frontend.txt'); git(first.job.worktree, 'commit', '-m', 'frontend');
    const review = await aliceDesktop.finish('thread-alice', task.spec.id, 'frontend done'); assert.equal(review.state.assignee, 'alice');
    assert.equal((await bobDesktop.poll('thread-bob')).job, null);
    await dispatch(bob, `协作 审核 ${task.spec.id} R-${review.state.seq} 通过`, 'wrong-bot');
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'stage_review');
    await dispatch(alice, `协作 审核 ${task.spec.id} R-${review.state.seq} 通过`, 'alice-review');
    const next = await bobDesktop.poll('thread-bob'); assert.equal(next.job.source_commit, review.state.checkpoint.commit);
    await writeFile(join(next.job.worktree, 'backend.txt'), 'done\n'); git(next.job.worktree, 'add', 'backend.txt'); git(next.job.worktree, 'commit', '-m', 'backend');
    const final = await bobDesktop.finish('thread-bob', task.spec.id, 'backend done'); assert.equal(final.state.assignee, 'bob');
    const notification = formatPeerNotification(final, 'review_requested', 'bob', final.team);
    assert.match(notification, /审核身份：bob/); assert.match(notification, /@ bob 对应的机器人/);
    assert.equal(await dispatch(bob, `协作 审核 ${task.spec.id} R-${final.state.seq} 通过`, 'stranger', 'other-person'), false);
    await dispatch(alice, `协作 审核 ${task.spec.id} R-${final.state.seq} 通过`, 'wrong-final-bot');
    assert.equal((await bob.service.read(task.spec.id)).state.status, 'review');
    await dispatch(bob, `协作 审核 ${task.spec.id} R-${final.state.seq} 通过`, 'bob-review');
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'approved');
    await dispatch(bob, `协作 完成 ${task.spec.id}`, 'member-complete');
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'approved');
    await dispatch(alice, `协作 完成 ${task.spec.id}`, 'admin-complete');
    const completed = await alice.service.read(task.spec.id); assert.equal(completed.state.status, 'completed');
    assert.deepEqual(completed.events.filter((e) => e.type === 'reviewed').map((e) => e.actor_id), ['alice', 'bob']);
    assert.equal(completed.events.at(-1).actor_id, 'alice');
    assert.equal(git(first.job.worktree, 'rev-parse', 'HEAD'), next.job.source_commit);
  } finally { await f.cleanup(); }
});

test('a regular colleague can enroll several command-enabled agents under their own account', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    for (const id of ['bob', 'other']) {
      const invite = await f.manager.issueBundle({ id: admin.id, agent_id: id, capabilities: 'backend', bot_id: `bot-${id}`, secret: 'fixture', password: 'long-fixture-password' });
      const exported = await f.manager.exportedBundle(admin.id, invite.invite_id);
      const profile = await f.manager.importBundle({ content: exported.content, password: 'long-fixture-password', repo: f.repos[id] });
      await f.manager.verifyMember({ id: profile.id, discovery_id: await f.verify({ profile_id: profile.id }, 'owner-colleague') });
      const dashboard = await f.manager.detail(admin.id);
      await f.manager.approve({ id: admin.id, request_id: dashboard.requests[0].request_id });
      const ready = await f.manager.resume(profile.id); const runtime = await loadRuntime(ready.config_path);
      assert.equal(runtime.team.agents[id].wecom_userid, 'owner-colleague'); assert.equal(runtime.config.wecom.commands_enabled, true);
    }
    const dashboard = await f.manager.detail(admin.id);
    assert.deepEqual(dashboard.owners, [{ agent_ids: ['alice'], is_you: true }, { agent_ids: ['bob', 'other'], is_you: false }]);
  } finally { await f.cleanup(); }
});


test('own agent rejects another remote before saving an invitation or identity', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    git(f.repos.bob, 'remote', 'set-url', 'origin', join(f.root, 'seed'));
    await assert.rejects(f.manager.createOwnAgent(ownInput(f, admin)), /远程与邀请仓库不一致/);
    assert.equal((await f.manager.overview()).profiles.length, 1);
    assert.deepEqual((await f.manager.detail(admin.id)).exports, []);
    assert.deepEqual(await readdir(join(f.manager.home, 'identities')), ['alice.private.json', 'alice.public.pem']);
    assert.equal(git(f.repos.bob, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('own agent resumes a persisted enrollment after automatic approval is interrupted', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const own = await f.manager.createOwnAgent(ownInput(f, admin));
    const approve = f.manager.approve.bind(f.manager);
    f.manager.approve = async () => { throw new Error('temporary failure with fixture-secret'); };
    await assert.rejects(f.manager.verifyMember({ id: own.id, discovery_id: await f.verify({ profile_id: own.id }) }),
      (error) => /继续/.test(error.message) && !/fixture-secret/.test(error.message));
    const persisted = await f.manager.state(own.id); assert.equal(persisted.phase, 'waiting');
    f.manager.approve = approve;
    const ready = await f.manager.resume(own.id); assert.equal(ready.phase, 'ready'); assert.equal(ready.own_agent, true);
    const resumed = await f.manager.state(own.id); assert.equal(resumed.request.request_id, persisted.request.request_id);
    const dashboard = await f.manager.detail(admin.id); assert.equal(dashboard.version, 2); assert.equal(dashboard.requests.length, 0);
    assert.equal((await f.manager.resume(own.id)).phase, 'ready'); assert.equal((await f.manager.detail(admin.id)).version, 2);
  } finally { await f.cleanup(); }
});
