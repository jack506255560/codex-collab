import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BotDiscovery } from '../discovery.mjs';
import { SetupManager } from '../manager.mjs';
export const git = (repo, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export class FakeBot extends EventEmitter { connect() { this.connected = true; } disconnect() { this.connected = false; this.emit('disconnected'); } }
export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'collab-wizard-')); const seed = join(root, 'seed'), remote = join(root, 'origin.git');
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'ignore' }); git(seed, 'config', 'user.name', 'Test'); git(seed, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(seed, 'test.sh'), 'set -eu\ntest -f test.sh\n'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'fixture');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { stdio: 'ignore' }); git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', 'main');
  const repos = {}; for (const id of ['alice', 'bob', 'other']) { repos[id] = join(root, id); execFileSync('git', ['clone', remote, repos[id]], { stdio: 'ignore' }); git(repos[id], 'config', 'user.name', id); git(repos[id], 'config', 'user.email', `${id}@example.invalid`); }
  let client; const calls = [];
  const discovery = new BotDiscovery({ clientFactory: () => { client = new FakeBot(); return client; } });
  const manager = new SetupManager({ home: join(root, 'private'), discovery, runCli: (command, config) => { calls.push({ command, config }); } });
  const verify = async (input, userid = 'owner-alice', chatid = 'group') => { const session = await manager.beginDiscovery(input); client.emit('authenticated'); client.emit('message.text', { body: { chattype: 'group', chatid, from: { userid }, text: { content: session.message } } }); return session.id; };
  const admin = async () => manager.createAdmin({ repo: repos.alice, agent_id: 'alice', capabilities: 'frontend,backend', discovery_id: await verify({ bot_id: 'bot-alice', secret: 'fixture-secret-alice' }) });
  return { root, remote, repos, manager, discovery, calls, verify, admin, cleanup: async () => { manager.close(); await rm(root, { recursive: true, force: true }); } };
}
