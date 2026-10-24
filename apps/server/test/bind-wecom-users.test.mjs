import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { hashToken } from '../auth.mjs';

test('bind WeCom users to existing token hashes without overwriting original file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-bind-'));
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  try {
    const input = join(root, 'original.json');
    const output = join(root, 'wecom.json');
    const alice = { id: 'alice', role: 'admin', token_sha256: hashToken('alice-token') };
    const bob = { id: 'bob', role: 'member', token_sha256: hashToken('bob-token') };
    await writeFile(input, JSON.stringify({ users: [alice, bob] }));
    execFileSync(process.execPath, ['scripts/bind-wecom-users.mjs', input, output, 'alice:wx-alice'], { cwd: repo });
    assert.deepEqual(JSON.parse(await readFile(input)).users, [alice, bob]);
    const bound = JSON.parse(await readFile(output)).users;
    assert.equal(bound[0].wecom_userid, 'wx-alice');
    assert.equal(bound[0].token_sha256, alice.token_sha256);
    assert.deepEqual(bound[1], bob);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, ['scripts/bind-wecom-users.mjs', input, output, 'alice:wx-again'], { cwd: repo, stdio: 'pipe' }), /EEXIST/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
