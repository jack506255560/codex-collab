import * as Lark from '@larksuiteoapi/node-sdk';
import { BadRequest } from './auth.mjs';

export function parseFeishuCommand(raw) {
  // Commands must start with 协作 to prevent accidental task creation from normal group talk.
  const text = raw.replace(/@_user_\d+/g, '').trim();
  const create = /^协作\s+创建\s+([^|]+?)(?:\s*\|\s*(.+))?$/.exec(text);
  if (create) {
    const acceptance = create[2]?.split(';').map((value) => value.trim()).filter(Boolean) || ['人工确认任务验收条件'];
    return { action: 'create', title: create[1].trim(), acceptance };
  }
  const assign = /^协作\s+分配\s+([A-Z][A-Z0-9-]{1,63})\s+([a-zA-Z0-9_-]+)$/.exec(text);
  if (assign) return { action: 'assign', id: assign[1], assignee: assign[2] };
  const review = /^协作\s+审核\s+([A-Z][A-Z0-9-]{1,63})\s+(通过|退回)$/.exec(text);
  if (review) return { action: 'review', id: review[1], decision: review[2] === '通过' ? 'approved' : 'changes_requested' };
  const complete = /^协作\s+完成\s+([A-Z][A-Z0-9-]{1,63})$/.exec(text);
  if (complete) return { action: 'complete', id: complete[1] };
  const status = /^协作\s+状态\s+([A-Z][A-Z0-9-]{1,63})$/.exec(text);
  if (status) return { action: 'status', id: status[1] };
  return null;
}

export async function dispatchFeishuMessage(data, { service, accounts, allowedChatIds, send }) {
  const message = data.message;
  if (!message || message.message_type !== 'text' || !allowedChatIds.includes(message.chat_id)) return false;
  let raw;
  try { raw = JSON.parse(message.content).text; } catch { return false; }
  const command = parseFeishuCommand(raw);
  if (!command) return false;
  const user = accounts.feishu(data.sender?.sender_id?.open_id);
  if (!user) { await send(message.chat_id, '协作 Bot：当前飞书账号未绑定协作身份。'); return true; }
  try {
    let response;
    if (command.action === 'create') {
      const task = await service.create(user, { title: command.title, acceptance: command.acceptance, chatId: message.chat_id }, `feishu:${message.message_id}`);
      response = `任务 ${task.spec.id} 已创建；待管理员分配。`;
    } else if (command.action === 'assign') {
      if (!accounts.users.some((account) => account.id === command.assignee)) throw new BadRequest('未知的协作成员');
      const task = await service.assign(user, command.id, command.assignee, `feishu:${message.message_id}`, message.chat_id);
      response = `任务 ${task.spec.id} 已分配给 ${task.state.assignee}。`;
    } else if (command.action === 'review') {
      const current = await service.read(command.id);
      const task = await service.report(user, command.id, { type: 'reviewed', decision: command.decision }, current.state.seq, `feishu:${message.message_id}`);
      response = `任务 ${task.spec.id} 审核${command.decision === 'approved' ? '通过' : '退回'}。`;
    } else if (command.action === 'complete') {
      const current = await service.read(command.id);
      const evidence = current.events.findLast((event) => event.type === 'review_requested')?.refs;
      const task = await service.report(user, command.id, { type: 'completed', refs: evidence }, current.state.seq, `feishu:${message.message_id}`);
      response = `任务 ${task.spec.id} 已完成。`;
    } else {
      const task = await service.read(command.id);
      response = `任务 ${task.spec.id}：${task.spec.title}；状态 ${task.state.status}；负责人 ${task.state.assignee || '未分配'}。`;
    }
    await send(message.chat_id, response);
  } catch (error) {
    await send(message.chat_id, `协作 Bot：操作失败：${error.message}`);
  }
  return true;
}

export async function startFeishu({ service, accounts, appId, appSecret, allowedChatIds }) {
  if (!allowedChatIds.length) throw new Error('FEISHU_CHAT_IDS must contain at least one allowed group chat_id');
  const config = { appId, appSecret };
  const client = new Lark.Client(config);
  const send = async (chatId, value) => {
    if (!allowedChatIds.includes(chatId)) throw new Error('refusing to send to a non-allowlisted chat');
    const result = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: value }) }
    });
    if (result.code !== 0) throw new Error(`Feishu send failed: ${result.code}`);
  };
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      await dispatchFeishuMessage(data, { service, accounts, allowedChatIds, send });
    }
  });
  const wsClient = new Lark.WSClient(config);
  await wsClient.start({ eventDispatcher: dispatcher });
  console.log('Feishu WebSocket event subscriber started');
  return { send, wsClient };
}
