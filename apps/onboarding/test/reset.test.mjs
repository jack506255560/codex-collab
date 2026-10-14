import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { DesktopExecutor } from '../../peer/desktop.mjs';
import { loadRuntime, readPeerConfig } from '../../peer/runtime.mjs';

const confirm = (plan) => ({ id: plan.id, kind: plan.kind, preview_token: plan.preview_token, confirmation: plan.agent_id, heartbeat_paused: true });

async function bound(f) {
  const admin = await f.admin(); const runtime = await loadRuntime(admin.config_path); const desktop = new DesktopExecutor(runtime.service, runtime.config);
  await desktop.bind('old-thread'); await desktop.poll('old-thread');
  return { admin, runtime, desktop };
}

test('conversation reset requires confirmation, pauses old binding, preserves identity and permits a new chat', async () => {
  const f = await fixture();
  try {
    const { admin, desktop } = await bound(f); const original = await readFile(admin.config_path, 'utf8');
    const plan = await f.manager.resetPreview({ id: admin.id, kind: 'conversation' });
    assert.equal(plan.thread_id, 'old-thread'); assert.doesNotMatch(JSON.stringify(plan), /fixture-secret|private_key/);
    await assert.rejects(f.manager.reset({ ...confirm(plan), confirmation: 'bob' }), /Agent 名称/);
    await assert.rejects(f.manager.reset({ ...confirm(plan), heartbeat_paused: false }), /暂停/);
    const result = await f.manager.reset(confirm(plan)); assert.equal(result.done, true); assert.equal(result.automation_paused, false);
    assert.equal((await desktop.status()).binding, null); assert.equal((await desktop.status()).last_poll_at, null);
    await assert.rejects(desktop.poll('old-thread'), /not the bound/);
    assert.equal(await readFile(admin.config_path, 'utf8'), original);
    assert.equal((await lstat(result.backup_path)).mode & 0o777, 0o600);
    await desktop.bind('new-thread'); assert.equal((await desktop.status()).binding.thread_id, 'new-thread');
    await assert.rejects(f.manager.reset(confirm(plan)), /预览/);
  } finally { await f.cleanup(); }
});

test('active leases block preview and a task claimed after preview blocks reset without stopping the Runner', async () => {
  const f = await fixture();
  try {
    const { admin, runtime, desktop } = await bound(f);
    const plan = await f.manager.resetPreview({ id: admin.id, kind: 'conversation' });
    const task = await runtime.service.create({ title: 'fixture', acceptance: ['sh test.sh'], workflow: ['frontend'], execution_mode: 'desktop_poll', source: { system: 'manual', request_id: 'reset-active' } });
    await desktop.poll('old-thread'); const stopCount = f.calls.filter((call) => call.command === 'stop').length;
    for (const kind of ['conversation', 'robot', 'project']) await assert.rejects(f.manager.resetPreview({ id: admin.id, kind }), /正在运行/);
    await assert.rejects(f.manager.reset(confirm(plan)), /正在运行/);
    assert.equal((await desktop.status()).binding.thread_id, 'old-thread'); assert.equal(f.calls.filter((call) => call.command === 'stop').length, stopCount);
    await desktop.fail('old-thread', task.spec.id, 'fixture failure');
    assert.ok((await f.manager.resetPreview({ id: admin.id, kind: 'conversation' })).preview_token);
  } finally { await f.cleanup(); }
});

