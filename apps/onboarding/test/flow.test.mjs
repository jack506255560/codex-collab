import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, git } from './helpers.mjs';
import { loadRuntime } from '../../peer/runtime.mjs';
import { DesktopExecutor } from '../../peer/desktop.mjs';
import { dispatchPeerWecom, PeerNotificationRelay, formatPeerNotification } from '../../peer/wecom.mjs';
import { generateIdentity, digest, readPrivateJson } from '../../../packages/peer/config.mjs';
import { policyVersion, recordHash, validateHistory, invitationRecord, enrollmentRequest, approveEnrollment, validateEnrollment } from '../../../packages/peer/registry.mjs';
import { buildTeamPolicy } from '../../../scripts/peer/onboarding.mjs';
import { encryptBundle, decryptBundle } from '../bundle.mjs';

function initLocalRepo(path, branch = 'main') {
  execFileSync('git', ['init', '-b', branch, path], { stdio: 'ignore' });
  git(path, 'config', 'user.name', 'Test');
  git(path, 'config', 'user.email', 'test@example.invalid');
}

test('onboarding explains empty, missing-main and missing-origin repositories', async () => {
  const f = await fixture();
  try {
    const emptyRemote = join(f.root, 'empty-origin.git');
    const emptyRepo = join(f.root, 'empty-repo');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', emptyRemote], { stdio: 'ignore' });
    initLocalRepo(emptyRepo);
    await writeFile(join(emptyRepo, 'test.sh'), 'set -eu\n');
    git(emptyRepo, 'add', '.'); git(emptyRepo, 'commit', '-m', 'fixture'); git(emptyRepo, 'remote', 'add', 'origin', emptyRemote);
    await assert.rejects(
      f.manager.createAdmin({ repo: emptyRepo, agent_id: 'empty', capabilities: 'backend' }),
      (error) => error.message.includes('远程仓库为空') && error.message.includes('push -u origin main'),
    );

    const otherBranchRemote = join(f.root, 'other-branch-origin.git');
    const otherBranchRepo = join(f.root, 'other-branch-repo');
    execFileSync('git', ['init', '--bare', '--initial-branch=develop', otherBranchRemote], { stdio: 'ignore' });
    initLocalRepo(otherBranchRepo);
    await writeFile(join(otherBranchRepo, 'test.sh'), 'set -eu\n');
    git(otherBranchRepo, 'add', '.'); git(otherBranchRepo, 'commit', '-m', 'fixture');
    git(otherBranchRepo, 'remote', 'add', 'origin', otherBranchRemote); git(otherBranchRepo, 'push', 'origin', 'HEAD:develop');
    await assert.rejects(
      f.manager.createAdmin({ repo: otherBranchRepo, agent_id: 'develop', capabilities: 'backend' }),
      (error) => error.message.includes('没有 main 分支') && error.message.includes('push -u origin main'),
    );

    const noOriginRepo = join(f.root, 'no-origin-repo');
    execFileSync('git', ['clone', f.remote, noOriginRepo], { stdio: 'ignore' });
    git(noOriginRepo, 'remote', 'remove', 'origin');
    await assert.rejects(
      f.manager.createAdmin({ repo: noOriginRepo, agent_id: 'no-origin', capabilities: 'backend' }),
      /没有名为 origin 的远程仓库/,
    );
  } finally { await f.cleanup(); }
});

