import { digest, verifyEvent } from './config.mjs';
import { Denied } from './protocol.mjs';
import { validReviewContext, assertReviewIntent } from './natural-review.mjs';

export const inboxIdPattern = /^N-[A-F0-9]{32}$/;
export const inboxTaskId = (id) => `T-${id.slice(2)}`;
export const inboxMessageKey = (agentId, chatId, messageId) => `inbox-message:${agentId}:${digest([chatId, messageId])}`;
const text = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
export function validateInboxSpec(spec, team) {
  if (!fields(spec, ['schema_version', 'id', 'repo', 'target_agent', 'chat_id', 'sender_id', 'content', 'message_key', 'admin_dispatch', 'review_context']) || spec.schema_version !== 1 || !inboxIdPattern.test(spec.id || '') || spec.repo !== team.repo || !text(spec.target_agent, 64) || !/^[a-zA-Z0-9_-]+$/.test(spec.target_agent) || !Object.hasOwn(team.agents, spec.target_agent) || !text(spec.chat_id, 200) || !text(spec.sender_id, 200) || !text(spec.content, 4000) || !text(spec.message_key, 300) || typeof spec.admin_dispatch !== 'boolean' || spec.id !== `N-${digest([spec.target_agent, spec.message_key]).slice(0, 32).toUpperCase()}`) throw new Error('invalid natural-language inbox specification');
  if (spec.review_context !== undefined && (!validReviewContext(spec.review_context) || team.agents[spec.target_agent].wecom_userid !== spec.sender_id)) throw new Denied('invalid human review context');
  const owner = team.agents[spec.target_agent].wecom_userid === spec.sender_id;
  const senders = Object.values(team.agents).filter((agent) => agent.wecom_userid === spec.sender_id);
  const member = senders.some((agent) => agent.role === 'member');
  const admin = spec.admin_dispatch && senders.some((agent) => agent.role === 'admin');
  if (!owner && !member && !admin) throw new Denied('only the bot owner or an enrolled team member may submit requests');
}

/** Append-only requests: only the receiving agent signs interpretation/replies. */
export function reduceInbox(spec, events, team) {
  validateInboxSpec(spec, team);
  let state = { status: 'unreceived', seq: 0, task_id: null };
  const keys = new Set(); const ids = new Set(); let previousTime = -Infinity;
  for (const event of events) {
    verifyEvent(team, event);
    if (!fields(event, ['schema_version', 'request_id', 'seq', 'event_id', 'actor_id', 'occurred_at', 'idempotency_key', 'team_hash', 'signature', 'type', 'spec_hash', 'content', 'message_key', 'response', 'task_id', 'task_hash', 'review_seq', 'decision', 'summary', 'task_event_hash'])) throw new Error('unsupported inbox event fields');
    const time = Date.parse(event.occurred_at);
    if (event.schema_version !== 1 || event.request_id !== spec.id || event.actor_id !== spec.target_agent || event.seq !== state.seq + 1 || !Number.isFinite(time) || !event.occurred_at.endsWith('Z') || time < previousTime || !/^[a-f0-9-]{36}$/.test(event.event_id || '') || !text(event.idempotency_key, 300) || keys.has(event.idempotency_key) || ids.has(event.event_id)) throw new Error('invalid inbox sequence, actor or duplicate event');
    const allowed = { received: ['spec_hash'], clarified: ['response'], replied: ['content', 'message_key'], task_created: ['task_id', 'task_hash', 'response'], answered: ['response'], reviewed: ['task_id', 'review_seq', 'decision', 'summary', 'task_event_hash', 'response'] }[event.type];
    if (!allowed || ['spec_hash', 'content', 'message_key', 'response', 'task_id', 'task_hash', 'review_seq', 'decision', 'summary', 'task_event_hash'].some((key) => event[key] !== undefined && !allowed.includes(key))) throw new Error('invalid inbox event payload');
    switch (event.type) {
      case 'received':
        if (state.seq || event.spec_hash !== digest(spec) || event.idempotency_key !== spec.message_key) throw new Error('invalid inbox reception');
        state.status = 'pending'; break;
      case 'clarified':
      case 'answered':
        if (state.status !== 'pending' || !text(event.response, 2000)) throw new Error('only a pending request may be answered or clarified');
        state.status = event.type === 'clarified' ? 'clarification' : 'answered'; break;
      case 'replied':
        if (state.status !== 'clarification' || !text(event.content, 4000) || !text(event.message_key, 300) || event.idempotency_key !== event.message_key) throw new Error('invalid clarification reply');
        state.status = 'pending'; break;
      case 'reviewed': {
        if (state.status !== 'pending' || !Number.isSafeInteger(event.review_seq) || event.review_seq < 2 || !text(event.response, 2000) || !/^[a-f0-9]{64}$/.test(event.task_event_hash || '')) throw new Error('invalid inbox human review');
        assertReviewIntent({ spec, events: events.slice(0, event.seq - 1) }, { task_id: event.task_id, expected_seq: event.review_seq - 1, decision: event.decision, ...(event.summary !== undefined ? { summary: event.summary } : {}) }, spec.target_agent, team);
        state.status = 'reviewed'; state.review_task_id = event.task_id; break;
      }
      case 'task_created':
        if (state.status !== 'pending' || event.task_id !== inboxTaskId(spec.id) || !/^[a-f0-9]{64}$/.test(event.task_hash || '') || !text(event.response, 2000)) throw new Error('invalid inbox task resolution');
        state.status = 'task_created'; state.task_id = event.task_id; break;
      default: throw new Error('unsupported inbox event');
    }
    state.seq = event.seq; keys.add(event.idempotency_key); ids.add(event.event_id); previousTime = time;
  }
  if (!state.seq) throw new Error('inbox has no signed reception');
  return Object.freeze(state);
}
