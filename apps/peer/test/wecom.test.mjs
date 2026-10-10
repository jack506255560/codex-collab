import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPeerWecom } from '../wecom.mjs';

test('Peer WeCom lifecycle diagnostics redact raw SDK errors and reasons', async () => {
  class FakeClient extends EventEmitter {
    connected = false;
    connect() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const client = new FakeClient();
  const dataDir = await mkdtemp(join(tmpdir(), 'codex-peer-wecom-'));
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const bridge = startPeerWecom({
      service: { agentId: 'alice', store: { dataDir }, async list() { return []; } },
      config: { bot_id: 'bot-safe', secret: 'super-secret-value', chat_ids: [] },
      clientFactory(options) {
        assert.equal(options.secret, 'super-secret-value');
        for (const method of ['debug', 'info', 'warn', 'error']) options.logger[method]('super-secret-value', { raw: 'secret server frame' });
        return client;
      }
    });
    assert.equal(client.connected, true);
    assert.equal(errors.length, 0, 'all SDK log methods must remain muted');
    client.emit('connected');
    assert.doesNotMatch(errors.join('\n'), /Peer WeCom authenticated/, 'transport connection must not be reported as authenticated');
    client.emit('authenticated');
    await bridge.health.flush();
    assert.equal(JSON.parse(await readFile(join(dataDir, 'wecom-health.json'), 'utf8')).status, 'authenticated');
    client.emit('error', Object.assign(new Error('secret server frame'), { code: 'ETIMEDOUT' }));
    client.emit('error', new Error('Authentication failed: secret server frame (code: 401)'));
    client.emit('reconnecting', 2);
    client.emit('reconnecting', 'secret attempt');
    client.emit('disconnected', 'secret close reason');
    client.emit('error', Object.assign(new Error('secret server frame'), { code: 'secret error code' }));
    client.emit('error', Object.assign(new Error('secret server frame'), { code: 'WS_RECONNECT_EXHAUSTED' }));
    assert.equal(bridge.health.snapshot().status, 'failed');
    bridge.close();
    await bridge.health.flush();
    assert.equal(JSON.parse(await readFile(join(dataDir, 'wecom-health.json'), 'utf8')).status, 'disconnected');
    assert.equal(client.connected, false);
  } finally {
    console.error = original;
    await rm(dataDir, { recursive: true, force: true });
  }
  const output = errors.join('\n');
  assert.match(output, /WebSocket connected; awaiting authentication/);
  assert.match(output, /连接失败（ETIMEDOUT）/);
  assert.match(output, /认证被企微拒绝（错误码 401）/);
  assert.match(output, /Peer WeCom authenticated/);
  assert.match(output, /reconnecting \(attempt 2\)/);
  assert.match(output, /reconnecting \(attempt unknown\)/);
  assert.match(output, /disconnected \(reason redacted\)/);
  assert.doesNotMatch(output, /super-secret-value|secret server frame|secret close reason|secret attempt|secret error code/);
});