test('signed enrollment rejects tampering, forged claims, expiry, unauthorized policies and package reuse', () => {
  const alice = generateIdentity(), bob = generateIdentity(), claim = generateIdentity();
  const team = buildTeamPolicy({ repo: 'fixture', reviewer: 'alice', defaultRoute: 'backend', agents: [{ id: 'alice', role: 'admin', capabilities: ['backend'], publicKey: alice.public_key, wecomUserid: 'alice-user' }], routes: { backend: ['alice'] } });
  const root = policyVersion(team, null, 'alice', alice.private_key); const history = validateHistory([root], recordHash(root));
  const invite = invitationRecord({ invite_id: randomUUID(), agent_id: 'bob', capabilities: ['backend'], bot_id: 'bob-bot', chat_ids: ['group'], commands_enabled: true, prefer: true, claim_public_key: claim.public_key, expires_at: new Date(Date.now() + 86400000).toISOString() }, root, 'alice', alice.private_key);
  const request = enrollmentRequest({ invite, publicKey: bob.public_key, privateKey: bob.private_key, claimPrivateKey: claim.private_key, userid: 'bob-user', chatid: 'group', requestId: randomUUID() });
  assert.throws(() => validateEnrollment({ ...request, wecom_userid: 'forged' }, invite, history));
  assert.throws(() => validateEnrollment({ ...request, invitation_signature: 'invalid' }, invite, history));
  assert.throws(() => validateEnrollment(request, invite, history, { now: Date.now() + 2 * 86400000 }));
  const version = approveEnrollment(request, invite, history, 'alice', alice.private_key); const grown = validateHistory([root, version], recordHash(root));
  assert.deepEqual(grown.latest.team.routes.backend, ['bob', 'alice']); assert.equal(approveEnrollment(request, invite, grown, 'alice', alice.private_key), null);
  const other = generateIdentity(); const second = enrollmentRequest({ invite, publicKey: other.public_key, privateKey: other.private_key, claimPrivateKey: claim.private_key, userid: 'other-user', chatid: 'group', requestId: randomUUID() });
  assert.throws(() => approveEnrollment(second, invite, grown, 'alice', alice.private_key));
  assert.throws(() => validateHistory([root, { ...version, signature: 'bad' }], recordHash(root)));
  assert.throws(() => validateHistory([root], '0'.repeat(64)));
  const altered = structuredClone(grown.latest.team); altered.agents.alice.public_key = other.public_key;
  assert.throws(() => validateHistory([root, version, policyVersion(altered, version, 'bob', bob.private_key)], recordHash(root)));
});

