import { randomUUID } from 'node:crypto';
import { BadRequest, Forbidden } from './auth.mjs';

const taskId = () => `T-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 6).toUpperCase()}`;
const key = () => randomUUID();

export class CollaborationService {
  constructor(store, { repoId, defaultReviewer, users, notify = async () => {} }) {
    this.store = store;
    this.repoId = repoId;
    this.defaultReviewer = defaultReviewer;
    this.userIds = users ? new Set(users.map((user) => user.id)) : null;
    this.notify = notify;
  }

  async list() { return this.store.list(); }
  async read(id) { return this.store.read(id); }

  async create(user, input, idempotencyKey = key()) {
    if (!user) throw new Forbidden();
    if (this.userIds && (input.reviewer || this.defaultReviewer) && !this.userIds.has(input.reviewer || this.defaultReviewer)) throw new BadRequest('unknown reviewer');
    const spec = {
      schema_version: 1, id: input.id || taskId(), repo: this.repoId,
      title: input.title, description: input.description || '',
      base_branch: 'main', acceptance: input.acceptance,
      source: { ...(input.chatId ? { chat_id: input.chatId } : {}),
        ...((input.reviewer || this.defaultReviewer) ? { reviewer: input.reviewer || this.defaultReviewer } : {}) }
    };
    const task = await this.store.create(spec, user.id, idempotencyKey);
    await this.notify(task, 'created');
    return task;
  }

  async assign(user, id, assignee, idempotencyKey = key(), chatId) {
    if (user.role !== 'admin') throw new Forbidden('only an admin may assign tasks');
    if (!assignee || (this.userIds && !this.userIds.has(assignee))) throw new BadRequest('unknown assignee');
    const current = await this.read(id);
    if (current.spec.source?.reviewer === assignee) throw new BadRequest('assignee and reviewer must be different');
    const task = await this.store.append(id, { type: 'assigned', assignee, ...(chatId ? { chat_id: chatId } : {}) }, user.id, idempotencyKey, current.state.seq);
    await this.notify(task, 'assigned');
    return task;
  }

  async report(user, id, payload, expectedSeq, idempotencyKey = key()) {
    const task = await this.read(id);
    if (!['progress', 'blocked', 'handoff', 'review_requested', 'reviewed', 'review_note', 'run_failed', 'completed', 'cancelled'].includes(payload.type)) throw new BadRequest('unsupported report event');
    if (payload.type === 'completed' || payload.type === 'cancelled') {
      if (user.role !== 'admin') throw new Forbidden('admin approval is required');
    } else if (task.state.assignee !== user.id && user.role !== 'admin') {
      throw new Forbidden('task is assigned to another agent');
    }
    if (payload.type === 'completed') {
      const evidence = task.events.findLast((event) => event.type === 'review_requested')?.refs;
      if (!evidence?.commit || !evidence?.tests || payload.refs?.commit !== evidence.commit || payload.refs?.tests !== evidence.tests) throw new BadRequest('completion evidence must match reviewed code');
    }
    if (['reviewed', 'review_note'].includes(payload.type) && task.spec.source?.reviewer && user.id !== task.spec.source.reviewer) throw new Forbidden('only assigned reviewer may review');
    if (payload.type === 'review_requested') {
      const reviewer = task.spec.source?.reviewer;
      if (!reviewer) throw new BadRequest('task has no reviewer');
      if (reviewer === user.id) throw new BadRequest('reviewer must be another agent');
      if (!payload.refs?.branch || !payload.refs?.commit || !payload.refs?.tests) throw new BadRequest('review request requires branch, commit and tests');
      payload = { ...payload, assignee: reviewer };
    }
    const updated = await this.store.append(id, payload, user.id, idempotencyKey, expectedSeq);
    await this.notify(updated, payload.type);
    return updated;
  }

  async nextJob(user) {
    const tasks = await this.list();
    return tasks.find((task) => task.state.assignee === user.id && ['assigned', 'review'].includes(task.state.status) && !task.events.slice(task.events.findLastIndex((event) => event.type === 'review_requested') + 1).some((event) => event.type === 'review_started')) ?? null;
  }

  async claim(user, id, expectedSeq) {
    const task = await this.read(id);
    if (!Number.isSafeInteger(expectedSeq) || expectedSeq !== task.state.seq) throw new BadRequest('stale task revision');
    if (task.state.assignee !== user.id) throw new Forbidden('task assigned to another agent');
    const type = task.state.status === 'assigned' ? 'run_started' : task.state.status === 'review' && !task.events.slice(task.events.findLastIndex((event) => event.type === 'review_requested') + 1).some((event) => event.type === 'review_started') ? 'review_started' : null;
    if (!type) throw new BadRequest('task is not claimable');
    return this.store.append(id, { type, run_id: randomUUID() }, user.id, `claim:${id}:${expectedSeq}:${user.id}`, expectedSeq);
  }
}
