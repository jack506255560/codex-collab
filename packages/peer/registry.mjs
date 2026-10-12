import { createPublicKey, sign, verify } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultReviewRules } from './review.mjs';
import { canonical, digest, validateTeam } from './config.mjs';

export const registryPath = '.agent-collab/team';
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const fail = () => { throw new Error('Team registry signature, history or enrollment is invalid.'); };
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail();
}
export function signRecord(value, privateKey) {
  return { ...value, signature: sign(null, Buffer.from(canonical(value)), privateKey).toString('base64') };
}
export function verifyRecord(record, publicKey) {
  const { signature, ...body } = record || {};
  try { if (typeof signature !== 'string' || !verify(null, Buffer.from(canonical(body)), publicKey, Buffer.from(signature, 'base64'))) fail(); }
  catch { fail(); }
  return body;
}
export function recordHash(record) { const { signature, ...body } = record; return digest(body); }
export function policyVersion(team, previous, actorId, privateKey, enrollment) {
  validateTeam(team);
  const value = { schema_version: 1, version: previous ? previous.version + 1 : 1,
    parent_hash: previous ? recordHash(previous) : null, team_hash: digest(team), team, actor_id: actorId,
    ...(enrollment ? { enrollment } : {}) };
  return signRecord(value, privateKey);
}
export function validateHistory(records, rootHash) {
  if (!Array.isArray(records) || !records.length || !hashPattern.test(rootHash || '') || recordHash(records[0]) !== rootHash) fail();
  const teams = new Map();
  let previous;
  for (const record of records) {
    fields(record, ['schema_version', 'version', 'parent_hash', 'team_hash', 'team', 'actor_id', 'enrollment', 'signature']);
    if (record.schema_version !== 1 || record.version !== (previous?.version || 0) + 1 || record.parent_hash !== (previous ? recordHash(previous) : null)) fail();
    const team = validateTeam(record.team);
    const authority = previous?.team || team;
    if (authority.agents[record.actor_id]?.role !== 'admin' || digest(team) !== record.team_hash || previous && team.repo !== authority.repo) fail();
    verifyRecord(record, authority.agents[record.actor_id].public_key);
    // Existing keys/roles remain stable; old tasks continue to use old routes.
    if (previous && team.schema_version < authority.schema_version) fail();
    if (previous) for (const [id, agent] of Object.entries(authority.agents)) {
      if (!team.agents[id] || team.agents[id].public_key !== agent.public_key || team.agents[id].role !== agent.role || team.agents[id].wecom_userid !== agent.wecom_userid) fail();
    }
    if (record.enrollment) {
      fields(record.enrollment, ['invite_id', 'request_id']);
      if (!uuidPattern.test(record.enrollment.invite_id || '') || !uuidPattern.test(record.enrollment.request_id || '')) fail();
    }
    teams.set(record.team_hash, team); previous = record;
  }
  return { records, teams, latest: previous, root_hash: rootHash };
}
export async function readRegistry(checkout, rootHash) {
  const dir = join(checkout, registryPath, 'versions');
  let files;
  try { files = (await readdir(dir)).sort(); }
  catch (error) { if (error.code === 'ENOENT' && !rootHash) return null; throw error; }
  if (!files.length || files.some((file, index) => file !== `${String(index + 1).padStart(6, '0')}.json`)) fail();
  const records = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(dir, file), 'utf8'))));
  // Legacy peers must explicitly import/adopt a registry before trusting changes.
  if (!rootHash) return null;
  return validateHistory(records, rootHash);
}
export function invitationRecord(input, record, actorId, privateKey) {
  const invite = { schema_version: 1, invite_id: input.invite_id, agent_id: input.agent_id,
    capabilities: input.capabilities, bot_id: input.bot_id, chat_ids: input.chat_ids,
    commands_enabled: input.commands_enabled, prefer: input.prefer,
    claim_public_key: input.claim_public_key, expires_at: input.expires_at,
    team_hash: record.team_hash, actor_id: actorId };
  const signed = signRecord(invite, privateKey);
  validateInvitation(signed, { teams: new Map([[record.team_hash, record.team]]) });
  return signed;
}
export function validateInvitation(invite, history) {
  fields(invite, ['schema_version', 'invite_id', 'agent_id', 'capabilities', 'bot_id', 'chat_ids', 'commands_enabled', 'prefer', 'claim_public_key', 'expires_at', 'team_hash', 'actor_id', 'signature']);
  const team = history.teams.get(invite.team_hash);
  if (invite.schema_version !== 1 || !uuidPattern.test(invite.invite_id || '') || !idPattern.test(invite.agent_id || '') || !team || team.agents[invite.actor_id]?.role !== 'admin' ||
    !Array.isArray(invite.capabilities) || !invite.capabilities.length || invite.capabilities.length > 16 || invite.capabilities.some((cap) => !idPattern.test(cap)) || new Set(invite.capabilities).size !== invite.capabilities.length ||
    typeof invite.bot_id !== 'string' || !invite.bot_id || invite.bot_id.length > 200 ||
    !Array.isArray(invite.chat_ids) || !invite.chat_ids.length || invite.chat_ids.some((id) => typeof id !== 'string' || !id || id.length > 200) ||
    typeof invite.commands_enabled !== 'boolean' || typeof invite.prefer !== 'boolean' || !Number.isFinite(Date.parse(invite.expires_at))) fail();
  try { if (createPublicKey(invite.claim_public_key).asymmetricKeyType !== 'ed25519') fail(); } catch { fail(); }
  verifyRecord(invite, team.agents[invite.actor_id].public_key);
  return invite;
}
export function enrollmentRequest({ invite, publicKey, userid, chatid, requestId, privateKey, claimPrivateKey }) {
  const body = { schema_version: 1, request_id: requestId, invite_id: invite.invite_id, agent_id: invite.agent_id,
    public_key: publicKey, wecom_userid: invite.commands_enabled ? userid : null, chat_id: chatid };
  const member = signRecord(body, privateKey);
  return { ...member, invitation_signature: sign(null, Buffer.from(canonical(body)), claimPrivateKey).toString('base64') };
}
export function validateEnrollment(request, invite, history, { now = Date.now(), allowExpired = false } = {}) {
  validateInvitation(invite, history);
  fields(request, ['schema_version', 'request_id', 'invite_id', 'agent_id', 'public_key', 'wecom_userid', 'chat_id', 'signature', 'invitation_signature']);
  if (request.schema_version !== 1 || !uuidPattern.test(request.request_id || '') || request.invite_id !== invite.invite_id || request.agent_id !== invite.agent_id ||
    !invite.chat_ids.includes(request.chat_id) || (invite.commands_enabled ? typeof request.wecom_userid !== 'string' || !request.wecom_userid || request.wecom_userid.length > 200 : request.wecom_userid !== null) ||
    !allowExpired && now > Date.parse(invite.expires_at)) fail();
  const { invitation_signature, ...member } = request;
  try { if (createPublicKey(request.public_key).asymmetricKeyType !== 'ed25519') fail(); } catch { fail(); }
  const body = verifyRecord(member, request.public_key);
  try { if (typeof invitation_signature !== 'string' || !verify(null, Buffer.from(canonical(body)), invite.claim_public_key, Buffer.from(invitation_signature, 'base64'))) fail(); }
  catch { fail(); }
  return request;
}
export function approveEnrollment(request, invite, history, actorId, privateKey) {
  const consumed = history.records.find((version) => version.enrollment?.invite_id === invite.invite_id);
  validateEnrollment(request, invite, history, { allowExpired: !!consumed });
  const previous = history.latest;
  if (previous.team.agents[actorId]?.role !== 'admin') fail();
  if (history.records.some((version) => version.enrollment?.invite_id === invite.invite_id)) {
    if (!history.records.some((version) => version.enrollment?.invite_id === invite.invite_id && version.enrollment.request_id === request.request_id) || previous.team.agents[request.agent_id]?.public_key !== request.public_key) fail();
    return null;
  }
  if (previous.team.agents[request.agent_id]) fail();
  const team = structuredClone(previous.team);
  team.agents[request.agent_id] = { role: 'member', capabilities: invite.capabilities, max_concurrent_tasks: 1, public_key: request.public_key,
    ...(request.wecom_userid ? { wecom_userid: request.wecom_userid } : {}) };
  for (const capability of invite.capabilities) {
    const candidates = team.routes[capability] || [];
    team.routes[capability] = invite.prefer ? [request.agent_id, ...candidates] : [...candidates, request.agent_id];
    if (team.schema_version === 3 && !team.review_rules[capability]) team.review_rules[capability] = defaultReviewRules({ [capability]: [] })[capability];
  }
  return policyVersion(team, previous, actorId, privateKey, { invite_id: invite.invite_id, request_id: request.request_id });
}
export const versionFile = (record) => `${registryPath}/versions/${String(record.version).padStart(6, '0')}.json`;
export const invitationFile = (id) => { if (!uuidPattern.test(id || '')) fail(); return `${registryPath}/invitations/${id}.json`; };
export const requestFile = (id) => { if (!uuidPattern.test(id || '')) fail(); return `${registryPath}/requests/${id}.json`; };
