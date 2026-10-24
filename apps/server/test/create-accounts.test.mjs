import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, stat, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Accounts, hashToken } from '../auth.mjs';

const script = fileURLToPath(new URL('../../../scripts/create-accounts.mjs', import.meta.url));

test('account setup takes WeCom IDs directly and keeps tokens out of the private account file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-accounts-'));
  try {
    const output = join(root, 'accounts.json');
    const stdout = execFileSync(process.execPath, [script, output, 'alice:admin:wx-alice', 'bob:member:-'], { encoding: 'utf8' });
    const { users } = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(users[0].wecom_userid, 'wx-alice');
    assert.equal(Object.hasOwn(users[1], 'wecom_userid'), false);
    const accounts = new Accounts(users);
    for (const { id } of users) {
      const token = new RegExp(`^${id} token: (.+)$`, 'm').exec(stdout)[1];
      assert.equal(accounts.token(token).id, id);
      assert.equal(users.find((user) => user.id === id).token_sha256, hashToken(token));
      assert.equal((await readFile(output, 'utf8')).includes(token), false);
    }
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    const original = await readFile(output, 'utf8');
    assert.throws(() => execFileSync(process.execPath, [script, output, 'alice:admin:wx-new'], { stdio: 'pipe' }), /EEXIST/);
    assert.equal(await readFile(output, 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid or ambiguous account syntax and duplicate identities fail before a file is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-invalid-accounts-'));
  try {
    const cases = [
      ['alice:admin'], ['alice:admin:'], ['alice:admin:-:wx-alice'], ['alice:admin:two words'],
      ['alice:owner:wx-alice'], ['alice:admin:wx-alice', 'bob:member:wx-alice'],
      ['alice:admin:wx-alice', 'alice:member:wx-bob']
    ];
    for (const [index, entries] of cases.entries()) {
      const output = join(root, `accounts-${index}.json`);
      assert.throws(() => execFileSync(process.execPath, [script, output, ...entries], { stdio: 'pipe' }), /invalid account|duplicate account/);
      await assert.rejects(access(output), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
