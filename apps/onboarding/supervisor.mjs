import { join } from 'node:path';
import { profiles } from './workspace.mjs';
import { readPeerConfig } from '../peer/runtime.mjs';
import { alive, readRunnerLock, acquireRunnerControl } from '../peer/process.mjs';
import { readRunnerIntent, writeRunnerIntent } from '../peer/intent.mjs';
import { savePrivate } from './manager.mjs';

export class RunnerSupervisor {
  constructor(manager, { clock = Date.now } = {}) { this.manager = manager; this.clock = clock; this.failures = new Map(); }
  async tick() {
    for (const profile of await profiles(this.manager.home)) {
      if (profile.phase !== 'ready') continue;
      const retry = this.failures.get(profile.id);
      if (retry?.after > this.clock()) continue;
      try {
        const { config } = await readPeerConfig(profile.config_path);
        const lock = await readRunnerLock(join(config.data_dir, 'runner.pid.json'));
        let intent = await readRunnerIntent(config.data_dir);
        // Upgrade only adopts a live connection. Previously stopped installations stay stopped.
        if (!intent) {
          const release = await acquireRunnerControl(config.data_dir, profile.config_path);
          try {
            intent = await readRunnerIntent(config.data_dir);
            if (!intent) {
              const current = await readRunnerLock(join(config.data_dir, 'runner.pid.json'));
              intent = await writeRunnerIntent(config.data_dir, !!current && alive(current.pid));
            }
          } finally { await release(); }
        }
        if (!intent.enabled || lock && alive(lock.pid)) { this.failures.delete(profile.id); continue; }
        if ([...this.manager.discovery.sessions.values()].some((session) => session.bot_id === config.wecom?.bot_id && ['connecting', 'authenticated'].includes(session.status))) continue;
        await this.manager.runCli('recover', profile.config_path);
        this.failures.delete(profile.id);
      } catch {
        const attempts = (retry?.attempts || 0) + 1;
        this.failures.set(profile.id, { attempts, after: this.clock() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5)) });
      }
    }
    await savePrivate(join(this.manager.home, 'supervisor.json'), { checked_at: new Date(this.clock()).toISOString(), retrying: [...this.failures].map(([id, retry]) => ({ id, next_retry_at: new Date(retry.after).toISOString() })) });
  }
}
