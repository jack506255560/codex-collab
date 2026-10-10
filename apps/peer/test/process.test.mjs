import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireRunnerLock, readRunnerLock } from '../process.mjs';

test('reader waits for a newly created lock to finish writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-lock-'));
  const path = join(dir, 'runner.pid.json');
  try {
    const fd = await open(path, 'wx');
    const pending = readRunnerLock(path);
    await delay(80);
    await fd.writeFile(JSON.stringify({ pid: process.pid, config: '/test' }));
    await fd.close();
    assert.equal((await pending).pid, process.pid);
    await assert.rejects(acquireRunnerLock(dir, '/other'), /already active/);
    assert.equal((await readRunnerLock(path)).pid, process.pid);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('incomplete lock fails closed rather than being deleted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collab-lock-'));
  const path = join(dir, 'runner.pid.json');
  try {
    await writeFile(path, '');
    await assert.rejects(acquireRunnerLock(dir, '/test'), /incomplete/);
    assert.equal(await (await import('node:fs/promises')).readFile(path, 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