test('project removal and restore preserve other settings, business files, ledger, worktrees and original identity', async () => {
  const f = await fixture();
  try {
    const { admin, runtime, desktop } = await bound(f);
    const configFile = join(f.repos.alice, '.codex/config.toml'); const skillFile = join(f.repos.alice, '.agents/skills/team-collab-desktop/SKILL.md');
    const original = await readFile(configFile, 'utf8'); const unrelated = 'model = "fixture"\n\n[mcp_servers.other]\ncommand = "fixture-other"\n';
    await writeFile(configFile, unrelated + original); const source = await readFile(join(f.repos.alice, 'test.sh'), 'utf8');
    const ledger = git(f.remote, 'rev-parse', 'agent-collab'); const business = git(f.repos.alice, 'rev-parse', 'HEAD');
    await writeFile(join(f.repos.alice, 'uncommitted.txt'), 'preserve user changes');
    const plan = await f.manager.resetPreview({ id: admin.id, kind: 'project' });
    const result = await f.manager.reset(confirm(plan));
    assert.equal((await f.manager.state(admin.id)).phase, 'removed');
    assert.equal((await f.manager.overview()).profiles.length, 0); assert.equal((await f.manager.overview()).removed_profiles[0].id, admin.id);
    assert.match(await readFile(configFile, 'utf8'), /model = "fixture"/); assert.match(await readFile(configFile, 'utf8'), /mcp_servers.other/); assert.doesNotMatch(await readFile(configFile, 'utf8'), /team-collab-alice/);
    await assert.rejects(readFile(skillFile), { code: 'ENOENT' });
    assert.equal(await readFile(join(f.repos.alice, 'test.sh'), 'utf8'), source); assert.equal(await readFile(join(f.repos.alice, 'uncommitted.txt'), 'utf8'), 'preserve user changes');
    assert.equal(git(f.remote, 'rev-parse', 'agent-collab'), ledger); assert.equal(git(f.repos.alice, 'rev-parse', 'HEAD'), business);
    await assert.rejects(readPeerConfig(admin.config_path), /已移除/); await assert.rejects(desktop.bind('stale-thread'), /removed/);
    await assert.rejects(f.manager.resume(admin.id), /已移除/);
    await writeFile(configFile, (await readFile(configFile, 'utf8')) + '\n[mcp_servers.new]\ncommand = "new"\n');
    const restore = await f.manager.resetPreview({ id: admin.id, kind: 'restore' }); await f.manager.reset(confirm(restore));
    const restored = await readPeerConfig(admin.config_path); assert.equal(restored.config.private_key, runtime.config.private_key);
    const text = await readFile(configFile, 'utf8'); assert.match(text, /mcp_servers.new/); assert.match(text, /team-collab-alice/); assert.ok(await readFile(skillFile, 'utf8'));
    assert.equal((await desktop.status()).binding, null); await desktop.bind('restored-thread');
    assert.equal((await f.manager.overview()).profiles[0].id, admin.id); assert.equal((await f.manager.detail(admin.id)).runner.online, false);
    assert.equal((await lstat(result.backup_path)).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test('removed clone can accept a different identity and restoration cannot overwrite the replacement', async () => {
  const f = await fixture();
  try {
    const { admin } = await bound(f);
    const invite = await f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-bob-secret', password: 'long-fixture-password' });
    const bundle = await f.manager.exportedBundle(admin.id, invite.invite_id);
    await f.manager.reset(confirm(await f.manager.resetPreview({ id: admin.id, kind: 'project' })));
    const member = await f.manager.importBundle({ content: bundle.content, password: 'long-fixture-password', repo: f.repos.alice }); assert.equal(member.agent_id, 'bob');
    await assert.rejects(f.manager.resetPreview({ id: admin.id, kind: 'restore' }), /其他本机项目/);
  } finally { await f.cleanup(); }
});

test('custom, tracked and symbolic linked project integrations are never overwritten', async () => {
  const f = await fixture();
  try {
    const { admin } = await bound(f); const file = join(f.repos.alice, '.codex/config.toml'); const skill = join(f.repos.alice, '.agents/skills/team-collab-desktop/SKILL.md');
    const toml = await readFile(file, 'utf8'); const template = await readFile(skill, 'utf8');
    await writeFile(skill, template + '\ncustom'); await assert.rejects(f.manager.resetPreview({ id: admin.id, kind: 'project' }), /自定义/); assert.match(await readFile(skill, 'utf8'), /custom/);
    await writeFile(skill, template); await writeFile(file, toml + '\n[mcp_servers.team-collab-alice.custom]\nfoo = "bar"\n'); await assert.rejects(f.manager.resetPreview({ id: admin.id, kind: 'project' }), /其他协作身份|嵌套/);
    await writeFile(file, toml); git(f.repos.alice, 'add', '-f', '.codex/config.toml'); await assert.rejects(f.manager.resetPreview({ id: admin.id, kind: 'project' }), /Git/); git(f.repos.alice, 'reset', '--', '.codex/config.toml');
    const external = join(f.root, 'external.toml'); await writeFile(external, toml); await rm(file); await symlink(external, file);
    await assert.rejects(f.manager.resetPreview({ id: admin.id, kind: 'project' }), /符号链接/); assert.equal(await readFile(external, 'utf8'), toml);
  } finally { await f.cleanup(); }
});

test('stale preview, expired preview and mismatched Runner config refuse any cleanup', async () => {
  const f = await fixture();
  try {
    const { admin, runtime, desktop } = await bound(f); const plan = await f.manager.resetPreview({ id: admin.id, kind: 'project' });
    const path = join(f.repos.alice, '.codex/config.toml'); await writeFile(path, (await readFile(path, 'utf8')) + '\n# edited\n');
    await assert.rejects(f.manager.reset(confirm(plan)), /预览/); assert.equal((await desktop.status()).binding.thread_id, 'old-thread');
    const expired = await f.manager.resetPreview({ id: admin.id, kind: 'conversation' }); f.manager.resets.previews.get(expired.preview_token).expires = 0;
    await assert.rejects(f.manager.reset(confirm(expired)), /预览/);
    await writeFile(join(runtime.config.data_dir, 'runner.pid.json'), JSON.stringify({ pid: process.pid, config: join(f.root, 'wrong.json') }));
    await assert.rejects(f.manager.resetPreview({ id: admin.id, kind: 'conversation' }), /Runner 配置/);
  } finally { await f.cleanup(); }
});

test('Runner must actually stop before a binding or project config is changed', async () => {
  const f = await fixture();
  try {
    const { admin, runtime, desktop } = await bound(f); const path = join(runtime.config.data_dir, 'runner.pid.json');
    await writeFile(path, JSON.stringify({ pid: process.pid, config: admin.config_path }));
    const plan = await f.manager.resetPreview({ id: admin.id, kind: 'conversation' });
    await assert.rejects(f.manager.reset(confirm(plan)), /仍在停止/); assert.equal((await desktop.status()).binding.thread_id, 'old-thread');
    f.manager.runCli = (command) => { assert.equal(command, 'stop'); git(f.repos.alice, 'status', '--porcelain'); }; // deliberately still online
    await assert.rejects(f.manager.reset(confirm(plan)), /仍在停止/);
    await rm(path); await f.manager.reset(confirm(plan)); assert.equal((await desktop.status()).binding, null);
  } finally { await f.cleanup(); }
});

test('new bot Secret requires original owner proof and changes all configs without unbinding the chat', async () => {
  const f = await fixture();
  try {
    const { admin, desktop } = await bound(f); const plan = await f.manager.resetPreview({ id: admin.id, kind: 'robot' });
    await assert.rejects(f.manager.reset(confirm(plan)), /群验证码/);
    const session = await f.manager.resetDiscovery({ ...confirm(plan), secret: 'new-fixture-secret' });
    const state = f.discovery.sessions.get(session.id); state.client.emit('authenticated');
    state.client.emit('message.text', { body: { chattype: 'group', chatid: 'group', from: { userid: 'imposter' }, text: { content: session.message } } });
    await assert.rejects(f.manager.reset({ ...confirm(plan), discovery_id: session.id }), /本人账号/);
    const retry = await f.manager.resetDiscovery({ ...confirm(plan), secret: 'new-fixture-secret' }); const verified = f.discovery.sessions.get(retry.id); verified.client.emit('authenticated');
    verified.client.emit('message.text', { body: { chattype: 'group', chatid: 'group', from: { userid: 'owner-alice' }, text: { content: retry.message } } });
    await desktop.poll('old-thread'); // idle polls must not invalidate verification
    const result = await f.manager.reset({ ...confirm(plan), discovery_id: retry.id }); assert.equal(result.done, true); assert.doesNotMatch(JSON.stringify(result), /new-fixture-secret/);
    assert.equal((await readPeerConfig(admin.config_path)).config.wecom.secret, 'new-fixture-secret'); assert.equal((await f.manager.state(admin.id)).wecom.secret, 'new-fixture-secret');
    assert.equal((await desktop.status()).binding.thread_id, 'old-thread'); assert.equal((await f.manager.detail(admin.id)).runner.online, false);
  } finally { await f.cleanup(); }
});

test('incomplete imported onboarding can be removed and restored without publishing team changes', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const invite = await f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture', password: 'long-fixture-password' });
    const bundle = await f.manager.exportedBundle(admin.id, invite.invite_id); const member = await f.manager.importBundle({ content: bundle.content, password: 'long-fixture-password', repo: f.repos.bob });
    const ledger = git(f.remote, 'rev-parse', 'agent-collab');
    await f.manager.reset(confirm(await f.manager.resetPreview({ id: member.id, kind: 'project' })));
    await f.manager.reset(confirm(await f.manager.resetPreview({ id: member.id, kind: 'restore' })));
    assert.equal((await f.manager.state(member.id)).phase, 'imported'); assert.equal(git(f.remote, 'rev-parse', 'agent-collab'), ledger);
    assert.equal(git(f.repos.bob, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('removal and restore update the actual alternate MCP config used by older desktop installs', async () => {
  const f = await fixture();
  try {
    const { admin, desktop } = await bound(f);
    const alternate = join(f.manager.path(admin.id), 'alice-desktop-peer.json'); const raw = await readFile(admin.config_path, 'utf8'); await writeFile(alternate, raw, { mode: 0o600 });
    const toml = join(f.repos.alice, '.codex/config.toml'); await writeFile(toml, (await readFile(toml, 'utf8')).replace(JSON.stringify(admin.config_path), JSON.stringify(alternate)));
    await f.manager.reset(confirm(await f.manager.resetPreview({ id: admin.id, kind: 'project' })));
    await assert.rejects(readPeerConfig(alternate), /已移除/);
    await f.manager.reset(confirm(await f.manager.resetPreview({ id: admin.id, kind: 'restore' })));
    assert.equal((await readPeerConfig(alternate)).config.agent_id, 'alice'); assert.equal((await desktop.status()).binding, null);
    assert.match(await readFile(toml, 'utf8'), /alice-desktop-peer/);
  } finally { await f.cleanup(); }
});

test('failed configuration save restores files and binding and leaves a private recovery record', async () => {
  const f = await fixture();
  try {
    const { admin, desktop } = await bound(f); const file = join(f.repos.alice, '.codex/config.toml'); const before = await readFile(file, 'utf8');
    const plan = await f.manager.resetPreview({ id: admin.id, kind: 'project' }); const originalSave = f.manager.save.bind(f.manager); let attempted = false;
    f.manager.save = async (state) => { if (!attempted) { attempted = true; throw new Error('fixture interrupted save'); } return originalSave(state); };
    await assert.rejects(f.manager.reset(confirm(plan)), /interrupted save/);
    assert.equal(await readFile(file, 'utf8'), before); assert.ok(await readFile(join(f.repos.alice, '.agents/skills/team-collab-desktop/SKILL.md'), 'utf8'));
    assert.equal((await desktop.status()).binding.thread_id, 'old-thread'); assert.equal((await f.manager.state(admin.id)).phase, 'ready'); assert.equal((await readPeerConfig(admin.config_path)).config.local_disabled, undefined);
    const { readdir } = await import('node:fs/promises'); assert.equal((await readdir(join(f.manager.home, 'reset-backups'))).length, 1);
  } finally { await f.cleanup(); }
});

test('cancelling credential discovery closes the connection and invalidates its reset preview', async () => {
  const f = await fixture();
  try {
    const { admin } = await bound(f); const plan = await f.manager.resetPreview({ id: admin.id, kind: 'robot' });
    const session = await f.manager.resetDiscovery({ ...confirm(plan), secret: 'fixture-new' }); const client = f.discovery.sessions.get(session.id).client;
    assert.equal(client.connected, true); assert.equal(f.manager.resetCancel({ id: admin.id, preview_token: plan.preview_token }).cancelled, true); assert.equal(client.connected, false);
    assert.equal(f.discovery.sessions.has(session.id), false); await assert.rejects(f.manager.reset(confirm(plan)), /预览/);
    assert.equal((await readPeerConfig(admin.config_path)).config.wecom.secret, 'fixture-secret-alice');
  } finally { await f.cleanup(); }
});
