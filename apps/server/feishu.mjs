import * as Lark from '@larksuiteoapi/node-sdk';
import { parseChatCommand, dispatchChatCommand } from './chat-command.mjs';

export const parseFeishuCommand = parseChatCommand;

export async function dispatchFeishuMessage(data, { service, accounts, allowedChatIds, send }) {
  const message = data.message;
  if (!message || message.message_type !== 'text' || !allowedChatIds.includes(message.chat_id)) return false;
  let raw;
  try { raw = JSON.parse(message.content).text; } catch { return false; }
  return dispatchChatCommand({ channel: 'feishu', chatId: message.chat_id, senderId: data.sender?.sender_id?.open_id,
    messageId: message.message_id, text: raw }, { service, accounts, allowedChatIds, send, lookupUser: (id) => accounts.feishu(id) });
}

export async function startFeishu({ service, accounts, appId, appSecret, allowedChatIds }) {
  if (!allowedChatIds.length) throw new Error('FEISHU_CHAT_IDS must contain at least one allowed group chat_id');
  const config = { appId, appSecret };
  const client = new Lark.Client(config);
  const send = async (chatId, value) => {
    if (!allowedChatIds.includes(chatId)) throw new Error('refusing to send to a non-allowlisted chat');
    const result = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: value }) }
    });
    if (result.code !== 0) throw new Error(`Feishu send failed: ${result.code}`);
  };
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      await dispatchFeishuMessage(data, { service, accounts, allowedChatIds, send });
    }
  });
  const wsClient = new Lark.WSClient(config);
  await wsClient.start({ eventDispatcher: dispatcher });
  console.log('Feishu WebSocket event subscriber started');
  return { send, wsClient };
}
