import { SetupError } from './errors.mjs';
import AiBot from '@wecom/aibot-node-sdk';
import { randomInt, randomUUID } from 'node:crypto';
import { wecomDiagnostic } from '../../scripts/wecom-diagnostic.mjs';

/** Short-lived connection; credentials and group messages never enter HTTP output. */
export class BotDiscovery {
  constructor({ clientFactory = (options) => new AiBot.WSClient(options), now = Date.now } = {}) {
    this.clientFactory = clientFactory; this.now = now; this.sessions = new Map();
  }
  begin({ bot_id, secret, chat_ids }) {
    if (typeof bot_id !== 'string' || !bot_id.trim() || typeof secret !== 'string' || !secret) throw new SetupError('请填写机器人 Bot ID 和 Secret。');
    this.closeAll();
    const id = randomUUID(); const code = String(randomInt(100000, 1000000));
    const state = { id, code, bot_id: bot_id.trim(), secret, expected_chats: chat_ids, expires: this.now() + 300000, status: 'connecting', proof: null, client: null, timer: null };
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = this.clientFactory({ botId: state.bot_id, secret, logger }); state.client = client;
    client.on('authenticated', () => { state.status = 'authenticated'; });
    client.on('error', (error) => { state.status = 'failed'; state.error = wecomDiagnostic(error); });
    client.on('disconnected', () => { if (!state.proof && !['expired', 'failed'].includes(state.status)) state.status = 'disconnected'; });
    client.on('message.text', (frame) => {
      if (this.now() > state.expires || state.proof || state.status !== 'authenticated') return;
      const body = frame?.body;
      const text = body?.text?.content?.trim().replace(/^(?:@[^\s@]{1,40}\s+)+/, '');
      if (body?.chattype !== 'group' || !body.chatid || !body.from?.userid || text !== `协作 接入 ${code}` || state.expected_chats && !state.expected_chats.includes(body.chatid)) return;
      state.proof = { chatid: body.chatid, userid: body.from.userid }; state.status = 'verified';
      client.disconnect();
    });
    state.timer = setTimeout(() => { if (!state.proof) { state.status = 'expired'; client.disconnect(); } }, 300000); state.timer.unref();
    this.sessions.set(id, state); client.connect(); return this.view(id);
  }
  view(id) {
    const state = this.sessions.get(id); if (!state) throw new SetupError('验证连接已结束，请重新连接。');
    if (this.now() > state.expires && !state.proof) { state.status = 'expired'; state.client.disconnect(); }
    return { id, status: state.status, message: `协作 接入 ${state.code}`, proof: state.proof, ...(state.error ? { error: state.error } : {}) };
  }
  consume(id) {
    this.view(id); const state = this.sessions.get(id);
    if (!state.proof || this.now() > state.expires) throw new SetupError('请先在群里完成机器人验证。');
    this.sessions.delete(id); clearTimeout(state.timer); state.client.disconnect();
    return { bot_id: state.bot_id, secret: state.secret, ...state.proof };
  }
  cancel(id) {
    const state = this.sessions.get(id); if (!state) return;
    this.sessions.delete(id); clearTimeout(state.timer); state.client.disconnect();
  }
  closeAll() { for (const state of this.sessions.values()) { clearTimeout(state.timer); state.client.disconnect(); } this.sessions.clear(); }
}
