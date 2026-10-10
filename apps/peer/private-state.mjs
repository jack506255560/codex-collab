import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { alive } from './process.mjs';
import { readPrivateJson } from '../../packages/peer/config.mjs';

// Shared by all project MCP processes. Never use a process-local MCP data dir for
// thread binding or job tokens, and never persist this file in the Git ledger.
export class PrivateDesktopState {
  constructor(dataDir) { this.directory = dataDir; this.path = join(dataDir, 'desktop-state.json'); }
  async read() {
    try { return await readPrivateJson(this.path); }
    catch (error) { if (error.code === 'ENOENT') return { schema_version: 1, binding: null, jobs: {} }; throw error; }
  }
  async write(value) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, this.path); await chmod(this.path, 0o600);
  }
  async locked(fn) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'desktop-state.lock');
    const deadline = Date.now() + 180000; let file;
    while (!file) {
      try { file = await open(path, 'wx', 0o600); await file.writeFile(String(process.pid)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const pid = Number(await readFile(path, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) await rm(path, { force: true });
        } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
        if (Date.now() > deadline) throw new Error('another desktop operation is still active');
        await delay(30);
      }
    }
    try { return await fn(await this.read()); }
    finally { await file.close(); await rm(path, { force: true }); }
  }
}
