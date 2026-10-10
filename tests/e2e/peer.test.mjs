import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generateIdentity, makeSigner } from '../../packages/peer/config.mjs';
import { PeerGitStore } from '../../packages/peer/store.mjs';
import { PeerService } from '../../packages/peer/service.mjs';
import { PeerRunner } from '../../apps/peer/runner.mjs';
import { dispatchPeerWecom, PeerNotificationRelay, assertReceipt } from '../../apps/peer/wecom.mjs';
import { reducePeerTask } from '../../packages/peer/protocol.mjs';

const git = (dir, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tools = fileURLToPath(new URL('../../', import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'collab-peer-e2e-'));
  const origin = join(root, 'origin.git'); const seed = join(root, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', origin], { stdio: 'ignore' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.name', 'Fixture'); git(seed, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(seed, 'greet.sh'), '#!/bin/sh\nprintf "hello, world\\n"\n');
  await writeFile(join(seed, 'test.sh'), '#!/bin/sh\nset -eu\ncase "$(sh greet.sh)" in "HELLO, WORLD"|"HELLO, TEAM") exit 0;; *) exit 1;; esac\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'fixture'); git(seed, 'push', 'origin', 'main');
  // An existing central-mode ledger must survive the peer-mode initialization.
  git(seed, 'checkout', '--orphan', 'agent-collab'); git(seed, 'rm', '-rf', '.');
  await writeFile(join(seed, 'central-marker.txt'), 'keep central ledger\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'existing central ledger'); git(seed, 'push', 'origin', 'agent-collab'); git(seed, 'checkout', 'main');
  const ids = Object.fromEntries(['alice', 'bob', 'carol'].map((id) => [id, generateIdentity()]));
  const team = { schema_version: 2, repo: 'fixture/repo', reviewer: 'alice', default_route: 'frontend',
    agents: Object.fromEntries(Object.entries(ids).map(([id, keys]) => [id, { role: id === 'alice' ? 'admin' : 'member', capabilities: ['frontend', 'backend'], max_concurrent_tasks: 1, public_key: keys.public_key, wecom_userid: `${id}-wx` }])),
    routes: { frontend: ['bob', 'carol'], backend: ['carol', 'bob'] }, policy: { claim_timeout_ms: 100, lease_ms: 10000, clock_skew_ms: 10, max_attempts: 3 } };
  const now = { value: 1_700_000_000_000 }; const peers = {};
  const teamPath = join(root, 'team.json'); await writeFile(teamPath, JSON.stringify(team));
  for (const id of Object.keys(ids)) {
    const repo = join(root, `${id}-repo`); execFileSync('git', ['clone', origin, repo], { stdio: 'ignore' });
    git(repo, 'config', 'user.name', id); git(repo, 'config', 'user.email', `${id}@fixture.invalid`);
    const config = { schema_version: 2, agent_id: id, repo, data_dir: join(root, `${id}-data`), team_file: teamPath, private_key: ids[id].private_key, test_argv: ['sh', 'test.sh'] };
    const configPath = join(root, `${id}-peer.json`); await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const store = await new PeerGitStore({ repo, dataDir: config.data_dir, team, agentId: id, privateKey: ids[id].private_key, clock: () => now.value }).init();
    peers[id] = { config, configPath, service: new PeerService(store) };
  }
  return { root, origin, seed, peers, now, team, ids, cleanup: () => rm(root, { recursive: true, force: true }) };
}
function frame(text, id, user = 'alice-wx', chat = 'group') {
  return { body: { chattype: 'group', chatid: chat, msgtype: 'text', msgid: id, from: { userid: user }, text: { content: text } } };
}
function runner(peer, text, inspect = () => {}) {
  return new PeerRunner(peer.service, peer.config, { agentFactory: () => ({ startThread: ({ workingDirectory }) => ({ run: async (prompt) => {
    await inspect(workingDirectory, prompt);
    await writeFile(join(workingDirectory, 'greet.sh'), `#!/bin/sh\nprintf "${text}\\n"\n`);
    return { finalResponse: 'Private conversation must not appear in shared Git.' };
  } }) }) });
}

test('peer WeCom -> independent local Runners -> pinned stage commit -> human review -> complete', async () => {
  const f = await fixture();
  try {
    const { alice, bob, carol } = f.peers; const replies = [];
    const dispatch = (text, key, user, chat) => dispatchPeerWecom(frame(text, key, user, chat), { service: alice.service, config: { chat_ids: ['group'] }, reply: async (_frame, text) => replies.push(text) });
    assert.equal(await dispatch('协作 创建 untrusted', 'denied', 'stranger'), false);
    assert.equal(await dispatch('协作 创建 other group', 'other', 'alice-wx', 'other-group'), false);
    await dispatch('协作 创建 [frontend>backend] greeting relay | tests pass;final HELLO, TEAM', 'create');
    await dispatch('协作 创建 [frontend>backend] greeting relay | tests pass;final HELLO, TEAM', 'create');
    assert.equal((await alice.service.list()).length, 1);
    const task = (await alice.service.list())[0];
    const stage1 = await runner(bob, 'HELLO, WORLD').once();
    assert.equal(stage1.state.status, 'waiting'); assert.equal(stage1.state.stage, 1);
    const checkpoint = stage1.state.checkpoint;
    const stage2 = await runner(carol, 'HELLO, TEAM', async (cwd, prompt) => {
      assert.equal(git(cwd, 'rev-parse', 'HEAD'), checkpoint.commit);
      assert.match(await readFile(join(cwd, 'greet.sh'), 'utf8'), /HELLO, WORLD/);
      assert.match(prompt, new RegExp(checkpoint.commit));
    }).once();
    assert.equal(stage2.state.status, 'review');
    await assert.rejects(carol.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /administrator/);
    await assert.rejects(alice.service.report(task.spec.id, { type: 'completed' }), /approved code evidence/);
    await dispatch(`协作 审核 ${task.spec.id} 通过`, 'approve');
    await dispatch(`协作 完成 ${task.spec.id}`, 'complete');
    const done = await alice.service.read(task.spec.id); assert.equal(done.state.status, 'completed');
    assert.match(git(alice.service.store.checkout, 'show', 'HEAD:central-marker.txt'), /keep central/);
    const events = JSON.stringify(done.events);
    assert.equal(events.includes('Private conversation'), false); assert.equal(events.includes(f.root), false);
    assert.match(git(carol.config.repo, 'show', `${done.state.checkpoint.commit}:greet.sh`), /HELLO, TEAM/);
    assert.match(replies.at(-1), /completed/);
    assert.equal(git(bob.config.repo, 'branch', '--show-current'), 'main');
    assert.equal(await runner(bob, 'SHOULD NOT RUN').once(), null);
  } finally { await f.cleanup(); }
});

test('peer failed tests fall back to another candidate without sharing private diagnostics', async () => {
  const f = await fixture();
  try {
    const { alice, bob, carol } = f.peers;
    const task = await alice.service.create({ title: 'fallback', acceptance: ['tests pass'] });
    await assert.rejects(runner(bob, 'bad result').once());
    const failed = await alice.service.read(task.spec.id);
    assert.equal(failed.state.status, 'open'); assert.deepEqual(failed.state.failed_agents, ['bob']);
    const result = await runner(carol, 'HELLO, TEAM').once(); assert.equal(result.state.status, 'review'); assert.equal(result.state.epoch, 2);
    assert.equal(JSON.stringify(result.events).includes(f.root), false);
    await alice.service.report(task.spec.id, { type: 'reviewed', decision: 'changes_requested' });
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'open');
  } finally { await f.cleanup(); }
});

test('peer untracked files are not automatically committed or pushed', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers;
    const task = await alice.service.create({ title: 'unsafe file', acceptance: ['tests pass'] });
    const unsafe = new PeerRunner(bob.service, bob.config, { agentFactory: () => ({ startThread: ({ workingDirectory }) => ({ run: async () => writeFile(join(workingDirectory, 'private.env'), 'PRIVATE=not-for-git') }) }) });
    await assert.rejects(unsafe.once(), /untracked/);
    const failed = await alice.service.read(task.spec.id);
    assert.equal(failed.events.at(-1).type, 'run_failed');
    assert.equal(git(f.seed, 'ls-remote', '--heads', 'origin', 'refs/heads/codex/*'), '');
    assert.equal(JSON.stringify(failed.events).includes('PRIVATE='), false);
  } finally { await f.cleanup(); }
});

