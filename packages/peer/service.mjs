import { randomUUID } from 'node:crypto';
import { digest } from './config.mjs';
import { canClaimDesktop, Conflict, Denied, eligible, leaseToken, validRefs } from './protocol.mjs';
import { git } from './store.mjs';
export class PeerService {
  constructor(store, { notify = async () => {} } = {}) { this.store = store; this.agentId = store.agentId; this.notify = notify; }
  get team() { return this.store.team; }
  list() { return this.store.list(); }
  read(id) { return this.store.read(id); }
  async publish(task, type) { if (task) { try { await this.notify(task, type); } catch { console.error('peer notification failed; Git task event is committed'); } } return task; }
  async create(input, idempotencyKey = randomUUID()) {
    const id = input.id || `T-${digest(`${this.agentId}:${idempotencyKey}`).slice(0, 32).toUpperCase()}`;
    const result = await this.store.transact(id, idempotencyKey, (current) => {
      if (current) throw new Conflict('task already exists');
      const spec = { schema_version: 2, id, repo: this.team.repo, title: input.title, description: input.description || '', base_branch: 'main', acceptance: input.acceptance,
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
    const allowed = ['progress', 'checkpoint', 'handoff', 'review_requested', 'run_failed', 'blocked', 'reviewed', 'completed', 'cancelled', 'reopened'];
    if (!allowed.includes(payload.type)) throw new Error('unsupported peer report');
    const result = await this.store.transact(id, idempotencyKey, async (task, _tasks, now) => {
      if (!task) throw new Error('unknown task');
      if (expectedSeq !== undefined && expectedSeq !== task.state.seq) throw new Conflict('stale task revision');
      const desktop = ['handoff', 'checkpoint', 'review_requested'].includes(payload.type) && task.state.status === 'desktop' && task.state.assignee === this.agentId;
      const human = ['reviewed', 'completed', 'cancelled', 'reopened'].includes(payload.type);
      if (!human && !desktop) this.checkLease(task, token, now);
      if (['reviewed', 'completed', 'cancelled', 'reopened'].includes(payload.type) && (task.team || this.team).agents[this.agentId]?.role !== 'admin') throw new Denied('human administrator approval required');
      if (['checkpoint', 'handoff', 'review_requested'].includes(payload.type)) {
        await this.verifyRefs(payload.refs);
        if (task.state.checkpoint) {
          try { await git(this.store.checkout, 'merge-base', '--is-ancestor', task.state.checkpoint.commit, payload.refs.commit); }
          catch { throw new Conflict('code must descend from the pinned handoff commit'); }
        }
      }
      const event = { type: payload.type, ...(!desktop && !human ? token : {}) };
      for (const field of ['summary', 'decision', 'refs']) if (payload[field] !== undefined) event[field] = payload[field];
      if (payload.type === 'handoff') event.next_stage = task.state.stage + 1;
      if (payload.type === 'completed') event.refs = task.state.checkpoint;
      return { event };
    });
    return this.publish(result, payload.type);
  }
  async handoff(id, payload, expectedSeq, key) { const task = await this.read(id); if (task.spec.execution_mode === 'desktop_poll') throw new Denied('use the bound desktop finish tool'); return this.report(id, { type: 'handoff', ...payload }, leaseToken(task), key, expectedSeq); }
  async requestReview(id, payload, expectedSeq, key) { const task = await this.read(id); if (task.spec.execution_mode === 'desktop_poll') throw new Denied('use the bound desktop finish tool'); return this.report(id, { type: 'review_requested', ...payload }, leaseToken(task), key, expectedSeq); }
}
