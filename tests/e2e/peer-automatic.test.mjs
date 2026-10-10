import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupLocal } from '../../scripts/peer/setup-local.mjs';
import { loadRuntime, readPeerConfig } from '../../apps/peer/runtime.mjs';
import { PeerRunner } from '../../apps/peer/runner.mjs';
import { dispatchPeerWecom, PeerNotificationRelay } from '../../apps/peer/wecom.mjs';

const tools = fileURLToPath(new URL('../../', import.meta.url));
const git = (repo, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function privateJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function fixture(mode = 'automatic') {
  const root = await mkdtemp(join(tmpdir(), 'peer-automatic-'));
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.name', 'Test'); git(seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'greet.sh'), '#!/bin/sh\nname=${1:-world}\nprintf "hello, %s\\n" "$name"\n');
  await writeFile(join(seed, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n[ "$(sh greet.sh Alice)" = "hello, Alice" ]\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
  const output = await setupLocal({ demo: seed, out: join(root, 'test'), ownerUserId: 'single-human-owner', mode });
  return { root, seed, output, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function configureFakeBots(output) {
  for (const id of ['alice', 'bob']) {
    const config = JSON.parse(await readFile(output.configs[id], 'utf8'));
    config.codex_home = join(output.root, `${id}-fake-codex-home`);
    config.wecom = { bot_id: `${id}-fake-bot`, secret: `${id}-fixture-not-a-real-secret`, chat_ids: ['fake-group'], commands_enabled: id === 'alice' };
    await privateJson(output.configs[id], config);
  }
}
function frame(text, msgid) {
  return { body: { chattype: 'group', chatid: 'fake-group', msgtype: 'text', msgid, from: { userid: 'single-human-owner' }, text: { content: text } } };
}
function fakeRunner(peer, run) {
  return new PeerRunner(peer.service, peer.config, { agentFactory: () => ({ startThread: (options) => {
    assert.equal(options.sandboxMode, 'workspace-write');
    assert.equal(options.approvalPolicy, 'never');
    assert.equal(options.networkAccessEnabled, false);
    return { id: `sdk-${peer.config.agent_id}-fixture-session`, run: async (prompt, { signal }) => {
      signal.throwIfAborted();
      await run(options.workingDirectory, prompt);
      return { finalResponse: 'PRIVATE mock SDK conversation, never shared' };
    } };
  } }) });
}

test('automatic local setup enables both agents, primary/fallback routes and leaves sources unchanged', async () => {
  const f = await fixture();
  try {
    const { output } = f;
    const { config: alice, team } = await readPeerConfig(output.configs.alice);
    const { config: bob } = await readPeerConfig(output.configs.bob);
    assert.equal(alice.auto_execute, true); assert.equal(bob.auto_execute, true);
    assert.equal(team.reviewer, 'alice');
    assert.deepEqual(team.routes, { frontend: ['alice', 'bob'], backend: ['bob', 'alice'] });
    assert.equal(team.agents.bob.wecom_userid, undefined);
    assert.equal(output.starts_processes, false); assert.equal(output.github_pushes, false);
    assert.equal(output.modifies_cc_switch, false); assert.equal(output.wecom_reused, false);
    assert.equal(git(f.seed, 'status', '--porcelain'), '');
    assert.equal(git(output.shared_origin, 'rev-parse', 'main'), git(f.seed, 'rev-parse', 'main'));
    assert.equal(git(output.shared_origin, 'remote'), '');
    for (const id of ['alice', 'bob']) {
      assert.equal(git(output.repos[id], 'status', '--porcelain'), '');
      assert.equal((await stat(output.configs[id])).mode & 0o077, 0);
    }
  } finally { await f.cleanup(); }
});

test('WeCom automatic task runs Alice then Bob from pinned SHA and stops for explicit human review', async () => {
  const f = await fixture();
  try {
    const alice = await loadRuntime(f.output.configs.alice);
    const bob = await loadRuntime(f.output.configs.bob);
    const config = { chat_ids: ['fake-group'] }; const replies = [];
    const dispatch = (text, id) => dispatchPeerWecom(frame(text, id), { service: alice.service, config, reply: async (_original, reply) => replies.push(reply) });
    await dispatch('协作 创建 [frontend>backend] Alice 实现 greet.sh --upper 保留姓名行为，Bob 只补 test.sh 回归测试 | sh test.sh 通过', 'create-automatic');
    const task = (await alice.service.list())[0];
    assert.equal(task.spec.execution_mode, 'automatic'); assert.equal(task.state.status, 'open');
    assert.equal((await alice.service.nextJob()).spec.id, task.spec.id);
    assert.equal(await bob.service.nextJob(), null);
    const baseline = git(f.seed, 'rev-parse', 'main');
    const first = await fakeRunner(alice, async (directory, prompt) => {
      assert.match(prompt, /stage 1\/2 \(frontend\)/);
      assert.equal(git(directory, 'rev-parse', 'HEAD'), baseline);
      await writeFile(join(directory, 'greet.sh'), '#!/bin/sh\nupper=false\nif [ "${1:-}" = --upper ]; then upper=true; shift; fi\nname=${1:-world}\nif "$upper"; then printf "hello, %s\\n" "$name" | tr "[:lower:]" "[:upper:]"; else printf "hello, %s\\n" "$name"; fi\n');
    }).once();
    assert.equal(first.state.status, 'waiting'); assert.equal(first.state.stage, 1);
    assert.equal(first.events.at(-1).actor_id, 'alice');
    assert.equal(first.events.at(-1).type, 'handoff');
    const firstSha = first.state.checkpoint.commit;
    const final = await fakeRunner(bob, async (directory, prompt) => {
      assert.match(prompt, /stage 2\/2 \(backend\)/);
      assert.ok(prompt.includes(firstSha));
      assert.equal(git(directory, 'rev-parse', 'HEAD'), firstSha);
      assert.match(await readFile(join(directory, 'greet.sh'), 'utf8'), /--upper/);
      await writeFile(join(directory, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n[ "$(sh greet.sh Alice)" = "hello, Alice" ]\n[ "$(sh greet.sh --upper)" = "HELLO, WORLD" ]\n[ "$(sh greet.sh --upper Alice)" = "HELLO, ALICE" ]\nprintf "all regression checks passed\\n"\n');
    }).once();
    assert.equal(final.state.status, 'review'); assert.equal(final.state.assignee, 'alice');
    assert.notEqual(final.state.checkpoint.commit, firstSha);
    assert.deepEqual(final.events.filter((event) => event.type === 'claimed').map((event) => event.actor_id), ['alice', 'bob']);
    assert.deepEqual(final.events.filter((event) => event.type === 'handoff').map((event) => event.actor_id), ['alice']);
    assert.equal(final.events.at(-1).type, 'review_requested');
    assert.equal(final.events.some((event) => ['reviewed', 'completed'].includes(event.type)), false);
    assert.equal(git(f.output.shared_origin, 'merge-base', firstSha, final.state.checkpoint.commit), firstSha);
    assert.equal(git(f.output.shared_origin, 'rev-parse', 'main'), baseline);
    assert.equal(git(f.output.repos.alice, 'rev-parse', 'HEAD'), baseline);
    assert.equal(git(f.output.repos.bob, 'rev-parse', 'HEAD'), baseline);
    assert.equal(JSON.stringify(final).includes('PRIVATE mock'), false);
    for (const [peer, epoch, status] of [[alice, 1, 'handoff'], [bob, 2, 'review_requested']]) {
      const sessionPath = join(peer.config.data_dir, 'jobs', task.spec.id, `${peer.config.agent_id}-${epoch}.session.json`);
      const session = JSON.parse(await readFile(sessionPath, 'utf8'));
      assert.equal(session.thread_id, `sdk-${peer.config.agent_id}-fixture-session`);
      assert.equal(session.status, status); assert.equal(session.stage, epoch - 1);
      assert.equal((await stat(sessionPath)).mode & 0o077, 0);
      assert.equal(JSON.stringify(session).includes('PRIVATE mock'), false);
      assert.equal(JSON.stringify(final).includes(session.thread_id), false);
    }
    assert.equal(await fakeRunner(alice, () => assert.fail('review must not automatically execute')).once(), null);
    assert.equal(await fakeRunner(bob, () => assert.fail('review must not automatically execute')).once(), null);
    // The personal bot relays only its own committed events, without real network access.
    const notifications = [];
    for (const peer of [alice, bob]) {
      await new PeerNotificationRelay(peer.service, async (current, type) => notifications.push([peer.config.agent_id, type, current.state.status])).poll();
    }
    assert.deepEqual(notifications, [['alice', 'created', 'open'], ['alice', 'claimed', 'running'], ['alice', 'handoff', 'waiting'], ['bob', 'claimed', 'running'], ['bob', 'review_requested', 'review']]);
    await assert.rejects(bob.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /administrator/);
    await dispatch(`协作 审核 ${task.spec.id} 通过`, 'human-review');
    await dispatch(`协作 完成 ${task.spec.id}`, 'human-complete');
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'completed');
    assert.equal(replies.length, 3);
  } finally { await f.cleanup(); }
});

test('automatic setup reuses only private bot/provider settings with fresh keys and a fresh ledger', async () => {
  const f = await fixture('desktop');
  try {
    await configureFakeBots(f.output);
    const before = Object.fromEntries(await Promise.all(['alice', 'bob'].map(async (id) => [id, await readFile(f.output.configs[id], 'utf8')])));
    const previous = await loadRuntime(f.output.configs.alice);
    await previous.service.create({ title: 'do not copy previous tasks', acceptance: ['pass'] });
    const output = await setupLocal({ demo: f.seed, out: join(f.root, 'automatic'), mode: 'automatic', wecomFrom: f.output.root });
    assert.equal(output.wecom_reused, true); assert.equal(output.must_stop_previous_bot_connections, true);
    assert.equal(output.alice_owner_configured, true); assert.equal(output.starts_processes, false);
    for (const id of ['alice', 'bob']) {
      const old = JSON.parse(before[id]); const { config, team } = await readPeerConfig(output.configs[id]);
      assert.equal(config.auto_execute, true); assert.equal(config.agent_id, id);
      assert.deepEqual(config.wecom, old.wecom); assert.equal(config.codex_home, old.codex_home);
      assert.notEqual(config.private_key, old.private_key);
      assert.equal(team.agents.alice.wecom_userid, 'single-human-owner');
      assert.equal(await readFile(f.output.configs[id], 'utf8'), before[id]);
      assert.equal((await stat(output.configs[id])).mode & 0o077, 0);
      assert.equal(JSON.stringify(output).includes(old.wecom.secret), false);
    }
    assert.deepEqual(await (await loadRuntime(output.configs.alice)).service.list(), []);
    assert.equal((await previous.service.list()).length, 1);
    assert.equal(git(f.seed, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('automatic setup rejects duplicate bots, mismatched policy and invalid reuse without creating output', async () => {
  const f = await fixture('desktop');
  try {
    await configureFakeBots(f.output);
    const out = join(f.root, 'rejected');
    const options = { demo: f.seed, out, mode: 'automatic', wecomFrom: f.output.root };
    const bob = JSON.parse(await readFile(f.output.configs.bob, 'utf8'));
    const originalBot = bob.wecom.bot_id;
    bob.wecom.bot_id = 'alice-fake-bot'; await privateJson(f.output.configs.bob, bob);
    await assert.rejects(setupLocal(options), /distinct bot IDs/);
    await assert.rejects(access(out), { code: 'ENOENT' });
    bob.wecom.bot_id = originalBot;
    bob.codex_home = 'relative-provider-home'; await privateJson(f.output.configs.bob, bob);
    await assert.rejects(setupLocal(options), /codex_home must be an absolute path/);
    await assert.rejects(access(out), { code: 'ENOENT' });
    bob.codex_home = join(f.output.root, 'bob-fake-codex-home');
    const alternate = JSON.parse(await readFile(bob.team_file, 'utf8')); alternate.repo = 'another/repo';
    bob.team_file = join(f.root, 'alternate-team.json'); await privateJson(bob.team_file, alternate);
    await privateJson(f.output.configs.bob, bob);
    await assert.rejects(setupLocal(options), /share one pinned team policy/);
    await assert.rejects(access(out), { code: 'ENOENT' });
    await assert.rejects(setupLocal({ ...options, mode: 'desktop' }), /requires automatic mode/);
    await assert.rejects(setupLocal({ ...options, wecomFrom: 'relative-path' }), /absolute private directory/);
  } finally { await f.cleanup(); }
});

test('setup CLI accepts automatic reuse flags and does not print secrets', async () => {
  const f = await fixture('desktop');
  try {
    await configureFakeBots(f.output);
    const env = { ...process.env }; delete env.WECOM_OWNER_USERID;
    const stdout = execFileSync(process.execPath, [join(tools, 'scripts/peer/setup-local.mjs'), '--demo', f.seed, '--out', join(f.root, 'cli-automatic'), '--mode', 'automatic', '--wecom-from', f.output.root], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = JSON.parse(stdout);
    assert.equal(output.mode, 'automatic'); assert.equal(output.wecom_reused, true);
    assert.doesNotMatch(stdout, /fixture-not-a-real-secret|PRIVATE KEY/);
    assert.equal((await readPeerConfig(output.configs.alice)).config.auto_execute, true);
    assert.equal((await readPeerConfig(output.configs.bob)).config.wecom.commands_enabled, false);
  } finally { await f.cleanup(); }
});


test('SDK failure is redacted locally, preserves private thread mapping and permits candidate fallback', async (t) => {
  const f = await fixture();
  const diagnostics = [];
  t.mock.method(console, 'error', (...args) => diagnostics.push(args.join(' ')));
  try {
    const alice = await loadRuntime(f.output.configs.alice);
    const bob = await loadRuntime(f.output.configs.bob);
    const task = await alice.service.create({ title: 'provider failure', acceptance: ['pass'] });
    await assert.rejects(fakeRunner(alice, async () => { throw new Error('PRIVATE SDK secret=never-print-this'); }).once(), /PRIVATE SDK/);
    const latest = await alice.service.read(task.spec.id);
    assert.equal(latest.state.status, 'open'); assert.deepEqual(latest.state.failed_agents, ['alice']);
    assert.equal((await bob.service.nextJob()).spec.id, task.spec.id);
    const session = JSON.parse(await readFile(join(alice.config.data_dir, 'jobs', task.spec.id, 'alice-1.session.json'), 'utf8'));
    assert.equal(session.status, 'failed'); assert.equal(session.phase, 'sdk');
    assert.equal(session.thread_id, 'sdk-alice-fixture-session');
    assert.equal(JSON.stringify(session).includes('never-print-this'), false);
    assert.equal(JSON.stringify(latest).includes('never-print-this'), false);
    assert.equal(diagnostics.join('\n').includes('never-print-this'), false);
    assert.ok(diagnostics.some((line) => line.includes('phase=sdk')));
  } finally { await f.cleanup(); }
});


test('team CLI keeps a capable reviewer in execution routes in declared order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-team-cli-'));
  try {
    const teamPath = join(root, 'team.json');
    execFileSync(process.execPath, [join(tools, 'scripts/peer/create-team.mjs'), teamPath, 'fixture/team', 'alice', 'frontend', 'alice:admin:frontend,backend:1', 'bob:member:backend:1'], { stdio: 'pipe' });
    const team = JSON.parse(await readFile(teamPath, 'utf8'));
    assert.deepEqual(team.routes, { frontend: ['alice'], backend: ['alice', 'bob'] });
    assert.equal(team.reviewer, 'alice');
    assert.equal((await stat(join(root, 'alice.private.json'))).mode & 0o077, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
