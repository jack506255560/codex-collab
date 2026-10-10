import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
// A newly created exclusive lock is visible before its JSON has been written.
// Never mistake an in-progress write for a stale lock, or remove it.
export async function readRunnerLock(path) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const state = JSON.parse(await readFile(path, 'utf8'));
      if (Number.isSafeInteger(state.pid) && state.pid > 0 && typeof state.config === 'string') return state;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (!(error instanceof SyntaxError)) throw error;
    }
    await delay(50);
  }
  throw new Error('Runner lock is incomplete; refusing to start another bot connection');
}

export async function acquireRunnerLock(dataDir, configPath) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'runner.pid.json');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(path, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, config: resolve(configPath), started_at: new Date().toISOString() }));
      await lock.close();
      return async () => {
        const current = await readRunnerLock(path);
        if (current?.pid === process.pid) await rm(path, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readRunnerLock(path);
      if (!previous) continue;
      if (alive(previous.pid)) throw new Error('Runner already active for this data directory; do not connect the same bot twice');
      await rm(path, { force: true });
    }
  }
  throw new Error('cannot acquire local Runner lock');
}
