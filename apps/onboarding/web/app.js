const $ = (id) => document.getElementById(id);
let currentId, pending, discovery, timer, busy = false, reviewVersion = null, reviewId, ownAdminId, resetPlan, resetDiscovery;
let viewEpoch = 0, currentView = 'home', completing = false;
const storageKey = 'codex-collab-onboarding';
function remember(value) { try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch {} }
function remembered() { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { return null; } }
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function show(view) { if (view !== 'profile' || currentView === 'profile') { $('delivery-panel').hidden = true; $('delivery-password').value = ''; $('delivery-instructions').textContent = ''; } clearInterval(timer); clearTimeout(timer); viewEpoch++; currentView = view; for (const section of document.querySelectorAll('main>section')) section.hidden = section.id !== view; }
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
async function action(fn) {
  if (busy) return; busy = true; notice(''); for (const button of document.querySelectorAll('button')) button.disabled = true;
  try { await fn(); } catch (error) { notice(error.message); } finally { busy = false; for (const button of document.querySelectorAll('button')) button.disabled = false; }
}
const values = (form) => Object.fromEntries(new FormData(form));
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, fn) { const node = text('button', label); node.onclick = () => action(fn); return node; }
async function overview() {
  const value = await api('overview'); $('profiles').replaceChildren(); $('removed-profiles').replaceChildren();
  $('removed-projects').hidden = !(value.removed_profiles || []).length;
  for (const profile of value.removed_profiles || []) {
    const card = document.createElement('div'); card.className = 'card'; const info = document.createElement('div');
    info.append(text('strong', profile.agent_id), text('p', profile.repo));
    card.append(info, button('恢复接入', () => openReset(profile.id, 'restore'))); $('removed-profiles').append(card);
  }
  for (const draft of value.drafts || []) {
    const card = document.createElement('div'); card.className = 'card';
    card.append(text('span', `${draft.display_name || draft.agent_id} · 待完成群验证`), button('继续创建团队', () => openDraft(draft.id))); $('profiles').append(card);
  }
  if (!value.profiles.length && !(value.drafts || []).length) $('profiles').append(text('p', '还没有接入项目。管理员选择“初始化团队”，成员选择“加入团队”。'));
  for (const profile of value.profiles) {
    const card = document.createElement('div'); card.className = 'card'; const info = document.createElement('div');
    info.append(text('strong', `${profile.display_name || profile.agent_id} · ${profile.role === 'admin' ? '管理员' : '成员'}`), text('p', profile.repo));
    card.append(info, button('打开项目', () => loadProfile(profile.id))); $('profiles').append(card);
  }
}
async function openDraft(id) {
  const value = await api(`admin-draft?id=${id}`);
  if (value.profile) { pending = null; await loadProfile(value.profile.id); return; }
  pending = { type: 'admin', draft_id: id }; remember({ draft_id: id }); await verifyView(value);
}
async function verifyView(session) {
  discovery = session; show('verification'); $('code').textContent = session.message; updateConnection(session);
  const epoch = viewEpoch;
  const tick = async () => {
    if (epoch !== viewEpoch) return;
    if (busy) { timer = setTimeout(tick, 2000); return; }
    try {
      const value = await api(`discovery?id=${session.id}`); if (epoch !== viewEpoch) return; updateConnection(value);
      if (value.status === 'verified') { await action(completeVerification); return; }
      if (['failed', 'expired', 'disconnected'].includes(value.status)) return;
      timer = setTimeout(tick, 2000);
    } catch (error) { if (epoch === viewEpoch) { notice(error.message); $('retry-code').hidden = false; } }
  };
  timer = setTimeout(tick, session.status === 'verified' ? 0 : 2000);
}
function updateConnection(value) {
  discovery = value; $('retry-code').hidden = !['failed', 'expired', 'disconnected'].includes(value.status);
  const labels = { connecting: '正在连接企业微信…', authenticated: '机器人已连接，请发送下面的验证码。', verified: '群验证成功，正在继续配置…', failed: '连接失败，请检查凭据。', expired: '验证码已过期，请重新连接。', disconnected: '连接已断开，请重新连接。' };
  $('connection').textContent = value.error || labels[value.status] || value.status;
}
async function completeVerification() {
  if (completing || !pending) return;
  completing = true; clearTimeout(timer);
  const setup = pending; const epoch = viewEpoch; let profile;
  try {
    const session = await api(`discovery?id=${discovery.id}`);
    if (epoch !== viewEpoch) return;
    updateConnection(session); if (session.status !== 'verified') throw new Error('请先完成群验证码验证。');
    try {
      profile = setup.type === 'admin' ? await api('admin-complete', { draft_id: setup.draft_id, discovery_id: session.id }) : await api('verify', { id: setup.id, discovery_id: session.id });
    } catch (error) {
      if (epoch !== viewEpoch) return;
      if (setup.type === 'admin') profile = (await api(`admin-draft?id=${setup.draft_id}`)).profile;
      else profile = (await api('overview')).profiles.find((value) => value.id === setup.id);
      if (!profile) { $('retry-code').hidden = false; throw error; }
      pending = null; await loadProfile(profile.id); notice(`${error.message} 可在此继续接入。`); return;
    }
    if (epoch !== viewEpoch) return;
    pending = null; await loadProfile(profile.id);
  } finally { completing = false; }
}
function renderSteps(value) {
  const verified = value.phase !== 'imported', approved = ['configuring', 'ready'].includes(value.phase);
  const steps = [['项目与机器人资料', true], ['企业微信群身份验证', verified], ['管理员确认入队', value.role === 'admin' ? verified : approved], ['本机 MCP 与 Skill', value.phase === 'ready' && value.project_setup?.mcp_configured && value.project_setup?.skill_installed], ['绑定 Codex 对话', !!value.desktop?.binding], ['观察到对话轮询', !!value.poll_recent]];
  $('setup-steps').replaceChildren(); let active = false;
  for (const [label, done] of steps) { const row = text('li', `${done ? '✓ ' : ''}${label}`); row.className = done ? 'done' : !active ? 'active' : ''; if (!done) active = true; $('setup-steps').append(row); }
  const stopped = value.phase === 'ready' && !value.runner?.online;
  $('next-step').textContent = value.error ? '接入暂时停在这里。处理下方问题后点击“继续接入”。' : value.can_receive_tasks ? '已观察到实际轮询，可以在协作群 @ 机器人发送任务。请保持当前对话的协作自动化启用。' : value.phase === 'waiting' ? '申请已提交，正在自动等待管理员确认。管理员工作台会自动显示申请。' : value.phase !== 'ready' ? '按当前提示继续，完成后向导会自动进入下一步。' : stopped ? '机器人连接已停止。需要接任务时点击“启动机器人连接”。' : !value.desktop?.binding ? '在 Codex 打开下方项目，加载项目 MCP 和 Skill，再把启用指令发到要绑定的对话。' : '对话已绑定，正在等待实际轮询记录。';
}
function watchProfile(id, epoch) {
  let failures = 0;
  const tick = async () => {
    if (epoch !== viewEpoch || currentId !== id) return;
    if (busy) { timer = setTimeout(tick, 2000); return; }
    try {
      const value = await api('progress', { id, sync: true });
      if (epoch !== viewEpoch || currentId !== id) return;
      failures = 0; renderProfile(value, true);
    } catch (error) {
      if (epoch !== viewEpoch) return; failures++;
      notice(`自动检查暂未成功，将重试。${error.message}`);
    }
    if (epoch === viewEpoch) timer = setTimeout(tick, Math.min(30000, 5000 * 2 ** failures));
  };
  timer = setTimeout(tick, 5000);
}
async function loadProfile(id) {
  currentId = id; remember({ profile_id: id }); show('profile'); const epoch = viewEpoch; let value;
  try { value = await api(`profile?id=${id}`); } catch (error) { value = await api(`profile?id=${id}&local=1`); notice(`团队同步暂未成功，本机状态仍可查看。${error.message}`); }
  if (epoch !== viewEpoch) return;
  if (value.phase === 'removed') { show('home'); await overview(); return; }
  renderProfile(value); watchProfile(id, epoch); return value;
}
function renderProfile(value, automatic = false) {
  const id = value.id; renderSteps(value);
  $('reset-conversation').hidden = value.phase !== 'ready'; $('reset-robot').hidden = value.phase !== 'ready';
  $('profile-title').textContent = `${value.display_name && value.display_name !== value.agent_id ? `${value.display_name}（${value.agent_id}）` : value.agent_id} · ${value.role === 'admin' ? '管理员' : '成员'}`; $('profile-repo').textContent = value.repo;
  $('profile-diagnostics').hidden = !value.config_path; $('config-path').textContent = value.config_path || '';
  $('checks').replaceChildren(); $('progress').replaceChildren(); $('binding').hidden = value.phase !== 'ready'; $('runner-actions').hidden = value.phase !== 'ready'; $('admin-tools').hidden = value.role !== 'admin' || value.phase !== 'ready';
  if (value.phase === 'ready') {
    $('binding-text').textContent = value.binding_prompt; $('binding-details').textContent = value.detailed_binding_prompt || value.binding_prompt;
    for (const [label, ok, wait] of [['项目 MCP', value.project_setup?.mcp_configured, '待配置'], ['项目 Skill', value.project_setup?.skill_installed, '待配置'], ['企业微信机器人', value.runner?.wecom === 'authenticated', value.runner?.online ? '连接中' : '已停止'], ['目标 Codex 对话', !!value.desktop?.binding, '待绑定'], ['对话实际轮询', value.poll_recent, value.poll_observed ? '最近未观察到轮询' : '待观察'], ['可接收任务', value.can_receive_tasks, '尚未满足条件']]) {
      const row = document.createElement('div'); row.className = 'check'; const badge = text('span', ok ? '已就绪' : wait); badge.className = `badge${ok ? '' : ' pending'}`; row.append(text('span', label), badge); $('checks').append(row);
    }
    $('checks').append(text('p', '轮询状态来自实际调用记录。自动化是否启用，请在绑定对话的 Codex 自动化中确认。'));
  } else {
    const phases = { imported: '机器人配置已保存，等待群身份验证。', initializing: '团队初始化尚未完成。', configuring: '正在配置本机项目。', verified: '正在提交入队申请。', waiting: value.own_agent ? '本人机器人申请已提交，正在自动完成入队。' : '申请已提交，正在自动等待管理员确认。' };
    $('progress').append(text('p', phases[value.phase] || value.phase), button(value.phase === 'imported' ? '连接分配的机器人' : '继续接入', async () => {
      if (value.phase === 'imported') { pending = { type: 'member', id }; await verifyView(await api('discovery', { profile_id: id })); }
      else { try { await api('resume', { id }); } finally { await loadProfile(id); } }
    }));
  }
  if (value.error) notice(value.error);
  $('members').replaceChildren(); $('routes').replaceChildren(); $('owners').replaceChildren();
  for (const member of value.members || []) $('members').append(text('p', `${member.id} · ${member.role === 'admin' ? '管理员' : '成员'} · ${member.capabilities.join(', ')}`));
  for (const [capability, candidates] of Object.entries(value.routes || {})) $('routes').append(text('p', `${capability}：${candidates.join(' → ')}（首选 → 候补）`));
  for (const owner of value.owners || []) $('owners').append(text('p', `${owner.is_you ? '你的机器人' : '同一位同事的机器人'}：${owner.agent_ids.join('、')}`));
  if (!automatic || reviewId !== id || reviewVersion === null) renderReviewRules(value);
  else if (value.version !== reviewVersion) $('review-policy-note').textContent = '团队规则已更新。当前未保存的编辑已保留；保存前请刷新并重新确认规则。';
  $('exports').replaceChildren(); $('requests').replaceChildren();
  for (const invitation of value.exports || []) {
    const row = document.createElement('div'); row.className = 'card'; row.append(text('span', `${invitation.display_name && invitation.display_name !== invitation.agent_id ? `${invitation.display_name}（${invitation.agent_id}）` : invitation.agent_id} · 有效至 ${new Date(invitation.expires_at).toLocaleDateString()}`));
    if (invitation.own_agent) row.append(button('继续接入我的机器人', async () => {
      const profile = await api('own-agent-resume', { id, invite_id: invitation.invite_id }); await connectMember(profile);
    }));
    else { row.append(button('查看接入说明与密码', () => showDelivery(id, invitation.invite_id))); const link = text('a', '下载加密接入包'); link.href = `/api/export?id=${id}&invite=${invitation.invite_id}`; link.download = invitation.filename; row.append(link); }
    $('exports').append(row);
  }
  for (const request of value.requests || []) {
    const row = document.createElement('div'); row.className = 'card'; row.append(text('span', `${request.agent_id} · ${request.capabilities.join(', ')} · userid: ${request.userid || '只接通知'}`), button('确认此成员入队', async () => { await api('approve', { id, request_id: request.request_id }); await loadProfile(id); })); $('requests').append(row);
  }
  if (!(value.requests || []).length) $('requests').append(text('p', '暂无待确认申请。'));
}
function renderReviewRules(profile) {
  $('review-rules').replaceChildren(); reviewVersion = null; reviewId = profile.id;
  const ready = profile.role === 'admin' && profile.phase === 'ready' && profile.routes && Number.isSafeInteger(profile.version);
  $('review-form').hidden = !ready;
  if (!ready) { $('review-policy-note').textContent = '团队同步成功后可设置审核规则。'; return; }
  reviewVersion = profile.version;
  $('review-policy-note').textContent = profile.policy_schema_version === 3
    ? '默认由执行 Agent 的所有者通过对应机器人审核。一人多个 Agent 时审核身份仍独立；未配置群命令身份的 Agent 由管理员审核。'
    : '此团队使用旧版规则。保存后升级审核协议；请先让所有成员升级工具并重启机器人与 MCP。';
  const members = (profile.members || []).filter((member) => member.verified_owner);
  function select(label, field, selected, options) {
    const wrapper = text('label', label), input = document.createElement('select'); input.dataset.field = field;
    for (const [value, title] of options) { const option = text('option', title); option.value = value; input.append(option); }
    input.value = selected; wrapper.append(input); return wrapper;
  }
  for (const route of Object.keys(profile.routes)) {
    const rule = profile.review_rules?.[route] || { required: true, reviewer: 'owner', notify: 'owner' };
    const card = document.createElement('fieldset'); card.dataset.route = route; card.append(text('legend', route));
    const check = text('label', '中间阶段提交后需要真人审核'); check.className = 'checkbox';
    const required = document.createElement('input'); required.type = 'checkbox'; required.dataset.field = 'required'; required.checked = rule.required; check.prepend(required);
    const row = document.createElement('div'); row.className = 'row';
    const people = members.map((member) => [`member:${member.id}`, `${member.id} 的所有者（通过其机器人）`]);
    row.append(select('审核人', 'reviewer', rule.reviewer, [['owner', '执行 Agent 的所有者（通过其机器人）'], ['admin', '管理员'], ...people]),
      select('额外通知对象', 'notify', rule.notify, [['owner', '执行 Agent 的所有者（通过其机器人）'], ['reviewer', '审核人'], ['none', '不额外通知'], ...people]));
    card.append(check, row); $('review-rules').append(card);
  }
}
$('review-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!Number.isSafeInteger(reviewVersion)) throw new Error('请先刷新工作台获取团队规则。');
  const review_rules = {};
  for (const row of $('review-rules').querySelectorAll('fieldset')) {
    const field = (name) => row.querySelector(`[data-field="${name}"]`);
    review_rules[row.dataset.route] = { required: field('required').checked, reviewer: field('reviewer').value, notify: field('notify').value };
  }
  await api('review-rules', { id: currentId, expected_version: reviewVersion, review_rules });
  await loadProfile(currentId); notice('审核规则已保存，新任务将使用此规则。');
}); };
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => action(async () => { clearInterval(timer); if (resetPlan) { await api('reset-cancel', { id: resetPlan.id, preview_token: resetPlan.preview_token }); resetPlan = null; resetDiscovery = null; $('reset-secret').value = ''; } remember(null); show(button.dataset.view); if (button.dataset.view === 'home') await overview(); });
function repoMode(prefix) {
  const clone = $(`${prefix}-repo-mode`).value === 'clone'; $(`${prefix}-existing-repo`).hidden = clone; $(`${prefix}-clone-repo`).hidden = !clone;
}
for (const prefix of ['admin', 'join']) $(`${prefix}-repo-mode`).onchange = () => repoMode(prefix);
$('check-project').onclick = () => action(async () => {
  const selected = await api('project-check', values($('admin-form')));
  const form = $('admin-form'); form.elements.repo.value = selected.repo; $('admin-repo-mode').value = 'existing'; repoMode('admin');
  $('project-recommendation').textContent = `项目已检查：${selected.repo}。${selected.tests.length ? '推荐：' + selected.tests.map((test) => test.command).join(' / ') + '，请确认或修改。' : '未找到常见测试入口，请填写适合项目的验证命令。'}`;
  if (!$('test-command').value && selected.tests.length) $('test-command').value = selected.tests[0].command;
});
$('admin-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  const input = values(event.target);
  const session = await api('admin-prepare', input); event.target.elements.secret.value = '';
  pending = { type: 'admin', draft_id: session.draft_id }; remember({ draft_id: session.draft_id }); await verifyView(session);
}); };
async function invitationInput(form) { const input = values(form); input.content = await input.file.text(); delete input.file; return input; }
$('inspect-invite').onclick = () => action(async () => {
  const value = await api('inspect-invite', await invitationInput($('join-form')));
  $('invite-info').hidden = false; $('invite-summary').textContent = `${value.display_name || value.agent_id}（${value.agent_id}）· 职责：${value.capabilities.join('、')}${value.team_name ? ' · ' + value.team_name : ''}`;
  $('invite-remote').textContent = value.remote;
  if (!$('join-form').elements.destination.value) $('join-form').elements.destination.value = value.suggested_repo;
});
$('join-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  const profile = await api('import', await invitationInput(event.target)); event.target.elements.password.value = ''; await connectMember(profile);
}); };
async function connectMember(profile) {
  currentId = profile.id; remember({ profile_id: profile.id });
  if (profile.phase !== 'imported') { pending = null; await loadProfile(profile.id); return; }
  pending = { type: 'member', id: profile.id };
  try { await verifyView(await api('discovery', { profile_id: profile.id })); }
  catch (error) { await loadProfile(profile.id); throw error; }
}
$('add-own-agent').onclick = () => action(async () => { ownAdminId = currentId; show('own'); });
$('own-cancel').onclick = () => action(() => loadProfile(ownAdminId));
$('own-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  const input = values(event.target); input.id = ownAdminId; input.prefer = event.target.elements.prefer.checked;
  let profile;
  try { profile = await api('own-agent', input); }
  catch (error) { await loadProfile(ownAdminId); throw error; }
  finally { event.target.elements.secret.value = ''; }
  await connectMember(profile);
}); };
$('retry-code').onclick = () => action(async () => {
  if (pending.type === 'admin') { const session = await api('admin-retry', { id: pending.draft_id }); if (session.profile) await loadProfile(session.profile.id); else await verifyView(session); }
  else await verifyView(await api('discovery', { profile_id: pending.id, reconnect: true }));
});
$('confirm-code').onclick = () => action(completeVerification);
$('existing-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const profile = await api('existing', values(event.target)); await loadProfile(profile.id); }); };
$('issue-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const input = values(event.target); input.id = currentId; input.prefer = event.target.elements.prefer.checked; input.commands_enabled = event.target.elements.commands_enabled.checked; const result = await api('issue', input); event.target.reset(); await loadProfile(currentId); await showDelivery(currentId, result.invite_id); notice('接入包已生成。下载文件交给指定成员，密码请单独发送。'); }); };
$('refresh').onclick = () => action(() => loadProfile(currentId));
$('start').onclick = () => action(async () => { await api('runner', { id: currentId, command: 'start' }); await loadProfile(currentId); });
$('stop').onclick = () => action(async () => { await api('runner', { id: currentId, command: 'stop' }); await loadProfile(currentId); });
$('copy-config-path').onclick = () => action(() => navigator.clipboard.writeText($('config-path').textContent));
$('copy-code').onclick = () => action(() => navigator.clipboard.writeText($('code').textContent));
$('copy-binding-details').onclick = () => action(() => navigator.clipboard.writeText($('binding-details').textContent));
$('copy-binding').onclick = () => action(() => navigator.clipboard.writeText($('binding-text').textContent));
async function openReset(id, kind) {
  clearInterval(timer); clearTimeout(timer); viewEpoch++; resetPlan = null; resetDiscovery = null;
  const plan = await api('reset-preview', { id, kind }); resetPlan = plan; currentId = id;
  $('reset-title').textContent = plan.title; $('reset-target').textContent = `${plan.agent_id} · ${plan.repo}`;
  $('reset-effects').replaceChildren(); for (const effect of plan.effects) $('reset-effects').append(text('li', effect));
  $('reset-thread').textContent = plan.thread_id ? `当前对话 ID：${plan.thread_id}` : '当前没有绑定的 Codex 对话。';
  $('reset-pause-label').hidden = !plan.requires_pause; $('reset-paused').checked = false;
  $('reset-confirmation').value = ''; $('reset-confirmation').placeholder = plan.agent_id;
  $('reset-secret-fields').hidden = kind !== 'robot'; $('reset-secret').value = ''; $('reset-verification').hidden = true;
  $('reset-submit').textContent = kind === 'restore' ? '确认恢复' : '确认操作'; show('reset-view');
}
$('reset-conversation').onclick = () => action(() => openReset(currentId, 'conversation'));
$('reset-robot').onclick = () => action(() => openReset(currentId, 'robot'));
$('reset-project').onclick = () => action(() => openReset(currentId, 'project'));
$('reset-cancel').onclick = () => action(async () => { const plan = resetPlan; clearInterval(timer); await api('reset-cancel', { id: plan.id, preview_token: plan.preview_token }); resetPlan = null; resetDiscovery = null; $('reset-secret').value = ''; if (plan.kind === 'restore') { show('home'); await overview(); } else { await loadProfile(plan.id); notice('已取消操作。如已验证新凭据，机器人连接仍停止，可在项目页面重新启动。'); } });
$('reset-copy-code').onclick = () => action(() => navigator.clipboard.writeText($('reset-code').textContent));
function resetConnection(value) {
  const labels = { connecting: '正在验证新凭据…', authenticated: '连接成功，请发送群验证码。', verified: '群身份已验证，可以确认保存。', failed: '连接失败，请检查新 Secret 后重试。', expired: '验证码已过期，请重新验证。', disconnected: '连接已断开，请重新验证。' };
  $('reset-connection').textContent = value.error || labels[value.status] || value.status;
}
$('reset-connect').onclick = () => action(async () => {
  const secret = $('reset-secret').value; if (!secret.trim()) throw new Error('请填写新的机器人 Secret。');
  const session = await api('reset-discovery', { id: resetPlan.id, kind: resetPlan.kind, preview_token: resetPlan.preview_token, secret });
  $('reset-secret').value = ''; resetDiscovery = session; $('reset-verification').hidden = false; $('reset-code').textContent = session.message; resetConnection(session);
  clearInterval(timer); timer = setInterval(async () => { if (busy || !resetPlan || !resetDiscovery) return; try {
    const value = await api(`discovery?id=${resetDiscovery.id}`); resetDiscovery = value; resetConnection(value);
    if (['verified', 'failed', 'expired', 'disconnected'].includes(value.status)) clearInterval(timer);
  } catch (error) { clearInterval(timer); notice(error.message); } }, 2000);
});
$('reset-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if ($('reset-confirmation').value !== resetPlan.agent_id) throw new Error('请填写当前 Agent 名称确认操作。');
  if (resetPlan.requires_pause && !$('reset-paused').checked) throw new Error('请先在原 Codex 对话暂停协作轮询，再勾选确认。');
  const input = { id: resetPlan.id, kind: resetPlan.kind, preview_token: resetPlan.preview_token, confirmation: $('reset-confirmation').value, heartbeat_paused: $('reset-paused').checked };
  if (resetPlan.kind === 'robot') {
    if (!resetDiscovery) throw new Error('请先验证新凭据。');
    const session = await api(`discovery?id=${resetDiscovery.id}`); resetConnection(session);
    if (session.status !== 'verified') throw new Error('请先在原协作群完成验证码验证。');
    input.discovery_id = resetDiscovery.id;
  }
  const result = await api('reset', input); clearInterval(timer); resetPlan = null; resetDiscovery = null;
  if (result.kind === 'project') { show('home'); await overview(); } else await loadProfile(result.id);
  notice(`${result.message} 本机恢复记录：${result.backup_path}`);
}); };

