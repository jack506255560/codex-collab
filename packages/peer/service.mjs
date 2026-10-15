import { stageReviewRule } from './review.mjs';
import { reviewContext, assertReviewIntent } from './natural-review.mjs';
import { randomUUID } from 'node:crypto';
import { digest } from './config.mjs';
import { canClaimDesktop, Conflict, Denied, eligible, leaseToken, validRefs } from './protocol.mjs';
import { git } from './store.mjs';
import { inboxIdPattern, inboxMessageKey, inboxTaskId } from './inbox.mjs';
const validText = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max;
const validList = (value, maxItems, maxText) => Array.isArray(value) && value.length > 0 && value.length <= maxItems && value.every((item) => validText(item, maxText));
const plainFields = (value, allowed) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
export class PeerService {
  constructor(store, { notify = async () => {} } = {}) { this.store = store; this.agentId = store.agentId; this.notify = notify; }
  get team() { return this.store.team; }
  list() { return this.store.list(); }
  read(id) { return this.store.read(id); }
  async publish(task, type) { if (task) { try { await this.notify(task, type); } catch { console.error('peer notification failed; Git task event is committed'); } } return task; }
  listRequests() { return this.store.listInbox(); }
  async pendingRequests({ chatIds } = {}) {
    return (await this.listRequests()).filter((request) => request.spec.target_agent === this.agentId && request.state.status === 'pending' && (!chatIds || chatIds.includes(request.spec.chat_id)))
      .sort((a, b) => a.events[0].occurred_at.localeCompare(b.events[0].occurred_at)).slice(0, 8);
  }
  async receiveRequest(input) {
    const { chatId, messageId, senderId, content, allowAdmin = false } = input || {};
    if (!plainFields(input, ['chatId', 'messageId', 'senderId', 'content', 'allowAdmin']) || !validText(chatId, 200) || !validText(messageId, 200) || !validText(senderId, 200) || !validText(content, 4000) || typeof allowAdmin !== 'boolean') throw new Conflict('invalid group request');
    const key = inboxMessageKey(this.agentId, chatId, messageId);
    return this.store.transactInbox(key, async (requests) => {
      const owner = this.team.agents[this.agentId]?.wecom_userid === senderId;
      const senderAgents = Object.values(this.team.agents).filter((agent) => agent.wecom_userid === senderId);
      const member = senderAgents.some((agent) => agent.role === 'member');
      const admin = allowAdmin && senderAgents.some((agent) => agent.role === 'admin');
      if (!senderId || !owner && !member && !admin) throw new Denied('sender is not authorized for this bot');
      const referencedId = content.match(/\bN-[A-F0-9]{32}\b/)?.[0];
      const mine = requests.filter((request) => request.spec.target_agent === this.agentId && request.spec.chat_id === chatId && request.spec.sender_id === senderId);
      const waiting = mine.filter((request) => request.state.status === 'clarification');
      const parent = referencedId ? mine.find((request) => request.spec.id === referencedId) : waiting.length === 1 ? waiting[0] : null;
      if (referencedId && (!parent || parent.state.status !== 'clarification')) throw new Conflict('that request is not awaiting a reply from this sender in this group');
      if (!referencedId && waiting.length > 1) throw Object.assign(new Conflict('multiple requests await clarification; include the N-request ID in your reply'), { code: 'AMBIGUOUS_INBOX_REPLY' });
      if (parent) return { id: parent.spec.id, event: { type: 'replied', content, message_key: key } };
      const id = `N-${digest([this.agentId, key]).slice(0, 32).toUpperCase()}`;
      const context = reviewContext(await this.store.listLocal(), this.agentId, senderId, chatId, this.team);
      return { id, spec: { schema_version: 1, id, repo: this.team.repo, target_agent: this.agentId, chat_id: chatId,
        sender_id: senderId, content, message_key: key, admin_dispatch: !!admin, ...(context.length ? { review_context: context } : {}) }, event: { type: 'received' } };
    }, { replay: (request) => {
      const event = request.events.find((item) => item.idempotency_key === key);
      const original = event.type === 'received' ? request.spec.content : event.content;
      if (request.spec.chat_id !== chatId || request.spec.sender_id !== senderId || original !== content) throw new Conflict('group message ID already used with different content or sender');
      const owner = this.team.agents[this.agentId]?.wecom_userid === senderId;
      const senderAgents = Object.values(this.team.agents).filter((agent) => agent.wecom_userid === senderId);
      const member = senderAgents.some((agent) => agent.role === 'member');
      const admin = allowAdmin && senderAgents.some((agent) => agent.role === 'admin');
      if (!owner && !member && !admin) throw new Denied('sender is not authorized for this bot');
    } });
  }
  async resolveRequest(id, expectedSeq, resolution, { defaultWorkflow } = {}) {
    const { action, response, task: input, review } = resolution || {};
    if (action === 'review' && response !== undefined) throw new Conflict('review confirmation is generated from the committed decision');
    if (!plainFields(resolution, ['action', 'response', 'task', 'review']) || response !== undefined && !validText(response, 2000)) throw new Conflict('invalid request resolution');
    if (!inboxIdPattern.test(id || '') || !Number.isSafeInteger(expectedSeq) || expectedSeq < 1) throw new Conflict('provide request ID and latest expected_seq');
    if (!['create_task', 'clarify', 'answer', 'review'].includes(action)) throw new Conflict('unsupported request resolution');
    if (action !== 'review' && review !== undefined) throw new Conflict('review payload requires review action');
    if (action === 'review' && (input !== undefined || !review)) throw new Conflict('review requires a human interpretation without a new task');
    if (action === 'create_task') {
      if (!plainFields(input, ['title', 'description', 'acceptance', 'workflow']) || !validText(input.title, 200) || input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 4000) || !validList(input.acceptance, 32, 1000) || input.workflow !== undefined && !validList(input.workflow, 16, 64)) throw new Conflict('invalid structured task');
    } else if (action !== 'review' && (input !== undefined || !validText(response, 2000))) throw new Conflict('answer and clarification require a response without a task');
    const key = `inbox-resolve:${id}:${expectedSeq}`;
    const result = await this.store.transactInbox(key, async (requests) => {
      const request = requests.find((item) => item.spec.id === id);
      if (!request || request.spec.target_agent !== this.agentId) throw new Denied('only the receiving bot identity may interpret this request');
      if (request.state.status !== 'pending' || request.state.seq !== expectedSeq) throw new Conflict('request changed or is no longer pending');
      if (action === 'review') {
        assertReviewIntent(request, review, this.agentId, this.team);
        const task = await this.store.readLocal(review.task_id);
        const frozen = request.spec.review_context.find((item) => item.task_id === review.task_id);
        if (task.state.seq !== review.expected_seq || task.state.checkpoint?.commit !== frozen.commit
          || !['stage_review', 'review'].includes(task.state.status) || task.state.assignee !== this.agentId
          || task.spec.source?.channel !== 'wecom' || task.spec.source.chat_id !== request.spec.chat_id) throw new Conflict('review changed; ask the human to review the latest result in a new message');
        if ((task.team || this.team).agents[this.agentId]?.wecom_userid !== request.spec.sender_id) throw new Denied('sender is not the pinned human reviewer');
        return { id, taskReview: review, event: { type: 'reviewed', task_id: review.task_id, review_seq: review.expected_seq + 1,
          decision: review.decision, ...(review.summary ? { summary: review.summary } : {}),
          response: `任务「${task.spec.title}」${review.decision === 'approved' ? '审核通过。' : `已退回修改：${review.summary}`}（${review.task_id}）` } };
      }
      if (action !== 'create_task') return { id, event: { type: action === 'clarify' ? 'clarified' : 'answered', response } };
      if (!input) throw new Conflict('a structured task is required');
      const taskSpec = { schema_version: 2, id: inboxTaskId(id), repo: this.team.repo, title: input.title,
        description: input.description ?? '', base_branch: 'main', acceptance: input.acceptance,
        workflow: input.workflow || defaultWorkflow || [this.team.default_route], execution_mode: 'desktop_poll', source: { channel: 'wecom', chat_id: request.spec.chat_id } };
      return { id, taskSpec, event: { type: 'task_created', task_id: taskSpec.id, task_hash: digest(taskSpec), response: response || `已创建任务 ${taskSpec.id}：${taskSpec.title}。分工：${taskSpec.workflow.join(' → ')}；等待绑定对话认领。` } };
    }, { replay: async (request) => {
      const event = request.events.find((item) => item.idempotency_key === key);
      const expectedType = { create_task: 'task_created', clarify: 'clarified', answer: 'answered', review: 'reviewed' }[action];
      if (event.type !== expectedType || response !== undefined && event.response !== response) throw new Conflict('request already resolved with different content');
      if (action === 'review') {
        assertReviewIntent(request, review, this.agentId, this.team);
        if (event.task_id !== review.task_id || event.review_seq !== review.expected_seq + 1 || event.decision !== review.decision || event.summary !== review.summary) throw new Conflict('request already resolved with a different review');
      }
      if (action === 'create_task') {
        const accepted = await this.store.readLocal(event.task_id);
        const taskSpec = { schema_version: 2, id: inboxTaskId(id), repo: this.team.repo, title: input.title, description: input.description ?? '', base_branch: 'main', acceptance: input.acceptance, workflow: input.workflow || accepted.spec.workflow, execution_mode: 'desktop_poll', source: { channel: 'wecom', chat_id: request.spec.chat_id } };
        if (digest(taskSpec) !== event.task_hash) throw new Conflict('request already resolved with a different task');
      }
    } });
    if (result.state.task_id) await this.publish(await this.read(result.state.task_id), 'created');
    else await this.publish(result, 'inbox_response');
    const taskId = result.state.task_id || result.state.review_task_id;
    return { request: result, ...(taskId ? { task: await this.read(taskId) } : {}) };
  }
  async create(input, idempotencyKey = randomUUID()) {
    const id = input.id || `T-${digest(`${this.agentId}:${idempotencyKey}`).slice(0, 32).toUpperCase()}`;
    const result = await this.store.transact(id, idempotencyKey, (current) => {
      if (current) throw new Conflict('task already exists');
      const spec = { schema_version: 2, id, repo: this.team.repo, title: input.title, description: input.description ?? '', base_branch: 'main', acceptance: input.acceptance,
      workflow: input.workflow || [this.team.default_route], execution_mode: input.execution_mode || 'automatic', ...(input.chatId ? { source: { channel: 'wecom', chat_id: input.chatId } } : {}) };
      return { spec, event: { type: 'created' } };
    });
    return this.publish(result, 'created');
  }
  async nextJob({ executionMode = 'runner' } = {}) {
    const tasks = await this.list(); const now = this.store.clock();
    return tasks.find((task) => (executionMode === 'runner' ? task.spec.execution_mode !== 'desktop_poll' : task.spec.execution_mode === executionMode) && eligible(task, this.agentId, tasks, task.team || this.team, now)) || null;
  }
  async claim(id, idempotencyKey = randomUUID(), { executionMode = 'runner' } = {}) {
    const result = await this.store.transact(id, idempotencyKey, (current, tasks, now) => {
      if (!current || (executionMode === 'runner' ? current.spec.execution_mode === 'desktop_poll' : current.spec.execution_mode !== executionMode) || !eligible(current, this.agentId, tasks, current.team || this.team, now)) throw new Conflict('task not eligible or capacity exhausted');
      return { event: { type: 'claimed', epoch: current.state.epoch + 1, lease_id: randomUUID(), expires_at: new Date(now + (current.team || this.team).policy.lease_ms).toISOString() } };
    });
    return this.publish(result, result.state.epoch > 1 ? 'taken_over' : 'claimed');
  }
  async claimDesktop(id, expectedSeq, idempotencyKey = randomUUID()) {
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq < 1) throw new Conflict('latest expected_seq required');
    const result = await this.store.transact(id, idempotencyKey, (task, tasks, now) => {
      if (!task || task.state.seq !== expectedSeq) throw new Conflict('stale task revision');
      if (!canClaimDesktop(task, this.agentId, tasks, task.team || this.team, now)) throw new Conflict('desktop handoff not eligible or capacity exhausted');
      return { event: { type: 'desktop_claimed' } };
    });
    return this.publish(result, 'desktop_claimed');
  }
  checkLease(task, token, now) {
    if (!task || task.state.status !== 'running' || task.state.assignee !== this.agentId || task.state.lease?.id !== token.lease_id || task.state.epoch !== token.epoch || now >= Date.parse(task.state.lease.expires_at)) throw new Conflict('expired or superseded execution lease');
  }
  async assertLease(id, token) { const task = await this.read(id); this.checkLease(task, token, this.store.clock()); return task; }
  renew(id, token) {
    return this.store.transact(id, randomUUID(), (task, _tasks, now) => {
      this.checkLease(task, token, now);
      return { event: { type: 'renewed', ...token, expires_at: new Date(now + (task.team || this.team).policy.lease_ms).toISOString() } };
    });
  }
  async verifyRefs(refs) {
    validRefs(refs);
    await git(this.store.repo, 'check-ref-format', `refs/heads/${refs.branch}`);
    // Verify in the private ledger clone, away from the user's FETCH_HEAD/worktree.
    await git(this.store.checkout, 'fetch', '--no-tags', 'origin', `refs/heads/${refs.branch}`);
    const tip = await git(this.store.checkout, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    if (tip !== refs.commit.toLowerCase()) throw new Conflict('code commit must be the shared branch tip');
  }
  async report(id, payload, token = {}, idempotencyKey = randomUUID(), expectedSeq) {
    const allowed = ['progress', 'checkpoint', 'handoff', 'stage_review_requested', 'review_requested', 'run_failed', 'blocked', 'reviewed', 'completed', 'cancelled', 'reopened'];
    if (!allowed.includes(payload.type)) throw new Error('unsupported peer report');
    const result = await this.store.transact(id, idempotencyKey, async (task, _tasks, now) => {
      if (!task) throw new Error('unknown task');
      if (expectedSeq !== undefined && (!Number.isSafeInteger(expectedSeq) || expectedSeq !== task.state.seq)) throw new Conflict('stale task revision');
      const desktop = ['handoff', 'checkpoint', 'stage_review_requested', 'review_requested'].includes(payload.type) && task.state.status === 'desktop' && task.state.assignee === this.agentId;
      const human = ['reviewed', 'completed', 'cancelled', 'reopened'].includes(payload.type);
      if (!human && !desktop) this.checkLease(task, token, now);
      if (payload.type === 'reviewed' && this.agentId !== task.state.assignee) throw new Denied('only the pinned human reviewer may decide; human administrator approval required for legacy tasks');
      if (payload.type === 'reviewed' && (task.team || this.team).review_rules && expectedSeq === undefined) throw new Conflict('review requires the R-sequence from the current notification');
      if (['completed', 'cancelled', 'reopened'].includes(payload.type) && (task.team || this.team).agents[this.agentId]?.role !== 'admin') throw new Denied('human administrator approval required');
      if (['checkpoint', 'handoff', 'stage_review_requested', 'review_requested'].includes(payload.type)) {
        await this.verifyRefs(payload.refs);
        if (task.state.checkpoint) {
          try { await git(this.store.checkout, 'merge-base', '--is-ancestor', task.state.checkpoint.commit, payload.refs.commit); }
          catch { throw new Conflict('code must descend from the pinned handoff commit'); }
        }
      }
      const type = payload.type === 'handoff' && stageReviewRule(task.team || this.team, task.spec.workflow[task.state.stage]).required ? 'stage_review_requested' : payload.type;
      const event = { type, ...(!desktop && !human ? token : {}) };
      for (const field of ['summary', 'decision', 'refs']) if (payload[field] !== undefined) event[field] = payload[field];
      if (['handoff', 'stage_review_requested'].includes(type)) event.next_stage = task.state.stage + 1;
      if (payload.type === 'completed') event.refs = task.state.checkpoint;
      return { event };
    });
    return this.publish(result, result.events.at(-1).type);
  }
  async handoff(id, payload, expectedSeq, key) { const task = await this.read(id); if (task.spec.execution_mode === 'desktop_poll') throw new Denied('use the bound desktop finish tool'); return this.report(id, { type: 'handoff', ...payload }, leaseToken(task), key, expectedSeq); }
  async requestReview(id, payload, expectedSeq, key) { const task = await this.read(id); if (task.spec.execution_mode === 'desktop_poll') throw new Denied('use the bound desktop finish tool'); return this.report(id, { type: 'review_requested', ...payload }, leaseToken(task), key, expectedSeq); }
}
