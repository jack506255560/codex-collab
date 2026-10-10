import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { setupLocal } from '../../scripts/peer/setup-local.mjs';
import { setupDesktopProject } from '../../scripts/peer/setup-desktop-project.mjs';
import { loadRuntime, readPeerConfig } from '../../apps/peer/runtime.mjs';
import { DesktopExecutor } from '../../apps/peer/desktop.mjs';
import { PeerRunner } from '../../apps/peer/runner.mjs';
import { dispatchPeerWecom, formatPeerNotification, PeerNotificationRelay } from '../../apps/peer/wecom.mjs';
const tools = fileURLToPath(new URL('../../', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const threads = { alice: 'desktop-alice-conversation', bob: 'desktop-bob-conversation' };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-poll-'));
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.name', 'Test'); git(seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'greet.sh'), '#!/bin/sh\nprintf "hello, %s\\n" "${1:-world}"\n');
  await writeFile(join(seed, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
  const output = await setupLocal({ demo: seed, out: join(root, 'private'), mode: 'desktop-poll', ownerUserId: 'owner' });
  let now = Date.parse('2026-10-09T00:00:00Z');
  const peers = {};
  for (const id of ['alice', 'bob']) {
    const runtime = await loadRuntime(output.configs[id], { clock: () => now });
    peers[id] = { ...runtime, desktop: new DesktopExecutor(runtime.service, runtime.config) };
  }
  return { root, seed, output, peers, advance: (ms) => { now += ms; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function create(f, key = 'poll-flow', workflow = ['frontend', 'backend']) {
  return f.peers.alice.service.create({ title: 'upper greeting', acceptance: ['preserve old behavior', 'upper supported and tested'], workflow, execution_mode: 'desktop_poll', chatId: 'group' }, key);
}
async function bind(f) { for (const id of ['alice', 'bob']) await f.peers[id].desktop.bind(threads[id]); }
async function commit(job, file, contents) {
  await writeFile(join(job.worktree, file), contents);
  git(job.worktree, 'add', '--', file); git(job.worktree, 'commit', '-m', 'desktop stage');
  return git(job.worktree, 'rev-parse', 'HEAD');
}

test('desktop-poll setup disables SDK, protects bindings and keeps source/projects clean', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers;
    assert.equal(alice.config.auto_execute, false); assert.equal(bob.config.auto_execute, false);
    assert.equal(alice.config.execution_mode, 'desktop_poll');
    assert.deepEqual(alice.team.routes, { frontend: ['alice', 'bob'], backend: ['bob', 'alice'] });
    assert.equal(alice.team.policy.lease_ms, 900000); assert.equal(alice.team.policy.claim_timeout_ms, 180000);
    assert.equal(git(f.seed, 'status', '--porcelain'), '');
    await assert.rejects(alice.desktop.poll(threads.alice), /not the bound/);
    await alice.desktop.bind(threads.alice); await alice.desktop.bind(threads.alice);
    await assert.rejects(alice.desktop.bind(threads.bob), /already bound/);
    assert.equal((await stat(alice.desktop.private.path)).mode & 0o077, 0);
    assert.equal((await alice.desktop.poll(threads.alice)).job, null);
    const task = await create(f);
    assert.equal(task.state.status, 'open'); assert.equal(task.state.assignee, null);
    await assert.rejects(alice.service.claim(task.spec.id), /not eligible/);
    const sdkRunner = new PeerRunner(alice.service, { ...alice.config, execution_mode: 'automatic', auto_execute: true }, { agentFactory: () => assert.fail('desktop tasks never dispatch SDK') });
    assert.equal(await sdkRunner.once(), null);
    const claimed = await alice.desktop.poll(threads.alice);
    assert.equal(claimed.job.thread_id, threads.alice);
    await assert.rejects(alice.desktop.unbind(threads.alice), /lease is active/);
    await assert.rejects(alice.desktop.renew(threads.bob, task.spec.id), /not the bound/);
    await assert.rejects(alice.service.handoff(task.spec.id, {}, claimed.task.state.seq), /bound desktop finish/);
    assert.equal(git(f.output.repos.alice, 'status', '--porcelain'), '');
    const seq = (await alice.service.read(task.spec.id)).state.seq;
    await delay(80);
    assert.equal((await alice.service.read(task.spec.id)).state.seq, seq, 'MCP or bot uptime never passively renews editing');
    const config = { ...alice.config, auto_execute: true };
    await writeFile(f.output.configs.alice, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(readPeerConfig(f.output.configs.alice), /requires auto_execute=false/);
  } finally { await f.cleanup(); }
});

test('group task → bound Alice stage → notification → bound Bob exact SHA → human review', async () => {
  const f = await fixture();
  try {
    await bind(f); const { alice, bob } = f.peers; const replies = [];
    await dispatchPeerWecom({ body: { chattype: 'group', chatid: 'group', msgtype: 'text', msgid: 'group-create', from: { userid: 'owner' }, text: { content: '@Alice 协作 创建 [frontend>backend] upper | test passes' } } }, {
      service: alice.service, config: { chat_ids: ['group'], execution_mode: 'desktop_poll' }, reply: async (_f, text) => replies.push(text)
    });
    const task = (await alice.service.list())[0];
    assert.equal(task.spec.execution_mode, 'desktop_poll');
    assert.match(replies[0], /等待绑定的 Codex 桌面对话/);
    assert.doesNotMatch(replies[0], /已经开始/);
    assert.equal((await bob.desktop.poll(threads.bob)).job, null);
    const first = await alice.desktop.poll(threads.alice);
    assert.equal(first.task.state.assignee, 'alice');
    await alice.desktop.renew(threads.alice, task.spec.id);
    const aliceCommit = await commit(first.job, 'greet.sh', '#!/bin/sh\nif [ "${1:-}" = --upper ]; then shift; printf "hello, %s\\n" "${1:-world}" | tr "[:lower:]" "[:upper:]"; else printf "hello, %s\\n" "${1:-world}"; fi\n');
    const waiting = await alice.desktop.finish(threads.alice, task.spec.id, 'Implemented upper; next add four regression cases.');
    assert.equal(waiting.state.status, 'waiting'); assert.equal(waiting.state.checkpoint.commit, aliceCommit);
    const seq = waiting.state.seq;
    assert.equal((await alice.desktop.finish(threads.alice, task.spec.id, 'retry')).state.seq, seq);
    assert.equal((await alice.desktop.poll(threads.alice)).job, null);
    const second = await bob.desktop.poll(threads.bob);
    assert.equal(second.job.source_commit, aliceCommit);
    assert.equal(git(second.job.worktree, 'rev-parse', 'HEAD'), aliceCommit);
    const bobCommit = await commit(second.job, 'test.sh', '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n[ "$(sh greet.sh Alice)" = "hello, Alice" ]\n[ "$(sh greet.sh --upper)" = "HELLO, WORLD" ]\n[ "$(sh greet.sh --upper Alice)" = "HELLO, ALICE" ]\nprintf "all checks passed\\n"\n');
    assert.equal(git(second.job.worktree, 'rev-parse', 'HEAD^'), aliceCommit);
    const review = await bob.desktop.finish(threads.bob, task.spec.id, 'Four regression cases pass; ready for human review.');
    assert.equal(review.state.status, 'review'); assert.equal(review.state.checkpoint.commit, bobCommit);
    assert.equal(git(f.output.shared_origin, 'rev-parse', 'main'), git(f.seed, 'rev-parse', 'main'));
    assert.match(execFileSync('sh', ['test.sh'], { cwd: second.job.worktree, encoding: 'utf8' }), /all checks passed/);
    const sent = [];
    for (const id of ['alice', 'bob']) await new PeerNotificationRelay(f.peers[id].service, async (notified, type) => {
      sent.push({ id, type, text: formatPeerNotification(notified, type, id, f.peers[id].team) });
    }).poll();
    assert.ok(sent.some((s) => s.id === 'alice' && s.type === 'handoff' && /优先 bob/.test(s.text)));
    assert.ok(sent.some((s) => s.id === 'bob' && s.type === 'review_requested' && /等待真人审核/.test(s.text)));
    assert.equal(JSON.stringify(review).includes(threads.alice), false);
    assert.equal(JSON.stringify(review).includes(first.job.worktree), false);
    assert.equal(JSON.stringify(review).includes('private_key'), false);
    assert.equal((await bob.desktop.status()).jobs[0].thread_id, threads.bob);
    await assert.rejects(bob.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /administrator/);
  } finally { await f.cleanup(); }
});

test('desktop lease expiry permits fallback and fences late renewal/publication', async () => {
  const f = await fixture();
  try {
    await bind(f); const { alice, bob } = f.peers; const task = await create(f, 'expiry', ['frontend']);
    const first = await alice.desktop.poll(threads.alice);
    f.advance(alice.team.policy.lease_ms + alice.team.policy.clock_skew_ms);
    const takeover = await bob.desktop.poll(threads.bob);
    assert.equal(takeover.task.state.epoch, 2); assert.equal(takeover.task.state.assignee, 'bob');
    assert.deepEqual(takeover.task.state.failed_agents, ['alice']);
    await commit(first.job, 'greet.sh', '#!/bin/sh\nprintf "late changes\\n"\n');
    await assert.rejects(alice.desktop.renew(threads.alice, task.spec.id), /expired or superseded/);
    await assert.rejects(alice.desktop.finish(threads.alice, task.spec.id, 'late result'), /expired or superseded/);
    assert.equal(git(f.output.shared_origin, 'branch', '--list', first.job.branch), '');
    assert.equal((await alice.desktop.poll(threads.alice)).job, null);
    assert.equal((await alice.desktop.status()).jobs[0].status, 'superseded');
  } finally { await f.cleanup(); }
});

test('missing primary waits for polling grace; failed fixed test releases to fallback without success', async () => {
  const f = await fixture();
  try {
    await bind(f); const { alice, bob } = f.peers; const task = await create(f, 'test-fail', ['frontend']);
    assert.equal((await bob.desktop.poll(threads.bob)).job, null);
    f.advance(alice.team.policy.claim_timeout_ms);
    const backup = await bob.desktop.poll(threads.bob);
    assert.equal(backup.task.state.assignee, 'bob');
    await commit(backup.job, 'test.sh', '#!/bin/sh\nprintf "PRIVATE test output must not enter ledger\\n"\nexit 1\n');
    await assert.rejects(bob.desktop.finish(threads.bob, task.spec.id, 'not actually passed'), /fixed verification failed/);
    const failed = await alice.service.read(task.spec.id);
    assert.equal(failed.state.status, 'open'); assert.deepEqual(failed.state.failed_agents, ['bob']);
    assert.equal(failed.events.some((e) => e.type === 'handoff' || e.type === 'review_requested'), false);
    assert.equal(JSON.stringify(failed).includes('PRIVATE test output'), false);
    assert.equal(git(f.output.shared_origin, 'branch', '--list', backup.job.branch), '');
    const next = await alice.desktop.poll(threads.alice);
    assert.equal(next.task.state.epoch, 2);
  } finally { await f.cleanup(); }
});

test('shared desktop state survives MCP restart and serializes duplicate polling', async () => {
  const f = await fixture();
  try {
    await bind(f); const { alice } = f.peers; const task = await create(f, 'race', ['frontend']);
    const runtime = await loadRuntime(f.output.configs.alice, { dataDir: join(f.root, 'second-mcp'), clock: alice.store.clock });
    const second = new DesktopExecutor(runtime.service, runtime.config);
    const results = await Promise.all([alice.desktop.poll(threads.alice), second.poll(threads.alice)]);
    assert.equal(results[0].job.branch, results[1].job.branch);
    assert.equal((await alice.service.read(task.spec.id)).events.filter((e) => e.type === 'claimed').length, 1);
    // Simulate a claim accepted before job metadata was saved.
    await alice.desktop.private.locked(async (state) => { delete state.jobs[task.spec.id]; await alice.desktop.private.write(state); });
    const recovered = await second.poll(threads.alice);
    assert.equal(recovered.job.worktree, results[0].job.worktree); assert.equal(recovered.task.state.epoch, 1);
    await second.fail(threads.alice, task.spec.id, 'Local execution could not continue.');
    assert.equal((await alice.desktop.status()).jobs[0].status, 'failed');
  } finally { await f.cleanup(); }
});

test('desktop project attachment preserves unrelated TOML, backs up private settings, refuses dirty project', async () => {
  const f = await fixture();
  try {
    const project = join(f.root, 'project'); execFileSync('git', ['clone', '--no-local', f.output.shared_origin, project], { stdio: 'ignore' });
    const { mkdir } = await import('node:fs/promises'); await mkdir(join(project, '.codex'));
    const old = 'model_provider = "cc-switch-existing"\n[mcp_servers.team-collab-alice]\ncommand = "old-node"\nargs = ["old"]\n[mcp_servers.other]\ncommand = "keep-me"\n';
    await writeFile(join(project, '.codex/config.toml'), old);
    const exclude = join(project, '.git/info/exclude'); await writeFile(exclude, '/.codex/config.toml\n');
    const out = await setupDesktopProject({ configPath: f.output.configs.alice, repo: project });
    assert.equal(git(project, 'status', '--porcelain'), '');
    const toml = await readFile(join(project, '.codex/config.toml'), 'utf8');
    assert.match(toml, /cc-switch-existing/); assert.match(toml, /keep-me/); assert.doesNotMatch(toml, /old-node/);
    assert.match(toml, /alice-desktop-peer.json/);
    assert.equal(JSON.parse(await readFile(out.backup, 'utf8')).config_toml, old);
    assert.equal((await stat(out.backup)).mode & 0o077, 0);
    assert.match(await readFile(out.binding_prompt, 'utf8'), /automation_update/);
    assert.equal(out.heartbeat_created, false);
    await assert.rejects(setupDesktopProject({ configPath: f.output.configs.alice, repo: project }), /already exists/);
    await writeFile(join(f.output.repos.bob, 'user-work.txt'), 'do not overwrite');
    await assert.rejects(setupDesktopProject({ configPath: f.output.configs.bob, repo: f.output.repos.bob }), /clean Git/);
  } finally { await f.cleanup(); }
});

test('real MCP stdio advertises polling tools, requires binding and returns quiet no-job without SDK', async () => {
  const f = await fixture(); let child;
  try {
    child = spawn(process.execPath, [join(tools, 'apps/peer/mcp-main.mjs'), f.output.configs.alice], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = ''; const waiting = new Map(); let seq = 0;
    child.stdout.on('data', (chunk) => { buffer += chunk; let n; while ((n = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); const message = JSON.parse(line); waiting.get(message.id)?.(message); } });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq; const timer = setTimeout(() => reject(new Error('MCP timeout')), 15000);
      waiting.set(id, (response) => { clearTimeout(timer); waiting.delete(id); resolve(response); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop-test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await request('tools/list', {});
    for (const name of ['bind_desktop_thread', 'poll_desktop_task', 'renew_desktop_task', 'finish_desktop_task', 'fail_desktop_task']) assert.ok(listed.result.tools.some((t) => t.name === name));
    const call = (name, args) => request('tools/call', { name, arguments: args });
    assert.equal((await call('poll_desktop_task', { thread_id: threads.alice })).result.isError, true);
    assert.equal((await call('bind_desktop_thread', { thread_id: threads.alice })).result.isError, undefined);
    const result = await call('poll_desktop_task', { thread_id: threads.alice });
    assert.equal(JSON.parse(result.result.content[0].text).job, null);
    assert.equal(listed.result.tools.some((t) => /approve|complete/.test(t.name)), false);
  } finally {
    if (child && child.exitCode === null) { const ended = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await ended; }
    await f.cleanup();
  }
});
