import AiBot from '@wecom/aibot-node-sdk';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../../packages/peer/config.mjs';
import { reviewNotificationMembers } from '../../packages/peer/review.mjs';
import { reducePeerTask } from '../../packages/peer/protocol.mjs';
import { wecomDiagnostic } from '../../scripts/wecom-diagnostic.mjs';
export function parsePeerCommand(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^(?:@[^\s@]{1,40}\s+)+(?=协作\s)/, '');
  const create = /^协作\s+创建\s+(?:\[([a-zA-Z0-9_>\-]+)\]\s+)?([^|]+?)(?:\s*\|\s*(.+))?$/.exec(text);
  if (create) return { action: 'create', workflow: create[1]?.split('>'), title: create[2].trim(), acceptance: create[3]?.split(';').map((s) => s.trim()).filter(Boolean) || ['人工确认验收条件'] };
  const reopen = /^协作\s+重试\s+(T-[A-Z0-9-]{1,62})\s+(.+)$/.exec(text);
  if (reopen) return { action: 'reopen', id: reopen[1], summary: reopen[2].trim() };
  const review = /^协作\s+审核\s+(T-[A-Z0-9-]{1,62})(?:\s+R-([1-9][0-9]*))?\s+(通过|退回)(?:\s*\|\s*(.+))?$/.exec(text);
  if (review) {
    const expectedSeq = review[2] ? Number(review[2]) : undefined;
    if (expectedSeq !== undefined && !Number.isSafeInteger(expectedSeq)) return null;
    return { action: 'review', id: review[1], decision: review[3] === '通过' ? 'approved' : 'changes_requested',
      ...(expectedSeq !== undefined ? { expectedSeq } : {}), ...(review[4] ? { summary: review[4].trim() } : {}) };
  }
  const rest = /^协作\s+(状态|完成|取消)\s+(T-[A-Z0-9-]{1,62})$/.exec(text);
  return rest ? { action: { 状态: 'status', 完成: 'complete', 取消: 'cancel' }[rest[1]], id: rest[2] } : null;
}
export async function dispatchPeerWecom(frame, { service, config, reply }) {
  if (config.commands_enabled === false) return false;
  const body = frame?.body;
  if (body?.chattype !== 'group' || body.msgtype !== 'text' || !config.chat_ids.includes(body.chatid) || !body.msgid) return false;
  const command = parsePeerCommand(body.text?.content); if (!command) return false;
  // Refresh policy before authorization so newly approved admins/owners are visible.
  if (service.store.registryRoot) await service.list();
  const sender = body.from?.userid;
  const owner = !!sender && sender === service.team.agents[service.agentId]?.wecom_userid;
  const admin = config.allow_admin_commands === true && !!sender && Object.values(service.team.agents).some((agent) => agent.role === 'admin' && agent.wecom_userid === sender);
  // Admins may dispatch/query via a member bot. Review mutations must be signed by
  // the human reviewer's own identity, never by impersonating another member.
  if (!owner && !(admin && ['create', 'status'].includes(command.action))) return false;
  const key = `wecom:${body.chatid}:${body.msgid}`;
  let text;
  try {
    let task;
    if (command.action === 'create') {
      task = await service.create({ ...command, workflow: command.workflow || (config.default_workflow ? config.default_workflow : undefined), id: `T-${digest(key).slice(0, 32).toUpperCase()}`, chatId: body.chatid, execution_mode: config.execution_mode === 'desktop_poll' ? 'desktop_poll' : 'automatic' }, key);
      text = task.spec.execution_mode === 'desktop_poll'
        ? `任务 ${task.spec.id} 已创建；按 ${task.spec.workflow.join(' → ')} 等待绑定的 Codex 桌面对话轮询认领。`
        : `任务 ${task.spec.id} 已创建；按 ${task.spec.workflow.join(' → ')} 自动认领。`;
    } else {
      task = await service.read(command.id);
      if (task.spec.source?.channel !== 'wecom' || task.spec.source.chat_id !== body.chatid) throw new Error('group mismatch');
      if (command.action === 'review') {
        if ((task.team || service.team).schema_version === 3 && command.expectedSeq === undefined) {
          await reply(frame, `请使用当前审核通知中的版本号：协作 审核 ${command.id} R-${task.state.seq} 通过；退回时追加 | 修改意见。`); return true;
        }
        if (command.expectedSeq !== undefined && command.expectedSeq !== task.state.seq) {
          await reply(frame, '审核版本已变化，请查看最新审核通知或查询任务状态，再使用新的 R-版本号。'); return true;
        }
        if ((task.team || service.team).schema_version === 3 && command.decision === 'changes_requested' && !command.summary) {
          await reply(frame, '退回需要填写修改意见：协作 审核 <任务ID> R-<版本号> 退回 | 修改意见'); return true;
        }
        if (task.state.assignee !== service.agentId || !['stage_review', 'review'].includes(task.state.status)) {
          await reply(frame, '当前任务未等待你审核；请由通知中指定的审核人 @ 自己绑定的机器人操作。'); return true;
        }
        task = await service.report(command.id, { type: 'reviewed', decision: command.decision, ...(command.summary ? { summary: command.summary } : {}) }, {}, key, command.expectedSeq);
      }
      if (command.action === 'complete') task = await service.report(command.id, { type: 'completed' }, {}, key);
      if (command.action === 'cancel') task = await service.report(command.id, { type: 'cancelled' }, {}, key);
      if (command.action === 'reopen') task = await service.report(command.id, { type: 'reopened', summary: command.summary }, {}, key);
      text = `任务 ${task.spec.id}：${task.state.status}；负责人 ${task.state.assignee || '待认领'}；步骤 ${task.state.stage + 1}/${task.spec.workflow.length}；轮次 ${task.state.epoch}；版本 R-${task.state.seq}。`;
    }
  } catch { text = '协作操作未成功：请核对任务所属群、本人权限和本机 Git 连接。'; }
  await reply(frame, text); return true;
}

