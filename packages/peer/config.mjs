import { validateReviewRules } from './review.mjs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
export const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
export function validateTeam(team) {
  if (![2, 3].includes(team?.schema_version) || typeof team.repo !== 'string' || !team.repo || !idPattern.test(team.default_route ?? '')) throw new Error('invalid peer team configuration');
  if (!team.agents || !team.routes || !Object.keys(team.agents).length) throw new Error('team needs agents and routes');
  const keys = new Set();
  for (const [id, agent] of Object.entries(team.agents)) {
    if (!idPattern.test(id) || !['admin', 'member'].includes(agent.role) || !Array.isArray(agent.capabilities) || agent.capabilities.some((c) => !idPattern.test(c)) || !Number.isSafeInteger(agent.max_concurrent_tasks) || agent.max_concurrent_tasks < 1 || agent.max_concurrent_tasks > 16) throw new Error(`invalid agent ${id}`);
    if (createPublicKey(agent.public_key).asymmetricKeyType !== 'ed25519' || keys.has(agent.public_key)) throw new Error('agents require distinct Ed25519 public keys');
    keys.add(agent.public_key);
    // An owner is a human account; several independent agents may share it.
    if (Object.hasOwn(agent, 'wecom_userid') && (typeof agent.wecom_userid !== 'string' || !agent.wecom_userid.trim() || agent.wecom_userid.length > 200)) throw new Error('invalid WeCom owner');
  }
  if (team.agents[team.reviewer]?.role !== 'admin') throw new Error('reviewer must be an admin');
  // Reviewer is a human approval identity, not an execution exclusion. Its Runner
  // may implement a stage; automatic Runner/MCP tools never approve or complete.
  for (const [route, candidates] of Object.entries(team.routes)) {
    if (!idPattern.test(route) || !Array.isArray(candidates) || !candidates.length || new Set(candidates).size !== candidates.length || candidates.some((id) => !team.agents[id]?.capabilities.includes(route))) throw new Error(`invalid candidates for route ${route}`);
  }
  if (!team.routes[team.default_route]) throw new Error('unknown default route');
  const policy = team.policy;
  for (const [key, min, max] of [['claim_timeout_ms', 10, 3600000], ['lease_ms', 100, 3600000], ['clock_skew_ms', 0, 60000], ['max_attempts', 1, 20]]) {
    if (!Number.isSafeInteger(policy?.[key]) || policy[key] < min || policy[key] > max) throw new Error(`invalid policy.${key}`);
  }
  if (policy.clock_skew_ms >= policy.lease_ms / 2) throw new Error('clock skew must be below half the lease');
  if (team.schema_version === 2 && team.review_rules !== undefined || team.schema_version === 3 && team.review_rules === undefined) throw new Error('human review rules require team policy v3');
  validateReviewRules(team);
  return team;
}
export function generateIdentity() {
  const pair = generateKeyPairSync('ed25519');
  return { private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), public_key: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
}
export async function readPrivateJson(path) {
  const info = await stat(path);
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('private configuration must have mode 0600 (chmod 600)');
  return JSON.parse(await readFile(path, 'utf8'));
}
export function makeSigner(team, agentId, privateKey) {
  validateTeam(team);
  const key = createPrivateKey(privateKey);
  if (!team.agents[agentId] || createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== team.agents[agentId].public_key) throw new Error('private key does not match pinned team identity');
  return (event) => {
    if (event.actor_id !== agentId) throw new Error('refusing to sign for another agent');
    const unsigned = { ...event, team_hash: digest(team) };
    return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64') };
  };
}
export function verifyEvent(team, event) {
  const { signature, ...unsigned } = event;
  if (event.team_hash !== digest(team) || !team.agents[event.actor_id] || typeof signature !== 'string' || !verify(null, Buffer.from(canonical(unsigned)), createPublicKey(team.agents[event.actor_id].public_key), Buffer.from(signature, 'base64'))) throw new Error('invalid peer event identity/signature or pinned team policy');
}
