import AiBot from '@wecom/aibot-node-sdk';
import { wecomDiagnostic } from './wecom-diagnostic.mjs';

const { WECOM_BOT_ID: botId, WECOM_BOT_SECRET: secret } = process.env;
if (!botId || !secret) throw new Error('WECOM_BOT_ID and WECOM_BOT_SECRET are required (use a newly rotated secret; do not paste it into chat)');

// SDK debug logs may contain complete inbound messages; never use the default logger.
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const client = new AiBot.WSClient({ botId, secret, logger });
client.on('connected', () => console.log('WeCom WebSocket connected; waiting for authentication.'));
client.on('authenticated', () => console.log('WeCom authenticated; send a text message to the bot in the test group. Stop with Ctrl-C.'));
client.on('error', (error) => console.error(`WeCom: ${wecomDiagnostic(error)}`));
client.on('message.text', (frame) => {
  const { chattype, chatid, from } = frame?.body || {};
  if (chattype === 'group' && chatid && from?.userid) {
    // Never print message text, frame, request IDs, or credentials.
    console.log(JSON.stringify({ chatid, userid: from.userid }));
  }
});
process.once('SIGINT', () => { client.disconnect(); process.exit(0); });
process.once('SIGTERM', () => { client.disconnect(); process.exit(0); });
client.connect();
console.log('WeCom group ID discovery connecting (do not run alongside the same bot service connection).');
