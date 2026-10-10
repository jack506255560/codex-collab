import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateIdentity } from '../../../packages/peer/config.mjs';
import { attachProject, buildTeamPolicy, createIdentityFiles, createMemberConfig, diagnosePeer, writeTeamPolicy } from '../onboarding.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cli = join(root, 'bin/codex-collab.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-collab-onboarding-'));
  const seed = join(dir, 'seed');
  const origin = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-b', 'main', seed], { stdio: 'ignore' });
  git(seed, 'config', 'user.name', 'Onboarding Test');
  git(seed, 'config', 'user.email', 'onboarding@example.invalid');
  await writeFile(join(seed, 'test.sh'), '#!/bin/sh\nexit 0\n');
  git(seed, 'add', 'test.sh');
  git(seed, 'commit', '-m', 'fixture');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' });
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-u', 'origin', 'main');
  execFileSync('git', ['clone', origin, repo], { stdio: 'ignore' });

  const alice = generateIdentity();
  const bob = generateIdentity();
  const policy = buildTeamPolicy({
    repo: 'fixture/collab-demo', reviewer: 'alice', defaultRoute: 'backend',
    agents: [
      { id: 'alice', role: 'admin', capabilities: ['backend'], publicKey: alice.public_key },
      { id: 'bob', role: 'member', capabilities: ['backend'], publicKey: bob.public_key }
    ],
    routes: { backend: ['alice', 'bob'] }
  });
  const teamPath = join(dir, 'team.json');
  await writeTeamPolicy(teamPath, policy);
  const identityPath = join(dir, 'bob.private.json');
  await writeFile(identityPath, JSON.stringify({ agent_id: 'bob', private_key: bob.private_key }) + '\n', { mode: 0o600 });
  return {
    dir, repo, teamPath, identityPath,
    configPath: join(dir, 'private', 'bob.json'),
    dataDir: join(dir, 'private', 'data'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('identity create keeps private key local and emits a separate public PEM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-collab-identity-'));
  try {
    const out = execFileSync(process.execPath, [cli, 'identity', 'create', 'bob', '--dir', dir], { encoding: 'utf8' });
    assert.match(out, /Private identity \(keep local\)/);
    assert.match(out, /Public key \(share with team admin\)/);
    const privatePath = join(dir, 'bob.private.json');
    const publicPath = join(dir, 'bob.public.pem');
    assert.equal((await stat(privatePath)).mode & 0o777, 0o600);
    assert.equal((await stat(publicPath)).mode & 0o777, 0o644);
    assert.match(await readFile(publicPath, 'utf8'), /BEGIN PUBLIC KEY/);
    assert.doesNotMatch(out, /BEGIN (?:PRIVATE|PUBLIC) KEY/);
    assert.throws(() => execFileSync(process.execPath, [cli, 'identity', 'create', 'bob', '--dir', dir], { stdio: 'pipe' }), { status: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('member setup validates identity, keeps config private, checks Git access and attaches MCP/Skill locally', async () => {
  const f = await fixture();
  try {
    const { config, origin } = await createMemberConfig({
      teamPath: f.teamPath, identityPath: f.identityPath, repoPath: f.repo,
      dataDir: f.dataDir, configPath: f.configPath, testArgv: ['sh', 'test.sh']
    });
    assert.equal(config.agent_id, 'bob');
    assert.equal(config.execution_mode, 'desktop_poll');
    assert.equal(origin, join(f.dir, 'origin.git'));
    assert.equal((await stat(f.configPath)).mode & 0o777, 0o600);
    const diagnosis = await diagnosePeer(f.configPath, { testPush: true });
    assert.match(diagnosis.checks.push_access, /dry-run passed/);

    const attached = await attachProject({ configPath: f.configPath, repoPath: f.repo });
    const toml = await readFile(attached.mcp_config, 'utf8');
    assert.match(toml, /\[mcp_servers\.team-collab-bob\]/);
    assert.match(toml, new RegExp(f.configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(toml, /BEGIN PRIVATE KEY/);
    assert.match(await readFile(attached.skill, 'utf8'), /poll_desktop_task/);
    assert.equal(git(f.repo, 'check-ignore', '.codex/config.toml'), '.codex/config.toml');
    await assert.rejects(attachProject({ configPath: f.configPath, repoPath: f.repo }), /already exists/);
  } finally { await f.cleanup(); }
});

test('member setup rejects mismatched keys and private files inside the code repository', async () => {
  const f = await fixture();
  try {
    const mismatched = join(f.dir, 'wrong.private.json');
    await writeFile(mismatched, JSON.stringify({ agent_id: 'bob', private_key: generateIdentity().private_key }) + '\n', { mode: 0o600 });
    await assert.rejects(createMemberConfig({ teamPath: f.teamPath, identityPath: mismatched, repoPath: f.repo, dataDir: f.dataDir, configPath: f.configPath }), /does not match/);
    await assert.rejects(createMemberConfig({ teamPath: f.teamPath, identityPath: f.identityPath, repoPath: f.repo, dataDir: join(f.repo, '.private-data'), configPath: f.configPath }), /must stay outside/);
    assert.equal(await readFile(f.configPath).catch(() => null), null);
  } finally { await f.cleanup(); }
});

test('CLI help documents the installable onboarding commands', () => {
  const out = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(out, /codex-collab setup/);
  assert.match(out, /identity create/);
  assert.match(out, /Never pass a bot Secret/);
});
