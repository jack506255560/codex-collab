const $ = (id) => document.getElementById(id);
let currentId, pending, discovery, timer, busy = false, reviewVersion = null, reviewId, ownAdminId, resetPlan, resetDiscovery;
let repositoryPolicy, currentProjectId, currentProject, projectSignature, ownReturnProject;
let viewEpoch = 0, currentView = 'home', completing = false, deliveryTarget;
const storageKey = 'codex-collab-onboarding';
function remember(value) { try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch {} }
function remembered() { try { return JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { return null; } }
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
const guideStep = { admin: 0, join: 0, own: 0 };
let sceneAnimation;
function animateScene(node) {
  sceneAnimation?.cancel();
  if (!node?.animate || typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches || document.visibilityState === 'hidden') return;
  sceneAnimation = node.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 320, easing: 'cubic-bezier(.2,.75,.2,1)' });
}
function guidePanels(name) { return [...$(`${name}-form`).querySelectorAll('[data-wizard-panel]')]; }
function setGuide(name, step, focus = true) {
  const panels = guidePanels(name); if (!panels.length) return;
  guideStep[name] = step;
  for (const [index, panel] of panels.entries()) panel.hidden = index !== step;
  const label = step === 0 ? '继续 →' : name === 'join' ? '接入项目 →' : '连接机器人 →';
  $(`${name}-continue`).textContent = label;
  $(`${name}-step-count`).textContent = `${String(step + 1).padStart(2, '0')} / 04`;
  const progress = $(`${name}-step-progress`); progress.setAttribute('aria-label', `第 ${step + 1} 步，共 4 步`);
  for (const [index, marker] of [...progress.querySelectorAll('span')].entries()) {
    marker.className = index <= step ? 'filled' : '';
    if (index === step) marker.setAttribute('aria-current', 'step'); else marker.removeAttribute('aria-current');
  }
  if (focus) { globalThis.scrollTo?.({ top: 0, behavior: 'auto' }); animateScene(panels[step]); panels[step].querySelector('h1')?.focus({ preventScroll: true }); }
}
function revealField(field) {
  for (let node = field.parentElement; node; node = node.parentElement) if (node.tagName === 'DETAILS') node.open = true;
}
function validatePanel(panel, skipCommand = false) {
  for (const field of panel.querySelectorAll('input, select, textarea')) {
    if (!field.willValidate || field.closest('[hidden]') || skipCommand && field.id === 'test-command') continue;
    if (!field.checkValidity()) { revealField(field); field.reportValidity(); return false; }
  }
  return true;
}
async function advanceGuide(name) {
  const panels = guidePanels(name); if (!panels.length) return true;
  const step = guideStep[name];
  if (!validatePanel(panels[step], name === 'admin' && step === 0)) return false;
  if (step === 0) {
    if (name === 'admin') {
      const selected = await checkProject(); if (!selected) return false;
      if (selected.selection_required) throw new Error('请选择协作远程和业务基准分支，再继续。');
      if (!validatePanel(panels[0])) return false;
    }
    if (name === 'join' && !await inspectInvite()) return false;
    setGuide(name, 1); return false;
  }
  return true;
}
function show(view) {
  notice('');
  if (view !== 'profile' || currentView === 'profile') {
    $('delivery-panel').hidden = true; $('delivery-password').value = ''; $('delivery-instructions').textContent = '';
    $('reissue-secret').value = ''; $('reissue-form').hidden = true; deliveryTarget = null;
  }
  clearInterval(timer); clearTimeout(timer); viewEpoch++; currentView = view;
  for (const section of document.querySelectorAll('main>section')) section.hidden = section.id !== view;
  if (Object.hasOwn(guideStep, view)) setGuide(view, 0, false);
  globalThis.scrollTo?.({ top: 0, behavior: 'auto' });
  const section = $(view); animateScene(section); section.querySelector('h1, h2')?.focus?.({ preventScroll: true });
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value;
}
async function action(fn) {
  if (busy) return; busy = true; notice('');
  const buttons = new Map([...document.querySelectorAll('button')].map((button) => [button, button.disabled]));
  for (const button of buttons.keys()) button.disabled = true;
  document.body?.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (error) { notice(error.message); $('notice').scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); } finally {
    busy = false; for (const [button, disabled] of buttons) button.disabled = disabled;
    document.body?.removeAttribute('aria-busy');
  }
}
const values = (form) => Object.fromEntries(new FormData(form));
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function button(label, fn) { const node = text('button', label); node.onclick = () => action(fn); return node; }
async function overview() {
  const value = await api('overview');
  const hasWork = !!((value.projects || []).length || (value.drafts || []).length || (!value.projects && (value.profiles || []).length));
  if (value.defaults) {
    if (!$('admin-form').elements.repo.value) $('admin-form').elements.repo.value = value.defaults.repo || '';
    if (!$('admin-form').elements.display_name.value) $('admin-form').elements.display_name.value = value.defaults.display_name || '我的开发助手';
  }
  $('home-start-options').hidden = hasWork;
  $('home-actions').hidden = !hasWork;
  $('profiles').hidden = !hasWork;
  const detectedRepo = value.defaults?.repo?.trim() || '';
  $('detected-project').hidden = !detectedRepo;
  $('detected-project-path').textContent = detectedRepo;
  $('startup-status').textContent = value.startup?.enabled ? '后台服务已运行，登录时自动恢复已开启的连接。可关闭终端和浏览器。' : value.startup?.error || '后台工作台会保持连接；登录自启状态可用 codex-collab autostart status 查看。';
  $('profiles').replaceChildren(); $('removed-profiles').replaceChildren();
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
  for (const [index, project] of (value.projects || []).entries()) {
    const card = document.createElement('div'); card.className = 'card project-card'; card.style?.setProperty('--order', Math.min(index, 7));
    const info = document.createElement('div'); info.className = 'project-card-info';
    const icon = text('span', '⌘'); icon.className = 'project-icon'; icon.setAttribute?.('aria-hidden', 'true');
    info.append(icon, text('h3', project.name), text('p', '和团队里的 Codex 一起工作'));
    const open = button('→', () => loadProject(project.id)); open.setAttribute?.('aria-label', `打开项目 ${project.name}`);
    card.append(info, open); $('profiles').append(card);
  }
  for (const profile of value.projects ? [] : value.profiles) {
    const card = document.createElement('div'); card.className = 'card'; const info = document.createElement('div');
    info.append(text('strong', `${profile.display_name || profile.agent_id} · ${profile.role === 'admin' ? '管理员' : '成员'}`), text('p', profile.repo));
    card.append(info, button('打开项目', () => loadProfile(profile.id))); $('profiles').append(card);
  }
}
function connectionStatus(connection) {
  if (connection.has_error) return '需要检查';
  if (connection.phase !== 'ready') return ({ imported: '待群验证', waiting: '待管理员确认', verified: '正在入队', configuring: '正在配置', initializing: '正在初始化' })[connection.phase] || '待完成接入';
  if (connection.can_receive_tasks) return '已就绪';
  if (!connection.runner_online) return '连接已停止';
  if (!connection.bound) return '待绑定对话';
  if (!connection.poll_recent) return '等待对话轮询';
  return '连接检查中';
}
function renderProject(value) {
  currentProject = value;
  $('project-title').textContent = value.name;
  $('project-repository').textContent = value.repository;
  $('project-sync').textContent = value.sync_error || (value.sync_status === 'synced' ? '团队信息已同步。连接状态仅显示本机实际记录。' : value.sync_status === 'cached' ? '正在显示本机已验证的团队记录。' : '接入尚未完成，可以继续配置下面的机器人。');
  $('project-add-own').hidden = !value.admin_profile_id; $('project-settings').hidden = !value.admin_profile_id;
  const signature = JSON.stringify(value);
  if (signature === projectSignature) return;
  projectSignature = signature;
  $('project-agents').replaceChildren();
  for (const [index, agent] of value.agents.entries()) {
    const card = document.createElement('article'); card.className = `robot-card${agent.mine ? ' is-mine' : ''}`; card.style?.setProperty('--order', Math.min(index, 7));
    const heading = document.createElement('div'); heading.className = 'robot-title';
    const connection = agent.connections[0];
    const display = connection?.display_name;
    heading.append(text('h4', display || agent.agent_id));
    if (agent.mine) { const mine = text('span', '我的'); mine.className = 'badge mine-badge'; heading.append(mine); }
    card.append(heading, text('p', `${agent.role === 'admin' ? '管理员' : '成员'}${agent.capabilities.length ? ' · ' + agent.capabilities.join(' / ') : ''}`));
    if (agent.identity_conflict) { const warning = text('p', '本机身份与团队记录不一致，请检查原接入。'); warning.className = 'warning-text'; card.append(warning); }
    for (const local of agent.connections) {
      const details = document.createElement('div'); details.className = 'robot-connection';
      const status = text('span', connectionStatus(local)); status.className = `badge${local.can_receive_tasks ? ' ready-badge' : ' pending'}`;
      const open = button(local.phase === 'ready' && local.bound ? '查看 →' : '完成连接 →', () => loadProfile(local.id));
      open.className = 'quiet-button'; details.append(status, open);
      if (agent.connections.length > 1) { const path = text('p', local.repo); path.className = 'repository-path'; card.append(path); }
      card.append(details);
    }
    if (!agent.connections.length) { const note = text('p', agent.mine ? '我的机器人 · 未在本机接入' : '由同事维护'); note.className = 'muted'; card.append(note); }
    $('project-agents').append(card);
  }
}
async function refreshProjectView(id, epoch) {
  const value = await api(`project?id=${encodeURIComponent(id)}`);
  if (epoch === viewEpoch && currentView === 'project') renderProject(value);
}
function watchProject(id, epoch, delay = 15000) {
  timer = setTimeout(async () => {
    if (epoch !== viewEpoch || currentView !== 'project') return;
    if (!busy && document.visibilityState !== 'hidden') {
      try { await refreshProjectView(id, epoch); }
      catch (error) { if (epoch === viewEpoch) $('project-sync').textContent = `自动同步暂未成功，将重试。${error.message}`; }
    }
    if (epoch === viewEpoch) watchProject(id, epoch);
  }, delay);
}
async function loadProject(id) {
  currentProjectId = id; projectSignature = null; currentProject = null;
  remember({ project_id: id }); show('project'); const epoch = viewEpoch;
  $('project-title').textContent = '正在打开项目'; $('project-repository').textContent = '';
  $('project-agents').replaceChildren();
  $('project-add-own').hidden = true; $('project-settings').hidden = true; $('project-sync').textContent = '';
  try {
    const value = await api(`project?id=${encodeURIComponent(id)}&local=1`);
    if (epoch !== viewEpoch) return;
    renderProject(value); watchProject(id, epoch, 100);
  } catch (error) { if (epoch === viewEpoch) { show('home'); await overview(); throw error; } }
}
$('project-back').onclick = () => action(async () => { remember(null); show('home'); await overview(); });
$('project-refresh').onclick = () => action(() => refreshProjectView(currentProjectId, viewEpoch));
$('project-settings').onclick = () => action(async () => { await loadProfile(currentProject.admin_profile_id); $('admin-tools').open = true; });
$('project-add-own').onclick = () => action(async () => { ownAdminId = currentProject.admin_profile_id; ownReturnProject = currentProjectId; show('own'); });
$('profile-back').onclick = () => action(() => loadProject(currentProjectId));
async function openDraft(id) {
  const value = await api(`admin-draft?id=${id}`);
  if (value.profile) { pending = null; await loadProfile(value.profile.id); return; }
  pending = { type: 'admin', draft_id: id }; remember({ draft_id: id }); await verifyView(value);
}
async function verifyView(session) {
  discovery = session; show('verification'); $('copy-code').textContent = '复制群验证消息'; $('code').textContent = session.message; updateConnection(session);
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
  $('next-step').textContent = value.error ? '接入暂时停在这里。处理下方问题后点击“继续接入”。' : value.can_receive_tasks ? '已观察到实际轮询，可以在协作群 @ 机器人发送任务。请保持当前对话的协作自动化启用。' : value.phase === 'waiting' ? '申请已提交，正在自动等待管理员确认。管理员工作台会自动显示申请。' : value.phase !== 'ready' ? '按当前提示继续，完成后向导会自动进入下一步。' : stopped ? '机器人连接已停止。需要接任务时点击“启动机器人连接”。' : !value.desktop?.binding ? '在 Codex 打开此项目，加载项目 MCP 和 Skill，再把启用指令发到要绑定的对话。' : '对话已绑定，正在等待实际轮询记录。';
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
  repositoryPolicy = null; $('repository-policy-form').hidden = true;
  if (currentView !== 'profile' || currentId !== id) {
    $('admin-tools').open = false; $('connection-details').open = false;
    $('profile-heading').textContent = '正在读取连接…'; $('profile-art').dataset.state = 'waiting';
    for (const key of ['binding', 'profile-done', 'profile-start', 'admin-tools', 'pending-requests', 'profile-back']) $(key).hidden = true;
    for (const key of ['profile-title', 'profile-repo', 'next-step', 'config-path']) $(key).textContent = '';
    for (const key of ['checks', 'progress', 'setup-steps']) $(key).replaceChildren();
  }
  currentId = id; remember({ profile_id: id }); show('profile'); $('copy-binding').textContent = '复制启用指令'; const epoch = viewEpoch; let value;
  try { value = await api(`profile?id=${id}`); } catch (error) { value = await api(`profile?id=${id}&local=1`); notice(`团队同步暂未成功，本机状态仍可查看。${error.message}`); }
  if (epoch !== viewEpoch) return;
  if (value.phase === 'removed') { show('home'); await overview(); return; }
  currentProjectId = value.project_id || null;
  $('profile-back').hidden = !currentProjectId;
  renderProfile(value); watchProfile(id, epoch); return value;
}
function renderProfile(value, automatic = false) {
  const id = value.id; renderSteps(value);
  const ready = value.phase === 'ready', bound = !!value.desktop?.binding, complete = !!value.can_receive_tasks;
  $('profile-heading').textContent = complete ? '就这么简单。' : ready && !value.runner?.online ? '连接已暂停。' : ready && !bound ? '最后，连接你的对话。' : ready ? '对话已绑定。' : '正在准备你的项目。';
  const state = complete ? 'success' : 'waiting';
  if ($('profile-art').dataset.state !== state) $('profile-art').dataset.state = state;
  $('profile-step-progress').hidden = complete;
  $('profile-done').hidden = !ready || !bound;
  $('profile-start').hidden = !ready || !!value.runner?.online;
  const requests = value.requests || [];
  $('pending-requests').hidden = !requests.length;
  $('pending-requests').textContent = requests.length ? `${requests.length} 位同事等待你的确认 →` : '';

  $('reset-conversation').hidden = value.phase !== 'ready'; $('reset-robot').hidden = value.phase !== 'ready';
  $('profile-title').textContent = `${value.display_name && value.display_name !== value.agent_id ? `${value.display_name}（${value.agent_id}）` : value.agent_id} · ${value.role === 'admin' ? '管理员' : '成员'}`; $('profile-repo').textContent = `${value.repo}${value.base_branch ? ` · 基准：${value.remote_name || '远程'}/${value.base_branch}` : ''}`;
  $('profile-diagnostics').hidden = !value.config_path; $('config-path').textContent = value.config_path || '';
  $('checks').replaceChildren(); $('progress').replaceChildren(); $('binding').hidden = !ready || bound; $('runner-actions').hidden = value.phase !== 'ready'; $('diagnostic-actions').hidden = value.phase !== 'ready'; $('admin-tools').hidden = value.role !== 'admin' || value.phase !== 'ready';
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
for (const link of document.querySelectorAll('[data-view]')) link.onclick = (event) => {
  event.preventDefault();
  return action(async () => {
    if (resetPlan) { await api('reset-cancel', { id: resetPlan.id, preview_token: resetPlan.preview_token }); resetPlan = null; resetDiscovery = null; $('reset-secret').value = ''; }
    remember(null); show(link.dataset.view);
    if (link.dataset.view === 'home') await overview();
  });
};
function repoMode(prefix) {
  const clone = $(`${prefix}-repo-mode`).value === 'clone';
  $(`${prefix}-existing-repo`).hidden = clone; $(`${prefix}-clone-repo`).hidden = !clone;
  const fields = $(`${prefix}-form`).elements;
  if (fields.repo) fields.repo.required = !clone;
  if (prefix === 'admin' && fields.remote) fields.remote.required = clone;
}
for (const prefix of ['admin', 'join', 'own']) $(`${prefix}-repo-mode`).onchange = () => {
  repoMode(prefix);
  if (prefix === 'admin') clearProjectSelection();
};
function clearProjectSelection() {
  $('admin-remote-name').value = ''; $('admin-base-branch').value = ''; $('repository-options').hidden = true;
  $('project-recommendation').textContent = ''; $('project-check-status').textContent = '会自动识别仓库、默认分支和验证命令。';
}
async function checkProject() {
  const snapshot = values($('admin-form'));
  const selected = await api('project-check', snapshot);
  const current = values($('admin-form'));
  if (['repo_mode', 'repo', 'remote', 'destination', 'remote_name', 'base_branch'].some((key) => current[key] !== snapshot[key])) return;
  const form = $('admin-form'); form.elements.repo.value = selected.repo; $('admin-repo-mode').value = 'existing'; repoMode('admin');
  $('repository-options').hidden = false;
  for (const [id, options, chosen, placeholder] of [
    ['admin-remote-name', selected.remotes || [], selected.remote_name, '请选择协作远程'],
    ['admin-base-branch', selected.branches || [], selected.base_branch, '请选择业务基准分支'],
  ]) {
    const select = $(id); select.replaceChildren();
    const empty = text('option', placeholder); empty.value = ''; select.append(empty);
    for (const value of options) { const option = text('option', value); option.value = value; select.append(option); }
    select.value = chosen || '';
  }
  $('project-recommendation').textContent = selected.selection_required ? '请在下方选择协作远程或业务基准分支，再继续。' : `项目已检查：${selected.repo}。基准：${selected.remote_name}/${selected.base_branch}。${selected.tests.length ? '推荐：' + selected.tests.map((test) => test.command).join(' / ') + '，请确认或修改。' : '未找到常见测试入口，请填写适合项目的验证命令。'}`;
  if (!$('test-command').value && selected.tests.length) $('test-command').value = selected.tests[0].command;
  $('project-check-status').textContent = selected.selection_required ? '需要你确认一下分支设置。' : `已识别 ${selected.remote_name}/${selected.base_branch}${$('test-command').value ? ` · 验证：${$('test-command').value}` : ''}`;
  if (selected.selection_required || !$('test-command').value) $('project-options').open = true;
  return selected;
}
$('load-repository-settings').onclick = () => action(async () => {
  const id = currentId, value = await api('repository-settings', { id });
  if (id !== currentId || currentView !== 'profile') return;
  const select = $('team-base-branch'); select.replaceChildren();
  for (const branch of value.branches) { const option = text('option', branch); option.value = branch; select.append(option); }
  select.value = value.branches.includes(value.base_branch) ? value.base_branch : value.default_branch || '';
  repositoryPolicy = { id, expected_version: value.version }; $('repository-policy-form').hidden = false;
});
$('repository-policy-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!repositoryPolicy || repositoryPolicy.id !== currentId) throw new Error('请重新读取团队基准分支。');
  await api('repository-policy', { ...repositoryPolicy, base_branch: $('team-base-branch').value });
  await loadProfile(currentId); notice('团队基准分支已保存，同事和新增机器人会自动继承；已有任务保留原起始提交。');
}); };
$('check-project').onclick = () => action(checkProject);
for (const id of ['admin-repo', 'admin-remote', 'admin-destination']) $(id).onchange = () => {
  clearProjectSelection();
};
$('admin-remote-name').onchange = () => { $('admin-base-branch').value = ''; action(checkProject); };
$('admin-base-branch').onchange = () => action(checkProject);
$('admin-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!await advanceGuide('admin')) return;
  const input = values(event.target);
  const session = await api('admin-prepare', input); event.target.elements.secret.value = '';
  pending = { type: 'admin', draft_id: session.draft_id }; remember({ draft_id: session.draft_id }); await verifyView(session);
}); };
async function invitationInput(form) { const input = values(form); input.content = await input.file.text(); delete input.file; return input; }
async function inspectInvite() {
  $('invite-info').hidden = true; $('invite-summary').textContent = ''; $('invite-remote').textContent = '';
  const file = $('join-form').elements.file.files?.[0];
  const input = await invitationInput($('join-form'));
  const value = await api('inspect-invite', input);
  if ($('join-form').elements.password.value !== input.password || $('join-form').elements.file.files?.[0] !== file) return;
  $('invite-info').hidden = false; $('invite-summary').textContent = `${value.display_name || value.agent_id}（${value.agent_id}）· 职责：${value.capabilities.join('、')}${value.team_name ? ' · ' + value.team_name : ''}`;
  $('invite-remote').textContent = `${value.remote}${value.base_branch ? ` · 基准分支：${value.base_branch}（自动继承）` : ''}`;
  if (!$('join-form').elements.destination.value) $('join-form').elements.destination.value = value.suggested_repo;
  return value;
}
$('inspect-invite').onclick = () => action(inspectInvite);
for (const id of ['invite-file', 'invite-password']) $(id).onchange = () => {
  $('invite-info').hidden = true;
  $('invite-summary').textContent = ''; $('invite-remote').textContent = '';
};
$('join-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!await advanceGuide('join')) return;
  const profile = await api('import', await invitationInput(event.target)); event.target.elements.password.value = ''; await connectMember(profile);
}); };
async function connectMember(profile) {
  currentId = profile.id; remember({ profile_id: profile.id });
  if (profile.phase !== 'imported') { pending = null; await loadProfile(profile.id); return; }
  pending = { type: 'member', id: profile.id };
  try { await verifyView(await api('discovery', { profile_id: profile.id })); }
  catch (error) { await loadProfile(profile.id); throw error; }
}
$('add-own-agent').onclick = () => action(async () => { ownAdminId = currentId; ownReturnProject = null; show('own'); });
$('own-cancel').onclick = () => action(() => ownReturnProject ? loadProject(ownReturnProject) : loadProfile(ownAdminId));
$('own-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!await advanceGuide('own')) return;
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
$('run-diagnostics').onclick = () => action(async () => {
  const value = await api('diagnostics', { id: currentId }); $('diagnostic-result').replaceChildren();
  for (const check of value.checks) $('diagnostic-result').append(text('p', `${check.ok ? '✓' : '待处理'} ${check.label}${check.action ? '：' + check.action : ''}`));
  $('diagnostic-result').append(text('p', value.note));
});
$('repair-project').onclick = () => action(async () => {
  const value = await api('repair', { id: currentId }); await loadProfile(currentId); notice(value.next_step);
});
$('refresh').onclick = () => action(() => loadProfile(currentId));
$('start').onclick = () => action(async () => { await api('runner', { id: currentId, command: 'start' }); await loadProfile(currentId); });
$('stop').onclick = () => action(async () => { await api('runner', { id: currentId, command: 'stop' }); await loadProfile(currentId); });
$('copy-config-path').onclick = () => action(() => navigator.clipboard.writeText($('config-path').textContent));
$('copy-code').onclick = () => copyFeedback('copy-code', '已复制，去群里发送');
$('copy-binding-details').onclick = () => action(() => navigator.clipboard.writeText($('binding-details').textContent));
$('copy-binding').onclick = () => copyFeedback('copy-binding', '已复制，发到 Codex 对话');
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
  deliveryTarget = { id, invite_id: inviteId };
  $('delivery-password-label').hidden = !value.password; $('copy-password').hidden = !value.password;
  $('delivery-password-note').hidden = !!value.password;
  $('delivery-password-note').textContent = value.can_reissue ? '这份旧接入包未保存密码，无法从加密文件取回。请重新生成接入包与密码，再加入团队。' : '本机未保存这份接入包密码。成员已获批准，请使用现有配置；如需恢复，请使用原密码或更新机器人凭据。';
  $('delivery-download').href = `/api/export?id=${id}&invite=${inviteId}`;
  $('reissue-invite').hidden = !value.can_reissue; $('reissue-bot-id').value = value.bot_id || '';
  $('reissue-secret').value = ''; $('reissue-form').hidden = true; $('delivery-panel').hidden = false;
}
$('copy-delivery').onclick = () => action(() => navigator.clipboard.writeText($('delivery-instructions').textContent));
$('copy-password').onclick = () => action(() => navigator.clipboard.writeText($('delivery-password').value));
$('reissue-invite').onclick = () => action(async () => { $('reissue-form').hidden = false; $('reissue-secret').value = ''; clearTimeout(timer); });
$('reissue-cancel').onclick = () => action(async () => { $('reissue-form').hidden = true; $('reissue-secret').value = ''; watchProfile(currentId, viewEpoch); });
$('reissue-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  if (!deliveryTarget || deliveryTarget.id !== currentId) throw new Error('请重新打开该机器人的接入说明。');
  const target = { ...deliveryTarget };
  let result;
  try { result = await api('reissue-invite', { ...target, secret: $('reissue-secret').value }); }
  finally { $('reissue-secret').value = ''; }
  await loadProfile(target.id); await showDelivery(target.id, result.invite_id);
  notice('新接入包与密码已生成，旧包已失效。请下载新文件，在“加入团队”中使用新密码。');
}); };
$('hide-delivery').onclick = () => action(async () => { $('delivery-panel').hidden = true; $('delivery-password').value = ''; $('reissue-secret').value = ''; $('reissue-form').hidden = true; deliveryTarget = null; watchProfile(currentId, viewEpoch); });
async function copyFeedback(id, copiedLabel) {
  return action(async () => {
    await navigator.clipboard.writeText($(id === 'copy-code' ? 'code' : 'binding-text').textContent);
    $(id).textContent = copiedLabel;
    animateScene($(id));
  });
}
for (const name of Object.keys(guideStep)) {
  $(`${name}-back`).onclick = () => {
    if (busy) return;
    if (guideStep[name] > 0) { notice(''); setGuide(name, guideStep[name] - 1); }
    else if (name === 'own') return $('own-cancel').onclick();
    else return action(async () => { show('home'); await overview(); });
  };
}
$('profile-done').onclick = () => action(async () => { if (currentProjectId) await loadProject(currentProjectId); else { remember(null); show('home'); await overview(); } });
$('profile-start').onclick = () => $('start').onclick();
$('pending-requests').onclick = () => { $('admin-tools').open = true; $('requests').scrollIntoView?.({ block: 'center', behavior: 'auto' }); };
function initializeAppearance() {
  if (!document.body) return;
  function apply(theme) {
    if (!['day', 'night'].includes(theme)) theme = 'day';
    document.body.dataset.theme = theme;
    for (const choice of document.querySelectorAll('[data-theme-choice]')) choice.setAttribute('aria-pressed', String(choice.dataset.themeChoice === theme));
    try { localStorage.setItem('codex-collab-theme', theme); } catch {}
  }
  let theme = 'night';
  try { theme = new URL(location.href).searchParams.get('theme') || localStorage.getItem('codex-collab-theme') || theme; } catch {}
  apply(theme);
  for (const choice of document.querySelectorAll('[data-theme-choice]')) choice.onclick = () => apply(choice.dataset.themeChoice);
  for (const name of Object.keys(guideStep)) repoMode(name);
}
initializeAppearance();
assignmentRow();
action(async () => {
  const token = location.hash.slice(1); if (token) { await api('session', { token }); history.replaceState(null, '', '/'); }
  const saved = remembered(); show('home'); await overview();
  try { if (saved?.draft_id) await openDraft(saved.draft_id); else if (saved?.profile_id) { const value = await loadProfile(saved.profile_id); if (value?.phase === 'imported') await connectMember(value); } else if (saved?.project_id) await loadProject(saved.project_id); }
  catch (error) { remember(null); show('home'); notice(`上次接入暂时无法恢复，可以从项目列表继续。${error.message}`); }
});

function updateMotion() { if (document.documentElement) document.documentElement.dataset.pageHidden = String(document.visibilityState === 'hidden'); }
document.addEventListener?.('visibilitychange', updateMotion); updateMotion();
