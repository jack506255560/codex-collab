import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitTaskStore } from '../../packages/git-store/src.mjs';
import { CollaborationService } from '../../apps/server/service.mjs';
import { Accounts, hashToken } from '../../apps/server/auth.mjs';
import { startHttp } from '../../apps/server/http.mjs';
import { dispatchWecomMessage } from '../../apps/server/wecom.mjs';
import { Runner } from '../../apps/runner/index.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const aliceToken = 'alice-token-123456789012345678901234';
const bobToken = 'bob-token-123456789012345678901234';

test('mock WeCom group -> Git ledger -> HTTP -> both runner roles -> human group approval -> completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-wecom-e2e-'));
  let server;
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, 'config', 'user.name', 'Test User'); git(repo, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(repo, 'greet.sh'), '#!/bin/sh\nprintf "hello, world\\n"\n');
    await writeFile(join(repo, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "HELLO, WORLD" ]\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
    git(repo, 'branch', 'agent-collab');
    const store = await new GitTaskStore({ repo, dataDir: join(root, 'server-data') }).init();
    const accounts = new Accounts([
      { id: 'alice', role: 'admin', wecom_userid: 'alice-wx', token_sha256: hashToken(aliceToken) },
      { id: 'bob', role: 'member', wecom_userid: 'bob-wx', token_sha256: hashToken(bobToken) }
    ]);
    const service = new CollaborationService(store, { repoId: 'fixture', defaultReviewer: 'alice', users: accounts.users });
    server = await startHttp({ service, accounts, port: 0 });
    const api = `http://127.0.0.1:${server.address().port}`;
    const replies = [];
    const group = async (userid, msgid, content) => dispatchWecomMessage({ headers: { req_id: msgid }, body: {
      chattype: 'group', chatid: 'test-group', from: { userid }, msgid, msgtype: 'text', text: { content }
    } }, { service, accounts, allowedChatIds: ['test-group'], reply: async (_frame, value) => replies.push(value) });
    await group('alice-wx', 'msg-1', '协作 创建 给 greet.sh 增加 --upper 参数 | sh test.sh 通过');
    const created = (await store.list())[0];
    assert.equal(created.spec.source.channel, 'wecom');
    assert.equal(created.spec.source.chat_id, 'test-group');
    assert.equal(created.spec.source.reviewer, 'alice');
    await group('alice-wx', 'msg-1', '协作 创建 给 greet.sh 增加 --upper 参数 | sh test.sh 通过');
    assert.equal((await store.list()).length, 1);
    await group('alice-wx', 'msg-2', `协作 分配 ${created.spec.id} bob`);
    assert.equal((await store.read(created.spec.id)).state.assignee, 'bob');
    const agentFactory = () => ({ startThread: ({ workingDirectory }) => ({ run: async () => {
      await writeFile(join(workingDirectory, 'greet.sh'), '#!/bin/sh\nprintf "HELLO, WORLD\\n"\n');
      git(workingDirectory, 'add', 'greet.sh'); git(workingDirectory, 'commit', '-m', 'Implement greeting');
      return { finalResponse: 'Done' };
    } }) });
    const bob = new Runner({ repo, dataDir: join(root, 'bob'), api, token: bobToken, userId: 'bob', agentFactory });
    const reviewed = await bob.once();
    assert.equal(reviewed.state.status, 'review');
    assert.match(git(repo, 'show', `${reviewed.events.at(-1).refs.branch}:greet.sh`), /HELLO, WORLD/);
    assert.match(git(repo, 'show', 'main:greet.sh'), /hello, world/);
    const alice = new Runner({ repo, dataDir: join(root, 'alice'), api, token: aliceToken, userId: 'alice', agentFactory: () => ({
      startThread: () => ({ run: async () => ({ finalResponse: 'Review: no issues' }) })
    }) });
    assert.equal((await alice.once()).events.at(-1).type, 'review_note');
    assert.equal((await store.read(created.spec.id)).state.status, 'review');
    await group('bob-wx', 'msg-3', `协作 审核 ${created.spec.id} 通过`);
    assert.match(replies.at(-1), /操作失败/);
    assert.equal((await store.read(created.spec.id)).state.status, 'review');
    await group('alice-wx', 'msg-4', `协作 审核 ${created.spec.id} 通过`);
    assert.equal((await store.read(created.spec.id)).state.status, 'approved');
    await group('alice-wx', 'msg-5', `协作 完成 ${created.spec.id}`);
    assert.equal((await store.read(created.spec.id)).state.status, 'completed');
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
