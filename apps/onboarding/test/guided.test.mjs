import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { cloneRepository, commandArgv, displayCommand, memberFields, recommendTests } from '../guided.mjs';
import { SetupManager } from '../manager.mjs';
import { decryptBundle } from '../bundle.mjs';
import { readPrivateJson } from '../../../packages/peer/config.mjs';

const bot = (name, extra = {}) => ({ display_name: name, responsibility: 'backend', bot_id: `bot-${name}`, secret: `fixture-secret-${name}`, ...extra });

test('friendly member fields generate valid IDs and explicit responsibility presets', () => {
  assert.deepEqual(memberFields({ display_name: 'Alice Wu', responsibility: 'fullstack' }), { display_name: 'Alice Wu', agent_id: 'alice-wu', capabilities: ['frontend', 'backend'] });
  assert.match(memberFields({ display_name: '张三' }).agent_id, /^agent-[a-f0-9]{8}$/);
  assert.deepEqual(memberFields({ agent_id: 'bob', capabilities: 'go,backend,go' }).capabilities, ['go', 'backend']);
  for (const invalid of [{ display_name: 3 }, { display_name: 'A', agent_id: {} }, { display_name: 'A', capabilities: [1] }, { display_name: 'A', responsibility: 'unknown' }]) assert.throws(() => memberFields(invalid), /名称|职责|文字/);
});

test('confirmed commands parse quotes as literal argv and reject shell operators', () => {
  assert.deepEqual(commandArgv('node "test file.mjs" --name=demo'), ['node', 'test file.mjs', '--name=demo']);
  const argv = ['node', "a'b", 'literal $(ignored)', 'x y'];
  assert.deepEqual(commandArgv(displayCommand(argv)), argv);
  for (const unsafe of ['', 'npm test && echo ok', 'sh test.sh | cat', 'node $(touch file)', 'node `touch file`', 'npm test > out', 'node (test)', 'node "broken', 'node test\nrm', 'node ""']) assert.throws(() => commandArgv(unsafe));
});

test('project detection only suggests commands and never executes repository scripts', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repos.bob, 'package.json'), JSON.stringify({ scripts: { test: 'throw-this-must-not-run' } }));
    await writeFile(join(f.repos.bob, 'go.mod'), 'module fixture');
    assert.deepEqual((await recommendTests(f.repos.bob)).map((item) => item.command), ['sh test.sh', 'npm test', 'go test ./...']);
    const checked = await f.manager.prepareProject({ repo: f.repos.bob });
    assert.equal(checked.remote, f.remote); assert.equal(f.calls.length, 0);
    await assert.rejects(f.manager.prepareAdmin({ repo: f.repos.bob, ...bot('bob'), test_command: 'npm test && echo ok' }), /命令/);
    assert.equal(f.discovery.sessions.size, 0); assert.equal((await f.manager.overview()).drafts.length, 0);
  } finally { await f.cleanup(); }
});

test('guided clone supports paths with spaces, resumes the same clone, and preserves unrelated folders', async () => {
  const f = await fixture();
  try {
    const mirror = join(f.root, 'local mirror.git'); execFileSync('git', ['clone', '--bare', f.remote, mirror], { stdio: 'ignore' });
    const destination = join(f.root, 'new project');
    const options = { remote: mirror, destination, privateHome: f.manager.home };
    const result = await cloneRepository(options); assert.equal(git(result, 'remote', 'get-url', 'origin'), mirror);
    assert.equal(await cloneRepository(options), result);
    const unrelated = join(f.root, 'personal'); await mkdir(unrelated); await writeFile(join(unrelated, 'keep'), 'personal file');
    await assert.rejects(cloneRepository({ ...options, destination: unrelated }), /目录已存在/);
    assert.equal(await readFile(join(unrelated, 'keep'), 'utf8'), 'personal file');
    await assert.rejects(cloneRepository({ ...options, remote: 'ext::bad' }), /地址/);
    await assert.rejects(cloneRepository({ ...options, remote: 'https://token@github.com/x/y.git' }), /Token/);
    await mkdir(f.manager.home, { recursive: true });
    const alias = join(f.root, 'private-link'); await symlink(f.manager.home, alias);
    await assert.rejects(cloneRepository({ ...options, destination: join(alias, 'project') }), /不能相互包含/);
    const badTarget = join(f.root, 'bad-clone');
    await assert.rejects(cloneRepository({ ...options, remote: join(f.root, 'missing.git'), destination: badTarget }), /拉取仓库/);
    assert.ok(!(await readdir(f.root)).some((file) => file === 'bad-clone' || file.startsWith('.collab-clone-')));
  } finally { await f.cleanup(); }
});