// Task prose cannot supply mentions; only signed team identities may be notified.
const notificationText = (value) => String(value).replace(/<@/g, '＠').replace(/</g, '＜').replace(/>/g, '＞');
export function formatPeerNotification(task, type, agentId, team) {
  const base = `[Codex Collab · ${agentId}] ${task.spec.id} ${type}\n状态：${task.state.status}；负责人：${task.state.assignee || '待认领'}；轮次：${task.state.epoch}`;
  const event = task.events.at(-1), detail = [];
  const next = () => {
    const route = task.spec.workflow[task.state.stage];
    return `下一阶段：${route}；优先 ${team.routes[route][0]}，等待其 Codex ${task.spec.execution_mode === 'desktop_poll' ? '对话轮询' : '执行器'}认领。`;
  };
  if (type === 'created' && task.spec.execution_mode === 'desktop_poll') detail.push('等待指定 Codex 对话轮询认领；尚未开始执行。');
  if (type === 'claimed') detail.push(`开始 ${task.spec.workflow[task.state.stage]} 阶段。${task.state.review_feedback ? `\n修改意见：${notificationText(task.state.review_feedback)}` : ''}`);
  if (['handoff', 'stage_review_requested', 'review_requested'].includes(type)) {
    const stage = type === 'handoff' ? task.state.stage - 1 : task.state.stage;
    detail.push(`已提交阶段：${stage + 1}/${task.spec.workflow.length} · ${task.spec.workflow[stage]}`);
    if (event.summary) detail.push(`结果：${notificationText(event.summary)}`);
    if (event.refs) detail.push(`分支：${event.refs.branch}\n提交：${event.refs.commit}\n测试：${notificationText(event.refs.tests)}`);
    const members = reviewNotificationMembers(task, team);
    if (members.length) {
      // WeCom's Markdown extension is best-effort on the smart-bot transport.
      // Encrypted callback userids and actual native @ rendering need group verification.
      detail.push(`通知本人：${members.map((id) => {
        const userid = team.agents[id].wecom_userid;
        return /^[a-zA-Z0-9_-]{1,128}$/.test(userid) ? `${id} <@${userid}>` : id;
      }).join('、')}`);
    }
    if (type === 'handoff') detail.push(next());
    else {
      detail.push(`${type === 'stage_review_requested' ? '本阶段等待真人审核，通过后继续下一阶段。' : '全部阶段已提交，等待真人审核。'}\n审核人：${task.state.assignee}；版本：R-${task.state.seq}`);
      detail.push(`请审核人 @ 自己绑定的机器人发送：\n协作 审核 ${task.spec.id} R-${task.state.seq} 通过\n协作 审核 ${task.spec.id} R-${task.state.seq} 退回 | 修改意见`);
    }
  }
  if (type === 'reviewed') {
    if (event.decision === 'changes_requested') detail.push(`审核退回，${task.spec.workflow[task.state.stage]} 阶段重新执行。\n修改意见：${notificationText(task.state.review_feedback)}\n从提交 ${task.state.checkpoint.commit} 继续修改。`);
    else if (task.state.status === 'waiting') detail.push('真人审核已通过。', next());
    else detail.push(`最终审核已通过；请管理员 @ 自己的机器人发送：协作 完成 ${task.spec.id}。代码分支尚未合并 main。`);
  }
  if (type === 'run_failed') detail.push('本阶段未成功，按 Git 路由交给剩余候选或等待人工处理。');
  return [base, ...detail].join('\n');
}

