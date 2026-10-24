import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchChatCommand, parseChatCommand, wecomTaskChatId } from '../chat-command.mjs';

test('WeCom text commands keep explicit intents and strip leading bot mentions', () => {
  assert.equal(parseChatCommand('随便说一说'), null);
  assert.equal(parseChatCommand(null), null);
  assert.deepEqual(parseChatCommand('@协作机器人 协作 分配 T-001 alice'), { action: 'assign', id: 'T-001', assignee: 'alice' });
  assert.deepEqual(parseChatCommand('协作 创建 增加大写 | 测试通过;有提交'), { action: 'create', title: '增加大写', acceptance: ['测试通过', '有提交'] });
  assert.deepEqual(parseChatCommand('协作 创建 增加大写'), { action: 'create', title: '增加大写', acceptance: ['人工确认任务验收条件'] });
  assert.deepEqual(parseChatCommand('协作 交接 T-001 bob'), { action: 'handoff_assign', id: 'T-001', assignee: 'bob' });
  assert.deepEqual(parseChatCommand('协作 审核 T-001 退回'), { action: 'review', id: 'T-001', decision: 'changes_requested' });
  assert.deepEqual(parseChatCommand('协作 完成 T-001'), { action: 'complete', id: 'T-001' });
  assert.deepEqual(parseChatCommand('协作 状态 T-001'), { action: 'status', id: 'T-001' });
});

test('group replies and notifications use only explicit WeCom provenance', () => {
  const source = { chat_id: 'group-1', channel: 'wecom' };
  assert.equal(wecomTaskChatId({ spec: { source } }), 'group-1');
  assert.equal(wecomTaskChatId({ spec: {}, events: [{ type: 'assigned', ...source }] }), 'group-1');
  assert.equal(wecomTaskChatId({ spec: {}, events: [] }), null);
  for (const channel of [undefined, null, '', 'other-im']) {
    // Even a later assignment must not rewrite the original group's provenance.
    assert.equal(wecomTaskChatId({ spec: { source: { chat_id: 'group-1', channel } }, events: [source] }), null);
    assert.equal(wecomTaskChatId({ spec: {}, events: [{ chat_id: 'group-1', channel }] }), null);
  }
  for (const chat_id of ['', '   ', 123]) assert.equal(wecomTaskChatId({ spec: { source: { chat_id, channel: 'wecom' } } }), null);
});

test('other channels and tasks without explicit matching group provenance are not dispatched', async () => {
  let creates = 0; let lookups = 0;
  const replies = [];
  const current = { spec: { id: 'T-001', title: 'private title', source: {} }, state: { status: 'open' }, events: [] };
  const options = {
    accounts: { wecom() { lookups++; return { id: 'alice' }; }, users: [] },
    service: { async create() { creates++; }, async read() { return current; } },
    allowedChatIds: ['group-1'], send: async (_group, reply) => replies.push(reply)
  };
  const message = { channel: 'other-im', chatId: 'group-1', senderId: 'user-1', messageId: 'm1', text: '协作 创建 测试' };
  assert.equal(await dispatchChatCommand(message, options), false);
  assert.equal(lookups, 0); assert.equal(creates, 0); assert.deepEqual(replies, []);
  for (const source of [{}, { chat_id: 'group-1' }, { chat_id: 'group-1', channel: 'other-im' }, { chat_id: 'other-group', channel: 'wecom' }]) {
    current.spec.source = source;
    assert.equal(await dispatchChatCommand({ ...message, channel: 'wecom', text: '协作 状态 T-001' }, options), true);
    assert.match(replies.at(-1), /任务不属于当前群/);
    assert.doesNotMatch(replies.at(-1), /private title/);
  }
});
