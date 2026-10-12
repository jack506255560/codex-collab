const $ = (id) => document.getElementById(id);
let currentId, pending, discovery, timer, busy = false;
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
    for (const [label, ok, wait] of [['项目 MCP 和 Skill', true, '待配置'], ['企业微信机器人', value.runner?.wecom === 'authenticated', value.runner?.online ? '连接中' : '已停止'], ['目标 Codex 对话', !!value.desktop?.binding, '待绑定'], ['对话实际轮询', value.poll_recent, value.poll_observed ? '最近未观察到轮询' : '待观察']]) {
      const row = document.createElement('div'); row.className = 'check'; const badge = text('span', ok ? '已就绪' : wait); badge.className = `badge${ok ? '' : ' pending'}`; row.append(text('span', label), badge); $('checks').append(row);
    }
    $('checks').append(text('p', '轮询状态来自实际调用记录。自动化是否启用，请在绑定对话的 Codex 自动化中确认。'));
  } else {
    const phases = { imported: '接入包已导入，等待群身份验证。', initializing: '团队初始化尚未完成。', configuring: '正在配置本机项目。', verified: '正在提交入队申请。', waiting: '申请已提交，请管理员刷新工作台并确认，然后点击继续。' };
    $('progress').append(text('p', phases[value.phase] || value.phase), button(value.phase === 'imported' ? '连接分配的机器人' : '继续接入', async () => {
      if (value.phase === 'imported') { pending = { type: 'member', id }; await verifyView(await api('discovery', { profile_id: id })); }
      else { await api('resume', { id }); await loadProfile(id); }
    }));
  }
  if (value.error) notice(value.error);
  $('members').replaceChildren(); $('routes').replaceChildren();
  for (const member of value.members || []) $('members').append(text('p', `${member.id} · ${member.role === 'admin' ? '管理员' : '成员'} · ${member.capabilities.join(', ')}`));
  for (const [capability, candidates] of Object.entries(value.routes || {})) $('routes').append(text('p', `${capability}：${candidates.join(' → ')}（首选 → 候补）`));
  $('exports').replaceChildren(); $('requests').replaceChildren();
  for (const invitation of value.exports || []) {
    const row = document.createElement('div'); row.className = 'card'; row.append(text('span', `${invitation.agent_id} · 有效至 ${new Date(invitation.expires_at).toLocaleDateString()}`));
    const link = text('a', '下载加密接入包'); link.href = `/api/export?id=${id}&invite=${invitation.invite_id}`; link.download = invitation.filename; row.append(link); $('exports').append(row);
  }
  for (const request of value.requests || []) {
    const row = document.createElement('div'); row.className = 'card'; row.append(text('span', `${request.agent_id} · ${request.capabilities.join(', ')} · userid: ${request.userid || '只接通知'}`), button('确认此成员入队', async () => { await api('approve', { id, request_id: request.request_id }); await loadProfile(id); })); $('requests').append(row);
  }
  if (!(value.requests || []).length) $('requests').append(text('p', '暂无待确认申请。'));
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => action(async () => { clearInterval(timer); show(button.dataset.view); if (button.dataset.view === 'home') await overview(); });
$('admin-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const input = values(event.target); input.test_argv = JSON.parse(input.test_argv); pending = { type: 'admin', input }; const session = await api('discovery', { bot_id: input.bot_id, secret: input.secret, repo: input.repo }); pending.credentials = { bot_id: input.bot_id, secret: input.secret, repo: input.repo }; delete pending.input.secret; event.target.elements.secret.value = ''; await verifyView(session); }); };
$('join-form').onsubmit = (event) => { event.preventDefault(); action(async () => { const input = values(event.target); input.content = await input.file.text(); delete input.file; const profile = await api('import', input); event.target.elements.password.value = ''; currentId = profile.id; pending = { type: 'member', id: profile.id }; await verifyView(await api('discovery', { profile_id: profile.id })); }); };
$('retry-code').onclick = () => action(async () => { await verifyView(await api('discovery', pending.type === 'member' ? { profile_id: pending.id } : pending.credentials)); });
$('confirm-code').onclick = () => action(async () => {
  const session = await api(`discovery?id=${discovery.id}`);
  if (session.status !== 'verified') { updateConnection(session); throw new Error('请先完成群验证码验证。'); }
  clearInterval(timer);
  try {
    const profile = pending.type === 'admin' ? await api('admin', { ...pending.input, discovery_id: discovery.id }) : await api('verify', { id: pending.id, discovery_id: discovery.id });
    pending = null; await loadProfile(profile.id);
  } catch (error) {
    // The server persists setup before Git/MCP work, so resume from that profile after an interruption.
    const profiles = (await api('overview')).profiles;
    const profile = profiles.find((value) => pending.type === 'member' ? value.id === pending.id : value.agent_id === pending.input.agent_id && value.role === 'admin');
    if (profile) { pending = null; await loadProfile(profile.id); notice(`${error.message} 可在此继续接入。`); }
    else throw error;
  }
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
