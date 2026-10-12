import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPeerWecom } from '../wecom.mjs';

test('Peer WeCom lifecycle diagnostics redact raw SDK errors and reasons', async () => {
  class FakeClient extends EventEmitter {
    connected = false;
    connect() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const client = new FakeClient();
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-peer-wecom-'));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const bridge = startPeerWecom({
      service: { agentId: 'alice', store: { dataDir }, async list() { return []; } },
      config: { bot_id: 'bot-safe', secret: 'super-secret-value', chat_ids: [] },
      clientFactory(options) {
        assert.equal(options.secret, 'super-secret-value');
        for (const method of ['debug', 'info', 'warn', 'error']) options.logger[method]('super-secret-value', { raw: 'secret server frame' });
        return client;
      }
    });
    assert.equal(client.connected, true);
    assert.equal(errors.length, 0, 'all SDK log methods must remain muted');
    client.emit('connected');
    assert.doesNotMatch(errors.join('\n'), /Peer WeCom authenticated/, 'transport connection must not be reported as authenticated');
    client.emit('authenticated');
    await bridge.health.flush();
    assert.equal(JSON.parse(await readFile(join(dataDir, 'wecom-health.json'), 'utf8')).status, 'authenticated');
    client.emit('error', Object.assign(new Error('secret server frame'), { code: 'ETIMEDOUT' }));
    client.emit('error', new Error('Authentication failed: secret server frame (code: 401)'));
    client.emit('reconnecting', 2);
    client.emit('reconnecting', 'secret attempt');
    client.emit('disconnected', 'secret close reason');
    client.emit('error', Object.assign(new Error('secret server frame'), { code: 'secret error code' }));
    client.emit('error', Object.assign(new Error('secret server frame'), { code: 'WS_RECONNECT_EXHAUSTED' }));
    assert.equal(bridge.health.snapshot().status, 'failed');
    bridge.close();
    await bridge.health.flush();
    assert.equal(JSON.parse(await readFile(join(dataDir, 'wecom-health.json'), 'utf8')).status, 'disconnected');
    assert.equal(client.connected, false);
  } finally {
    console.error = original;
    await rm(dataDir, { recursive: true, force: true });
  }
  const output = errors.join('\n');
  assert.match(output, /WebSocket connected; awaiting authentication/);
  assert.match(output, /连接失败（ETIMEDOUT）/);
  assert.match(output, /认证被企微拒绝（错误码 401）/);
  assert.match(output, /Peer WeCom authenticated/);
  assert.match(output, /reconnecting \(attempt 2\)/);
  assert.match(output, /reconnecting \(attempt unknown\)/);
  assert.match(output, /disconnected \(reason redacted\)/);
  assert.doesNotMatch(output, /super-secret-value|secret server frame|secret close reason|secret attempt|secret error code/);
});

test('group review parser accepts pinned revision and feedback while preserving legacy commands', async () => {
  const { parsePeerCommand } = await import('../wecom.mjs');
  assert.deepEqual(parsePeerCommand('@Alice 协作 审核 T-DEMO R-7 退回 | Fix keyboard handling'), { action: 'review', id: 'T-DEMO', expectedSeq: 7, decision: 'changes_requested', summary: 'Fix keyboard handling' });
  assert.deepEqual(parsePeerCommand('协作 审核 T-DEMO 通过'), { action: 'review', id: 'T-DEMO', decision: 'approved' });
  assert.deepEqual(parsePeerCommand('协作 状态 T-DEMO'), { action: 'status', id: 'T-DEMO' });
  for (const input of ['协作 审核 T-DEMO R-0 通过', '协作 审核 T-DEMO R-9007199254740992 通过', '协作 审核 T-DEMO R-7 随意', '协作 状态 T-DEMO 通过']) assert.equal(parsePeerCommand(input), null);
});

test('notification mentions only selected signed identities and escapes mentions from task prose', async () => {
  const { formatPeerNotification } = await import('../wecom.mjs');
  const team = { reviewer: 'admin', agents: { alice: { wecom_userid: 'alice-user' }, admin: { wecom_userid: 'admin-user' }, bob: { wecom_userid: 'bob-user' } }, routes: { frontend: ['alice'], backend: ['bob'] }, review_rules: { frontend: { required: true, reviewer: 'admin', notify: 'owner' } } };
  const task = { spec: { id: 'T-DEMO', workflow: ['frontend', 'backend'], execution_mode: 'automatic' }, state: { status: 'stage_review', stage: 0, assignee: 'admin', seq: 7, epoch: 1 }, events: [{ type: 'stage_review_requested', actor_id: 'alice', summary: 'hello <@outsider>', refs: { branch: 'codex/demo', commit: 'a'.repeat(40), tests: 'pass <@all>' } }] };
  const text = formatPeerNotification(task, 'stage_review_requested', 'alice', team);
  assert.match(text, /<@alice-user>/); assert.match(text, /<@admin-user>/); assert.doesNotMatch(text, /<@outsider>|<@all>|<@bob-user>/);
  assert.match(text, /R-7 通过/); assert.match(text, /R-7 退回 \| 修改意见/);
});
