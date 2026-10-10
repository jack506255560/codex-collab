import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { hashToken } from '../apps/server/auth.mjs';

const [output, ...entries] = process.argv.slice(2);
if (!output || !entries.length) throw new Error('usage: node scripts/create-accounts.mjs <output.json> <id:role:feishu_open_id_or_dash:wecom_userid_or_dash> ...');
const users = entries.map((entry) => {
  const [id, role, feishuOpenId, wecomUserid] = entry.split(':');
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(id || '') || !['admin', 'member'].includes(role) || !feishuOpenId) throw new Error(`invalid account: ${entry}`);
  const token = randomBytes(32).toString('base64url');
  return { id, role, ...(feishuOpenId === '-' ? {} : { feishu_open_id: feishuOpenId }), ...(wecomUserid && wecomUserid !== '-' ? { wecom_userid: wecomUserid } : {}), token, token_sha256: hashToken(token) };
});
if (new Set(users.map((u) => u.id)).size !== users.length) throw new Error('duplicate user IDs');
await writeFile(output, JSON.stringify({ users: users.map(({ token, ...user }) => user) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
for (const { id, token } of users) console.log(`${id} token: ${token}`);
console.log(`accounts written to ${output} (tokens appear only in this terminal; store them privately)`);