test('administrator draft persists private credentials, survives restart and completes idempotently', async () => {
  const f = await fixture();
  try {
    const draft = await f.manager.prepareAdmin({ repo: f.repos.alice, ...bot('Alice'), responsibility: 'fullstack', test_command: 'sh test.sh', team_name: '开发团队' });
    assert.equal(draft.agent_id, 'alice'); assert.doesNotMatch(JSON.stringify(draft), /fixture-secret/);
    const listing = await f.manager.overview(); assert.equal(listing.drafts.length, 1); assert.doesNotMatch(JSON.stringify(listing), /fixture-secret/);
    assert.equal((await stat(f.manager.draftPath(draft.draft_id))).mode & 0o777, 0o600);
    const restarted = new SetupManager({ home: f.manager.home, discovery: f.discovery, runCli: f.manager.runCli });
    assert.equal((await restarted.adminDraft({ id: draft.draft_id })).id, draft.id);
    const state = f.discovery.sessions.get(draft.id); state.client.emit('authenticated'); state.client.emit('message.text', { body: { chattype: 'group', chatid: 'group', from: { userid: 'owner-alice' }, text: { content: draft.message } } });
    const profile = await restarted.completeAdmin({ draft_id: draft.draft_id, discovery_id: draft.id });
    assert.equal(profile.phase, 'ready'); assert.equal(profile.display_name, 'Alice');
    assert.equal((await restarted.completeAdmin({ draft_id: draft.draft_id, discovery_id: draft.id })).id, profile.id);
    const saved = await readPrivateJson(f.manager.draftPath(draft.draft_id)); assert.equal(saved.input.secret, undefined);
    assert.equal((await f.manager.overview()).drafts.length, 0);
    assert.equal(f.calls.filter((call) => call.command === 'start').length, 1);
  } finally { await f.cleanup(); }
});

test('batch invitations publish together, retain private delivery, and reject duplicate assignment before publishing', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    await assert.rejects(f.manager.issueBatch({ id: admin.id, members: [bot('Bob'), bot('Bob')] }), /重复/);
    const store = await f.manager.profileStore(await f.manager.state(admin.id));
    assert.deepEqual(await readdir(join(store.checkout, '.agent-collab/team/invitations')).catch(() => []), []);
    const batch = await f.manager.issueBatch({ id: admin.id, members: [bot('Bob'), bot('Carol', { responsibility: 'testing' })] });
    assert.equal(batch.assignments.length, 2); assert.notEqual(batch.assignments[0].password, batch.assignments[1].password);
    for (const item of batch.assignments) {
      assert.ok(item.password.length >= 12);
      const exported = await f.manager.exportedBundle(admin.id, item.invite_id);
      assert.doesNotMatch(exported.content, /fixture-secret|delivery_password/); assert.ok(!exported.content.includes(item.password));
      const bundle = decryptBundle(JSON.parse(exported.content), item.password); assert.equal(bundle.display_name, item.display_name);
      const delivery = await f.manager.delivery({ id: admin.id, invite_id: item.invite_id });
      assert.equal(delivery.password, item.password); assert.ok(!delivery.instructions.includes(item.password)); assert.doesNotMatch(delivery.instructions, /fixture-secret/);
      const ledger = git(f.remote, 'show', `agent-collab:.agent-collab/team/invitations/${item.invite_id}.json`);
      assert.ok(!ledger.includes(item.password)); assert.doesNotMatch(ledger, /fixture-secret|display_name|delivery_password/);
    }
    const count = (await f.manager.detail(admin.id)).exports.length;
    await assert.rejects(f.manager.issueBatch({ id: admin.id, members: [bot('Dave'), bot('Bob')] }), /有效接入包/);
    assert.equal((await f.manager.detail(admin.id)).exports.length, count);
  } finally { await f.cleanup(); }
});

