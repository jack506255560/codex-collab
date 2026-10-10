import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { reduceTask, validateTaskSpec } from '../protocol/src/index.mjs';

const run = promisify(execFile);
const taskIdPattern = /^[A-Z][A-Z0-9-]{1,63}$/;

async function git(cwd, ...args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 4 * 1024 * 1024
  });
  return stdout.trim();
}

export class GitTaskStore {
  constructor({ repo, dataDir, push = false }) {
    this.repo = resolve(repo);
    this.checkout = resolve(dataDir, 'ledger');
    this.push = push;
    this.queue = Promise.resolve();
  }

  async init() {
    if (!(await git(this.repo, 'rev-parse', '--is-inside-work-tree') === 'true')) throw new Error('repo is not a Git worktree');
    try {
      await git(this.checkout, 'rev-parse', '--abbrev-ref', 'HEAD');
    } catch {
      await mkdir(dirname(this.checkout), { recursive: true });
      await git(this.repo, 'worktree', 'add', this.checkout, 'agent-collab');
    }
    if (await git(this.checkout, 'branch', '--show-current') !== 'agent-collab') throw new Error('ledger must checkout agent-collab');
    if (await git(this.checkout, 'status', '--porcelain')) throw new Error('ledger checkout has uncommitted changes');
    if (this.push) {
      await git(this.checkout, 'fetch', 'origin', 'agent-collab');
      await git(this.checkout, 'merge', '--ff-only', 'origin/agent-collab');
    }
    return this;
  }

  taskRoot(id) {
    if (!taskIdPattern.test(id)) throw new Error('invalid task ID');
    return join(this.checkout, '.agent-collab', 'tasks', id);
  }

  async list() {
    const dir = join(this.checkout, '.agent-collab', 'tasks');
    await mkdir(dir, { recursive: true });
    const ids = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && taskIdPattern.test(e.name)).map((e) => e.name);
    return Promise.all(ids.sort().map((id) => this.read(id)));
  }

  async read(id) {
    const root = this.taskRoot(id);
    const spec = JSON.parse(await readFile(join(root, 'spec.json'), 'utf8'));
    const eventFiles = (await readdir(join(root, 'events'))).filter((file) => /^\d{6}-[^/]+\.json$/.test(file)).sort();
    const events = await Promise.all(eventFiles.map(async (file) => JSON.parse(await readFile(join(root, 'events', file), 'utf8'))));
    return { spec, events, state: reduceTask(spec, events) };
  }

  async findIdempotencyKey(key) {
    for (const task of await this.list()) {
      if (task.events.some((event) => event.idempotency_key === key)) return task.spec.id;
    }
    return null;
  }

  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async create(spec, actor, key) {
    return this.serialize(async () => {
      validateTaskSpec(spec);
      if (!key || !actor) throw new Error('actor and idempotency key are required');
      const existing = await this.findIdempotencyKey(key);
      if (existing) return this.read(existing);
      const root = this.taskRoot(spec.id);
      await mkdir(dirname(root), { recursive: true });
      // mkdir without recursive mode must fail if the ID already exists.
      await mkdir(root);
      const eventsDir = join(root, 'events');
      await mkdir(eventsDir);
      const event = {
        schema_version: 1, event_id: randomUUID(), task_id: spec.id, seq: 1,
        type: 'created', actor_id: actor, occurred_at: new Date().toISOString(), idempotency_key: key
      };
      await writeFile(join(root, 'spec.json'), JSON.stringify(spec, null, 2) + '\n', { flag: 'wx' });
      await writeFile(join(eventsDir, `000001-${event.event_id}.json`), JSON.stringify(event, null, 2) + '\n', { flag: 'wx' });
      await this.commit([root], `collab: create ${spec.id}`);
      return this.read(spec.id);
    });
  }

  async append(id, payload, actor, key, expectedSeq) {
    return this.serialize(async () => {
      const task = await this.read(id);
      if (task.events.some((event) => event.idempotency_key === key)) return task;
      if (!Number.isSafeInteger(expectedSeq) || task.state.seq !== expectedSeq) throw new Error(`stale task revision: expected ${task.state.seq}`);
      const event = {
        schema_version: 1, event_id: randomUUID(), task_id: id,
        seq: expectedSeq + 1, type: payload.type, actor_id: actor,
        occurred_at: new Date().toISOString(), idempotency_key: key
      };
      for (const field of ['summary', 'assignee', 'run_id', 'decision', 'refs', 'chat_id', 'channel']) {
        if (payload[field] !== undefined) event[field] = payload[field];
      }
      // The reducer must accept the transition before any filesystem change.
      reduceTask(task.spec, [...task.events, event]);
      const file = join(this.taskRoot(id), 'events', `${String(event.seq).padStart(6, '0')}-${event.event_id}.json`);
      await writeFile(file, JSON.stringify(event, null, 2) + '\n', { flag: 'wx' });
      await this.commit([file], `collab: ${id} ${event.type}`);
      return this.read(id);
    });
  }

  async commit(paths, message) {
    await git(this.checkout, 'add', '--', ...paths);
    await git(this.checkout, 'commit', '-m', message);
    if (this.push) await git(this.checkout, 'push', 'origin', 'agent-collab');
  }
}
