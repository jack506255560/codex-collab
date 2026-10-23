import { isAbsolute } from 'node:path';
import { createMemberConfig } from './onboarding.mjs';
const [teamPath, identityPath, repoPath, dataDir, configPath] = process.argv.slice(2);
if (![teamPath, identityPath, repoPath, dataDir, configPath].every((v) => v && isAbsolute(v))) throw new Error('usage: node scripts/peer/init-agent.mjs /abs/team.json /abs/bob.private.json /abs/clone /abs/data /abs/bob-peer.json');
await createMemberConfig({ teamPath, identityPath, repoPath, dataDir, configPath });
console.log(`private peer config written: ${configPath} (keep it local)`);
