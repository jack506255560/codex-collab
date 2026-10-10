import AiBot from '@wecom/aibot-node-sdk';
import { randomUUID } from 'node:crypto';
import { dispatchChatCommand, parseChatCommand } from './chat-command.mjs';

/** Privacy-safe metadata only: never include message content, platform IDs, frame, or credentials. */
export function wecomFrameDiagnostic(frame, accounts, allowedChatIds) {
  const body = frame?.body || {};
  const text = body.text?.content;
  return {
    kind: body.msgtype === 'text' ? 'text' : 'other',
    group: body.chattype === 'group',
    allowlisted: allowedChatIds.includes(body.chatid),
    senderMapped: !!accounts.wecom(body.from?.userid),
    hasMessageId: !!body.msgid,
    hasCommandKeyword: typeof text === 'string' && text.includes('协作'),
    command: typeof text === 'string' ? (parseChatCommand(text)?.action || 'none') : 'none'
  };
}


/** Handle only allowlisted group text. The callback is never treated as an instruction to the model. */
export async function dispatchWecomMessage(frame, { service, accounts, allowedChatIds, reply }) {
  const body = frame?.body;
  if (body?.chattype !== 'group' || body.msgtype !== 'text' || !allowedChatIds.includes(body.chatid)) return false;
  const text = body.text?.content;
  if (typeof text !== 'string' || !body.msgid || !body.from?.userid) return false;
  return dispatchChatCommand({ channel: 'wecom', chatId: body.chatid, senderId: body.from.userid,
    messageId: body.msgid, text }, { service, accounts, allowedChatIds,
    lookupUser: (userid) => accounts.wecom(userid),
    send: (_chatId, response) => reply(frame, response) });
}

export function startWecom({ service, accounts, botId, secret, allowedChatIds,
  diagnostics = process.env.COLLAB_WECOM_DIAGNOSTICS === '1', clientFactory = (config) => new AiBot.WSClient(config) }) {
  if (!botId || !secret || !Array.isArray(allowedChatIds) || allowedChatIds.length === 0) {
    throw new Error('WECOM_BOT_ID, WECOM_BOT_SECRET and WECOM_CHAT_IDS are required');
  }
  // The SDK's default debug logger prints full inbound message bodies. Keep all SDK logs redacted.
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const client = clientFactory({ botId, secret, logger });
  const send = async (chatId, value) => {
    if (!allowedChatIds.includes(chatId)) throw new Error('refusing to send to a non-allowlisted group');
    const result = await client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: value } });
    if (result?.errcode && result.errcode !== 0) throw new Error(`WeCom send failed: ${result.errcode}`);
  };
  client.on('authenticated', () => console.log('WeCom WebSocket authenticated'));
  client.on('error', () => console.error('WeCom WebSocket error (check local credentials/network)'));
  if (diagnostics) client.on('message', (frame) => {
    console.log('WeCom inbound metadata:', JSON.stringify(wecomFrameDiagnostic(frame, accounts, allowedChatIds)));
  });
  client.on('message.text', (frame) => {
    void dispatchWecomMessage(frame, { service, accounts, allowedChatIds,
      reply: async (originalFrame, value) => {
        const result = await client.replyStream(originalFrame, `collab-${randomUUID()}`, value, true);
        if (result?.errcode && result.errcode !== 0) throw new Error(`WeCom reply failed: ${result.errcode}`);
      }
    }).then((handled) => {
      if (diagnostics) console.log(`WeCom command handled=${handled}`);
    }).catch(() => console.error('WeCom message handler failed (reply or service operation failed)'));
  });
  client.connect();
  console.log('WeCom WebSocket connecting (wait for authenticated)');
  return { client, send };
}
