import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { generateIdentity, validateTeam } from '../../packages/peer/config.mjs';
const [out, repo, reviewer, route, ...rawAgents] = process.argv.slice(2);
if (!out || !repo || !reviewer || !route || rawAgents.length < 2 || !isAbsolute(out)) throw new Error('usage: node scripts/peer/create-team.mjs /abs/team.json repo reviewer frontend alice:admin:frontend bob:member:frontend carol:member:frontend');
await mkdir(dirname(resolve(out)), { recursive: true, mode: 0o700 });
const agents = {};
const identities = {};
for (const raw of rawAgents) {
  const [id, role, capabilities, max, wecom_userid] = raw.split(':');
  if (!id || !role || !capabilities) throw new Error(`invalid agent: ${raw}`);
  if (agents[id]) throw new Error(`duplicate agent: ${id}`);
  const identity = generateIdentity();
  agents[id] = { role, capabilities: capabilities.split(',').filter(Boolean), max_concurrent_tasks: Number(max || 1), public_key: identity.public_key, ...(wecom_userid ? { wecom_userid } : {}) };
  identities[id] = identity;
}
const routes = Object.fromEntries([...new Set(Object.values(agents).flatMap((agent) => agent.capabilities))].map((capability) => [capability, Object.entries(agents).filter(([_id, agent]) => agent.capabilities.includes(capability)).map(([id]) => id)]));
const team = validateTeam({ schema_version: 2, repo, reviewer, default_route: route, agents, routes, policy: { claim_timeout_ms: 60000, lease_ms: 180000, clock_skew_ms: 5000, max_attempts: 3 } });
for (const [id, identity] of Object.entries(identities)) {
  const privatePath = resolve(dirname(out), `${id}.private.json`);
  await writeFile(privatePath, JSON.stringify({ agent_id: id, private_key: identity.private_key }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(privatePath, 0o600);
  console.error(`private identity for ${id}: ${privatePath} (keep local; do not commit or paste it)`);
}
await writeFile(resolve(out), JSON.stringify(team, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
console.log(`team file written: ${resolve(out)}; distribute it as public policy only`);
