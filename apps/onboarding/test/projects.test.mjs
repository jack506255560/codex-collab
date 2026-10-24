import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { groupProjects, projectId, projectView } from '../projects.mjs';
import { generateIdentity } from '../../../packages/peer/config.mjs';
import { policyVersion, recordHash, registryPath } from '../../../packages/peer/registry.mjs';
import { buildTeamPolicy } from '../../../scripts/peer/onboarding.mjs';
import { fixture } from './helpers.mjs';

const remote = 'https://example.invalid/team/product.git';
test('project grouping combines clones and equivalent remotes while separating forks and signed roots', () => {
  const state = { id: 'a', agent_id: 'alice', remote, root_hash: 'root', phase: 'ready', repo: '/fixture/first' };
  const states = [state, { ...state, id: 'b', agent_id: 'bob', repo: '/fixture/second', remote: 'git@example.invalid:team/product.git' },
    { ...state, id: 'c', remote: 'https://example.invalid/fork/product.git' }, { ...state, id: 'd', root_hash: 'different-root' },
    { ...state, id: 'removed', phase: 'removed' }];
  const projects = groupProjects(states);
  assert.equal(projects.length, 3);
  const project = projects.find((value) => value.id === projectId(state));
  assert.deepEqual(project.profile_ids, ['a', 'b']); assert.equal(project.local_agent_count, 2);
  assert.equal(project.name, 'product'); assert.equal(project.repository, 'example.invalid/team/product');
  assert.notEqual(projectId({ id: 'x' }), projectId({ id: 'y' }));
  assert.equal(projectId(state), projectId({ ...state, remote: 'https://user:credential@example.invalid/team/product.git' }));
});