function assignmentRow() {
  const card = document.createElement('fieldset'); card.className = 'assignment'; card.append(text('legend', '成员／机器人'));
  const field = (label, name, { type = 'text', placeholder = '', required = false } = {}) => {
    const wrapper = text('label', label), input = document.createElement('input'); input.name = name; input.dataset.field = name; input.type = type; input.placeholder = placeholder; input.required = required; input.autocomplete = 'off'; wrapper.append(input); return wrapper;
  };
  const row = document.createElement('div'); row.className = 'row';
  const roleLabel = text('label', '职责'), role = document.createElement('select'); role.dataset.field = 'responsibility';
  for (const [value, label] of [['frontend', '前端开发'], ['backend', '后端开发'], ['fullstack', '全栈开发'], ['testing', '测试'], ['docs', '文档'], ['general', '通用开发']]) { const option = text('option', label); option.value = value; role.append(option); }
  role.value = 'backend'; roleLabel.append(role); row.append(field('显示名称', 'display_name', { required: true, placeholder: '例如 Bob 或李四' }), roleLabel); card.append(row);
  const bots = document.createElement('div'); bots.className = 'row'; bots.append(field('Bot ID', 'bot_id', { required: true }), field('Secret', 'secret', { type: 'password', required: true })); card.append(bots);
  const advanced = document.createElement('details'); advanced.append(text('summary', '自定义身份与分工'), field('内部 Agent ID（可选）', 'agent_id'), field('自定义职责（可选）', 'capabilities'));
  for (const [name, label] of [['prefer', '作为这些职责的首选'], ['commands_enabled', '允许所有者通过此机器人发送群命令']]) { const wrapper = text('label', label), input = document.createElement('input'); input.type = 'checkbox'; input.dataset.field = name; input.checked = true; wrapper.className = 'checkbox'; wrapper.prepend(input); advanced.append(wrapper); }
  card.append(advanced, button('移除此行', async () => { card.remove(); })); $('assignment-rows').append(card);
}
$('add-assignment').onclick = () => action(async () => { if ($('assignment-rows').children.length >= 25) throw new Error('每次最多分配 25 个机器人。'); assignmentRow(); });
$('batch-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  const members = [...$('assignment-rows').children].map((row) => Object.fromEntries([...row.querySelectorAll('[data-field]')].map((field) => [field.dataset.field, field.type === 'checkbox' ? field.checked : field.value])));
  const id = currentId; const result = await api('issue-batch', { id, members });
  $('assignment-rows').replaceChildren(); assignmentRow(); await loadProfile(id);
  if (result.assignments.length === 1) await showDelivery(id, result.assignments[0].invite_id);
  notice(`已分配 ${result.assignments.length} 个机器人。在“已分配的机器人”中逐个下载接入包、复制接入说明和密码。`);
}); };
async function showDelivery(id, inviteId) {
  const epoch = viewEpoch, value = await api('delivery', { id, invite_id: inviteId }); if (epoch !== viewEpoch) return;
  $('delivery-title').textContent = `${value.display_name}（${value.agent_id}）的接入说明`;
  $('delivery-instructions').textContent = value.instructions; $('delivery-password').value = value.password || '';
  $('copy-password').hidden = !value.password; $('delivery-panel').hidden = false;
}
$('copy-delivery').onclick = () => action(() => navigator.clipboard.writeText($('delivery-instructions').textContent));
$('copy-password').onclick = () => action(() => navigator.clipboard.writeText($('delivery-password').value));
$('hide-delivery').onclick = () => action(async () => { $('delivery-panel').hidden = true; $('delivery-password').value = ''; });
assignmentRow();
action(async () => {
  const token = location.hash.slice(1); if (token) { await api('session', { token }); history.replaceState(null, '', '/'); }
  const saved = remembered(); await overview();
  try { if (saved?.draft_id) await openDraft(saved.draft_id); else if (saved?.profile_id) { const value = await loadProfile(saved.profile_id); if (value?.phase === 'imported') await connectMember(value); } }
  catch (error) { remember(null); show('home'); notice(`上次接入暂时无法恢复，可以从项目列表继续。${error.message}`); }
});
