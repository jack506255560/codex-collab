import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Accounts, hashToken } from '../auth.mjs';
import { dispatchWecomMessage, startWecom, wecomFrameDiagnostic } from '../wecom.mjs';

const users = [
  { id: 'alice', role: 'admin', wecom_userid: 'alice-wecom', token_sha256: hashToken('alice-test-token-123456789012345678') },
  { id: 'bob', role: 'member', wecom_userid: 'bob-wecom', token_sha256: hashToken('bob-test-token-12345678901234567890') }
];
const accounts = new Accounts(users);
const frame = (text, overrides = {}) => ({ headers: { req_id: 'req-1' }, body: {
  msgid: 'mid-1', msgtype: 'text', chattype: 'group', chatid: 'group-1',
  from: { userid: 'alice-wecom' }, text: { content: text }, ...overrides
} });

function fixture() {
  const tasks = new Map();
  const calls = [];
  const service = {
    async create(user, input, key) {
      calls.push({ user, input, key });
      if (!tasks.has(key)) tasks.set(key, { spec: { id: 'T-TEST', source: { chat_id: input.chatId, channel: input.channel }, title: input.title }, state: { status: 'open', assignee: null }, events: [] });
      return tasks.get(key);
    },
    async read() { return tasks.values().next().value; }
  };
  const replies = [];
  const options = { service, accounts, allowedChatIds: ['group-1'], reply: async (_frame, value) => replies.push(value) };
  return { service, calls, replies, options };
}

test('WeCom group commands: allowlist, sender mapping, duplicate message id, private chat, cross-group guard', async () => {
  const { calls, replies, options } = fixture();
  const cmd = frame('@智能机器人 协作 创建 添加功能 | sh test.sh 通过');
  const safe = JSON.stringify(wecomFrameDiagnostic(cmd, accounts, ['group-1']));
  assert.match(safe, /\"command\":\"create\"/);
  for (const sensitive of ['添加功能', 'group-1', 'alice-wecom', 'mid-1']) assert.equal(safe.includes(sensitive), false);
  for (const overrides of [{ chattype: 'single' }, { chatid: 'group-2' }, { msgtype: 'image' }, { msgid: '' }, { from: {} }]) {
    assert.equal(await dispatchWecomMessage(frame('协作 创建 忽略', overrides), options), false);
  }
  assert.equal(calls.length, 0);
  assert.equal(await dispatchWecomMessage(cmd, options), true);
  assert.equal(calls[0].key, 'wecom:mid-1');
  assert.equal(calls[0].input.channel, 'wecom');
  assert.match(replies.at(-1), /已创建/);
  await dispatchWecomMessage(cmd, options);
  assert.equal(calls[1].key, 'wecom:mid-1');
  assert.match(replies.at(-1), /已创建/);
  await dispatchWecomMessage(frame('协作 创建 未绑定', { msgid: 'mid-2', from: { userid: 'stranger' } }), options);
  assert.match(replies.at(-1), /未绑定/);
  assert.equal(calls.length, 2);
  await dispatchWecomMessage(frame('协作 状态 T-TEST', { msgid: 'mid-3', chatid: 'group-2' }), { ...options, allowedChatIds: ['group-1', 'group-2'] });
  assert.match(replies.at(-1), /任务不属于当前群/);
  assert.doesNotMatch(replies.at(-1), /添加功能/);
  assert.equal(await dispatchWecomMessage(frame('普通消息', { msgid: 'mid-4' }), options), false);
});

test('WeCom adapter uses SDK methods, no unlisted send, redacted SDK logs, and checks reply receipts', async () => {
  class FakeClient extends EventEmitter {
    connected = false;
    replies = [];
    sends = [];
    connect() { this.connected = true; }
    async replyStream(...args) { this.replies.push(args); return { errcode: 0 }; }
    async sendMessage(...args) { this.sends.push(args); return { errcode: 0 }; }
  }
  const client = new FakeClient();
  const { service } = fixture();
  let passedConfig;
  const bridge = startWecom({ service, accounts, botId: 'test-id', secret: 'test-secret', allowedChatIds: ['group-1'],
    clientFactory(config) { passedConfig = config; return client; } });
  assert.equal(client.connected, true);
  assert.equal(passedConfig.logger.debug('secret', frame('sensitive')), undefined);
  assert.equal(passedConfig.secret, 'test-secret');
  await bridge.send('group-1', 'notification');
  assert.deepEqual(client.sends.at(-1), ['group-1', { msgtype: 'markdown', markdown: { content: 'notification' } }]);
  await assert.rejects(bridge.send('group-2', 'no'), /non-allowlisted/);
  client.emit('message.text', frame('协作 创建 测试 | 通过'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.replies.length, 1);
  assert.equal(client.replies[0][0].body.chatid, 'group-1');
  assert.equal(client.replies[0][3], true);
  client.sendMessage = async () => ({ errcode: 40001 });
  await assert.rejects(bridge.send('group-1', 'fail'), /40001/);
  const originalReply = client.replyStream.bind(client);
  client.replyStream = async (...args) => { await originalReply(...args); return { errcode: 40002 }; };
  // The adapter catches rejected receipts so a callback never crashes the WebSocket process.
  client.emit('message.text', frame('协作 创建 失败回执', { msgid: 'mid-9' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.replies.length, 2);
});

test('duplicate WeCom user IDs cannot bind to different accounts', () => {
  assert.throws(() => new Accounts([users[0], { ...users[1], wecom_userid: 'alice-wecom' }]), /duplicate account wecom_userid/);
});
