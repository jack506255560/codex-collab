import { BadRequest, Forbidden } from './auth.mjs';

export function parseChatCommand(raw) {
  if (typeof raw !== 'string') return null;
  // Feishu uses @_user_N tokens; WeCom may include a leading @bot name in text.content.
  const text = raw.replace(/@_user_\d+/g, '').trim().replace(/^(?:@[^\s@]{1,40}\s+)+(?=协作\s)/, '');
  const create = /^协作\s+创建\s+([^|]+?)(?:\s*\|\s*(.+))?$/.exec(text);
  if (create) return { action: 'create', title: create[1].trim(), acceptance: create[2]?.split(';').map((value) => value.trim()).filter(Boolean) || ['人工确认任务验收条件'] };
  const assign = /^协作\s+分配\s+([A-Z][A-Z0-9-]{1,63})\s+([a-zA-Z0-9_-]+)$/.exec(text);
  if (assign) return { action: 'assign', id: assign[1], assignee: assign[2] };
  const handoff = /^协作\s+交接\s+([A-Z][A-Z0-9-]{1,63})\s+([a-zA-Z0-9_-]+)$/.exec(text);
  if (handoff) return { action: 'handoff_assign', id: handoff[1], assignee: handoff[2] };
  const review = /^协作\s+审核\s+([A-Z][A-Z0-9-]{1,63})\s+(通过|退回)$/.exec(text);
  if (review) return { action: 'review', id: review[1], decision: review[2] === '通过' ? 'approved' : 'changes_requested' };
  const complete = /^协作\s+完成\s+([A-Z][A-Z0-9-]{1,63})$/.exec(text);
  if (complete) return { action: 'complete', id: complete[1] };
  const status = /^协作\s+状态\s+([A-Z][A-Z0-9-]{1,63})$/.exec(text);
  if (status) return { action: 'status', id: status[1] };
  return null;
}

export async function dispatchChatCommand(message, { service, accounts, allowedChatIds, send, lookupUser }) {
  const { channel, chatId, senderId, messageId, text } = message;
  if (!['feishu', 'wecom'].includes(channel) || !allowedChatIds.includes(chatId) || !messageId) return false;
  const command = parseChatCommand(text);
  if (!command) return false;
  const user = lookupUser(senderId);
  if (!user) { await send(chatId, '协作 Bot：当前账号未绑定协作身份。'); return true; }
  const idempotencyKey = `${channel}:${messageId}`;
  let response;
  try {
    if (command.action === 'create') {
      const task = await service.create(user, { title: command.title, acceptance: command.acceptance, chatId, channel }, idempotencyKey);
      response = `任务 ${task.spec.id} 已创建；待管理员分配。`;
    } else {
      const current = await service.read(command.id);
      // Group messages must not reveal or mutate a task belonging to another group/channel.
      const source = current.spec?.source || {};
      const originating = source.chat_id ? source : current.events?.findLast((event) => event.chat_id);
      if (!originating?.chat_id || originating.chat_id !== chatId || (originating.channel || 'feishu') !== channel) throw new Forbidden('任务不属于当前群');
      if (command.action === 'assign' || command.action === 'handoff_assign') {
        if (command.action === 'handoff_assign' && current.state.status !== 'waiting') throw new BadRequest('任务尚未提交代码交接');
        if (!accounts.users.some((account) => account.id === command.assignee)) throw new BadRequest('未知的协作成员');
        const task = await service.assign(user, command.id, command.assignee, idempotencyKey, chatId, channel);
        response = `任务 ${task.spec.id} 已分配给 ${task.state.assignee}。`;
      } else if (command.action === 'review') {
        const task = await service.report(user, command.id, { type: 'reviewed', decision: command.decision }, current.state.seq, idempotencyKey);
        response = `任务 ${task.spec.id} 审核${command.decision === 'approved' ? '通过' : '退回'}。`;
      } else if (command.action === 'complete') {
        const evidence = current.events.findLast((event) => event.type === 'review_requested')?.refs;
        const task = await service.report(user, command.id, { type: 'completed', refs: evidence }, current.state.seq, idempotencyKey);
        response = `任务 ${task.spec.id} 已完成。`;
      } else {
        response = `任务 ${current.spec.id}：${current.spec.title}；状态 ${current.state.status}；负责人 ${current.state.assignee || '未分配'}。`;
      }
    }
  } catch (error) {
    // Avoid sending internal error details, paths or credentials to a group.
    response = `协作 Bot：操作失败：${error.status && error.status < 500 ? error.message : '请联系管理员查看服务日志'}`;
  }
  // Never retry a failed SDK reply as a second reply to the same callback frame.
  await send(chatId, response);
  return true;
}
