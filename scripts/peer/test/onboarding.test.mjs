import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { generateIdentity } from '../../../packages/peer/config.mjs';
import { attachProject, buildTeamPolicy, createIdentityFiles, createMemberConfig, createPrompts, diagnosePeer, runSetupWizard, writeTeamPolicy } from '../onboarding.mjs';

import { refreshProject } from '../refresh-project.mjs';

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

test('project attachment creates a missing Git info/exclude and installs local MCP/Skill files', async () => {
  const f = await fixture();
  try {
    const { config } = await createMemberConfig({
      teamPath: f.teamPath, identityPath: f.identityPath, repoPath: f.repo,
      dataDir: f.dataDir, configPath: f.configPath, testArgv: ['sh', 'test.sh']
    });
    assert.equal(config.agent_id, 'bob');
    const excludePath = git(f.repo, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
    await rm(excludePath, { force: true });
    await assert.rejects(stat(excludePath), { code: 'ENOENT' });

    const attached = await attachProject({ configPath: f.configPath, repoPath: f.repo });
    assert.match(await readFile(attached.mcp_config, 'utf8'), /\[mcp_servers\.team-collab-bob\]/);
    assert.match(await readFile(attached.skill, 'utf8'), /poll_desktop_task/);
    const exclude = await readFile(excludePath, 'utf8');
    assert.match(exclude, /^\/\.codex\/config\.toml$/m);
    assert.match(exclude, /^\/\.agents\/skills\/team-collab-desktop\/$/m);
    assert.match(exclude, /^\/\.codex-collab-worktrees\/$/m);
    assert.equal(git(f.repo, 'check-ignore', '.codex/config.toml'), '.codex/config.toml');
  } finally { await f.cleanup(); }
});

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

function promptStreams(t) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = output.isTTY = true;
  output.columns = 80;
  input.isRaw = false;
  const rawModes = [];
  input.setRawMode = (enabled) => { input.isRaw = enabled; rawModes.push(enabled); };
  let transcript = '';
  output.on('data', (chunk) => { transcript += chunk.toString(); });
  t.after(() => { input.destroy(); output.destroy(); });
  return { input, output, rawModes, transcript: () => transcript };
}

test('interactive prompts await typed input, trim answers and apply defaults', { timeout: 5000 }, async (t) => {
  const { input, output } = promptStreams(t);
  const prompts = createPrompts(input, output);
  t.after(prompts.close);
  const answer = prompts.ask('Agent ID');
  input.write('  bob  \n');
  assert.equal(await answer, 'bob');
  let settled = false;
  const choice = prompts.ask('Role', '2').then((value) => { settled = true; return value; });
  await setImmediate();
  assert.equal(settled, false, 'the prompt must wait for input');
  input.write('\n');
  assert.equal(await choice, '2');
});

test('interactive required prompts retry blank answers and confirmations honor defaults', { timeout: 5000 }, async (t) => {
  const { input, output, transcript } = promptStreams(t);
  const prompts = createPrompts(input, output);
  t.after(prompts.close);
  const required = prompts.required('Agent ID');
  input.write('   \n');
  await setImmediate();
  assert.match(transcript(), /需要填写此项/);
  input.write('alice\n');
  assert.equal(await required, 'alice');
  for (const [answer, defaultYes, expected] of [['', true, true], ['', false, false], ['YES', false, true], ['n', true, false]]) {
    const confirmed = prompts.confirm('Continue', defaultYes);
    input.write(`${answer}\n`);
    assert.equal(await confirmed, expected);
  }
});

test('hidden Secret input restores normal prompts without echoing the credential', { timeout: 5000 }, async (t) => {
  const { input, output, rawModes, transcript } = promptStreams(t);
  const prompts = createPrompts(input, output);
  t.after(prompts.close);
  const botId = prompts.required('Bot ID');
  input.write('test-bot\n');
  assert.equal(await botId, 'test-bot');
  const secret = prompts.secret('Secret');
  input.write('dummy-test-secretX\u007f\r');
  assert.equal(await secret, 'dummy-test-secret');
  assert.deepEqual(rawModes, [true, false, true, false, true]);
  assert.equal(input.isRaw, true, 'terminal readline must resume its normal input mode');
  const chatid = prompts.required('Group chatid');
  input.write(' test-chatid \n');
  assert.equal(await chatid, 'test-chatid');
  assert.doesNotMatch(transcript(), /dummy-test-secret/);
  prompts.close();
  assert.equal(input.isRaw, false);
});

test('setup menu reads and validates the selected role', { timeout: 5000 }, async (t) => {
  const { input, output, transcript } = promptStreams(t);
  const rejected = assert.rejects(runSetupWizard({ input, output }), /请选择 1（管理员）或 2（成员）/);
  input.write('3\n');
  await rejected;
  assert.match(transcript(), /Codex Collab setup/);
  assert.match(transcript(), /初始化团队（管理员）/);
  assert.match(transcript(), /加入现有团队（成员）/);
});

