import { Conflict, Denied } from './protocol.mjs';

export const reviewTaskPattern = /^T-[A-Z0-9-]{1,62}$/;
const fields = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));

// Freeze the human's review scope when their authenticated group message arrives.
// Model interpretation must never silently substitute a newer task revision.
export function reviewContext(tasks, agentId, senderId, chatId, team) {
  if (team.agents[agentId]?.wecom_userid !== senderId) return [];
  return tasks.filter((task) => task.spec.source?.channel === 'wecom' && task.spec.source.chat_id === chatId
    && ['stage_review', 'review'].includes(task.state.status) && task.state.assignee === agentId
    && (task.team || team).agents[agentId]?.wecom_userid === senderId)
    .map((task) => ({ task_id: task.spec.id, expected_seq: task.state.seq, title: task.spec.title,
      commit: task.state.checkpoint.commit, stage: task.state.stage }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));
}

export function validReviewContext(value) {
  return Array.isArray(value) && value.length <= 100 && new Set(value.map((item) => item?.task_id)).size === value.length
    && value.every((item) => fields(item, ['task_id', 'expected_seq', 'title', 'commit', 'stage'])
      && reviewTaskPattern.test(item.task_id || '') && Number.isSafeInteger(item.expected_seq) && item.expected_seq > 0
      && typeof item.title === 'string' && !!item.title.trim() && item.title.length <= 200
      && /^[a-f0-9]{40}$/.test(item.commit || '') && Number.isSafeInteger(item.stage) && item.stage >= 0);
}

export function assertReviewIntent(request, review, agentId, team) {
  if (!fields(review, ['task_id', 'expected_seq', 'decision', 'summary']) || !reviewTaskPattern.test(review.task_id || '')
    || !Number.isSafeInteger(review.expected_seq) || review.expected_seq < 1
    || !['approved', 'changes_requested'].includes(review.decision)
    || review.summary !== undefined && (typeof review.summary !== 'string' || !review.summary.trim() || review.summary.length > 2000)
    || review.decision === 'changes_requested' && !review.summary) throw new Conflict('invalid human review interpretation; rejection requires feedback');
  if (request.spec.sender_id !== team.agents[agentId]?.wecom_userid) throw new Denied('only the authenticated bot owner may review');
  const candidates = request.spec.review_context || [];
  const target = candidates.find((item) => item.task_id === review.task_id && item.expected_seq === review.expected_seq);
  if (!target) throw new Conflict('review target/version was not pending when this human message arrived; ask for a new review message');
  const humanMessages = [request.spec.content, ...request.events.filter((event) => event.type === 'replied').map((event) => event.content)];
  // Keep a person's task selection across clarification turns. Never use the
  // model's question/answer text as evidence of which task the person selected.
  let selected = false; let revisionSelected = false;
  for (let i = humanMessages.length - 1; i >= 0; i--) {
    const selection = reviewSelection(humanMessages[i], candidates, i > 0);
    if (!selected && selection.ids.length) {
      if (selection.ids.length !== 1 || selection.ids[0] !== target.task_id) throw new Conflict('explicit task selection does not match the selected review; clarify conflicting choices');
      selected = true;
    }
    if (!revisionSelected && selection.revisions.length) {
      if (selection.revisions.length !== 1 || selection.revisions[0] !== target.expected_seq) throw new Conflict('explicit task or revision does not match the selected review');
      revisionSelected = true;
    }
  }
  if (candidates.length > 1 && !selected) throw new Conflict('multiple pending reviews; clarify the task first using its title, list number or ID');
  const decisionText = (value) => {
    for (const item of candidates.toSorted((a, b) => b.title.length - a.title.length)) value = value.replaceAll(item.title, '').replaceAll(item.task_id, '');
    return value.replace(/\bN-[A-F0-9]{32}\b|\bR-[1-9][0-9]*\b/g, '').trim();
  };
  const selectionOnly = (value) => /^(?:(?:我选|选择|选|是)\s*)?(?:第\s*(?:[1-9][0-9]*|[一二三四五六七八九十百]+)\s*[个项条])?(?:这个|那个|任务|这条|那条)?[。！!\s]*$/.test(value);
  let latestIntent = null;
  for (const human of humanMessages.toReversed()) {
    const value = decisionText(human);
    if (selectionOnly(value)) continue;
    latestIntent = explicitReviewDecision(value); break;
  }
  if (review.summary && !humanMessages.some((message) => message.includes(review.summary))) throw new Conflict('review feedback must quote actual human instructions');
  if (review.decision === 'changes_requested') {
    const feedback = review.summary.replace(/先别通过|不要通过|不通过|退回|需要修改|审核|通过|同意|批准/g, '').replace(/[\s，,。！!；;：:]/g, '');
    if (feedback.length < 2) throw new Conflict('rejection feedback must quote concrete human instructions; ask for missing feedback');
  }
  if (latestIntent !== review.decision) throw new Conflict('no matching explicit human review decision; clarify instead of guessing');
  return target;
}

// A conservative consent check supplements model interpretation. Unclear or
// conditional prose becomes a clarification, never an inferred approval.
export function explicitReviewDecision(content) {
  const value = content.trim().replace(/^@[^\s@]{1,40}\s+/, '');
  if (/[？?]/.test(value) || /(?:如果|假如|若是|等.+(?:通过|完成)|通过(?:以后|之后|后)再|不要退回|别退回|不退回)/.test(value)) return null;
  if (/(?:退回|不通过|不批准|不同意|先别通过|不要通过|还不行|需要修改|再改|再补|补充|补一下|改成|改为)/.test(value)) return 'changes_requested';
  if (/(?:先等等|先等一下|等一下|稍等|暂缓|暂不|先不|先别|别急|待确认)/.test(value)) return null;
  if (/(?:^|[，,。！!；;\n])\s*(?:我(?:确认|同意)\s*)?(?:审核|验收)?(?:通过|同意|批准|没问题|可以了|可以继续|就这样|OK|ok)(?=$|[，,。！!；;\s]|了|吧)/.test(value)) return 'approved';
  return null;
}

function reviewSelection(value, candidates, afterClarification) {
  const ids = new Set(value.match(/\bT-[A-Z0-9-]{1,62}\b/g) || []);
  const revisions = [...new Set((value.match(/\bR-[1-9][0-9]*\b/g) || []).map((item) => Number(item.slice(2))))];
  // Match longer titles first so a title prefix isn't a second selection.
  for (const candidate of candidates.toSorted((a, b) => b.title.length - a.title.length)) {
    if (value.includes(candidate.title)) {
      for (const sameTitle of candidates.filter((item) => item.title === candidate.title)) ids.add(sameTitle.task_id);
      value = value.replaceAll(candidate.title, '');
    }
  }
  for (const match of value.matchAll(/第\s*([1-9][0-9]*|[一二三四五六七八九十百]+)\s*(?:个|项|条)/g)) {
    ids.add(afterClarification ? candidates[reviewIndex(match[1]) - 1]?.task_id || 'invalid-list-selection' : 'unconfirmed-list-selection');
  }
  return { ids: [...ids], revisions };
}

function reviewIndex(token) {
  if (/^[0-9]+$/.test(token)) return Number(token);
  if (token === '一百') return 100;
  const digits = '零一二三四五六七八九';
  if (token.includes('十')) { const [tens, ones] = token.split('十'); return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0); }
  return digits.indexOf(token);
}
