import { Codex } from '@openai/codex-sdk';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../../packages/peer/store.mjs';
import { agentEnvironment } from './runner.mjs';

const expected = 'CODEX_COLLAB_PROVIDER_OK';
// An explicit diagnostic request: no bot connection, ledger mutation, source
// edits or secrets in stdout. Uses the same home/provider env as the Runner.
export async function probeProvider(config, { agentFactory, timeoutMs = 120000 } = {}) {
  await mkdir(config.data_dir, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(config.data_dir, 'provider-probe-'));
  const controller = new AbortController();
  let timer; let thread;
  const resultPath = join(config.data_dir, 'provider-probe.json');
  const record = async (status) => {
    const threadId = typeof thread?.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(thread.id) ? thread.id : null;
    const result = { agent_id: config.agent_id, status, thread_id: threadId, checked_at: new Date().toISOString() };
    await writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
  };
  try {
    await git(directory, 'init', '-b', 'main');
    const agent = agentFactory ? agentFactory() : new Codex({ env: agentEnvironment(config) });
    thread = agent.startThread({ workingDirectory: directory, sandboxMode: 'read-only', approvalPolicy: 'never', networkAccessEnabled: false, webSearchMode: 'disabled' });
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('probe timeout')); }, timeoutMs);
    });
    const turn = await Promise.race([thread.run(`Reply with exactly ${expected}. Do not use tools, read files, execute commands, or change anything. This is only a model-provider connectivity check.`, { signal: controller.signal }), deadline]);
    if (turn.finalResponse?.trim() !== expected) throw new Error('unexpected probe response');
    return await record('passed');
  } catch {
    try { await record(controller.signal.aborted ? 'timeout' : 'failed'); } catch { /* never echo private errors */ }
    throw new Error('Codex SDK provider probe failed or timed out; check local model/auth/proxy configuration. Raw response and credentials were not printed.');
  } finally {
    clearTimeout(timer); controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
}