async function refreshFixture() {
  const f = await fixture();
  try {
    await createMemberConfig({ teamPath: f.teamPath, identityPath: f.identityPath, repoPath: f.repo, dataDir: f.dataDir, configPath: f.configPath });
    const attached = await attachProject({ configPath: f.configPath, repoPath: f.repo });
    return { ...f, ...attached };
  } catch (error) { await f.cleanup(); throw error; }
}

for (const version of ['0.4.3', '0.5.0']) test(`refresh upgrades the ${version} Skill, preserves other settings/resources and is idempotent`, async () => {
  const f = await refreshFixture();
  try {
    const original = await readFile(join(root, `scripts/peer/test/fixtures/team-collab-desktop-${version}.md`), 'utf8');
    await writeFile(f.skill, original);
    const unrelated = 'model = "existing-provider-model"\n[mcp_servers.other]\ncommand = "other-tool"\n';
    const before = unrelated + await readFile(f.mcp_config, 'utf8');
    await writeFile(f.mcp_config, before);
    const references = join(f.repo, '.agents/skills/team-collab-desktop/references');
    await mkdir(references); await writeFile(join(references, 'peer.md'), 'Keep this local reference.');
    const result = await refreshProject({ configPath: f.configPath });
    assert.equal(result.changed, true); assert.equal(result.heartbeat_updated, false);
    const backup = JSON.parse(await readFile(result.backup, 'utf8'));
    assert.equal(backup.config_toml, before); assert.equal(backup.skill, original);
    assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
    assert.equal((await stat(result.binding_prompt)).mode & 0o777, 0o600);
    assert.match(await readFile(result.binding_prompt, 'utf8'), /\$team-collab-desktop.*绑定到当前对话/);
    assert.match(await readFile(f.skill, 'utf8'), /resolve_desktop_request/);
    assert.match(await readFile(f.skill, 'utf8'), /heartbeat/);
    assert.ok((await readFile(f.mcp_config, 'utf8')).startsWith(unrelated));
    assert.match(await readFile(f.skill, 'utf8'), /natural-language request interpretation/);
    assert.equal(await readFile(join(references, 'peer.md'), 'utf8'), 'Keep this local reference.');
    const again = await refreshProject({ configPath: f.configPath });
    assert.equal(again.changed, false); assert.equal(again.backup, null);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('refresh refuses customized Skill/MCP and a different personal config without overwriting files', async () => {
  const f = await refreshFixture();
  try {
    const toml = await readFile(f.mcp_config, 'utf8'); const skill = await readFile(f.skill, 'utf8');
    await writeFile(f.skill, skill + '\nCustom instruction.\n');
    await assert.rejects(refreshProject({ configPath: f.configPath }), /Skill 已自定义/);
    assert.equal(await readFile(f.mcp_config, 'utf8'), toml);
    await writeFile(f.skill, skill);
    await writeFile(f.mcp_config, toml + 'enabled = false\n');
    await assert.rejects(refreshProject({ configPath: f.configPath }), /MCP 有自定义设置/);
    assert.equal(await readFile(f.mcp_config, 'utf8'), toml + 'enabled = false\n');
    await writeFile(f.mcp_config, toml);
    const other = join(f.dir, 'private/other.json'); await writeFile(other, await readFile(f.configPath), { mode: 0o600 });
    await assert.rejects(refreshProject({ configPath: other }), /实际使用的个人配置路径/);
    assert.equal(await readFile(f.skill, 'utf8'), skill);
    assert.equal(await readFile(f.mcp_config, 'utf8'), toml);
  } finally { await f.cleanup(); }
});

test('refresh refuses tracked or symlinked project configuration', async () => {
  const f = await refreshFixture();
  try {
    const skill = await readFile(f.skill, 'utf8');
    git(f.repo, 'add', '-f', '.agents/skills/team-collab-desktop/SKILL.md');
    await assert.rejects(refreshProject({ configPath: f.configPath }), /已提交到项目 Git/);
    git(f.repo, 'reset', '--', '.agents/skills/team-collab-desktop/SKILL.md');
    const target = join(f.dir, 'outside-skill.md'); await writeFile(target, skill);
    await rm(f.skill); await symlink(target, f.skill);
    await assert.rejects(refreshProject({ configPath: f.configPath }), /符号链接/);
    assert.equal(await readFile(target, 'utf8'), skill);
  } finally { await f.cleanup(); }
});

test('refresh CLI generates a new saved prompt but never edits a desktop binding', async () => {
  const f = await refreshFixture();
  try {
    const binding = join(f.dataDir, 'desktop-binding.json');
    await writeFile(binding, '{"thread_id":"fixture-thread"}\n', { mode: 0o600 });
    const options = { cwd: f.repo, env: { ...process.env, HOME: f.dir, USERPROFILE: f.dir } };
    const output = JSON.parse(execFileSync(process.execPath, [cli, 'refresh-project', f.configPath], { ...options, encoding: 'utf8' }));
    assert.equal(output.agent_id, 'bob'); assert.equal(output.heartbeat_updated, false);
    assert.equal(await readFile(binding, 'utf8'), '{"thread_id":"fixture-thread"}\n');
    assert.throws(() => execFileSync(process.execPath, [cli, 'refresh-project'], { ...options, stdio: 'pipe' }), { status: 1 });
  } finally { await f.cleanup(); }
});
