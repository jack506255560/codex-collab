import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerSupervisor } from '../supervisor.mjs';
import { readRunnerIntent, writeRunnerIntent } from '../../peer/intent.mjs';
import { acquireRunnerControl } from '../../peer/process.mjs';
import { startupDefinition, configureStartup } from '../startup.mjs';
import { resolveCommand } from '../commands.mjs';
import { fixture } from './helpers.mjs';
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../../../bin/codex-collab.mjs', import.meta.url));

test('supervision restores enabled connections, backs off failures and preserves explicit stops', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const state = await f.manager.state(admin.id); const data = join(f.manager.path(admin.id), 'data');
    let now = Date.now(); const supervisor = new RunnerSupervisor(f.manager, { clock: () => now });
    f.calls.length = 0; await supervisor.tick(); assert.equal(f.calls.at(-1).command, 'recover');
    await f.manager.runner({ id: admin.id, command: 'stop' }); f.calls.length = 0;
    await supervisor.tick(); assert.equal(f.calls.length, 0); assert.equal((await readRunnerIntent(data)).enabled, false);
    await f.manager.resume(admin.id); assert.equal(f.calls.length, 0, 'resuming configuration must not undo a deliberate stop');
    await writeRunnerIntent(data, true);
    f.manager.runCli = () => { throw new Error('PRIVATE-SECRET'); };
    await supervisor.tick(); assert.equal(supervisor.failures.size, 1);
    const retry = supervisor.failures.get(admin.id); await supervisor.tick(); assert.equal(supervisor.failures.get(admin.id), retry);
    now = retry.after + 1; await supervisor.tick(); assert.equal(supervisor.failures.get(admin.id).attempts, 2);
    assert.doesNotMatch(await readFile(join(f.manager.home, 'supervisor.json'), 'utf8'), /PRIVATE-SECRET/);
    state.phase = 'removed'; await f.manager.save(state); await supervisor.tick();
  } finally { await f.cleanup(); }
});

test('upgrade adopts only live legacy runners; path-free CLI resolves project and rejects ambiguity', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const data = join(f.manager.path(admin.id), 'data');
    await rm(join(data, 'runner-intent.json')); f.calls.length = 0;
    await f.manager.resume(admin.id); assert.equal(f.calls.length, 0, 'opening an offline legacy profile must preserve the stopped connection');
    await new RunnerSupervisor(f.manager).tick(); assert.equal(f.calls.length, 0); assert.equal((await readRunnerIntent(data)).enabled, false);
    const resolved = await resolveCommand(['status'], { home: f.manager.home, cwd: f.repos.alice });
    assert.equal(resolved.profile.id, admin.id);
    const second = { ...await f.manager.state(admin.id), id: '11111111-1111-1111-1111-111111111111', repo: f.repos.bob };
    await f.manager.save(second);
    await assert.rejects(resolveCommand(['status'], { home: f.manager.home, cwd: f.root }), /多个接入/);
    const selected = await resolveCommand(['status', '--profile', admin.id], { home: f.manager.home, cwd: f.root }); assert.equal(selected.profile.id, admin.id);
    const legacy = await resolveCommand(['read', join(f.root, 'private-peer.json'), 'task-1'], { home: f.manager.home }); assert.deepEqual(legacy.args, ['task-1']);
  } finally { await f.cleanup(); }
});

