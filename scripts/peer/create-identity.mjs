import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { generateIdentity } from '../../packages/peer/config.mjs';

const [id, path] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id || '') || !path || !isAbsolute(path)) throw new Error('usage: node scripts/peer/create-identity.mjs bob /abs/bob.private.json');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const identity = generateIdentity();
await writeFile(resolve(path), JSON.stringify({ agent_id: id, private_key: identity.private_key }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ agent_id: id, public_key: identity.public_key }, null, 2));
console.error(`Private identity stays on this machine: ${resolve(path)}; share only the public key printed above.`);
