const $ = (id) => document.getElementById(id);
let currentId, pending, discovery, timer, busy = false, reviewVersion = null, ownAdminId;
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
function show(view) { for (const section of document.querySelectorAll('main>section')) section.hidden = section.id !== view; }
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
  const value = await api('overview'); $('profiles').replaceChildren();
  if (!value.profiles.length) $('profiles').append(text('p', '还没有接入项目。管理员选择“初始化团队”，成员选择“加入团队”。'));
  for (const profile of value.profiles) {
    const card = document.createElement('div'); card.className = 'card'; const info = document.createElement('div');
    info.append(text('strong', `${profile.agent_id} · ${profile.role === 'admin' ? '管理员' : '成员'}`), text('p', profile.repo));
    card.append(info, button('打开项目', () => loadProfile(profile.id))); $('profiles').append(card);
  }
}
async function verifyView(session) {
  discovery = session; show('verification'); $('code').textContent = session.message; updateConnection(session);
  clearInterval(timer); timer = setInterval(async () => { if (busy) return; try { const value = await api(`discovery?id=${session.id}`); updateConnection(value); if (['verified', 'failed', 'expired', 'disconnected'].includes(value.status)) clearInterval(timer); } catch (error) { clearInterval(timer); notice(error.message); } }, 2000);
}
function updateConnection(value) { discovery = value; $('retry-code').hidden = !['failed', 'expired', 'disconnected'].includes(value.status); const labels = { connecting: '正在连接企业微信…', authenticated: '机器人已连接，请发送下面的验证码。', verified: '群验证成功，点击继续完成配置。', failed: '连接失败，请检查凭据。', expired: '验证码已过期，请重新连接。', disconnected: '连接已断开，请重新连接。' }; $('connection').textContent = value.error || labels[value.status] || value.status; }
async function loadProfile(id) {
  currentId = id; show('profile'); let value;
  try { value = await api(`profile?id=${id}`); } catch (error) { value = await api(`profile?id=${id}&local=1`); notice(`团队同步暂未成功，本机状态仍可查看。${error.message}`); }
  $('profile-title').textContent = `${value.agent_id} · ${value.role === 'admin' ? '管理员' : '成员'}`; $('profile-repo').textContent = value.repo;
  $('profile-diagnostics').hidden = !value.config_path; $('config-path').textContent = value.config_path || '';
  $('checks').replaceChildren(); $('progress').replaceChildren(); $('binding').hidden = value.phase !== 'ready'; $('runner-actions').hidden = value.phase !== 'ready'; $('admin-tools').hidden = value.role !== 'admin' || value.phase !== 'ready';
  if (value.phase === 'ready') {
    $('binding-text').textContent = value.binding_prompt;
    for (const [label, ok, wait] of [['项目 MCP', value.project_setup?.mcp_configured, '待配置'], ['项目 Skill', value.project_setup?.skill_installed, '待配置'], ['企业微信机器人', value.runner?.wecom === 'authenticated', value.runner?.online ? '连接中' : '已停止'], ['目标 Codex 对话', !!value.desktop?.binding, '待绑定'], ['对话实际轮询', value.poll_recent, value.poll_observed ? '最近未观察到轮询' : '待观察'], ['可接收任务', value.can_receive_tasks, '尚未满足条件']]) {
      const row = document.createElement('div'); row.className = 'check'; const badge = text('span', ok ? '已就绪' : wait); badge.className = `badge${ok ? '' : ' pending'}`; row.append(text('span', label), badge); $('checks').append(row);
    }
    $('checks').append(text('p', '轮询状态来自实际调用记录。自动化是否启用，请在绑定对话的 Codex 自动化中确认。'));
  } else {
    const phases = { imported: '机器人配置已保存，等待群身份验证。', initializing: '团队初始化尚未完成。', configuring: '正在配置本机项目。', verified: '正在提交入队申请。', waiting: value.own_agent ? '申请已提交，点击继续完成本人机器人入队。' : '申请已提交，请管理员刷新工作台并确认，然后点击继续。' };
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
  renderReviewRules(value);
  $('exports').replaceChildren(); $('requests').replaceChildren();
  for (const invitation of value.exports || []) {
    const row = document.createElement('div'); row.className = 'card'; row.append(text('span', `${invitation.agent_id} · 有效至 ${new Date(invitation.expires_at).toLocaleDateString()}`));
    if (invitation.own_agent) row.append(button('继续接入我的机器人', async () => {
      const profile = await api('own-agent-resume', { id, invite_id: invitation.invite_id }); await connectMember(profile);
    }));
    else { const link = text('a', '下载加密接入包'); link.href = `/api/export?id=${id}&invite=${invitation.invite_id}`; link.download = invitation.filename; row.append(link); }
    $('exports').append(row);
  }
  for (const request of value.requests || []) {
    const row = document.createElement('div'); row.className = 'card'; row.append(text('span', `${request.agent_id} · ${request.capabilities.join(', ')} · userid: ${request.userid || '只接通知'}`), button('确认此成员入队', async () => { await api('approve', { id, request_id: request.request_id }); await loadProfile(id); })); $('requests').append(row);
  }
  if (!(value.requests || []).length) $('requests').append(text('p', '暂无待确认申请。'));
}
function renderReviewRules(profile) {
  $('review-rules').replaceChildren(); reviewVersion = null;
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
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => action(async () => { clearInterval(timer); show(button.dataset.view); if (button.dataset.view === 'home') await overview(); });
$('admin-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const input = values(event.target); try { input.test_argv = JSON.parse(input.test_argv); } catch { throw new Error('验证命令必须是 JSON 字符串数组，例如 [\"npm\",\"test\"]。'); } if (!Array.isArray(input.test_argv) || !input.test_argv.length || input.test_argv.length > 32 || input.test_argv.some((part) => typeof part !== 'string' || !part || part.length > 2000)) throw new Error('验证命令必须是 JSON 字符串数组，例如 ["npm","test"]。'); pending = { type: 'admin', input, existing_ids: (await api('overview')).profiles.map((profile) => profile.id) }; const session = await api('discovery', { bot_id: input.bot_id, secret: input.secret, repo: input.repo }); pending.credentials = { bot_id: input.bot_id, secret: input.secret, repo: input.repo }; delete pending.input.secret; event.target.elements.secret.value = ''; await verifyView(session); }); };
$('join-form').onsubmit = (event) => { event.preventDefault(); action(async () => {
  const input = values(event.target); input.content = await input.file.text(); delete input.file;
  const profile = await api('import', input); event.target.elements.password.value = ''; await connectMember(profile);
}); };
async function connectMember(profile) {
  currentId = profile.id;
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
$('retry-code').onclick = () => action(async () => { await verifyView(await api('discovery', pending.type === 'member' ? { profile_id: pending.id } : pending.credentials)); });
$('confirm-code').onclick = () => action(async () => {
  const session = await api(`discovery?id=${discovery.id}`);
  if (session.status !== 'verified') { updateConnection(session); throw new Error('请先完成群验证码验证。'); }
  clearInterval(timer);
  const setup = pending; let profile;
  try {
    profile = setup.type === 'admin' ? await api('admin', { ...setup.input, discovery_id: discovery.id }) : await api('verify', { id: setup.id, discovery_id: discovery.id });
  } catch (error) {
    // Setup may be persisted before Git/MCP work fails; recover the same profile.
    const profiles = (await api('overview')).profiles;
    profile = profiles.find((value) => setup.type === 'member' ? value.id === setup.id : value.agent_id === setup.input.agent_id.trim() && value.role === 'admin' && !setup.existing_ids.includes(value.id));
    if (!profile) throw error;
    pending = null; await loadProfile(profile.id); notice(`${error.message} 可在此继续接入。`); return;
  }
  pending = null; await loadProfile(profile.id);
});
$('existing-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const profile = await api('existing', values(event.target)); await loadProfile(profile.id); }); };
$('issue-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const input = values(event.target); input.id = currentId; input.prefer = event.target.elements.prefer.checked; input.commands_enabled = event.target.elements.commands_enabled.checked; await api('issue', input); event.target.reset(); await loadProfile(currentId); notice('接入包已生成。下载文件交给指定成员，密码请单独发送。'); }); };
$('refresh').onclick = () => action(() => loadProfile(currentId));
$('start').onclick = () => action(async () => { await api('runner', { id: currentId, command: 'start' }); await loadProfile(currentId); });
$('stop').onclick = () => action(async () => { await api('runner', { id: currentId, command: 'stop' }); await loadProfile(currentId); });
$('copy-config-path').onclick = () => action(() => navigator.clipboard.writeText($('config-path').textContent));
$('copy-code').onclick = () => action(() => navigator.clipboard.writeText($('code').textContent));
$('copy-binding').onclick = () => action(() => navigator.clipboard.writeText($('binding-text').textContent));
action(async () => { const token = location.hash.slice(1); if (token) { await api('session', { token }); history.replaceState(null, '', '/'); } await overview(); });