test('login service definitions quote paths and surface platform registration failures safely', async () => {
  const home = await mkdtemp(join(tmpdir(), 'collab-startup-'));
  try {
    const mac = startupDefinition({ home: join(home, 'a & b'), userHome: home, platform: 'darwin', node: '/node path/bin/node', path: '/bin:<private>' });
    assert.match(mac.content, /a &amp; b/); assert.match(mac.content, /SuccessfulExit/); assert.match(mac.content, /<key>Umask<\/key><integer>63/);
    const linux = startupDefinition({ home: join(home, 'a % b'), userHome: home, platform: 'linux', path: '/bin:$local' });
    assert.match(linux.content, /a %% b/); assert.match(linux.content, /PATH=\/bin:\$local/);
    assert.throws(() => startupDefinition({ home: home + '\nInjected', platform: 'linux' }), /换行/);
    const calls = [];
    const registered = await configureStartup({ home, platform: 'darwin', userHome: home, start: true, execute: async (...args) => { calls.push(args); } });
    assert.equal(registered.enabled, true); assert.equal(calls[0][1][0], 'bootstrap'); assert.equal((await stat(startupDefinition({ home, userHome: home, platform: 'darwin' }).path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'service.log'))).mode & 0o777, 0o600);
    const failure = await configureStartup({ home, platform: 'linux', userHome: home, execute: async () => { throw new Error('TOKEN-PRIVATE'); } });
    assert.equal(failure.enabled, false); assert.doesNotMatch(JSON.stringify(failure), /TOKEN-PRIVATE/);
    const unsupported = await configureStartup({ home, platform: 'win32' }); assert.equal(unsupported.supported, false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('legacy migration rechecks stop intent while holding the cross-process control lock', async () => {
  const f = await fixture(); let release;
  try {
    const admin = await f.admin(); const data = join(f.manager.path(admin.id), 'data');
    const configPath = join(f.manager.path(admin.id), 'peer.json');
    await rm(join(data, 'runner-intent.json'));
    await writeFile(join(data, 'runner.pid.json'), JSON.stringify({ pid: process.pid, config: configPath }));
    release = await acquireRunnerControl(data, configPath);
    let finished = false;
    const pending = new RunnerSupervisor(f.manager).tick().then(() => { finished = true; });
    await delay(100);
    assert.equal(finished, false, 'migration must wait for an in-progress stop');
    await writeRunnerIntent(data, false); await release(); release = null;
    f.calls.length = 0; await pending;
    assert.equal((await readRunnerIntent(data)).enabled, false); assert.equal(f.calls.length, 0);
  } finally { await release?.(); await f.cleanup(); }
});

test('default launcher exits while a private background workbench stays alive and is reused', { timeout: 25000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'collab-background-')); let pid;
  const env = { ...process.env, CODEX_COLLAB_HOME: home };
  try {
    const first = await exec(process.execPath, [cli, 'setup', '--no-open', '--no-startup'], { env, timeout: 12000 });
    assert.match(first.stdout, /可以关闭终端和浏览器/);
    const state = JSON.parse(await readFile(join(home, 'wizard.json'), 'utf8')); pid = state.pid;
    assert.notEqual(pid, process.pid); process.kill(pid, 0);
    assert.equal(state.runtime.version, JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')).version);
    assert.equal(state.runtime.entry, fileURLToPath(new URL('../main.mjs', import.meta.url)));
    assert.equal((await stat(join(home, 'wizard.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'service.log'))).mode & 0o777, 0o600);
    const url = new URL(state.url); const response = await fetch(`${url.origin}/api/session`, { method: 'POST', headers: { Origin: url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: url.hash.slice(1) }) });
    assert.equal(response.status, 200);
    const overview = await fetch(`${url.origin}/api/overview`, { headers: { Cookie: response.headers.get('set-cookie').split(';')[0] } }); assert.equal(overview.status, 200);
    await exec(process.execPath, [cli, 'setup', '--no-open', '--no-startup'], { env, timeout: 12000 });
    assert.equal(JSON.parse(await readFile(join(home, 'wizard.json'), 'utf8')).pid, pid);
    const status = await exec(process.execPath, [cli, 'service-status'], { env }); assert.equal(JSON.parse(status.stdout).online, true); assert.doesNotMatch(status.stdout, /#|token|http:/);
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50; i++) { try { await stat(join(home, 'wizard.json')); } catch { break; } await delay(100); } }
    await rm(home, { recursive: true, force: true });
  }
});

test('setup replaces legacy and outdated workbenches, serializes concurrent launches and serves the full effect module graph', { timeout: 35000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'collab-service-upgrade-'));
  const path = join(home, 'wizard.json'); const env = { ...process.env, CODEX_COLLAB_HOME: home }; let pid;
  const launch = () => exec(process.execPath, [cli, 'setup', '--no-open', '--no-startup'], { env, timeout: 18000 });
  try {
    await launch(); let state = JSON.parse(await readFile(path, 'utf8')); pid = state.pid;
    for (const legacy of [true, false]) {
      const oldPid = pid;
      if (legacy) delete state.runtime;
      else state.runtime.version = '0.0.0';
      await writeFile(path, JSON.stringify(state), { mode: 0o600 });
      const launches = await Promise.all([launch(), launch()]);
      assert.equal(launches.filter(result => /已更新本机向导服务/.test(result.stdout)).length, 1);
      state = JSON.parse(await readFile(path, 'utf8')); pid = state.pid;
      assert.notEqual(pid, oldPid);
      assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
      const origin = new URL(state.url).origin;
      for (const asset of ['/effects.css', '/effects.js', '/vendor/three.module.js', '/vendor/three.core.js']) {
        const response = await fetch(origin + asset);
        assert.equal(response.status, 200, asset);
        assert.match(response.headers.get('content-type'), /text\/(css|javascript)/);
      }
      assert.equal((await fetch(origin + '/api/overview')).status, 401);
      await launch(); assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, pid, 'the upgraded workbench is reused');
    }
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50; i++) { try { await stat(path); } catch { break; } await delay(100); } }
    await rm(home, { recursive: true, force: true });
  }
});

