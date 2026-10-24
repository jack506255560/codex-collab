const $ = (selector) => document.querySelector(selector);
const icons = {
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-10 12 10 6 10-6M2 12l10 6 10-6"/>',
  bag: '<path d="M5 7h14l2 14H3L5 7Zm3 0V5a4 4 0 0 1 8 0v2"/>',
  bot: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4M1 12v4m22-4v4M8 12h.01M16 12h.01M9 16h6"/>',
  wecom: '<path d="M21 10c0 4-4 7-9 7H8l-5 3 1-5C2 14 1 12 1 10c0-4 4-7 10-7s10 3 10 7Z"/><path d="m7 9 3 3 6-6"/>',
  chat: '<path d="M20 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8Z"/><path d="m8 10 3 3 5-6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>'
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.folder}</svg>`;
const projects = [
  { id: 'collab', name: 'codex-collab', description: '和团队里的 Codex 一起工作', icon: 'code', color: 'mint', repo: 'example-team/codex-collab', agents: [
    { name: '我的开发助手', role: '全栈开发', mine: true, ready: true },
    { name: '我的审查助手', role: '代码审查', mine: true, ready: true },
    { name: '后端助手', role: '后端开发', mine: false, ready: true }
  ] },
  { id: 'commerce', name: 'commerce-platform', description: '把想法变成下一次交付', icon: 'bag', color: 'blue', repo: 'example-team/commerce-platform', agents: [
    { name: '我的前端助手', role: '前端开发', mine: true, ready: true },
    { name: '服务端助手', role: '后端开发', mine: false, ready: true },
    { name: '测试助手', role: '测试验证', mine: false, ready: true }
  ] },
  { id: 'design', name: 'design-system', description: '打磨每一个小小的界面', icon: 'layers', color: 'sand', repo: 'example-team/design-system', agents: [
    { name: '我的界面助手', role: '前端开发', mine: true, ready: false },
    { name: '组件助手', role: '组件开发', mine: false, ready: true }
  ] }
];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let activeProject = projects[0];
let setup = { mode: 'connect', selected: false, copied: false, bot: 'demo-assistant', secret: 'demo-key', password: '' };
let transitionId = 0;
let toastTimer;
let route = '';
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const stepProgress = (step) => `<div class="step-progress" aria-label="第 ${step + 1} 步，共 3 步">${[0,1,2].map(i => `<span class="${i <= step ? 'filled' : ''}" ${i === step ? 'aria-current="step"' : ''}></span>`).join('')}</div>`;
function art(kind, color = '') {
  return `<div class="scene-art ${kind} ${color}" aria-hidden="true"><span class="art-halo"></span><span class="art-tile">${icon(kind === 'welcome' ? 'code' : kind === 'success' ? 'check' : kind)}</span>${kind === 'welcome' ? `<span class="art-small">${icon('chat')}</span><span class="art-spark"></span>` : ''}</div>`;
}
function hero(title, description, artKind = '') {
  return `${artKind ? art(artKind) : ''}<div class="intro"><h1 tabindex="-1">${title}</h1><p>${description}</p></div>`;
}
function home() {
  return `<section class="home">${hero('让 Codex 组队工作。', '在企业微信群里，连接你和同事的 Codex 会话，按角色分工、接力完成任务。', 'welcome')}
    <div class="project-list">${projects.map((project, i) => `<a class="project-entry" style="--order:${i}" href="#project/${project.id}"><span class="project-icon ${project.color}">${icon(project.icon)}</span><span class="project-copy"><strong>${project.name}</strong><span>${project.description}</span></span><span class="entry-arrow">${icon('arrow')}</span></a>`).join('')}</div>
    <div class="home-actions"><button class="button primary" data-action="connect">${icon('plus')}接入一个项目</button><button class="quiet-button" data-action="invite">接受同事的邀请${icon('arrow')}</button></div>
  </section>`;
}
function projectView(project) {
  return `<section class="project-scene"><a class="back-link" href="#home">${icon('back')}所有项目</a>
    ${art(project.icon, project.color)}${hero(project.name, '你的机器人和同事，都在这里。')}
    <div class="agent-list">${project.agents.map((agent, i) => `<div class="agent-row" style="--order:${i}"><span class="agent-icon ${agent.mine ? 'owned' : ''}">${icon('bot')}</span><span class="agent-copy"><strong>${agent.name}${agent.mine ? '<span class="mine-tag">我的</span>' : ''}</strong><span>${agent.role}${!agent.mine ? ' · 由同事管理' : ''}</span></span>${!agent.ready ? '<button class="small-link" data-action="bind">完成连接' + icon('arrow') + '</button>' : agent.mine ? '<button class="agent-action" data-action="manage" aria-label="查看' + agent.name + '">' + icon('chevron') + '</button>' : ''}</div>`).join('')}</div>
    <div class="project-actions"><button class="button primary" data-action="add-agent">${icon('plus')}添加我的机器人</button><button class="quiet-button" data-action="project-info">查看项目信息</button></div>
    <div id="project-info" class="disclosure" hidden><span>Git 仓库</span><code>${project.repo}</code><span>协作方式</span><span>企业微信</span></div>
  </section>`;
}
function setupView(mode, step) {
  const invite = mode === 'invite';
  const title = step === 0 ? invite ? '加入同事的项目。' : '从一个项目开始。' : step === 1 ? invite ? '是这个项目，对吗？' : '连上你的企微机器人。' : '最后，连接你的对话。';
  const description = step === 0 ? invite ? '选择同事发来的接入包，信息会自动填好。' : '选择电脑里已有的项目，其他信息交给我们。' : step === 1 ? invite ? '确认一下，再选择它在你电脑里的位置。' : '只需要填入机器人提供的两项信息。' : '在你想用于协作的 Codex 对话里，发送连接指令。';
  let content;
  if (step === 0) {
    content = `<button class="pick-area ${setup.selected ? 'selected' : ''}" data-action="pick">${setup.selected ? `<span class="selection-check">${icon('check')}</span><strong>${invite ? '团队项目接入包.json' : activeProject.name}</strong><span>${invite ? '已读取演示接入包' : '已识别演示仓库，使用默认分支'}</span>` : `${icon(invite ? 'mail' : 'folder')}<strong>${invite ? '选择接入包' : '选择项目文件夹'}</strong><span>${invite ? '使用示例 .json 文件体验' : '使用示例项目体验'}</span>`}</button>${invite && setup.selected ? `<label class="field">接入包密码<input data-field="password" type="password" value="${escapeHtml(setup.password)}" placeholder="同事单独发给你的密码" autocomplete="off"></label>` : ''}`;
  } else if (step === 1) {
    content = invite ? `<div class="selected-project"><span class="project-icon ${activeProject.color}">${icon(activeProject.icon)}</span><div><strong>${activeProject.name}</strong><span>${activeProject.repo}</span></div><span class="selection-check">${icon('check')}</span></div><label class="field">本机项目目录<input data-field="directory" value="${escapeHtml(setup.directory || '~/Projects/' + activeProject.name)}" aria-label="本机项目目录"></label>` : `<div class="credentials"><label class="field">Bot ID<input data-field="bot" value="${escapeHtml(setup.bot)}" placeholder="填写 Bot ID" autocomplete="off" autocapitalize="none" spellcheck="false"></label><label class="field">Secret<input data-field="secret" value="${escapeHtml(setup.secret)}" type="password" placeholder="填写 Secret" autocomplete="off"></label></div><button class="help-link" data-action="help">这两项在哪里找到？</button><p id="field-help" class="help-note" hidden>在企业微信的智能机器人配置中查看 Bot ID 和 Secret。此处已填入演示值，无需真实凭证。</p>`;
  } else {
    content = `<div class="binding-illustration" aria-hidden="true"><span class="binding-node">${icon('wecom')}</span><span class="binding-line"><i></i><i></i><i></i></span><span class="binding-node codex-node">⌘</span></div><p class="binding-caption">${setup.copied ? '把指令粘贴到对话里，就差这一步。' : '复制指令 → 粘贴到对话 → 完成'}</p><button class="help-link" data-action="show-command">查看连接指令</button><div id="binding-command" class="command-preview" hidden><code>${escapeHtml(bindingCommand())}</code></div>`;
  }
  const disabled = step === 0 && !setup.selected;
  const action = step === 2 && !setup.copied ? 'copy' : 'next';
  const buttonText = step === 2 ? setup.copied ? '我已发送，完成演示' : '复制连接指令' : step === 1 && !invite ? '连接 · 演示' : '继续';
  return `<section class="setup-scene"><button class="back-link" data-action="previous">${icon('back')}${step === 0 ? '返回' : '上一步'}</button>${stepProgress(step)}${hero(title, description, step === 0 ? invite ? 'mail' : 'folder' : step === 1 ? invite ? activeProject.icon : 'wecom' : 'chat')}<div class="step-content">${content}</div><div class="step-actions"><button class="button primary continue-button" data-action="${action}" ${disabled ? 'disabled' : ''}>${icon(step === 2 && !setup.copied ? 'copy' : 'arrow')}<span>${buttonText}</span></button><span class="step-count">${String(step + 1).padStart(2, '0')} / 03</span></div></section>`;
}
function successView() {
  return `<section class="success-scene">${hero('就这么简单。', '接入流程体验完成，去看看你的项目吧。', 'success')}<div class="success-project"><span class="project-icon ${activeProject.color}">${icon(activeProject.icon)}</span><div><strong>${activeProject.name}</strong><span>我的开发助手 · 演示连接完成</span></div></div><a class="button primary" href="#project/${activeProject.id}">进入项目${icon('arrow')}</a><a class="quiet-button" href="#home">回到首页</a></section>`;
}
function bindingCommand() { return `【设计预览，请勿执行】将 ${activeProject.name} 的“我的开发助手”绑定到当前 Codex 对话。`; }
async function showScene(html) {
  const id = ++transitionId;
  const scene = $('#scene');
  scene.getAnimations().forEach(animation => animation.cancel());
  if (scene.children.length && !reduceMotion.matches) {
    await scene.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-7px)' }], { duration: 120, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
    if (id !== transitionId) return;
  }
  scene.getAnimations().forEach(animation => animation.cancel());
  scene.innerHTML = html;
  scene.querySelector('h1')?.focus({ preventScroll: true });
  if (!reduceMotion.matches) scene.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 360, easing: 'cubic-bezier(.2,.7,.2,1)' });
}
function navigate() {
  route = location.hash || '#home';
  const projectMatch = /^#project\/(\w+)$/.exec(route);
  const setupMatch = /^#(connect|invite)\/([0-2])$/.exec(route);
  if (projectMatch) {
    activeProject = projects.find(p => p.id === projectMatch[1]) || projects[0];
    showScene(projectView(activeProject));
  } else if (setupMatch) {
    setup.mode = setupMatch[1];
    showScene(setupView(setup.mode, Number(setupMatch[2])));
  } else if (route === '#done') showScene(successView());
  else showScene(home());
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function startSetup(mode, step = 0, keepProject = false) {
  if (!keepProject) activeProject = projects[0];
  setup = { mode, selected: keepProject, copied: false, bot: 'demo-assistant', secret: 'demo-key', password: '' };
  location.hash = `${mode}/${step}`;
}
function setTheme(value) {
  const theme = ['day', 'night'].includes(value) ? value : 'day';
  document.body.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme)));
  const url = new URL(location.href); url.searchParams.set('theme', theme); history.replaceState(null, '', url);
}
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3200);
}
document.addEventListener('input', event => { if (event.target.dataset.field) setup[event.target.dataset.field] = event.target.value; });
document.addEventListener('click', async event => {
  const themeButton = event.target.closest('[data-theme-choice]');
  if (themeButton) { setTheme(themeButton.dataset.themeChoice); return; }
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  const match = /^#(connect|invite)\/([0-2])$/.exec(route);
  const step = match ? Number(match[2]) : 0;
  if (action === 'connect' || action === 'invite') startSetup(action);
  if (action === 'add-agent') startSetup('connect', 1, true);
  if (action === 'bind') startSetup('connect', 2, true);
  if (action === 'pick') {
    setup.selected = true;
    button.classList.add('selected');
    button.innerHTML = `<span class="selection-check">${icon('check')}</span><strong>${setup.mode === 'invite' ? '团队项目接入包.json' : activeProject.name}</strong><span>${setup.mode === 'invite' ? '已读取演示接入包' : '已识别演示仓库，使用默认分支'}</span>`;
    if (setup.mode === 'invite' && !$('.field')) button.insertAdjacentHTML('afterend', '<label class="field">接入包密码<input data-field="password" type="password" placeholder="同事单独发给你的密码" autocomplete="off"></label>');
    $('.continue-button').disabled = false;
    if (!reduceMotion.matches) button.animate([{ transform: 'scale(.985)' }, { transform: 'scale(1)' }], { duration: 250, easing: 'ease-out' });
  }
  if (action === 'previous') location.hash = step ? `${setup.mode}/${step - 1}` : 'home';
  if (action === 'next') location.hash = step === 2 ? 'done' : `${setup.mode}/${step + 1}`;
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(bindingCommand());
      setup.copied = true;
      $('.binding-caption').textContent = '指令已复制。粘贴到你的 Codex 对话里。';
      button.dataset.action = 'next'; button.innerHTML = `${icon('check')}<span>我已发送，完成演示</span>`;
    } catch {
      $('#binding-command').hidden = false;
      setup.copied = true;
      button.dataset.action = 'next'; button.innerHTML = `${icon('arrow')}<span>完成演示</span>`;
      toast('请手动复制下方演示指令');
    }
  }
  if (action === 'help') $('#field-help').hidden = !$('#field-help').hidden;
  if (action === 'show-command') $('#binding-command').hidden = !$('#binding-command').hidden;
  if (action === 'project-info') $('#project-info').hidden = !$('#project-info').hidden;
  if (action === 'manage') toast('这是你的机器人；正式版本在这里继续管理。');
});
window.addEventListener('hashchange', navigate);
document.addEventListener('visibilitychange', () => {
  document.documentElement.dataset.pageHidden = String(document.hidden);
  $('#scene').getAnimations().forEach(animation => document.hidden ? animation.pause() : animation.play());
});
setTheme(new URLSearchParams(location.search).get('theme') || 'day');
navigate();
