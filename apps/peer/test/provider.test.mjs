import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probeProvider } from '../provider.mjs';
import { agentEnvironment } from '../runner.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'peer-provider-'));
  return { root, config: { agent_id: 'alice', data_dir: root }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('provider probe uses a disposable read-only SDK thread and records no raw response', async () => {
  const f = await fixture();
  try {
    const result = await probeProvider(f.config, { agentFactory: () => ({ startThread(options) {
      assert.equal(options.sandboxMode, 'read-only'); assert.equal(options.approvalPolicy, 'never');
      assert.equal(options.networkAccessEnabled, false); assert.equal(options.webSearchMode, 'disabled');
      assert.ok(options.workingDirectory.startsWith(f.root));
      return { id: 'private-sdk-probe', async run(prompt, { signal }) {
        assert.match(prompt, /Do not use tools/); assert.equal(signal.aborted, false);
        return { finalResponse: 'CODEX_COLLAB_PROVIDER_OK', items: ['PRIVATE'], usage: null };
      } };
    } }) });
    assert.equal(result.status, 'passed'); assert.equal(result.thread_id, 'private-sdk-probe');
    assert.deepEqual(await readdir(f.root), ['provider-probe.json']);
    assert.equal((await stat(join(f.root, 'provider-probe.json'))).mode & 0o077, 0);
    assert.equal((await readFile(join(f.root, 'provider-probe.json'), 'utf8')).includes('PRIVATE'), false);
  } finally { await f.cleanup(); }
});

test('provider probe redacts model exceptions, unexpected output and timeouts', async () => {
  const f = await fixture();
  try {
    for (const run of [async () => { throw new Error('secret private provider response'); }, async () => ({ finalResponse: 'secret private provider response' })]) {
      await assert.rejects(probeProvider(f.config, { agentFactory: () => ({ startThread: () => ({ id: 'probe-fixture', run }) }) }), (error) => {
        assert.doesNotMatch(error.message, /secret private/); assert.match(error.message, /probe failed/); return true;
      });
      assert.equal(JSON.parse(await readFile(join(f.root, 'provider-probe.json'), 'utf8')).status, 'failed');
    }
    let aborted = false;
    await assert.rejects(probeProvider(f.config, { timeoutMs: 10, agentFactory: () => ({ startThread: () => ({ id: 'probe-fixture', run: async (_prompt, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('private exception')); }, { once: true })) }) }) }), /timed out/);
    assert.equal(aborted, true);
    assert.equal(JSON.parse(await readFile(join(f.root, 'provider-probe.json'), 'utf8')).status, 'timeout');
    assert.deepEqual(await readdir(f.root), ['provider-probe.json']);
  } finally { await f.cleanup(); }
});

test('Runner environment does not leak bot credentials or arbitrary local variables', () => {
  const originalBot = process.env.WECOM_BOT_SECRET;
  const originalPrivate = process.env.COLLAB_TEST_PRIVATE;
  try {
    process.env.WECOM_BOT_SECRET = 'fixture-only-bot-secret'; process.env.COLLAB_TEST_PRIVATE = 'fixture-only-private-data';
    const env = agentEnvironment({ codex_home: '/fixture/private/codex-home' });
    assert.equal(env.CODEX_HOME, '/fixture/private/codex-home');
    assert.equal(env.WECOM_BOT_SECRET, undefined); assert.equal(env.COLLAB_TEST_PRIVATE, undefined);
  } finally {
    if (originalBot === undefined) delete process.env.WECOM_BOT_SECRET; else process.env.WECOM_BOT_SECRET = originalBot;
    if (originalPrivate === undefined) delete process.env.COLLAB_TEST_PRIVATE; else process.env.COLLAB_TEST_PRIVATE = originalPrivate;
  }
});
