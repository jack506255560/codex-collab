import { resolve } from 'node:path';
import { GitTaskStore } from '../../packages/git-store/src.mjs';
import { Accounts } from './auth.mjs';
import { CollaborationService } from './service.mjs';
import { startHttp } from './http.mjs';
import { startFeishu } from './feishu.mjs';

const repo = process.env.COLLAB_REPO;
const accountsFile = process.env.COLLAB_ACCOUNTS_FILE;
if (!repo || !accountsFile) throw new Error('COLLAB_REPO and COLLAB_ACCOUNTS_FILE are required');
const accounts = await Accounts.fromFile(accountsFile);
const store = await new GitTaskStore({
  repo, dataDir: resolve(process.env.COLLAB_DATA_DIR || '.collab-data'),
  push: process.env.COLLAB_PUSH === '1'
}).init();
let feishuSend = async () => {};
const service = new CollaborationService(store, {
  repoId: process.env.COLLAB_REPO_ID || 'jack506255560/codex-collab-demo',
  defaultReviewer: process.env.COLLAB_DEFAULT_REVIEWER || accounts.users.find((u) => u.role === 'admin')?.id,
  users: accounts.users,
  notify: async (task, type) => {
    const chat = task.spec.source?.chat_id || task.events.findLast((event) => event.chat_id)?.chat_id;
    if (chat) await feishuSend(chat, `[Codex Collab] ${task.spec.id} ${type}: ${task.state.status}`);
  }
});
const server = await startHttp({ service, accounts, host: process.env.COLLAB_HOST || '127.0.0.1', port: Number(process.env.COLLAB_PORT || 38765) });
console.log(`Codex Collab HTTP listening on ${server.address().address}:${server.address().port}`);
if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) {
  const bridge = await startFeishu({ service, accounts, appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET,
    allowedChatIds: (process.env.FEISHU_CHAT_IDS || '').split(',').filter(Boolean) });
  feishuSend = bridge.send;
} else {
  console.log('Feishu disabled: set FEISHU_APP_ID, FEISHU_APP_SECRET and FEISHU_CHAT_IDS to enable it');
}