test('admin allocates encrypted bot package; member enrolls locally; desktop stages notify and hand off', async (t) => {
  const f = await fixture();
  try {
    const admin = await f.admin(); assert.equal(admin.phase, 'ready'); assert.equal(f.calls[0].command, 'start');
    const alice = await loadRuntime(admin.config_path); const old = await alice.service.create({ title: 'old backend', acceptance: ['pass'], workflow: ['backend'], execution_mode: 'desktop_poll' }, 'old-policy');
    const invite = await f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-secret-bob', password: 'long-fixture-password' });
    const exported = await f.manager.exportedBundle(admin.id, invite.invite_id);
    assert.doesNotMatch(exported.content, /fixture-secret-bob|PRIVATE KEY/);
    await assert.rejects(f.manager.importBundle({ content: exported.content, password: 'bad', repo: f.repos.bob }));
    const bobProfile = await f.manager.importBundle({ content: exported.content, password: 'long-fixture-password', repo: f.repos.bob });
    assert.equal(bobProfile.phase, 'imported');
    const verify = await f.verify({ profile_id: bobProfile.id }, 'owner-bob'); const waiting = await f.manager.verifyMember({ id: bobProfile.id, discovery_id: verify }); assert.equal(waiting.phase, 'waiting');
    const dashboard = await f.manager.detail(admin.id); assert.equal(dashboard.requests.length, 1); assert.equal(dashboard.requests[0].agent_id, 'bob');
    await f.manager.approve({ id: admin.id, request_id: dashboard.requests[0].request_id });
    // A crash after approval but before saving the waiting phase must recover even after invite expiry.
    const recovering = await f.manager.state(bobProfile.id); recovering.phase = 'verified'; await f.manager.save(recovering);
    const originalNow = Date.now; const clock = t.mock.method(Date, 'now', () => originalNow() + 8 * 86400000);
    let ready; try { ready = await f.manager.resume(bobProfile.id); } finally { clock.mock.restore(); }
    assert.equal(ready.phase, 'ready'); const bob = await loadRuntime(ready.config_path);
    assert.equal(bob.team.agents.bob.wecom_userid, 'owner-bob'); assert.deepEqual(bob.team.routes.backend, ['bob', 'alice']);
    assert.equal((await alice.service.read(old.spec.id)).events[0].team_hash, digest((await alice.service.read(old.spec.id)).team));
    await assert.rejects(bob.service.claim(old.spec.id, 'no-old-policy', { executionMode: 'desktop_poll' }));
    await f.manager.resume(bobProfile.id); // Attachment and setup are idempotent.
    assert.equal(git(f.repos.bob, 'status', '--porcelain'), '');
    assert.equal((await stat(ready.config_path)).mode & 0o777, 0o600);
    assert.throws(() => git(alice.store.checkout, 'grep', '-l', 'PRIVATE KEY'));
    assert.throws(() => git(alice.store.checkout, 'grep', '-l', 'fixture-secret'));
    const aliceDesktop = new DesktopExecutor(alice.service, alice.config); const bobDesktop = new DesktopExecutor(bob.service, bob.config);
    await aliceDesktop.bind('alice-thread'); await bobDesktop.bind('bob-thread');
    await alice.service.report(old.spec.id, { type: 'cancelled' });
    const task = await alice.service.create({ title: 'two stages', acceptance: ['fixed tests pass'], workflow: ['frontend', 'backend'], execution_mode: 'desktop_poll', chatId: 'group' }, 'workflow');
    const messages = [];
    const relay = new PeerNotificationRelay(alice.service, async (value, type) => messages.push(formatPeerNotification(value, type, 'alice', value.team)));
    const first = await aliceDesktop.poll('alice-thread'); assert.equal(first.job.task_id, task.spec.id);
    await writeFile(join(first.job.worktree, 'frontend.txt'), 'done\n'); git(first.job.worktree, 'add', 'frontend.txt'); git(first.job.worktree, 'commit', '-m', 'frontend');
    const handed = await aliceDesktop.finish('alice-thread', task.spec.id, '前端已完成'); assert.equal(handed.state.stage, 0); assert.equal(handed.state.status, 'stage_review'); await relay.poll();
    assert.equal((await bobDesktop.poll('bob-thread')).job, null, 'next conversation waits for human approval');
    assert.ok(messages.some((message) => message.includes('前端已完成') && message.includes(`R-${handed.state.seq}`)));
    await alice.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }, {}, 'frontend-approved', handed.state.seq); await relay.poll();
    assert.ok(messages.some((message) => message.includes('真人审核已通过') && message.includes('优先 bob')));
    const next = await bobDesktop.poll('bob-thread'); assert.equal(next.job.source_commit, handed.state.checkpoint.commit);
    await writeFile(join(next.job.worktree, 'backend.txt'), 'done\n'); git(next.job.worktree, 'add', 'backend.txt'); git(next.job.worktree, 'commit', '-m', 'backend');
    const finished = await bobDesktop.finish('bob-thread', task.spec.id, '后端已完成'); assert.equal(finished.state.status, 'review');
    assert.equal((await bobDesktop.status()).poll_count, 2); assert.ok((await bobDesktop.status()).last_poll_at);
    assert.equal((await f.manager.detail(bobProfile.id)).poll_observed, true);
    const { mkdir } = await import('node:fs/promises');
    const bobData = bob.config.data_dir;
    await mkdir(bobData, { recursive: true });
    await writeFile(join(bobData, 'runner.pid.json'), JSON.stringify({ pid: process.pid, config: ready.config_path }));
    await writeFile(join(bobData, 'wecom-health.json'), JSON.stringify({ pid: process.pid, status: 'authenticated' }));
    assert.equal((await f.manager.detail(bobProfile.id)).can_receive_tasks, true);
    const botConfig = { ...bob.config.wecom, execution_mode: 'desktop_poll' }; let reply = '';
    const body = { chattype: 'group', msgtype: 'text', chatid: 'group', msgid: 'admin-dispatch', from: { userid: 'owner-alice' }, text: { content: '协作 创建 指派给后端 | tests pass' } };
    assert.equal(await dispatchPeerWecom({ body }, { service: bob.service, config: botConfig, reply: async (_, value) => { reply = value; } }), true); assert.match(reply, /已创建/);
    assert.equal(await dispatchPeerWecom({ body: { ...body, msgid: 'outsider', from: { userid: 'outsider' } } }, { service: bob.service, config: botConfig, reply: async () => assert.fail('stranger') }), false);
    assert.equal(await dispatchPeerWecom({ body: { ...body, msgid: 'admin-review', text: { content: `协作 审核 ${task.spec.id} 通过` } } }, { service: bob.service, config: botConfig, reply: async () => assert.fail('member must not sign admin review') }), false);
    const approval = { ...body, msgid: 'bob-review', from: { userid: 'owner-bob' }, text: { content: `协作 审核 ${task.spec.id} R-${finished.state.seq} 通过` } };
    assert.equal(await dispatchPeerWecom({ body: approval }, { service: bob.service, config: botConfig, reply: async (_, value) => { reply = value; } }), true);
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'approved');
    await assert.rejects(bob.service.report(task.spec.id, { type: 'completed' }), /administrator/);
    assert.equal((await alice.service.report(task.spec.id, { type: 'completed' })).state.status, 'completed');
    // Verify a policy rollback is detected using the previously persisted checkpoint.
    git(alice.store.checkout, 'fetch', 'origin', 'agent-collab'); const tip = git(alice.store.checkout, 'rev-parse', 'origin/agent-collab');
    git(alice.store.checkout, 'checkout', '-B', 'agent-collab', tip); git(alice.store.checkout, 'rm', '.agent-collab/team/versions/000002.json'); git(alice.store.checkout, 'commit', '-m', 'invalid rollback'); git(alice.store.checkout, 'push', 'origin', 'HEAD:agent-collab');
    await assert.rejects(bob.service.list(), /rolled back or forked/);
  } finally { await f.cleanup(); }
});