test('invitation metadata and validated remote drive automatic clone, with tampering rejected before clone', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const item = (await f.manager.issueBatch({ id: admin.id, members: [bot('Bob')] })).assignments[0];
    const { content } = await f.manager.exportedBundle(admin.id, item.invite_id);
    const input = { content, password: item.password, repo_mode: 'clone', destination: join(f.root, 'auto-bob'), remote: 'ext::untrusted-browser-remote' };
    const info = await f.manager.inspectBundle(input); assert.equal(info.remote, f.remote); assert.equal(info.agent_id, 'bob'); assert.doesNotMatch(JSON.stringify(info), /fixture-secret|private_key/);
    await assert.rejects(f.manager.importBundle({ ...input, password: 'wrong-password-123' }), /密码|接入包/);
    assert.ok(!(await readdir(f.root)).includes('auto-bob'));
    const imported = await f.manager.importBundle(input); assert.equal(imported.phase, 'imported'); assert.equal(git(imported.repo, 'remote', 'get-url', 'origin'), f.remote);
    const other = join(f.root, 'should-not-clone');
    assert.equal((await f.manager.importBundle({ ...input, destination: other })).id, imported.id);
    assert.ok(!(await readdir(f.root)).includes('should-not-clone'));
  } finally { await f.cleanup(); }
});

test('automatic progress waits for explicit approval, completes once, and leaves stopped runners stopped', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const item = await f.manager.issueBundle({ id: admin.id, ...bot('Bob') });
    const { content } = await f.manager.exportedBundle(admin.id, item.invite_id);
    const imported = await f.manager.importBundle({ content, password: item.password, repo: f.repos.bob });
    const proof = await f.verify({ profile_id: imported.id }, 'owner-bob');
    assert.equal((await f.manager.verifyMember({ id: imported.id, discovery_id: proof })).phase, 'waiting');
    assert.equal((await f.manager.progress({ id: imported.id })).phase, 'waiting');
    const req = (await f.manager.progress({ id: admin.id, sync: true })).requests[0]; assert.equal(req.agent_id, 'bob');
    await f.manager.approve({ id: admin.id, request_id: req.request_id });
    assert.equal((await f.manager.progress({ id: imported.id })).phase, 'ready');
    const starts = f.calls.filter((call) => call.command === 'start').length;
    await f.manager.runner({ id: imported.id, command: 'stop' });
    await f.manager.progress({ id: imported.id, sync: true }); await f.manager.progress({ id: admin.id, sync: true });
    assert.equal(f.calls.filter((call) => call.command === 'start').length, starts);
    const saved = await f.manager.state(imported.id); saved.phase = 'configuring'; saved.last_error = '请检查 Git 权限'; await f.manager.save(saved);
    assert.equal((await f.manager.progress({ id: imported.id })).error, '请检查 Git 权限');
    assert.equal(f.calls.filter((call) => call.command === 'start').length, starts);
  } finally { await f.cleanup(); }
});


test('project check reuses an existing local connection even offline without exposing credentials or starting a runner', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const starts = f.calls.length;
    const peerBefore = await readFile(admin.config_path, 'utf8');
    const alias = join(f.root, 'project-alias'); await symlink(f.repos.alice, alias);
    git(f.repos.alice, 'remote', 'set-url', 'origin', join(f.root, 'unreachable.git'));
    const selected = await f.manager.prepareProject({ repo: alias });
    assert.deepEqual(selected, { repo: admin.repo, existing_profile: { id: admin.id } });
    assert.doesNotMatch(JSON.stringify(selected), /fixture-secret|private_key/);
    assert.equal(f.calls.length, starts);
    assert.equal(await readFile(admin.config_path, 'utf8'), peerBefore);
    await assert.rejects(f.manager.prepareAdmin({ repo: alias, ...bot('Other'), test_command: 'sh test.sh' }), /已经接入/);
    assert.equal((await f.manager.overview()).drafts.length, 0);
    // A different clone still gets an independent connection, even for this same remote.
    assert.equal((await f.manager.prepareProject({ repo: f.repos.bob })).existing_profile, undefined);
    const state = await f.manager.state(admin.id); state.phase = 'removed'; await f.manager.save(state);
    git(f.repos.alice, 'remote', 'set-url', 'origin', f.remote);
    assert.equal((await f.manager.prepareProject({ repo: alias })).existing_profile, undefined);
  } finally { await f.cleanup(); }
});
