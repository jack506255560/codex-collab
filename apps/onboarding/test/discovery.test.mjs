import test from 'node:test';
import assert from 'node:assert/strict';
import { BotDiscovery } from '../discovery.mjs';
import { FakeBot } from './helpers.mjs';
import { encryptBundle, decryptBundle, remoteIdentity } from '../bundle.mjs';
test('discovery requires authentication, exact code, group and sender; hides credentials and expires', () => {
  let now = 1000, client; const discovery = new BotDiscovery({ now: () => now, clientFactory: () => { client = new FakeBot(); return client; } });
  const session = discovery.begin({ bot_id: 'bot', secret: 'private-fixture-secret', chat_ids: ['group'] });
  const body = { chattype: 'group', chatid: 'group', from: { userid: 'user' }, text: { content: session.message } };
  client.emit('message.text', { body }); assert.equal(discovery.view(session.id).proof, null);
  client.emit('authenticated');
  for (const change of [{ chatid: 'other' }, { chattype: 'single' }, { from: {} }, { text: { content: session.message + ' extra' } }]) client.emit('message.text', { body: { ...body, ...change } });
  assert.equal(discovery.view(session.id).proof, null);
  client.emit('message.text', { body: { ...body, text: { content: `@Bot ${session.message}` } } }); assert.equal(discovery.view(session.id).status, 'verified');
  assert.doesNotMatch(JSON.stringify(discovery.view(session.id)), /private-fixture-secret/); assert.equal(client.connected, false);
  assert.deepEqual(discovery.consume(session.id), { bot_id: 'bot', secret: 'private-fixture-secret', chatid: 'group', userid: 'user' });
  const second = discovery.begin({ bot_id: 'second', secret: 's' }); now += 300001; assert.equal(discovery.view(second.id).status, 'expired'); assert.throws(() => discovery.consume(second.id)); discovery.closeAll();
});
test('invitation encryption authenticates ciphertext and remote comparison permits SSH/HTTPS equivalents', () => {
  const value = { secret: 'private', kind: 'test' }; const envelope = encryptBundle(value, 'long-fixture-password');
  assert.doesNotMatch(JSON.stringify(envelope), /private/); assert.deepEqual(decryptBundle(envelope, 'long-fixture-password'), value);
  assert.throws(() => decryptBundle(envelope, 'wrong-password')); assert.throws(() => decryptBundle({ ...envelope, tag: Buffer.alloc(16).toString('base64') }, 'long-fixture-password'));
  assert.throws(() => encryptBundle(value, 'short'));
  assert.equal(remoteIdentity('git@github.com:owner/repo.git'), remoteIdentity('https://github.com/owner/repo'));
  assert.notEqual(remoteIdentity('https://github.com/other/repo'), remoteIdentity('https://github.com/owner/repo'));
});
