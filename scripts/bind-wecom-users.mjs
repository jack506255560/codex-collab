import { readFile, writeFile } from 'node:fs/promises';
import { Accounts } from '../apps/server/auth.mjs';

const [source, destination, ...bindings] = process.argv.slice(2);
if (!source || !destination || source === destination || !bindings.length) {
  throw new Error('usage: node scripts/bind-wecom-users.mjs <existing-accounts.json> <new-accounts.json> <account-id:wecom-userid> ...');
}
const parsed = JSON.parse(await readFile(source, 'utf8'));
const users = parsed.users?.map((user) => ({ ...user }));
if (!users) throw new Error('invalid accounts file');
for (const binding of bindings) {
  const separator = binding.indexOf(':');
  const id = binding.slice(0, separator);
  const userid = binding.slice(separator + 1);
  if (separator < 1 || !userid || userid.includes(':')) throw new Error('invalid binding: expected account-id:wecom-userid');
  const account = users.find((user) => user.id === id);
  if (!account) throw new Error(`unknown account id: ${id}`);
  account.wecom_userid = userid;
}
new Accounts(users);
// No regeneration or disclosure of the existing personal bearer token hashes.
await writeFile(destination, JSON.stringify({ users }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('Bound WeCom user IDs in a new private accounts file; existing bearer token hashes preserved.');