export function startPeerWecom({ service, config, clientFactory = (options) => new AiBot.WSClient(options) }) {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const client = clientFactory({ botId: config.bot_id, secret: config.secret, logger });
  // PID-scoped status distinguishes a running adapter from an authenticated bot.
  // Serialize atomic writes so delayed events cannot overwrite a newer state.
  const healthPath = join(service.store.dataDir, 'wecom-health.json');
  let health = { pid: process.pid, status: 'connecting', updated_at: new Date().toISOString() };
  let pendingHealth = Promise.resolve();
  function setHealth(status) {
    health = { pid: process.pid, status, updated_at: new Date().toISOString() };
    const value = JSON.stringify(health) + '\n';
    pendingHealth = pendingHealth.then(async () => {
      const temp = `${healthPath}.${process.pid}.tmp`;
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, healthPath);
    }).catch(() => console.error('Peer WeCom health update failed'));
  }
  setHealth('connecting');
  client.on('connected', () => { setHealth('connecting'); console.error('Peer WeCom WebSocket connected; awaiting authentication'); });
  client.on('authenticated', () => { setHealth('authenticated'); console.error('Peer WeCom authenticated'); });
  client.on('reconnecting', (attempt) => { setHealth('reconnecting'); console.error(`Peer WeCom reconnecting (attempt ${Number.isInteger(attempt) ? attempt : 'unknown'})`); });
  // The SDK can include server frames, close reasons, IDs or credentials in error/reason
  // objects. Log only a safe category; never forward the raw object to the terminal.
  client.on('disconnected', () => { setHealth('disconnected'); console.error('Peer WeCom disconnected (reason redacted)'); });
  client.on('error', (error) => { if (['WS_RECONNECT_EXHAUSTED', 'WS_AUTH_FAILURE_EXHAUSTED'].includes(error?.code)) setHealth('failed'); console.error(`Peer WeCom ${wecomDiagnostic(error)}`); });
  client.on('message.text', (frame) => { void dispatchPeerWecom(frame, { service, config, reply: async (original, text) => assertReceipt(await client.replyStream(original, `collab-${randomUUID()}`, text, true)) }).catch(() => console.error('Peer WeCom reply failed')); });
  const send = async (task, type) => {
    const chatId = task.spec.source?.chat_id;
    if (!chatId || !config.chat_ids.includes(chatId) || type === 'progress' || type === 'checkpoint') return;
    const result = await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: formatPeerNotification(task, type, service.agentId, task.team || service.team) } });
    assertReceipt(result);
  };
  // MCP and Runner use independent processes. Relay committed events from either
  // process; never rely on receiving another bot's group messages for scheduling.
  const relay = new PeerNotificationRelay(service, send);
  service.notify = () => relay.poll();
  client.connect(); return { close: () => { setHealth('disconnected'); client.disconnect(); }, poll: () => relay.poll(), health: { snapshot: () => health, flush: () => pendingHealth } };
}

export function assertReceipt(frame) {
  if (frame?.errcode !== 0) throw new Error('WeCom receipt missing or rejected');
}

export class PeerNotificationRelay {
  constructor(service, send) {
    this.service = service; this.send = send;
    this.path = join(service.store.dataDir, 'wecom-notifications.json');
    this.cursors = null; this.pending = Promise.resolve();
  }
  poll() {
    const operation = this.pending.then(() => this.flush());
    this.pending = operation.catch(() => {});
    return operation;
  }
  async flush() {
    if (!this.cursors) {
      try { this.cursors = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; this.cursors = {}; }
    }
    const tasks = await this.service.list();
    for (const task of tasks) {
      const start = this.cursors[task.spec.id] || 0;
      for (const event of task.events.slice(start)) {
        if (event.actor_id === this.service.agentId && !['renewed', 'progress', 'checkpoint'].includes(event.type)) {
          const events = task.events.slice(0, event.seq);
          await this.send({ ...task, events, state: reducePeerTask(task.spec, events, task.team || this.service.team) }, event.type);
        }
        this.cursors[task.spec.id] = event.seq;
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify(this.cursors) + '\n', { mode: 0o600 });
        await rename(temp, this.path);
      }
    }
  }
}
