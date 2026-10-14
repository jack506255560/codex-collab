import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, git } from './helpers.mjs';
import { decryptBundle } from '../bundle.mjs';
import { generateIdentity, readPrivateJson } from '../../../packages/peer/config.mjs';
import { policyVersion, validateHistory, recordHash, invitationRecord, enrollmentRequest, approveEnrollment, validateEnrollment } from '../../../packages/peer/registry.mjs';
import { buildTeamPolicy } from '../../../scripts/peer/onboarding.mjs';

async function legacyInvite(f, admin) {
  const issued = await f.manager.issueBundle({ id: admin.id, agent_id: 'bob', capabilities: 'backend', bot_id: 'bot-bob', secret: 'fixture-old-secret', password: 'fixture-old-password' });
  const path = join(f.manager.path(admin.id), 'exports', `${issued.invite_id}.json`);
  const saved = await readPrivateJson(path);
  // Match pre-password-persistence installations: only the ciphertext and public invitation survived.
  await writeFile(path, JSON.stringify({ invitation: saved.invitation, encrypted: saved.encrypted }), { mode: 0o600 });
  return { issued, saved, path };
}

test('legacy missing password recovers a usable package, invalidates the old one and protects approved members', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const { issued, saved } = await legacyInvite(f, admin);
    const before = await f.manager.delivery({ id: admin.id, invite_id: issued.invite_id });
    assert.equal(before.password, null); assert.equal(before.password_missing, true); assert.equal(before.can_reissue, true);
    assert.throws(() => f.manager.readBundle({ content: JSON.stringify(saved.encrypted), password: '' }), /请填写接入包密码/);
    await assert.rejects(f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: '' }), /Secret/);
    const restored = await f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' });
    assert.notEqual(restored.invite_id, issued.invite_id);
    const delivery = await f.manager.delivery({ id: admin.id, invite_id: restored.invite_id });
    assert.ok(delivery.password.length >= 12);
    const exported = await f.manager.exportedBundle(admin.id, restored.invite_id);
    const bundle = decryptBundle(JSON.parse(exported.content), delivery.password);
    assert.equal(bundle.wecom.secret, 'fixture-new-secret'); assert.equal(bundle.invitation.bot_id, 'bot-bob');
    assert.deepEqual(bundle.invitation.capabilities, ['backend']);
    await assert.rejects(f.manager.exportedBundle(admin.id, issued.invite_id), /已被替换/);
    const retry = await f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' });
    assert.deepEqual(retry, restored);
    assert.deepEqual((await f.manager.detail(admin.id)).exports.map((invite) => invite.invite_id), [restored.invite_id]);
    const member = await f.manager.importBundle({ content: exported.content, password: delivery.password, repo: f.repos.bob });
    await assert.rejects(f.manager.reissueBundle({ id: member.id, invite_id: restored.invite_id, secret: 'fixture-new-secret' }), /管理员/);
    const waiting = await f.manager.verifyMember({ id: member.id, discovery_id: await f.verify({ profile_id: member.id }, 'owner-bob') });
    assert.equal(waiting.phase, 'waiting');
    const request = (await f.manager.detail(admin.id)).requests[0];
    await f.manager.approve({ id: admin.id, request_id: request.request_id });
    assert.equal((await f.manager.resume(member.id)).phase, 'ready');
    await assert.rejects(f.manager.reissueBundle({ id: admin.id, invite_id: restored.invite_id, secret: 'fixture-new-secret' }), /已获批准/);
    assert.equal((await f.manager.delivery({ id: admin.id, invite_id: restored.invite_id })).can_reissue, false);
    const store = await f.manager.profileStore(await f.manager.state(admin.id));
    assert.throws(() => git(store.checkout, 'grep', '-l', 'fixture-new-secret'));
    assert.throws(() => git(store.checkout, 'grep', '-l', 'PRIVATE KEY'));
    assert.throws(() => git(store.checkout, 'grep', '-l', delivery.password));
    assert.equal((await stat(join(f.manager.path(admin.id), 'exports', `${restored.invite_id}.json`))).mode & 0o777, 0o600);
    assert.equal(git(f.repos.alice, 'status', '--porcelain'), '');
    assert.equal(git(f.repos.bob, 'status', '--porcelain'), '');
  } finally { await f.cleanup(); }
});

test('replacement clears stale approval and safely reimports into the same waiting clone', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const { issued, saved } = await legacyInvite(f, admin);
    const old = await f.manager.importBundle({ content: JSON.stringify(saved.encrypted), password: 'fixture-old-password', repo: f.repos.bob });
    await f.manager.verifyMember({ id: old.id, discovery_id: await f.verify({ profile_id: old.id }, 'owner-bob') });
    const stale = (await f.manager.detail(admin.id)).requests[0];
    const restored = await f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' });
    assert.deepEqual((await f.manager.detail(admin.id)).requests, []);
    await assert.rejects(f.manager.approve({ id: admin.id, request_id: stale.request_id }));
    await assert.rejects(f.manager.resume(old.id), /已被替换/);
    const delivery = await f.manager.delivery({ id: admin.id, invite_id: restored.invite_id });
    const exported = await f.manager.exportedBundle(admin.id, restored.invite_id);
    const fresh = await f.manager.importBundle({ content: exported.content, password: delivery.password, repo: f.repos.bob });
    assert.equal(fresh.id, old.id); assert.equal(fresh.phase, 'imported');
    const state = await f.manager.state(fresh.id); assert.equal(state.request, undefined); assert.equal(state.last_error, undefined);
    const backup = join(f.manager.path(old.id), 'replaced-invitations', `${issued.invite_id}.json`);
    assert.equal((await readPrivateJson(backup)).request.request_id, stale.request_id);
    assert.equal((await stat(backup)).mode & 0o777, 0o600);
    await f.manager.verifyMember({ id: fresh.id, discovery_id: await f.verify({ profile_id: fresh.id }, 'owner-bob') });
    const current = (await f.manager.detail(admin.id)).requests[0]; assert.notEqual(current.request_id, stale.request_id);
    await f.manager.approve({ id: admin.id, request_id: current.request_id });
    assert.equal((await f.manager.resume(fresh.id)).phase, 'ready');
  } finally { await f.cleanup(); }
});

