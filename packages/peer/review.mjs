const memberSelector = /^member:([a-zA-Z0-9_-]{1,64})$/;

export function validateReviewRules(team) {
  if (team.review_rules === undefined) return;
  if (!team.review_rules || typeof team.review_rules !== 'object' || Array.isArray(team.review_rules)) throw new Error('invalid human review rules');
  if (Object.keys(team.routes).some((route) => !Object.hasOwn(team.review_rules, route))) throw new Error('human review rules must cover every route');
  for (const [route, rule] of Object.entries(team.review_rules)) {
    if (!team.routes[route] || !rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some((key) => !['required', 'reviewer', 'notify'].includes(key)) || typeof rule.required !== 'boolean') throw new Error('invalid human review rule');
    for (const field of ['reviewer', 'notify']) {
      const value = rule[field];
      const reserved = field === 'reviewer' ? ['owner', 'admin'] : ['owner', 'reviewer', 'none'];
      if (reserved.includes(value)) continue;
      const member = typeof value === 'string' && memberSelector.exec(value)?.[1];
      if (!member || !team.agents[member]?.wecom_userid) throw new Error('review/notification member needs a verified WeCom account');
    }
  }
}

export function stageReviewRule(team, route) {
  return team.review_rules?.[route] || { required: false, reviewer: 'admin', notify: 'owner' };
}

export function resolveHuman(selector, executorId, team, reviewerId = team.reviewer) {
  if (selector === 'none') return null;
  if (selector === 'reviewer') return reviewerId;
  if (selector === 'admin') return team.reviewer;
  // Notification-only identities cannot send approval commands. Route their review
  // to the administrator. Verified agents keep their own review identity even
  // when several agents share the same human owner.
  if (selector === 'owner') return team.agents[executorId]?.wecom_userid ? executorId : team.reviewer;
  return memberSelector.exec(selector || '')?.[1] || null;
}

export function stageReviewer(team, route, executorId) {
  const rule = stageReviewRule(team, route);
  return rule.required ? resolveHuman(rule.reviewer, executorId, team) : team.reviewer;
}

export function reviewNotificationMembers(task, team) {
  const event = task.events.at(-1);
  const waiting = ['stage_review', 'review'].includes(task.state.status);
  if (!['handoff', 'stage_review_requested', 'review_requested'].includes(event?.type)) return [];
  const completedStage = event.type === 'handoff' ? task.state.stage - 1 : task.state.stage;
  const rule = stageReviewRule(team, task.spec.workflow[completedStage]);
  const reviewer = waiting ? task.state.assignee : stageReviewer(team, task.spec.workflow[completedStage], event.actor_id);
  const notified = resolveHuman(rule.notify, event.actor_id, team, reviewer);
  return [...new Set([notified, ...(waiting ? [reviewer] : [])].filter((id) => id && team.agents[id]?.wecom_userid))];
}

export function defaultReviewRules(routes) {
  return Object.fromEntries(Object.keys(routes).map((route) => [route, { required: true, reviewer: 'owner', notify: 'owner' }]));
}