async function signedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'collab-projects-'));
  const keys = Object.fromEntries(['alice', 'bob', 'carol'].map((id) => [id, generateIdentity()]));
  const team = buildTeamPolicy({ repo: 'product', reviewer: 'alice', defaultRoute: 'backend', agents: Object.entries(keys).map(([id, key]) => ({
    id, role: id === 'alice' ? 'admin' : 'member', capabilities: ['backend'], publicKey: key.public_key,
    wecomUserid: id === 'bob' ? 'private-bob-owner' : 'private-alice-owner',
  })), routes: { backend: ['alice', 'bob', 'carol'] } });
  const genesis = policyVersion(team, null, 'alice', keys.alice.private_key), rootHash = recordHash(genesis);
  const states = [];
  const manager = { path: (id) => join(root, id), async localStates() { return states; }, async profileStore() { throw new Error('Git echoed PRIVATE-CREDENTIAL'); },
    async detail() { return { runner: { online: true }, desktop: { binding: {} }, poll_recent: true, can_receive_tasks: false }; } };
  async function local(agentId, { identity = keys[agentId], phase = 'ready', history = [genesis] } = {}) {
    const id = randomUUID(), path = manager.path(id); await mkdir(path);
    const identityPath = join(path, 'identity.json'); await writeFile(identityPath, JSON.stringify(identity), { mode: 0o600 });
    const state = { id, remote, root_hash: rootHash, agent_id: agentId, role: team.agents[agentId].role,
      phase, repo: join(root, `clone-${id}`), identity_path: identityPath, bundle: { history }, bootstrap_team: team, wecom: { secret: 'PRIVATE-CREDENTIAL' } };
    states.push(state); return state;
  }
  async function cache(state, history) {
    const dir = join(manager.path(state.id), 'data', 'peer-ledger', registryPath, 'versions'); await mkdir(dir, { recursive: true });
    for (const record of history) await writeFile(join(dir, `${String(record.version).padStart(6, '0')}.json`), JSON.stringify(record));
  }
  return { root, keys, team, genesis, states, manager, local, cache, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('signed project roster marks local and same-owner agents as mine without exposing ownership or credentials', async () => {
  const f = await signedFixture();
  try {
    const alice = await f.local('alice');
    const result = await projectView(f.manager, projectId(alice));
    assert.equal(result.sync_status, 'cached'); assert.match(result.sync_error, /同步暂未成功/);
    assert.deepEqual(result.agents.map(({ agent_id, mine }) => [agent_id, mine]), [['alice', true], ['bob', false], ['carol', true]]);
    assert.equal(result.agents[0].connections[0].id, alice.id); assert.equal(result.agents[0].connections[0].can_receive_tasks, false);
    assert.deepEqual(result.agents[1].connections, []); assert.deepEqual(result.agents[2].connections, []);
    assert.equal(result.admin_profile_id, alice.id);
    assert.doesNotMatch(JSON.stringify(result), /private-alice-owner|private-bob-owner|PRIVATE-CREDENTIAL|private_key|public_key|wecom_userid/);
    f.states.length = 0;
    const bob = await f.local('bob'); const member = await projectView(f.manager, projectId(bob), { localOnly: true });
    assert.deepEqual(member.agents.map(({ mine }) => mine), [false, true, false]); assert.equal(member.admin_profile_id, null);
  } finally { await f.cleanup(); }
});

test('offline project chooses newest verified history across connections and ignores tampered cache', async () => {
  const f = await signedFixture();
  try {
    const alice = await f.local('alice'), carol = await f.local('carol');
    const changed = structuredClone(f.team); changed.base_branch = 'develop';
    const next = policyVersion(changed, f.genesis, 'alice', f.keys.alice.private_key);
    await f.cache(carol, [f.genesis, next]);
    let result = await projectView(f.manager, projectId(alice), { localOnly: true });
    assert.equal(result.base_branch, 'develop'); assert.equal(result.sync_status, 'cached'); assert.equal(result.sync_error, null);
    const bad = structuredClone(next); bad.team.base_branch = 'malicious'; await f.cache(carol, [f.genesis, bad]);
    result = await projectView(f.manager, projectId(alice), { localOnly: true });
    assert.equal(result.base_branch, 'main');
    f.manager.profileStore = async () => ({ team: changed });
    result = await projectView(f.manager, projectId(alice)); assert.equal(result.sync_status, 'synced'); assert.equal(result.base_branch, 'develop');
  } finally { await f.cleanup(); }
});

test('mismatched local key cannot claim signed membership or administrative project actions', async () => {
  const f = await signedFixture();
  try {
    const state = await f.local('alice', { identity: generateIdentity() });
    const result = await projectView(f.manager, projectId(state), { localOnly: true });
    const signed = result.agents.find((value) => value.agent_id === 'alice' && value.registered);
    assert.equal(signed.mine, false); assert.deepEqual(signed.connections, []); assert.equal(result.admin_profile_id, null);
    assert.equal(result.agents.find((value) => value.agent_id === 'carol').mine, false);
    const recoverable = result.agents.find((value) => !value.registered);
    assert.equal(recoverable.identity_conflict, true); assert.equal(recoverable.connections[0].id, state.id);
    state.bundle.history[0] = { ...f.genesis, signature: 'tampered' };
    const untrusted = await projectView(f.manager, projectId(state), { localOnly: true });
    assert.equal(untrusted.sync_status, 'pending'); assert.equal(untrusted.agents.length, 1); assert.equal(untrusted.agents[0].registered, false);
    await assert.rejects(projectView(f.manager, 'missing'), /未找到这个项目/);
  } finally { await f.cleanup(); }
});

test('real Git enrollment appears as one project and removing a local connection preserves signed team membership', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const own = await f.manager.createOwnAgent({ id: admin.id, repo: f.repos.bob, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-secret-bob' });
    await f.manager.verifyMember({ id: own.id, discovery_id: await f.verify({ profile_id: own.id }) });
    const overview = await f.manager.overview(); assert.equal(overview.projects.length, 1); assert.equal(overview.projects[0].local_agent_count, 2);
    const project = await f.manager.project(overview.projects[0].id); assert.equal(project.sync_status, 'synced');
    assert.deepEqual(project.agents.map((value) => [value.agent_id, value.mine, value.connections.length]), [['alice', true, 1], ['bob', true, 1]]);
    assert.equal((await f.manager.detail(own.id, { localOnly: true })).project_id, project.id);
    const state = await f.manager.state(own.id); await f.manager.save({ ...state, phase: 'removed' });
    const after = await f.manager.project(project.id, { localOnly: true });
    assert.equal(after.local_agent_count, 1); assert.equal(after.agents.find((value) => value.agent_id === 'bob').connections.length, 0);
  } finally { await f.cleanup(); }
});