test('replacement publication retries after lost acknowledgments and persists one password across restarts', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const { issued } = await legacyInvite(f, admin);
    const original = f.manager.profileStore.bind(f.manager);
    f.manager.profileStore = async (...args) => {
      const store = await original(...args), transaction = store.registryTransaction.bind(store);
      store.registryTransaction = async (build) => { await transaction(build); throw new Error('simulated lost acknowledgment'); };
      return store;
    };
    await assert.rejects(f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' }), /lost acknowledgment/);
    f.manager.profileStore = original;
    const restored = await f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' });
    const first = await f.manager.delivery({ id: admin.id, invite_id: restored.invite_id });
    const repeat = await f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' });
    assert.deepEqual(restored, repeat); assert.equal((await f.manager.delivery({ id: admin.id, invite_id: repeat.invite_id })).password, first.password);
    const store = await original(await f.manager.state(admin.id));
    assert.equal(store.registry.records.filter((record) => record.invitation_replacement).length, 1);
  } finally { await f.cleanup(); }
});

test('unpublished replacement stays hidden and cannot be delivered, then old invite retry publishes it', async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(); const { issued } = await legacyInvite(f, admin);
    const original = f.manager.profileStore.bind(f.manager);
    f.manager.profileStore = async (...args) => {
      const store = await original(...args);
      store.registryTransaction = async (build) => { await build(store.registry); throw new Error('simulated push rejection'); };
      return store;
    };
    await assert.rejects(f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' }), /simulated push rejection/);
    f.manager.profileStore = original;
    const hidden = await f.manager.detail(admin.id);
    assert.equal(hidden.exports.some((item) => item.invite_id !== issued.invite_id), false);
    const exportsDir = join(f.manager.path(admin.id), 'exports');
    const candidate = await Promise.all((await readdir(exportsDir)).map((file) => readPrivateJson(join(exportsDir, file)))).then((values) => values.find((value) => value.replaces_invite_id === issued.invite_id));
    assert.ok(candidate);
    await assert.rejects(f.manager.delivery({ id: admin.id, invite_id: candidate.invitation.invite_id }), /尚未发布/);
    await assert.rejects(f.manager.exportedBundle(admin.id, candidate.invitation.invite_id), /尚未发布/);
    const restored = await f.manager.reissueBundle({ id: admin.id, invite_id: issued.invite_id, secret: 'fixture-new-secret' });
    assert.equal(restored.invite_id, candidate.invitation.invite_id);
    assert.ok((await f.manager.detail(admin.id)).exports.some((item) => item.invite_id === restored.invite_id));
    assert.ok((await f.manager.delivery({ id: admin.id, invite_id: restored.invite_id })).password);
  } finally { await f.cleanup(); }
});

test('signed replacement rejects late approval, forgery, cycles and replacing approved invitations', () => {
  const alice = generateIdentity(), bob = generateIdentity(), claim = generateIdentity();
  const team = buildTeamPolicy({ repo: 'fixture', reviewer: 'alice', defaultRoute: 'backend', agents: [{ id: 'alice', role: 'admin', capabilities: ['backend'], publicKey: alice.public_key }], routes: { backend: ['alice'] } });
  const root = policyVersion(team, null, 'alice', alice.private_key), hash = recordHash(root), initial = validateHistory([root], hash);
  const oldId = randomUUID(), newId = randomUUID();
  const invite = invitationRecord({ invite_id: oldId, agent_id: 'bob', capabilities: ['backend'], bot_id: 'bot-bob', chat_ids: ['group'], commands_enabled: true, prefer: true, claim_public_key: claim.public_key, expires_at: new Date(Date.now() + 86400000).toISOString() }, root, 'alice', alice.private_key);
  const request = enrollmentRequest({ invite, publicKey: bob.public_key, userid: 'owner-bob', chatid: 'group', requestId: randomUUID(), privateKey: bob.private_key, claimPrivateKey: claim.private_key });
  const replacement = policyVersion(team, root, 'alice', alice.private_key, undefined, { old_invite_id: oldId, new_invite_id: newId });
  const history = validateHistory([root, replacement], hash);
  assert.throws(() => validateEnrollment(request, invite, history));
  assert.throws(() => approveEnrollment(request, invite, history, 'alice', alice.private_key));
  assert.throws(() => validateHistory([root, { ...replacement, signature: 'tampered' }], hash));
  const cycle = policyVersion(team, replacement, 'alice', alice.private_key, undefined, { old_invite_id: newId, new_invite_id: oldId });
  assert.throws(() => validateHistory([root, replacement, cycle], hash));
  const late = policyVersion(team, replacement, 'alice', alice.private_key, { invite_id: oldId, request_id: request.request_id });
  assert.throws(() => validateHistory([root, replacement, late], hash));
  const approved = approveEnrollment(request, invite, initial, 'alice', alice.private_key);
  const invalid = policyVersion(approved.team, approved, 'alice', alice.private_key, undefined, { old_invite_id: oldId, new_invite_id: newId });
  assert.throws(() => validateHistory([root, approved, invalid], hash));
});