test('existing admin/member configs adopt signed registry without changing task policy or private chat binding', async () => {
  const f = await fixture();
  try {
    const { setupLocal } = await import('../../../scripts/peer/setup-local.mjs');
    const { savePrivate } = await import('../manager.mjs');
    const output = await setupLocal({ demo: f.repos.alice, out: join(f.root, 'legacy'), mode: 'desktop-poll', ownerUserId: 'legacy-user' });
    for (const id of ['alice', 'bob']) {
      const config = await readPrivateJson(output.configs[id]);
      await savePrivate(output.configs[id], { ...config, wecom: { bot_id: `legacy-${id}`, secret: `fixture-${id}`, chat_ids: ['group'], commands_enabled: id === 'alice' } });
    }
    const runtime = await loadRuntime(output.configs.alice); const desktop = new DesktopExecutor(runtime.service, runtime.config);
    await desktop.bind('original-thread'); const task = await runtime.service.create({ title: 'legacy', acceptance: ['pass'], workflow: ['backend'], execution_mode: 'desktop_poll' }, 'legacy-task');
    const rootHash = digest(runtime.team); const imported = await f.manager.importExisting({ config_path: output.configs.alice });
    assert.equal(imported.desktop.binding.thread_id, 'original-thread'); assert.equal(imported.config_path, output.configs.alice);
    const updated = await loadRuntime(output.configs.alice); assert.equal((await updated.service.read(task.spec.id)).events[0].team_hash, rootHash);
    const bob = await f.manager.importExisting({ config_path: output.configs.bob }); assert.equal(bob.phase, 'ready'); assert.equal(bob.config_path, output.configs.bob);
    const importedAgain = await f.manager.importExisting({ config_path: output.configs.alice }); assert.equal(importedAgain.id, imported.id);
  } finally { await f.cleanup(); }
});

