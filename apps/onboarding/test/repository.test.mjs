import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { SetupManager } from '../manager.mjs';
import { readPeerConfig, loadRuntime } from '../../peer/runtime.mjs';
import { PeerService } from '../../../packages/peer/service.mjs';
import { diagnosePeer } from '../../../scripts/peer/onboarding.mjs';

test('admin drafts retain selected remote and branch across restart; members inherit live policy using their own alias', async () => {
  const f = await fixture();
  try {
    git(f.repos.alice, 'push', 'origin', 'HEAD:develop');
    const fork = join(f.root, 'fork.git'); execFileSync('git', ['clone', '--bare', f.remote, fork], { stdio: 'ignore' });
    git(f.repos.alice, 'remote', 'rename', 'origin', 'team'); git(f.repos.alice, 'remote', 'add', 'origin', fork);
    const prepared = await f.manager.prepareAdmin({ repo: f.repos.alice, remote_name: 'team', base_branch: 'develop', display_name: 'Alice', capabilities: 'backend', test_argv: ['sh', 'test.sh'], bot_id: 'bot-alice', secret: 'fixture-secret' });
    const resumed = new SetupManager({ home: f.manager.home, discovery: f.discovery, runCli: () => {} });
    try {
      const draft = JSON.parse(await readFile(resumed.draftPath(prepared.draft_id), 'utf8'));
      assert.equal(draft.input.remote_name, 'team'); assert.equal(draft.input.base_branch, 'develop');
      const admin = await resumed.createAdmin({ ...draft.input, discovery_id: await f.verify({ bot_id: 'bot-alice', secret: 'fixture-secret' }) });
      const loaded = await readPeerConfig(admin.config_path);
      assert.equal(loaded.config.remote_name, 'team'); assert.equal(loaded.team.base_branch, 'develop');
      const checks = await diagnosePeer(admin.config_path, { testPush: true });
      assert.match(checks.checks.repository, /team\/develop/);
      const invite = await resumed.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-bob-secret', password: 'long-fixture-password' });
      const exported = await resumed.exportedBundle(admin.id, invite.invite_id);
      const inspection = await resumed.inspectBundle({ content: exported.content, password: 'long-fixture-password' });
      assert.equal(inspection.base_branch, 'develop');
      // The invite predates this baseline change. Enrollment must use current signed policy.
      await resumed.setRepositoryPolicy({ id: admin.id, expected_version: (await resumed.repositorySettings({ id: admin.id })).version, base_branch: 'main' });
      git(f.repos.bob, 'remote', 'rename', 'origin', 'shared'); git(f.repos.bob, 'remote', 'add', 'origin', fork);
      const imported = await resumed.importBundle({ content: exported.content, password: 'long-fixture-password', repo: f.repos.bob });
      await resumed.verifyMember({ id: imported.id, discovery_id: await f.verify({ bot_id: 'bot-bob', secret: 'fixture-bob-secret' }, 'owner-bob') });
      const requests = (await resumed.detail(admin.id)).requests;
      await resumed.approve({ id: admin.id, request_id: requests[0].request_id });
      const member = await resumed.resume(imported.id); const memberConfig = await readPeerConfig(member.config_path);
      assert.equal(memberConfig.config.remote_name, 'shared'); assert.equal(memberConfig.team.base_branch, 'main');
      assert.equal(member.base_branch, 'main');
      await assert.rejects(resumed.setRepositoryPolicy({ id: member.id, expected_version: 1, base_branch: 'develop' }), /管理员/);
    } finally { resumed.close(); }
  } finally { await f.cleanup(); }
});

test('signed baseline changes apply to future tasks only and reject stale policy updates', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const { service } = await loadRuntime(admin.config_path);
    const before = await service.create({ title: 'before', acceptance: ['pass'] }, 'before');
    await writeFile(join(f.repos.alice, 'develop.txt'), 'new baseline\n');
    git(f.repos.alice, 'add', 'develop.txt'); git(f.repos.alice, 'commit', '-m', 'develop'); git(f.repos.alice, 'push', 'origin', 'HEAD:develop');
    const settings = await f.manager.repositorySettings({ id: admin.id });
    assert.deepEqual(settings.branches, ['develop', 'main']);
    await f.manager.setRepositoryPolicy({ id: admin.id, expected_version: settings.version, base_branch: 'develop' });
    await assert.rejects(f.manager.setRepositoryPolicy({ id: admin.id, expected_version: settings.version, base_branch: 'main' }), /规则已更新/);
    await assert.rejects(f.manager.setRepositoryPolicy({ id: admin.id, expected_version: settings.version + 1, base_branch: 'missing' }), /不存在/);
    await assert.rejects(f.manager.setRepositoryPolicy({ id: admin.id, expected_version: settings.version + 1, base_branch: 'agent-collab' }), /账本/);
    // Reuse the already running service; a restart must not be required for policy refresh.
    const after = await service.create({ title: 'after', acceptance: ['pass'] }, 'after');
    assert.equal(after.spec.base_branch, 'develop'); assert.equal(after.spec.base_commit, git(f.repos.alice, 'rev-parse', 'HEAD'));
    const historical = await service.read(before.spec.id);
    assert.equal(historical.spec.base_branch, 'main'); assert.equal(historical.spec.base_commit, before.spec.base_commit);
    assert.equal(historical.team.base_branch, 'main');
    assert.equal((await f.manager.detail(admin.id, { localOnly: true })).base_branch, 'develop');
    const cached = await readPeerConfig(admin.config_path);
    await writeFile(cached.config.team_file, JSON.stringify(before.team));
    assert.equal((await diagnosePeer(admin.config_path)).base_branch, 'develop', 'doctor uses live signed policy even with a stale local cache');
    await writeFile(cached.config.team_file, JSON.stringify(cached.team));
    const currentStore = await f.manager.profileStore(await f.manager.state(admin.id));
    assert.equal((await new PeerService(currentStore).read(before.spec.id)).spec.base_commit, before.spec.base_commit);
    git(f.repos.bob, 'remote', 'rename', 'origin', 'company');
    const own = await f.manager.createOwnAgent({ id: admin.id, agent_id: 'personal', display_name: 'Personal', capabilities: 'backend', bot_id: 'bot-personal', secret: 'fixture-personal-secret', repo: f.repos.bob });
    const ready = await f.manager.verifyMember({ id: own.id, discovery_id: await f.verify({ profile_id: own.id }) });
    const personal = await readPeerConfig(ready.config_path);
    assert.equal(personal.team.base_branch, 'develop'); assert.equal(personal.config.remote_name, 'company');
  } finally { await f.cleanup(); }
});
