import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile, rm, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, makeSigner, validateTeam } from './config.mjs';
import { reducePeerTask, taskIdPattern } from './protocol.mjs';
import { readRegistry, recordHash, registryPath } from './registry.mjs';
const exec = promisify(execFile);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

/** Disposable ledger clone, cross-process local lock, remote fast-forward CAS and signed replay. */
export class PeerGitStore {
  constructor({ repo, dataDir, team, agentId, privateKey, clock = Date.now, maxRetries = 8, registryRoot, enrollmentOnly = false }) {
    this.repo = resolve(repo); this.dataDir = resolve(dataDir); this.checkout = join(this.dataDir, 'peer-ledger');
    this.team = validateTeam(team); this.agentId = agentId; this.enrollmentOnly = enrollmentOnly; this.sign = enrollmentOnly ? null : makeSigner(team, agentId, privateKey);
    this.privateKey = privateKey; this.registryRoot = registryRoot; this.registry = null;
    this.clock = clock; this.maxRetries = maxRetries; this.push = true;
  }
  async locked(fn) {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const path = join(this.dataDir, 'peer-ledger.lock'); const deadline = Date.now() + 60000;
    let lock;
    while (!lock) {
      try { lock = await open(path, 'wx', 0o600); await lock.writeFile(String(process.pid)); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          const pid = Number(await readFile(path, 'utf8'));
          if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') await rm(path, { force: true }); } }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (Date.now() > deadline) throw new Error('local peer ledger is busy; another process owns its lock');
        await pause(30);
      }
    }
    try { return await fn(); } finally { await lock.close(); await rm(path, { force: true }); }
  }
  async init() {
    return this.locked(async () => {
      const remote = await git(this.repo, 'remote', 'get-url', 'origin');
      try { await git(this.checkout, 'rev-parse', '--git-dir'); }
      catch { await git(this.dataDir, 'clone', '--no-checkout', '--', remote, this.checkout); }
      if (await git(this.checkout, 'remote', 'get-url', 'origin') !== remote) throw new Error('private ledger origin differs from target repository');
      await git(this.checkout, 'config', 'user.name', this.agentId);
      await git(this.checkout, 'config', 'user.email', `${this.agentId}@collab.invalid`);
      if (!(await git(this.checkout, 'ls-remote', '--heads', 'origin', 'refs/heads/agent-collab'))) {
        await git(this.checkout, 'checkout', '--orphan', 'agent-collab');
        await git(this.checkout, 'rm', '-rf', '--ignore-unmatch', '.');
        await mkdir(join(this.checkout, '.agent-collab'), { recursive: true });
        await writeFile(join(this.checkout, '.agent-collab', 'README.md'), '# Signed peer ledger v2\nDo not merge into main.\n');
        await git(this.checkout, 'add', '.agent-collab/README.md'); await git(this.checkout, 'commit', '-m', 'collab: initialize peer ledger');
        try { await git(this.checkout, 'push', 'origin', 'HEAD:refs/heads/agent-collab'); }
        catch { if (!(await git(this.checkout, 'ls-remote', '--heads', 'origin', 'refs/heads/agent-collab'))) throw new Error('cannot initialize remote ledger (credentials/network/branch policy)'); }
      }
      await this.sync(); return this;
    });
  }
  async sync() {
    await git(this.checkout, 'fetch', '--no-tags', 'origin', '+refs/heads/agent-collab:refs/remotes/origin/agent-collab');
    // Never reset the user's checkout; this clone contains disposable replicas only.
    await git(this.checkout, 'checkout', '-B', 'agent-collab', 'refs/remotes/origin/agent-collab');
    await git(this.checkout, 'reset', '--hard', 'refs/remotes/origin/agent-collab');
    await git(this.checkout, 'clean', '-fd');
    if (this.registryRoot) {
      const registry = await readRegistry(this.checkout, this.registryRoot);
      const checkpointPath = join(this.dataDir, 'team-checkpoint.json');
      let checkpoint;
      try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (checkpoint && (registry.records.length < checkpoint.version || recordHash(registry.records[checkpoint.version - 1]) !== checkpoint.hash)) throw new Error('team registry rolled back or forked; refusing to trust it');
      if (!this.enrollmentOnly) {
        if (!registry.latest.team.agents[this.agentId]) throw new Error('member is not yet approved in the team registry');
        this.sign = makeSigner(registry.latest.team, this.agentId, this.privateKey);
      }
      this.team = registry.latest.team; this.registry = registry;
      const temporary = `${checkpointPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: registry.latest.version, hash: recordHash(registry.latest) }) + '\n', { mode: 0o600 });
      const { rename } = await import('node:fs/promises');
      await rename(temporary, checkpointPath);
    }
  }
  root(id) {
    if (!taskIdPattern.test(id ?? '')) throw new Error('invalid peer task ID');
    return join(this.checkout, '.agent-collab', 'peer', 'tasks', id);
  }
  async readLocal(id) {
    const root = this.root(id);
    const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'));
    const files = (await readdir(join(root, 'events'))).sort();
    if (files.some((f) => !/^\d{6}-[a-f0-9-]{36}\.json$/.test(f))) throw new Error('unexpected peer event file');
    const events = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(root, 'events', file), 'utf8'))));
    const team = this.registry ? this.registry.teams.get(events[0]?.team_hash) : this.team;
    if (!team) throw new Error('task references an untrusted team policy');
    return { spec, events, state: reducePeerTask(spec, events, team), ...(this.registry ? { team } : {}) };
  }
  async listLocal() {
    let entries;
    try { entries = await readdir(join(this.checkout, '.agent-collab', 'peer', 'tasks')); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (entries.some((id) => !taskIdPattern.test(id))) throw new Error('unexpected peer task entry');
    return Promise.all(entries.sort().map((id) => this.readLocal(id)));
  }
  async list() { return this.locked(async () => { await this.sync(); return this.listLocal(); }); }
  async read(id) { return this.locked(async () => { await this.sync(); return this.readLocal(id); }); }
  async registryTransaction(build) {
    return this.locked(async () => {
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        await this.sync();
        const result = await build(this.registry);
        if (!result.files?.length) return result.value;
        for (const [path, value] of result.files) {
          if (!new RegExp(`^${registryPath.replace('.', '\\.')}/(?:versions/\\d{6}|(?:invitations|requests)/[a-f0-9-]{36})\\.json$`).test(path)) throw new Error('unsupported team registry file');
          const target = join(this.checkout, path);
          await mkdir(join(target, '..'), { recursive: true });
          await writeFile(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
          await git(this.checkout, 'add', '--', path);
        }
        await git(this.checkout, 'commit', '-m', 'collab: update signed team enrollment');
        try { await git(this.checkout, 'push', 'origin', 'HEAD:refs/heads/agent-collab'); }
        catch { await pause(20 * (attempt + 1)); continue; }
        await this.sync(); return result.value;
      }
      throw new Error('team enrollment not accepted; check Git access and retry');
    });
  }
  async transact(id, idempotencyKey, build) {
    if (this.enrollmentOnly) throw new Error('enrollment client cannot write tasks');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 300) throw new Error('invalid idempotency key');
    return this.locked(async () => {
      for (let attempt = 0; attempt < this.maxRetries; attempt++) {
        await this.sync();
        const tasks = await this.listLocal(); const current = tasks.find((t) => t.spec.id === id);
        const existing = current?.events.find((e) => e.idempotency_key === idempotencyKey);
        if (existing) {
          if (existing.actor_id !== this.agentId) throw new Error('idempotency key belongs to another peer identity');
          return current;
        }
        if (tasks.some((t) => t.events.some((e) => e.idempotency_key === idempotencyKey))) throw new Error('idempotency key already used by another peer task');
        const now = this.clock();
        const built = await build(current, tasks, now);
        if (!built) return null;
        const spec = current?.spec || built.spec;
        if (!spec || spec.id !== id) throw new Error('transaction task mismatch');
        const taskTeam = current?.team || this.team;
        const sign = makeSigner(taskTeam, this.agentId, this.privateKey);
        const event = sign({ schema_version: 2, task_id: id, seq: (current?.state.seq || 0) + 1,
          event_id: randomUUID(), actor_id: this.agentId, occurred_at: new Date(now).toISOString(), idempotency_key: idempotencyKey,
          ...built.event, ...(current ? {} : { spec_hash: digest(spec) }) });
        reducePeerTask(spec, [...(current?.events || []), event], taskTeam);
        const root = this.root(id); await mkdir(join(root, 'events'), { recursive: true });
        if (!current) await writeFile(join(root, 'spec.json'), JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' });
        await writeFile(join(root, 'events', `${String(event.seq).padStart(6, '0')}-${event.event_id}.json`), JSON.stringify(event, null, 2) + '\n', { flag: 'wx' });
        await git(this.checkout, 'add', '--', root); await git(this.checkout, 'commit', '-m', `collab(peer): ${id} ${event.type}`);
        try { await git(this.checkout, 'push', 'origin', 'HEAD:refs/heads/agent-collab'); return this.readLocal(id); }
        catch {
          // A lost push acknowledgement is also possible. Pull before any retry;
          // the idempotency key makes an already accepted transaction recognizable.
          await this.sync();
          const accepted = (await this.listLocal()).find((t) => t.spec.id === id && t.events.some((e) => e.idempotency_key === idempotencyKey));
          if (accepted) return accepted;
          await pause(20 * (attempt + 1));
        }
      }
      throw new Error('remote ledger transaction not accepted; check network/permissions or retry after contention');
    });
  }
}
