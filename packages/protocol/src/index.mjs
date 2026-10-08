const transitions = Object.freeze({
  uncreated: { created: 'open' },
  open: { assigned: 'assigned', cancelled: 'cancelled' },
  assigned: { run_started: 'running', assigned: 'assigned', cancelled: 'cancelled' },
  running: {
    progress: 'running', blocked: 'blocked', run_failed: 'blocked',
    handoff: 'waiting', review_requested: 'review', cancelled: 'cancelled'
  },
  blocked: { assigned: 'assigned', cancelled: 'cancelled' },
  waiting: { assigned: 'assigned', cancelled: 'cancelled' },
  review: { reviewed: (event) => event.decision === 'approved' ? 'approved' : 'blocked', cancelled: 'cancelled' },
  approved: { completed: 'completed', cancelled: 'cancelled' },
  completed: {},
  cancelled: {}
});

export function validateTaskSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new TypeError('task spec must be an object');
  if (spec.schema_version !== 1) throw new Error('unsupported task schema version');
  if (!/^[A-Z][A-Z0-9-]{1,63}$/.test(spec.id ?? '')) throw new Error('invalid task id');
  for (const field of ['repo', 'title', 'base_branch']) {
    if (typeof spec[field] !== 'string' || spec[field].trim() === '') throw new Error(`invalid ${field}`);
  }
  if (!Array.isArray(spec.acceptance) || spec.acceptance.length === 0 || spec.acceptance.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('acceptance must contain at least one nonempty criterion');
  }
  return spec;
}

export function reduceTask(spec, events) {
  validateTaskSpec(spec);
  if (!Array.isArray(events)) throw new TypeError('events must be an array');
  let status = 'uncreated';
  let assignee = null;
  let seq = 0;
  const eventIds = new Set();
  const idempotencyKeys = new Set();
  for (const event of events) {
    if (!event || event.schema_version !== 1 || event.task_id !== spec.id) throw new Error('invalid event version or task id');
    if (!Number.isSafeInteger(event.seq) || event.seq !== seq + 1) throw new Error(`expected event sequence ${seq + 1}`);
    for (const field of ['event_id', 'actor_id', 'idempotency_key']) {
      if (typeof event[field] !== 'string' || !event[field].trim()) throw new Error(`invalid ${field}`);
    }
    if (!Number.isFinite(Date.parse(event.occurred_at)) || !/Z$/.test(event.occurred_at)) throw new Error('occurred_at must be a UTC timestamp');
    if (eventIds.has(event.event_id) || idempotencyKeys.has(event.idempotency_key)) throw new Error('duplicate event or idempotency key');
    const transition = transitions[status][event.type];
    if (!transition) throw new Error(`invalid transition ${status} -> ${event.type}`);
    if (event.type === 'assigned' && (!event.assignee || typeof event.assignee !== 'string')) throw new Error('assignment requires an assignee');
    if (event.type === 'reviewed' && !['approved', 'changes_requested'].includes(event.decision)) throw new Error('review requires a valid decision');
    if (event.type === 'completed' && (!event.refs || !event.refs.commit || !event.refs.tests)) throw new Error('completion requires commit and test evidence');
    status = typeof transition === 'function' ? transition(event) : transition;
    if (event.type === 'assigned') assignee = event.assignee;
    eventIds.add(event.event_id);
    idempotencyKeys.add(event.idempotency_key);
    seq = event.seq;
  }
  return Object.freeze({ id: spec.id, status, assignee, seq });
}
