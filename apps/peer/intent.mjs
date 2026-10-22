import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Kept separately from setup.json: CLI stop must win over an open browser's stale state.
export async function readRunnerIntent(dataDir) {
  try {
    const value = JSON.parse(await readFile(join(dataDir, 'runner-intent.json'), 'utf8'));
    if (typeof value.enabled !== 'boolean') throw new Error('Invalid runner intent');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeRunnerIntent(dataDir, enabled) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'runner-intent.json'); const temporary = `${path}.${randomUUID()}.tmp`;
  const value = { enabled, updated_at: new Date().toISOString() };
  await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path);
  return value;
}
