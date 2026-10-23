import { isBranchName, isCommit, teamBaseBranch } from './repository.mjs';
import { stageReviewRule, stageReviewer } from './review.mjs';
import { digest, verifyEvent } from './config.mjs';
export const taskIdPattern = /^T-[A-Z0-9-]{1,62}$/;
export class Conflict extends Error { constructor(message) { super(message); this.status = 409; } }
export class Denied extends Error { constructor(message) { super(message); this.status = 403; } }
export function validateSpec(spec, team) {
  if (![2, 3].includes(spec?.schema_version) || !taskIdPattern.test(spec.id ?? '') || spec.repo !== team.repo || typeof spec.title !== 'string' || !spec.title.trim() || spec.title.length > 200 || !isBranchName(spec.base_branch) || !Array.isArray(spec.acceptance) || !spec.acceptance.length || spec.acceptance.some((v) => typeof v !== 'string' || !v.trim() || v.length > 1000)) throw new Error('invalid peer task specification');
  if (spec.schema_version === 2 ? spec.base_branch !== 'main' || team.base_branch !== undefined : spec.base_branch !== teamBaseBranch(team) || !isCommit(spec.base_commit)) throw new Error('task must use the pinned team base branch and starting commit');
  const allowed = new Set(['schema_version', 'id', 'repo', 'title', 'description', 'base_branch', 'acceptance', 'workflow', 'execution_mode', 'source', ...(spec.schema_version === 3 ? ['base_commit'] : [])]);
  if (Object.keys(spec).some((key) => !allowed.has(key))) throw new Error('peer task specification contains unsupported fields');
  if (spec.acceptance.length > 32 || spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > 4000)) throw new Error('invalid task description/acceptance');
  if (spec.execution_mode !== undefined && !['automatic', 'desktop', 'desktop_poll'].includes(spec.execution_mode)) throw new Error('invalid task execution mode');
  if (!Array.isArray(spec.workflow) || !spec.workflow.length || spec.workflow.length > 16 || spec.workflow.some((role) => !team.routes[role])) throw new Error('invalid task workflow/route');
  if (spec.source !== undefined && (!spec.source || typeof spec.source !== 'object' || spec.source.channel !== 'wecom' || typeof spec.source.chat_id !== 'string' || !spec.source.chat_id || Object.keys(spec.source).some((key) => !['channel', 'chat_id'].includes(key)))) throw new Error('invalid task group provenance');
}
export function validRefs(refs) {
  if (!refs || typeof refs !== 'object' || Object.keys(refs).some((key) => !['branch', 'commit', 'tests'].includes(key))) throw new Error('unsupported code evidence fields');
  if (!/^codex\/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$/.test(refs?.branch ?? '') || refs.branch.includes('..') || refs.branch.endsWith('.lock') || refs.branch.endsWith('/') || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(refs.commit ?? '') || typeof refs.tests !== 'string' || !refs.tests.trim() || refs.tests.length > 1000) throw new Error('code evidence requires safe codex/* branch, full SHA and test evidence');
}
export function eligible(task, id, tasks, team, now) {
  const { state, spec } = task;
  if (!['open', 'waiting', 'running'].includes(state.status) || state.attempts >= team.policy.max_attempts) return false;
  const takeover = state.status === 'running';
  if (takeover && now < Date.parse(state.lease.expires_at) + team.policy.clock_skew_ms) return false;
  const failed = new Set(state.failed_agents);
  if (takeover) failed.add(state.assignee);
  const candidates = team.routes[spec.workflow[state.stage]].filter((agent) => !failed.has(agent));
  const rank = candidates.indexOf(id);
  if (rank < 0) return false;
  const anchor = takeover ? Date.parse(state.lease.expires_at) + team.policy.clock_skew_ms : Date.parse(state.available_at);
  if (now < anchor + rank * team.policy.claim_timeout_ms) return false;
  const active = tasks.filter((t) => t.spec.id !== spec.id && t.state.assignee === id && (t.state.status === 'desktop' || t.state.status === 'running' && now < Date.parse(t.state.lease.expires_at) + team.policy.clock_skew_ms)).length;
  return active < team.agents[id].max_concurrent_tasks;
}
export function canClaimDesktop(task, id, tasks, team, now) {
  return task.spec.execution_mode === 'desktop' && task.state.status === 'waiting' && eligible(task, id, tasks, team, now);
}
export function reducePeerTask(spec, events, team) {
  validateSpec(spec, team);
  let state = { id: spec.id, status: 'uncreated', review: null, review_feedback: null, seq: 0, creator_id: null, assignee: null, stage: 0, epoch: 0, attempts: 0, lease: null, failed_agents: [], available_at: null, checkpoint: null };
  const keys = new Set(); const ids = new Set(); let previousTime = -Infinity;
  for (const event of events) {
    verifyEvent(team, event);
    const allowedFields = new Set(['schema_version', 'task_id', 'seq', 'event_id', 'actor_id', 'occurred_at', 'idempotency_key', 'team_hash', 'signature', 'type', 'spec_hash', 'epoch', 'lease_id', 'expires_at', 'summary', 'refs', 'next_stage', 'decision']);
    if (Object.keys(event).some((key) => !allowedFields.has(key))) throw new Error('unsupported peer event fields');
    const time = Date.parse(event.occurred_at);
    if (event.schema_version !== 2 || event.task_id !== spec.id || event.seq !== state.seq + 1 || !Number.isFinite(time) || !event.occurred_at.endsWith('Z') || time < previousTime || !event.event_id || !event.idempotency_key || keys.has(event.idempotency_key) || ids.has(event.event_id)) throw new Error('invalid peer event sequence, timestamp or idempotency key');
    const admin = team.agents[event.actor_id].role === 'admin';
    const ownsLease = () => {
      if (state.status !== 'running' || event.actor_id !== state.assignee || event.lease_id !== state.lease.id || event.epoch !== state.epoch || time >= Date.parse(state.lease.expires_at)) throw new Conflict('expired or superseded execution lease');
    };
    if (event.summary !== undefined && (typeof event.summary !== 'string' || event.summary.length > 4000)) throw new Error('invalid event summary');
    switch (event.type) {
      case 'created':
        if (state.status !== 'uncreated' || event.spec_hash !== digest(spec)) throw new Error('invalid creation/spec signature');
        state = { ...state, status: spec.execution_mode === 'desktop' ? 'desktop' : 'open', creator_id: event.actor_id, assignee: spec.execution_mode === 'desktop' ? event.actor_id : null, available_at: event.occurred_at }; break;
      case 'desktop_claimed':
        if (!canClaimDesktop({ spec, state }, event.actor_id, [], team, time)) throw new Conflict('desktop handoff is not eligible for this agent');
        state = { ...state, status: 'desktop', assignee: event.actor_id, lease: null }; break;
      case 'claimed': {
        if (!eligible({ spec, state }, event.actor_id, [], team, time)) throw new Conflict('agent is not eligible to claim this task');
        if (event.epoch !== state.epoch + 1 || typeof event.lease_id !== 'string' || !event.lease_id || Date.parse(event.expires_at) !== time + team.policy.lease_ms) throw new Error('invalid new lease');
        const failed = state.status === 'running' ? [...new Set([...state.failed_agents, state.assignee])] : state.failed_agents;
        state = { ...state, status: 'running', assignee: event.actor_id, epoch: event.epoch, attempts: state.attempts + 1, failed_agents: failed, lease: { id: event.lease_id, expires_at: event.expires_at } }; break;
      }
      case 'renewed':
        ownsLease();
        if (Date.parse(event.expires_at) !== time + team.policy.lease_ms || Date.parse(event.expires_at) < Date.parse(state.lease.expires_at)) throw new Error('invalid lease renewal');
        state = { ...state, lease: { ...state.lease, expires_at: event.expires_at } }; break;
      case 'progress': ownsLease(); break;
      case 'checkpoint':
        if (!(state.status === 'desktop' && event.actor_id === state.assignee)) ownsLease();
        validRefs(event.refs); state = { ...state, checkpoint: event.refs }; break;
      case 'handoff':
        const desktopHandoff = state.status === 'desktop' && event.actor_id === state.assignee;
        if (!desktopHandoff) ownsLease();
        if (stageReviewRule(team, spec.workflow[state.stage]).required) throw new Denied('human stage review required before handoff');
        validRefs(event.refs);
        if (!event.summary?.trim() || event.next_stage !== state.stage + 1 || !spec.workflow[event.next_stage]) throw new Error('handoff requires summary and the next configured workflow stage');
        state = { ...state, status: 'waiting', stage: event.next_stage, checkpoint: event.refs, assignee: null, lease: null, attempts: 0, failed_agents: [], available_at: event.occurred_at }; break;
      case 'stage_review_requested':
      case 'review_requested': {
        const desktopReview = state.status === 'desktop' && event.actor_id === state.assignee;
        if (!desktopReview) ownsLease();
        validRefs(event.refs);
        const intermediate = event.type === 'stage_review_requested';
        if (intermediate ? team.schema_version !== 3 || !stageReviewRule(team, spec.workflow[state.stage]).required || event.next_stage !== state.stage + 1 || !spec.workflow[event.next_stage] || !event.summary?.trim() : state.stage !== spec.workflow.length - 1) throw new Error('review must match the current configured workflow stage');
        const reviewer = stageReviewer(team, spec.workflow[state.stage], event.actor_id);
        state = { ...state, status: intermediate ? 'stage_review' : 'review', assignee: reviewer, checkpoint: event.refs, lease: null,
          review: { reviewer_id: reviewer, executor_id: event.actor_id, next_stage: intermediate ? event.next_stage : null }, review_feedback: null }; break;
      }
      case 'run_failed':
        ownsLease();
        {
          const failed = [...new Set([...state.failed_agents, state.assignee])];
          const remaining = team.routes[spec.workflow[state.stage]].some((agent) => !failed.includes(agent));
          state = { ...state, status: state.attempts >= team.policy.max_attempts || !remaining ? 'blocked' : 'open', failed_agents: failed, assignee: null, lease: null, available_at: event.occurred_at };
        }
        break;
      case 'blocked': ownsLease(); state = { ...state, status: 'blocked', lease: null }; break;
      case 'reopened':
        if (!admin || state.status !== 'blocked' || !event.summary?.trim()) throw new Denied('admin with a reason required to reopen blocked task');
        state = { ...state, status: 'open', assignee: null, lease: null, attempts: 0, failed_agents: [], available_at: event.occurred_at }; break;
      case 'reviewed': {
        if (!['stage_review', 'review'].includes(state.status) || event.actor_id !== state.assignee || !['approved', 'changes_requested'].includes(event.decision)) throw new Denied('only the pinned human reviewer may decide');
        if (team.schema_version === 3 && event.decision === 'changes_requested' && !event.summary?.trim()) throw new Error('review rejection requires feedback');
        if (event.decision === 'changes_requested') {
          state = { ...state, status: 'open', attempts: 0, failed_agents: [], available_at: event.occurred_at, assignee: null, lease: null,
            review: null, review_feedback: event.summary || 'Reviewer requested changes; inspect the submitted code and task acceptance.' };
        } else if (state.status === 'stage_review') {
          state = { ...state, status: 'waiting', stage: state.review.next_stage, assignee: null, lease: null, attempts: 0, failed_agents: [], available_at: event.occurred_at, review: null, review_feedback: null };
        } else state = { ...state, status: 'approved', review: null, review_feedback: null };
        break;
      }
      case 'completed':
        if (!admin || state.status !== 'approved' || digest(event.refs) !== digest(state.checkpoint)) throw new Denied('completion requires admin and approved code evidence');
        state = { ...state, status: 'completed' }; break;
      case 'cancelled':
        if (!admin || ['completed', 'cancelled', 'uncreated'].includes(state.status)) throw new Denied('admin required to cancel active task');
        state = { ...state, status: 'cancelled', lease: null }; break;
      default: throw new Error('unsupported peer event');
    }
    state = { ...state, seq: event.seq };
    keys.add(event.idempotency_key); ids.add(event.event_id);
    previousTime = time;
  }
  return Object.freeze(state);
}
export function leaseToken(task) { return { lease_id: task.state.lease?.id, epoch: task.state.epoch }; }