test('MCP-process events are relayed by the local bot with persisted retry cursors', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers;
    const task = await alice.service.create({ title: 'relay', acceptance: ['pass'], chatId: 'group' });
    let failing = true; const sent = [];
    const relay = new PeerNotificationRelay(alice.service, async (task, type) => { if (failing) throw new Error('receipt rejected'); sent.push([task.spec.id, type, task.state.status]); });
    await assert.rejects(relay.poll(), /receipt rejected/);
    failing = false; await relay.poll(); assert.deepEqual(sent, [[task.spec.id, 'created', 'open']]);
    await bob.service.claim(task.spec.id);
    await relay.poll(); assert.equal(sent.length, 1);
    const restarted = new PeerNotificationRelay(alice.service, async () => assert.fail('must not duplicate acknowledged notifications'));
    await restarted.poll();
    assert.throws(() => assertReceipt({ errcode: 123 }), /rejected/);
    assert.throws(() => assertReceipt({}), /missing/); assert.doesNotThrow(() => assertReceipt({ errcode: 0 }));
  } finally { await f.cleanup(); }
});

test('signed backdated events and unknown fields are rejected during replay', async () => {
  const f = await fixture();
  try {
    const { alice, bob } = f.peers;
    const task = await alice.service.create({ title: 'timestamps', acceptance: ['pass'] });
    f.now.value += 1000; const claimed = await bob.service.claim(task.spec.id);
    const sign = makeSigner(f.team, 'bob', f.ids.bob.private_key);
    const event = sign({ schema_version: 2, task_id: task.spec.id, seq: 3, event_id: 'new-id', actor_id: 'bob', occurred_at: task.events[0].occurred_at, idempotency_key: 'backdate', type: 'progress', lease_id: claimed.state.lease.id, epoch: claimed.state.epoch });
    assert.throws(() => reducePeerTask(task.spec, [...claimed.events, event], f.team), /timestamp/);
    const unsafe = sign({ schema_version: 2, task_id: task.spec.id, seq: 3, event_id: 'unsafe-id', actor_id: 'bob', occurred_at: claimed.events.at(-1).occurred_at, idempotency_key: 'unsafe-fields', type: 'progress', lease_id: claimed.state.lease.id, epoch: claimed.state.epoch, private_transcript: 'not allowed' });
    assert.throws(() => reducePeerTask(task.spec, [...claimed.events, unsafe], f.team), /unsupported peer event fields/);
  } finally { await f.cleanup(); }
});

