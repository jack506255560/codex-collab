import * as Lark from '@larksuiteoapi/node-sdk';
const { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret } = process.env;
if (!appId || !appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
const client = new Lark.WSClient({ appId, appSecret });
await client.start({ eventDispatcher: new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async ({ message, sender }) => {
    // Never log the message body or auth credentials. Stop after identifying IDs.
    console.log(JSON.stringify({ chat_id: message?.chat_id, sender_open_id: sender?.sender_id?.open_id }));
  }
}) });
console.log('Feishu discovery listener started; send a message in the target group, copy IDs, then stop this process.');
