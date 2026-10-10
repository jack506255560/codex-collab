import { resolve } from 'node:path';
import { GitTaskStore } from '../../packages/git-store/src.mjs';
import { Accounts } from './auth.mjs';
import { CollaborationService } from './service.mjs';
import { startHttp } from './http.mjs';
import { startFeishu } from './feishu.mjs';
import { startWecom } from './wecom.mjs';

const repo = process.env.COLLAB_REPO;
const accountsFile = process.env.COLLAB_ACCOUNTS_FILE;
if (!repo || !accountsFile) throw new Error('COLLAB_REPO and COLLAB_ACCOUNTS_FILE are required');
const accounts = await Accounts.fromFile(accountsFile);
const store = await new GitTaskStore({
  repo, dataDir: resolve(process.env.COLLAB_DATA_DIR || '.collab-data'),
  push: process.env.COLLAB_PUSH === '1'
}).init();
const senders = new Map();
const configured = (value) => typeof value === 'string' && value.trim().length > 0;
const hasWecom = configured(process.env.WECOM_BOT_ID) || configured(process.env.WECOM_BOT_SECRET);
const hasFeishu = configured(process.env.FEISHU_APP_ID) || configured(process.env.FEISHU_APP_SECRET);
if (hasWecom && (!configured(process.env.WECOM_BOT_ID) || !configured(process.env.WECOM_BOT_SECRET) || !configured(process.env.WECOM_CHAT_IDS))) throw new Error('WECOM_BOT_ID, WECOM_BOT_SECRET and WECOM_CHAT_IDS must all be set');
if (hasFeishu && (!configured(process.env.FEISHU_APP_ID) || !configured(process.env.FEISHU_APP_SECRET) || !configured(process.env.FEISHU_CHAT_IDS))) throw new Error('FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_CHAT_IDS must all be set');
const service = new CollaborationService(store, {
  repoId: process.env.COLLAB_REPO_ID || 'jack506255560/codex-collab-demo',
  defaultReviewer: process.env.COLLAB_DEFAULT_REVIEWER || accounts.users.find((u) => u.role === 'admin')?.id,
  users: accounts.users,
  notify: async (task, type) => {
    const target = task.spec.source?.chat_id ? task.spec.source : task.events.findLast((event) => event.chat_id);
    if (!target?.chat_id) return;
    const send = senders.get(target.channel || 'feishu');
    if (!send) return;
    try { await send(target.chat_id, `[Codex Collab] ${task.spec.id} ${type}: ${task.state.status}`); }
    catch { console.error('Chat notification delivery failed; task event was still committed'); }
  }
});
const server = await startHttp({ service, accounts, host: process.env.COLLAB_HOST || '127.0.0.1', port: Number(process.env.COLLAB_PORT || 38765) });
console.log(`Codex Collab HTTP listening on ${server.address().address}:${server.address().port}`);
if (hasFeishu) {
  const bridge = await startFeishu({ service, accounts, appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET,
    allowedChatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean) });
  senders.set('feishu', bridge.send);
}
if (hasWecom) {
  const bridge = startWecom({ service, accounts, botId: process.env.WECOM_BOT_ID, secret: process.env.WECOM_BOT_SECRET,
    allowedChatIds: process.env.WECOM_CHAT_IDS.split(',').map((id) => id.trim()).filter(Boolean) });
  senders.set('wecom', bridge.send);
}
if (!hasWecom && !hasFeishu) console.log('Chat disabled: configure Feishu or WeCom credentials and allowed group IDs');