test('setup refuses to signal an outdated service when its private session cannot be authenticated', { timeout: 20000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'collab-service-identity-'));
  const path = join(home, 'wizard.json'); const env = { ...process.env, CODEX_COLLAB_HOME: home }; let pid, original;
  const launch = () => exec(process.execPath, [cli, 'setup', '--no-open', '--no-startup'], { env, timeout: 12000 });
  try {
    await launch(); original = await readFile(path, 'utf8');
    const state = JSON.parse(original); pid = state.pid; delete state.runtime;
    const url = new URL(state.url); url.hash = '0'.repeat(64); state.url = url.href;
    await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    await assert.rejects(launch(), error => /无法确认旧版向导服务的身份/.test(error.stderr) && !error.stderr.includes(url.hash.slice(1)));
    process.kill(pid, 0);
    assert.equal((await fetch(new URL(JSON.parse(original).url).origin)).status, 200);
  } finally {
    if (original) await writeFile(path, original, { mode: 0o600 });
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} for (let i = 0; i < 50; i++) { try { await stat(path); } catch { break; } await delay(100); } }
    await rm(home, { recursive: true, force: true });
  }
});

test('repair restores a missing generated Skill and diagnosis reports actionable checks without secrets', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const skill = join(f.repos.alice, '.agents/skills/team-collab-desktop/SKILL.md');
    await rm(skill); await f.manager.repair({ id: admin.id }); assert.match(await readFile(skill, 'utf8'), /team-collab-desktop/);
    const report = await f.manager.diagnostics({ id: admin.id });
    assert.equal(report.ready, false); assert.ok(report.checks.find((check) => check.key === 'binding').action); assert.equal(report.heartbeat_confirmed, false);
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret|private_key/);
    await writeFile(skill, '# custom skill'); await assert.rejects(f.manager.repair({ id: admin.id }), /自定义/); assert.equal(await readFile(skill, 'utf8'), '# custom skill');
  } finally { await f.cleanup(); }
});

test('repair reconstructs missing MCP settings and preserves unrelated or other identities settings', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const toml = join(f.repos.alice, '.codex/config.toml');
    await rm(toml); await f.manager.repair({ id: admin.id });
    assert.match(await readFile(toml, 'utf8'), /\[mcp_servers\.team-collab-alice\]/);
    await writeFile(toml, 'model = "custom-model"\n');
    await f.manager.repair({ id: admin.id });
    assert.match(await readFile(toml, 'utf8'), /^model = "custom-model"\n/);
    const other = '[mcp_servers.team-collab-other]\ncommand = "custom"\n';
    await writeFile(toml, other); await assert.rejects(f.manager.repair({ id: admin.id }), /MCP/);
    assert.equal(await readFile(toml, 'utf8'), other);
  } finally { await f.cleanup(); }
});

test('real local runner recovers from process death and stays offline after a CLI stop', { timeout: 25000 }, async () => {
  const f = await fixture(); let pid;
  try {
    const admin = await f.admin(); const configPath = join(f.manager.path(admin.id), 'peer.json');
    const config = JSON.parse(await readFile(configPath, 'utf8')); delete config.wecom;
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 }); // Local Git only, no external bot or SDK session.
    f.manager.runCli = async (command, path) => (await exec(process.execPath, [cli, command, path], { timeout: 12000 })).stdout;
    const lockPath = join(config.data_dir, 'runner.pid.json');
    await f.manager.runCli('start', configPath); pid = JSON.parse(await readFile(lockPath, 'utf8')).pid;
    for (let i = 0; i < 100; i++) {
      if ((await readFile(join(config.data_dir, 'runner.log'), 'utf8')).includes('runner online')) break;
      await delay(50);
    }
    const original = pid; process.kill(pid, 'SIGKILL');
    for (let i = 0; i < 100; i++) { try { process.kill(pid, 0); } catch { break; } await delay(20); }
    const supervisor = new RunnerSupervisor(f.manager); await supervisor.tick();
    pid = JSON.parse(await readFile(lockPath, 'utf8')).pid; assert.notEqual(pid, original); process.kill(pid, 0);
    await f.manager.runCli('stop', configPath); pid = null;
    assert.equal((await readRunnerIntent(config.data_dir)).enabled, false);
    await supervisor.tick(); await assert.rejects(readFile(lockPath), { code: 'ENOENT' });
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    await f.cleanup();
  }
});