test('imported legacy desktop attachment recognizes its generated desktop MCP config', async () => {
  const f = await fixture();
  try {
    const { setupLocal } = await import('../../../scripts/peer/setup-local.mjs');
    const { setupDesktopProject } = await import('../../../scripts/peer/setup-desktop-project.mjs');
    const { savePrivate } = await import('../manager.mjs');
    const { readPrivateJson } = await import('../../../packages/peer/config.mjs');
    const { execFileSync } = await import('node:child_process');
    const output = await setupLocal({ demo: f.repos.alice, out: join(f.root, 'legacy-mcp'), mode: 'desktop-poll' });
    const configPaths = {};
    for (const id of ['alice', 'bob']) {
      const configPath = output.configs[id];
      const config = await readPrivateJson(configPath);
      const target = join(f.root, `legacy-${id}-target`);
      execFileSync('git', ['clone', output.shared_origin, target], { stdio: 'ignore' });
      await savePrivate(configPath, { ...config, repo: target, wecom: { bot_id: `legacy-${id}`, secret: 'fixture', chat_ids: ['group'], commands_enabled: false } });
      await setupDesktopProject({ configPath, repo: target });
      configPaths[id] = configPath;
    }

    const admin = await f.manager.importExisting({ config_path: configPaths.alice });
    assert.deepEqual(admin.project_setup, { mcp_configured: true, skill_installed: true });
    const imported = await f.manager.importExisting({ config_path: configPaths.bob });
    assert.deepEqual(imported.project_setup, { mcp_configured: true, skill_installed: true });
  } finally { await f.cleanup(); }
});

test('interrupted project attachment resumes without overwriting user configuration', async () => {
  const f = await fixture();
  try {
    const { mkdir } = await import('node:fs/promises');
    const { savePrivate } = await import('../manager.mjs');
    const path = join(f.repos.alice, '.codex/config.toml'); await mkdir(join(f.repos.alice, '.codex'), { recursive: true }); await writeFile(path, 'model = "existing-provider-model"\n');
    const admin = await f.admin();
    assert.deepEqual(admin.project_setup, { mcp_configured: true, skill_installed: true });
    let state = await f.manager.state(admin.id); state.phase = 'configuring'; state.attached = false; await f.manager.save(state);
    const resumed = await f.manager.resume(admin.id); assert.equal(resumed.phase, 'ready'); assert.match(await readFile(path, 'utf8'), /existing-provider-model/);
    assert.deepEqual(resumed.project_setup, { mcp_configured: true, skill_installed: true });
    const before = await readFile(path, 'utf8'); await f.manager.resume(admin.id); assert.equal(await readFile(path, 'utf8'), before);
    await savePrivate(join(f.manager.path(admin.id), 'data/runner.pid.json'), { pid: process.pid, config: admin.config_path });
    await assert.rejects(f.manager.beginDiscovery({ bot_id: 'bot-alice', secret: 'fixture' }), /已有本机 Runner/);
  } finally { await f.cleanup(); }
});


