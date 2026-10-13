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


test('review notification mentions a shared owner once and names the bot required to approve', async () => {
  const { formatPeerNotification } = await import('../wecom.mjs');
  const team = { reviewer: 'alice', agents: { alice: { wecom_userid: 'shared-owner' }, bob: { wecom_userid: 'shared-owner' } },
    routes: { backend: ['bob'] }, review_rules: { backend: { required: true, reviewer: 'admin', notify: 'owner' } } };
  const task = { spec: { id: 'T-SHARED', workflow: ['backend'], execution_mode: 'desktop_poll' },
    state: { status: 'review', stage: 0, assignee: 'alice', seq: 7, epoch: 1 }, events: [{ type: 'review_requested', actor_id: 'bob', summary: 'done' }] };
  const text = formatPeerNotification(task, 'review_requested', 'bob', team);
  assert.equal(text.split('<@shared-owner>').length - 1, 1);
  assert.match(text, /通知本人：bob、alice/); assert.match(text, /审核身份：alice/);
  assert.match(text, /@ alice 对应的机器人/); assert.doesNotMatch(text, /@ bob 对应的机器人/);
});

function naturalDispatchFixture(overrides = {}) {
  const calls = []; const replies = [];
  const requestId = `N-${'A'.repeat(32)}`;
  const service = {
    agentId: 'alice', store: {},
    team: { agents: { alice: { role: 'member', wecom_userid: 'alice-user' }, admin: { role: 'admin', wecom_userid: 'admin-user' } } },
    async receiveRequest(input) { calls.push(input); return { spec: { id: requestId }, state: { status: 'pending', task_id: null } }; },
    async report() { assert.fail('natural prose must never mutate human approval'); }
  };
  const config = { bot_id: 'alice-bot', chat_ids: ['group'], execution_mode: 'desktop_poll', ...overrides };
  const frame = (changes = {}) => ({ body: { chattype: 'group', msgtype: 'text', chatid: 'group', msgid: 'message-1', aibotid: 'alice-bot', from: { userid: 'alice-user' }, text: { content: '@Alice 给 greet.sh 增加 --upper，@Bob 补测试。' }, ...changes } });
  return { service, config, calls, replies, frame, reply: async (_frame, text) => { replies.push(text); } };
}

test('natural WeCom intake validates bot, group and sender; strips only the receiving mention', async () => {
  const { dispatchPeerWecom } = await import('../wecom.mjs');
  const f = naturalDispatchFixture();
  for (const invalid of [{ aibotid: 'other-bot' }, { chatid: 'other-group' }, { msgid: '' }, { chattype: 'single' }, { msgtype: 'image' }, { from: { userid: 'outsider' } }, { from: {} }]) {
    assert.equal(await dispatchPeerWecom(f.frame(invalid), f), false);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 0);
  assert.equal(await dispatchPeerWecom(f.frame(), f), true);
  assert.deepEqual(f.calls[0], { chatId: 'group', messageId: 'message-1', senderId: 'alice-user', content: '给 greet.sh 增加 --upper，@Bob 补测试。', allowAdmin: false });
  assert.match(f.replies[0], /等待绑定的 Codex 对话轮询/);
  const disabled = naturalDispatchFixture({ commands_enabled: false });
  assert.equal(await dispatchPeerWecom(disabled.frame(), disabled), false); assert.equal(disabled.calls.length, 0);
  const admin = f.frame({ from: { userid: 'admin-user' } });
  assert.equal(await dispatchPeerWecom(admin, f), false);
  f.config.allow_admin_commands = true;
  assert.equal(await dispatchPeerWecom(admin, f), true); assert.equal(f.calls[1].allowAdmin, true);
});