test('peer MCP stdio exposes tools and defaults desktop creation to reserved state', async () => {
  const f = await fixture(); let child;
  try {
    child = spawn(process.execPath, [join(tools, 'apps/peer/mcp-main.mjs'), f.peers.alice.configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = ''; const waiting = new Map();
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line); if (message.id !== undefined) waiting.get(message.id)?.(message);
      }
    });
    let seq = 0;
    const request = async (method, params) => {
      const id = ++seq; const response = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return Promise.race([response, delay(15000).then(() => { throw new Error('MCP response timed out'); })]);
    };
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'peer-smoke', version: '1' } }); assert.ok(init.result);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listed = await request('tools/list', {}); assert.ok(listed.result.tools.some((t) => t.name === 'handoff_task'));
    assert.ok(listed.result.tools.some((t) => t.name === 'claim_desktop_task'));
    const identity = await request('tools/call', { name: 'get_identity', arguments: {} });
    assert.equal(JSON.parse(identity.result.content[0].text).agent_id, 'alice');
    assert.equal(listed.result.tools.some((t) => /approve|complete/.test(t.name)), false);
    const created = await request('tools/call', { name: 'create_task', arguments: { title: 'desktop', acceptance: ['pass'], workflow: ['frontend', 'backend'], idempotency_key: 'mcp-desktop' } });
    assert.equal(created.result.isError, undefined);
    const task = JSON.parse(created.result.content[0].text); assert.equal(task.state.status, 'desktop');
    assert.equal(await f.peers.bob.service.nextJob(), null);
  } finally {
    if (child && child.exitCode === null) { const closed = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGTERM'); await closed; }
    await f.cleanup();
  }
});
