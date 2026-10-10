import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupLocal } from '../../scripts/peer/setup-local.mjs';
import { loadRuntime, readPeerConfig } from '../../apps/peer/runtime.mjs';
import { PeerRunner } from '../../apps/peer/runner.mjs';
import { dispatchPeerWecom, PeerNotificationRelay } from '../../apps/peer/wecom.mjs';

const git = (repo, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'peer-desktop-'));
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.name', 'Test'); git(seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'greet.sh'), '#!/bin/sh\nprintf "hello, world\\n"\n');
  await writeFile(join(seed, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'base');
  git(seed, 'branch', 'agent-collab');
  const output = await setupLocal({ demo: seed, out: join(root, 'test'), ownerUserId: 'single-human-owner', mode: 'desktop' });
  return { root, seed, output, cleanup: () => rm(root, { recursive: true, force: true }) };
}
async function pushedChange(repo, branch, file, content, startingCommit) {
  git(repo, 'checkout', '-b', branch, ...(startingCommit ? [startingCommit] : []));
  await writeFile(join(repo, file), content);
  git(repo, 'add', file); git(repo, 'commit', '-m', 'local desktop stage'); git(repo, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  return { branch, commit: git(repo, 'rev-parse', 'HEAD'), tests: 'sh test.sh: pass' };
}

test('local setup isolates two identities and project MCPs without modifying source or global settings', async () => {
  const f = await fixture();
  try {
    const { output } = f; const before = await readFile(join(output.root, 'team.json'), 'utf8');
    assert.equal(git(f.seed, 'status', '--porcelain'), '');
    assert.equal(git(output.shared_origin, 'branch', '--list'), '* main');
    assert.equal(git(output.shared_origin, 'remote'), '');
    assert.equal((await stat(output.root)).mode & 0o077, 0);
    const identities = [];
    for (const id of ['alice', 'bob']) {
      assert.equal(git(output.repos[id], 'remote', 'get-url', 'origin'), output.shared_origin);
      assert.equal(git(output.repos[id], 'status', '--porcelain'), '');
      assert.equal((await stat(output.configs[id])).mode & 0o077, 0);
      const { config, team } = await readPeerConfig(output.configs[id]);
      assert.equal(config.agent_id, id); assert.equal(config.auto_execute, false);
      identities.push(team.agents[id].public_key);
      const toml = await readFile(join(output.repos[id], '.codex', 'config.toml'), 'utf8');
      assert.ok(toml.includes(`[mcp_servers.team-collab-${id}]`));
      assert.ok(toml.includes(output.configs[id])); assert.equal(toml.includes(config.private_key), false);
      assert.equal(git(output.repos[id], 'check-ignore', '.codex/config.toml'), '.codex/config.toml');
    }
    assert.notEqual(identities[0], identities[1]);
    await assert.rejects(setupLocal({ demo: f.seed, out: output.root }), { code: 'EEXIST' });
    assert.equal(await readFile(join(output.root, 'team.json'), 'utf8'), before);
    await assert.rejects(setupLocal({ demo: f.seed, out: join(f.seed, 'private') }), /outside/);
  } finally { await f.cleanup(); }
});

test('two desktop identities hand off exact commits, manually reserve, notify and await human approval', async () => {
  const f = await fixture();
  try {
    const alice = await loadRuntime(f.output.configs.alice);
    const bob = await loadRuntime(f.output.configs.bob);
    const task = await alice.service.create({ title: 'upper greeting', acceptance: ['old behavior retained', 'upper supported'], workflow: ['frontend', 'backend'], execution_mode: 'desktop', chatId: 'group' }, 'two-desktops');
    assert.equal(task.state.assignee, 'alice');
    await assert.rejects(bob.service.claimDesktop(task.spec.id, task.state.seq), /not eligible/);
    const aliceRefs = await pushedChange(f.output.repos.alice, 'codex/alice-desktop', 'greet.sh', '#!/bin/sh\nif [ "${1:-}" = --upper ]; then printf "HELLO, WORLD\\n"; else printf "hello, world\\n"; fi\n');
    execFileSync('sh', ['test.sh'], { cwd: f.output.repos.alice });
    const waiting = await alice.service.handoff(task.spec.id, { summary: 'Implementation done. Add tests for --upper next.', refs: aliceRefs }, task.state.seq, 'alice-handoff');
    assert.equal(waiting.state.status, 'waiting');
    const disabledRunner = new PeerRunner(bob.service, bob.config, { agentFactory: () => assert.fail('notification-only mode must not start a model') });
    assert.equal(await disabledRunner.once(), null);
    assert.equal((await alice.service.read(task.spec.id)).state.status, 'waiting');
    await assert.rejects(alice.service.claimDesktop(task.spec.id, waiting.state.seq), /not eligible/);
    await assert.rejects(bob.service.claimDesktop(task.spec.id, waiting.state.seq - 1), /stale/);
    const claimed = await bob.service.claimDesktop(task.spec.id, waiting.state.seq, 'bob-desktop-claim');
    assert.equal(claimed.state.status, 'desktop'); assert.equal(claimed.state.assignee, 'bob'); assert.equal(claimed.state.lease, null);
    assert.equal(await alice.service.nextJob(), null); assert.equal(await bob.service.nextJob(), null);
    await assert.rejects(bob.service.claim(task.spec.id), /not eligible/);
    const pending = await alice.service.create({ title: 'automatic waits for desktop capacity', acceptance: ['pass'], execution_mode: 'automatic' }, 'capacity-pending');
    await assert.rejects(bob.service.claimDesktop(pending.spec.id, pending.state.seq), /not eligible/);
    await assert.rejects(bob.service.claim(pending.spec.id), /not eligible/);
    await alice.service.report(pending.spec.id, { type: 'cancelled' });
    const retried = await bob.service.claimDesktop(task.spec.id, waiting.state.seq, 'bob-desktop-claim');
    assert.equal(retried.state.seq, claimed.state.seq);
    await assert.rejects(alice.service.requestReview(task.spec.id, { summary: 'spoof', refs: aliceRefs }, claimed.state.seq), /expired or superseded/);
    git(f.output.repos.bob, 'fetch', 'origin', `refs/heads/${aliceRefs.branch}`);
    assert.equal(git(f.output.repos.bob, 'rev-parse', 'FETCH_HEAD'), aliceRefs.commit);
    const bobRefs = await pushedChange(f.output.repos.bob, 'codex/bob-desktop', 'test.sh', '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n[ "$(sh greet.sh --upper)" = "HELLO, WORLD" ]\n', aliceRefs.commit);
    execFileSync('sh', ['test.sh'], { cwd: f.output.repos.bob });
    const reviewed = await bob.service.requestReview(task.spec.id, { summary: 'Regression tests passed.', refs: bobRefs }, claimed.state.seq, 'bob-review');
    assert.equal(reviewed.state.status, 'review');
    const sent = [];
    await new PeerNotificationRelay(alice.service, async (notified, type) => { if (notified.spec.id === task.spec.id) sent.push(['alice', type]); }).poll();
    await new PeerNotificationRelay(bob.service, async (notified, type) => { if (notified.spec.id === task.spec.id) sent.push(['bob', type]); }).poll();
    assert.deepEqual(sent, [['alice', 'created'], ['alice', 'handoff'], ['bob', 'desktop_claimed'], ['bob', 'review_requested']]);
    await assert.rejects(bob.service.report(task.spec.id, { type: 'reviewed', decision: 'approved' }), /administrator/);
    const replies = [];
    const command = async (text, msgid) => dispatchPeerWecom({ body: { chattype: 'group', chatid: 'group', msgtype: 'text', msgid, from: { userid: 'single-human-owner' }, text: { content: text } } }, { service: alice.service, config: { chat_ids: ['group'] }, reply: async (_frame, text) => replies.push(text) });
    await command(`协作 审核 ${task.spec.id} 通过`, 'human-review');
    await command(`协作 完成 ${task.spec.id}`, 'human-complete');
    const final = await alice.service.read(task.spec.id);
    assert.equal(final.state.status, 'completed'); assert.equal(final.state.checkpoint.commit, bobRefs.commit);
    assert.equal(replies.length, 2);
    assert.equal(git(f.output.shared_origin, 'rev-parse', 'main'), git(f.seed, 'rev-parse', 'main'));
    assert.equal(JSON.stringify(final).includes('private_key'), false);
  } finally { await f.cleanup(); }
});

test('manual desktop reservation races an automatic claim without two owners executing one stage', async () => {
  const f = await fixture();
  try {
    const alice = await loadRuntime(f.output.configs.alice);
    const bobManual = await loadRuntime(f.output.configs.bob, { dataDir: join(f.root, 'bob-manual') });
    const bobAutomatic = await loadRuntime(f.output.configs.bob, { dataDir: join(f.root, 'bob-automatic') });
    const task = await alice.service.create({ title: 'race', acceptance: ['pass'], workflow: ['frontend', 'backend'], execution_mode: 'desktop' });
    const refs = await pushedChange(f.output.repos.alice, 'codex/desktop-race', 'greet.sh', '#!/bin/sh\nprintf "hello, world\\n"\nprintf ""\n');
    const waiting = await alice.service.handoff(task.spec.id, { summary: 'Continue from the pinned change.', refs }, task.state.seq);
    const results = await Promise.allSettled([bobManual.service.claimDesktop(task.spec.id, waiting.state.seq), bobAutomatic.service.claim(task.spec.id)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 409).length, 1);
    const latest = await alice.service.read(task.spec.id);
    assert.equal(latest.state.assignee, 'bob'); assert.ok(['desktop', 'running'].includes(latest.state.status));
    assert.equal(latest.state.seq, waiting.state.seq + 1);
  } finally { await f.cleanup(); }
});

test('notification-only second bot accepts no group commands and needs no duplicate owner identity', async () => {
  const f = await fixture();
  try {
    const config = JSON.parse(await readFile(f.output.configs.bob, 'utf8'));
    config.wecom = { bot_id: 'different-local-test-bot', secret: 'fake-fixture-secret-not-a-credential', chat_ids: ['group'], commands_enabled: false };
    await writeFile(f.output.configs.bob, JSON.stringify(config), { mode: 0o600 });
    const bob = await loadRuntime(f.output.configs.bob);
    assert.equal(bob.team.agents.bob.wecom_userid, undefined);
    const handled = await dispatchPeerWecom({ body: { chattype: 'group', chatid: 'group', msgtype: 'text', msgid: 'msg', from: { userid: 'single-human-owner' }, text: { content: '协作 创建 should-not-exist' } } }, { service: bob.service, config: config.wecom, reply: () => assert.fail('notification-only bot must not reply to commands') });
    assert.equal(handled, false); assert.deepEqual(await bob.service.list(), []);
    config.wecom.commands_enabled = true;
    await writeFile(f.output.configs.bob, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(readPeerConfig(f.output.configs.bob), /pinned owner/);
    config.wecom.commands_enabled = false; config.auto_execute = 'false';
    await writeFile(f.output.configs.bob, JSON.stringify(config), { mode: 0o600 });
    await assert.rejects(readPeerConfig(f.output.configs.bob), /auto_execute/);
  } finally { await f.cleanup(); }
});