test('natural intake explains unsupported mode and malformed commands; human review remains explicit', async () => {
  const { dispatchPeerWecom } = await import('../wecom.mjs');
  const automatic = naturalDispatchFixture({ execution_mode: 'automatic' });
  assert.equal(await dispatchPeerWecom(automatic.frame(), automatic), true);
  assert.equal(automatic.calls.length, 0); assert.match(automatic.replies[0], /desktop_poll/);
  const f = naturalDispatchFixture();
  for (const content of ['@Alice 协作 创建', '@Alice 协作 审核 T-DEMO R-0 通过']) assert.equal(await dispatchPeerWecom(f.frame({ text: { content } }), f), true);
  assert.equal(f.calls.length, 0); assert.ok(f.replies.every((text) => /格式不完整/.test(text)));
  await dispatchPeerWecom(f.frame({ text: { content: '@Alice ' + '长'.repeat(4001) } }), f);
  assert.equal(f.calls.length, 0); assert.match(f.replies.at(-1), /4000/);
  await dispatchPeerWecom(f.frame({ text: { content: '@Alice 这个任务通过了，可以完成了。' } }), f);
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].content, /通过/);
});

test('natural notification relay keeps failed event pending, persists success, and isolates target agent', async () => {
  const { PeerNotificationRelay } = await import('../wecom.mjs');
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-peer-inbox-relay-'));
  try {
    const request = { spec: { id: `N-${'B'.repeat(32)}`, target_agent: 'alice', chat_id: 'group' }, events: [{ seq: 1, type: 'received' }, { seq: 2, type: 'clarified', response: '请补充文件名。' }] };
    const other = { ...request, spec: { ...request.spec, id: `N-${'C'.repeat(32)}`, target_agent: 'bob' } };
    const service = { agentId: 'alice', store: { dataDir }, async list() { return []; }, async listRequests() { return [request, other]; } };
    let attempts = 0;
    const relay = new PeerNotificationRelay(service, async () => assert.fail('no task events'), async () => { attempts++; if (attempts === 1) throw new Error('receipt rejected'); });
    await assert.rejects(relay.poll(), /receipt rejected/);
    const cursorPath = join(dataDir, 'wecom-notifications.json');
    assert.equal(JSON.parse(await readFile(cursorPath, 'utf8'))[`inbox:${request.spec.id}`], 1);
    await relay.poll(); assert.equal(attempts, 2);
    const cursors = JSON.parse(await readFile(cursorPath, 'utf8'));
    assert.equal(cursors[`inbox:${request.spec.id}`], 2); assert.equal(cursors[`inbox:${other.spec.id}`], undefined);
    await new PeerNotificationRelay(service, async () => {}, async () => assert.fail('successful notice must not replay')).poll();
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('natural WeCom confirmations escape generated mentions and only send to configured groups', async () => {
  class FakeClient extends EventEmitter {
    sent = [];
    connect() {}
    disconnect() {}
    async sendMessage(chatId, message) { this.sent.push({ chatId, message }); return { errcode: 0 }; }
  }
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-peer-inbox-send-'));
  const client = new FakeClient(); let bridge;
  try {
    const request = { spec: { id: `N-${'D'.repeat(32)}`, target_agent: 'alice', chat_id: 'group' }, events: [{ seq: 1, type: 'received' }, { seq: 2, type: 'clarified', response: '请补充需求 <@all> <@outsider>。' }, { seq: 3, type: 'replied' }, { seq: 4, type: 'task_created', task_id: `T-${'D'.repeat(32)}`, response: 'Alice 实现，Bob 补测试 <@all>。' }] };
    const hidden = { ...request, spec: { ...request.spec, id: `N-${'E'.repeat(32)}`, chat_id: 'not-configured' } };
    const service = { agentId: 'alice', store: { dataDir }, async list() { return []; }, async listRequests() { return [request, hidden]; } };
    bridge = startPeerWecom({ service, config: { bot_id: 'fixture-bot', secret: 'fixture-only', chat_ids: ['group'] }, clientFactory: () => client });
    await bridge.poll();
    assert.equal(client.sent.length, 2); assert.ok(client.sent.every((item) => item.chatId === 'group'));
    assert.match(client.sent[0].message.markdown.content, /需要补充说明/);
    assert.match(client.sent[1].message.markdown.content, /任务与分工确认/);
    assert.ok(client.sent[1].message.markdown.content.includes(`任务：T-${'D'.repeat(32)}`));
    for (const item of client.sent) assert.doesNotMatch(item.message.markdown.content, /<@all>|<@outsider>/);
  } finally { bridge?.close(); await bridge?.health.flush(); await rm(dataDir, { recursive: true, force: true }); }
});