test('failed invitation publication can recover the same encrypted export without distributing an unpublished assignment', async () => {
  const f = await fixture();
  try {
    const { readdir, rm } = await import('node:fs/promises');
    const admin = await f.admin();
    const hook = join(f.remote, 'hooks/pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'recover-bob', secret: 'fixture-recovery-secret', password: 'long-fixture-password' }), /not accepted/);
    const files = await readdir(join(f.manager.path(admin.id), 'exports')); assert.equal(files.length, 1);
    const invitation = files[0].replace(/\.json$/, '');
    await assert.rejects(f.manager.exportedBundle(admin.id, invitation), /not accepted/);
    await rm(hook);
    const exported = await f.manager.exportedBundle(admin.id, invitation);
    assert.equal(decryptBundle(JSON.parse(exported.content), 'long-fixture-password').invitation.invite_id, invitation);
    const member = await f.manager.importBundle({ content: exported.content, password: 'long-fixture-password', repo: f.repos.bob });
    assert.equal(member.phase, 'imported');
    await assert.rejects(f.manager.issueBundle({ id: admin.id, agent_id: 'other', capabilities: 'backend', bot_id: 'recover-bob', secret: 'fixture', password: 'long-fixture-password' }), /有效接入包/);
  } finally { await f.cleanup(); }
});

test('readiness requires MCP, Skill, authenticated runner, binding and recent polling', async () => {
  const f = await fixture();
  try {
    const { rm } = await import('node:fs/promises');
    const admin = await f.admin(); const runtime = await loadRuntime(admin.config_path);
    const desktop = new DesktopExecutor(runtime.service, runtime.config);
    await desktop.bind('readiness-thread'); await desktop.poll('readiness-thread');
    await writeFile(join(runtime.config.data_dir, 'runner.pid.json'), JSON.stringify({ pid: process.pid, config: admin.config_path }));
    await writeFile(join(runtime.config.data_dir, 'wecom-health.json'), JSON.stringify({ pid: process.pid, status: 'authenticated' }));
    assert.equal((await f.manager.detail(admin.id)).can_receive_tasks, true);
    const tomlPath = join(f.repos.alice, '.codex/config.toml'); const original = await readFile(tomlPath, 'utf8');
    await writeFile(tomlPath, original.replace('[mcp_servers.team-collab-alice]', '[mcp_servers.team-collab-alice]\nenabled = false'));
    assert.equal((await f.manager.detail(admin.id)).can_receive_tasks, false);
    await writeFile(tomlPath, '');
    const missingMcp = await f.manager.detail(admin.id); assert.equal(missingMcp.project_setup.mcp_configured, false); assert.equal(missingMcp.can_receive_tasks, false);
    await writeFile(tomlPath, original);
    await rm(join(f.repos.alice, '.agents/skills/team-collab-desktop/SKILL.md'));
    const missingSkill = await f.manager.detail(admin.id); assert.equal(missingSkill.project_setup.skill_installed, false); assert.equal(missingSkill.can_receive_tasks, false);
  } finally { await f.cleanup(); }
});

test('runner failures persist safe errors and successful retry clears them', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); f.manager.runCli = () => { throw new Error('SECRET-MUST-NOT-LEAK'); };
    await assert.rejects(f.manager.runner({ id: admin.id, command: 'start' }), /机器人启动未完成/);
    const failed = await f.manager.detail(admin.id); assert.match(failed.error, /Runner 日志/); assert.doesNotMatch(failed.error, /SECRET/);
    await assert.rejects(f.manager.resume(admin.id), (error) => error.name === 'Error' && !error.message.includes('SECRET'));
    assert.doesNotMatch((await f.manager.detail(admin.id)).error, /SECRET/);
    f.manager.runCli = () => {};
    assert.equal((await f.manager.runner({ id: admin.id, command: 'start' })).error, null);
  } finally { await f.cleanup(); }
});

test('member import rejects another origin before creating a profile or changing repository settings', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const invite = await f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-secret', password: 'long-fixture-password' });
    const exported = await f.manager.exportedBundle(admin.id, invite.invite_id);
    const otherRemote = join(f.root, 'another-origin.git');
    execFileSync('git', ['clone', '--bare', f.remote, otherRemote], { stdio: 'ignore' });
    git(f.repos.bob, 'remote', 'set-url', 'origin', otherRemote);
    await assert.rejects(f.manager.importBundle({ content: exported.content, password: 'long-fixture-password', repo: f.repos.bob }), /origin 与邀请仓库不一致/);
    assert.equal(git(f.repos.bob, 'remote', 'get-url', 'origin'), otherRemote);
    assert.deepEqual((await f.manager.overview()).profiles.map((profile) => profile.id), [admin.id]);
    assert.equal(git(f.repos.bob, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('malformed invitation file has an actionable error before creating local identity', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.importBundle({ content: '{broken', password: 'fixture-password', repo: f.repos.bob }), /接入包文件不是有效 JSON/);
    assert.deepEqual((await f.manager.overview()).profiles, []);
  } finally { await f.cleanup(); }
});
