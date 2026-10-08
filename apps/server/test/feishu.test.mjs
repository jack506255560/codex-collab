import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFeishuCommand, dispatchFeishuMessage } from '../feishu.mjs';

test('only explicit group commands are recognized', () => {
  assert.equal(parseFeishuCommand('随便说一说'), null);
  assert.deepEqual(parseFeishuCommand('@_user_1 协作 分配 T-001 alice'), { action: 'assign', id: 'T-001', assignee: 'alice' });
  assert.deepEqual(parseFeishuCommand('协作 创建 增加大写 | 测试通过;有提交'), { action: 'create', title: '增加大写', acceptance: ['测试通过', '有提交'] });
  assert.deepEqual(parseFeishuCommand('协作 审核 T-001 退回'), { action: 'review', id: 'T-001', decision: 'changes_requested' });
  assert.deepEqual(parseFeishuCommand('协作 完成 T-001'), { action: 'complete', id: 'T-001' });
});

test('allowlist and sender identity are enforced, duplicate message ID is forwarded as idempotency key', async () => {
  const replies = [];
  const calls = [];
  const service = {
    create: async (...args) => { calls.push(args); return { spec: { id: 'T-002' } }; }
  };
  const accounts = { feishu: (id) => id === 'ou-alice' ? { id: 'alice' } : null, users: [] };
  const options = { service, accounts, allowedChatIds: ['chat-allowed'], send: async (...args) => replies.push(args) };
  const data = { sender: { sender_id: { open_id: 'ou-alice' } }, message: { chat_id: 'chat-allowed', message_type: 'text', message_id: 'mid-001', content: JSON.stringify({ text: '协作 创建 写测试 | sh test.sh 通过' }) } };
  assert.equal(await dispatchFeishuMessage({ ...data, message: { ...data.message, chat_id: 'other' } }, options), false);
  assert.equal(calls.length, 0);
  assert.equal(await dispatchFeishuMessage(data, options), true);
  assert.equal(calls[0][2], 'feishu:mid-001');
  assert.deepEqual(replies.at(-1), ['chat-allowed', '任务 T-002 已创建；待管理员分配。']);
  const unknown = { ...data, sender: { sender_id: { open_id: 'other' } } };
  await dispatchFeishuMessage(unknown, options);
  assert.match(replies.at(-1)[1], /未绑定/);
});
