import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitTaskStore } from '../../packages/git-store/src.mjs';
import { CollaborationService } from '../../apps/server/service.mjs';
import { Accounts, hashToken } from '../../apps/server/auth.mjs';
import { startHttp } from '../../apps/server/http.mjs';
import { dispatchFeishuMessage } from '../../apps/server/feishu.mjs';
import { Runner } from '../../apps/runner/index.mjs';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const token = '1234567890123456789012345678901234567890';

test('Feishu mock -> Git ledger -> authenticated HTTP -> runner-owned Codex mock -> review -> completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-e2e-'));
  let server;
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, 'config', 'user.name', 'Test User'); git(repo, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(repo, 'test.sh'), '#!/bin/sh\ntest -f finished.txt\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
    git(repo, 'branch', 'agent-collab');
    const store = await new GitTaskStore({ repo, dataDir: join(root, 'server') }).init();
    const accounts = new Accounts([
      { id: 'alice', role: 'admin', token_sha256: hashToken(token), feishu_open_id: 'ou-alice' },
      { id: 'bob', role: 'member', token_sha256: hashToken('bob-token-123456789012345678901234') }
    ]);
    const service = new CollaborationService(store, { repoId: 'fixture' });
    server = await startHttp({ service, accounts, port: 0 });
    const api = `http://127.0.0.1:${server.address().port}`;
    const req = async (path, method = 'GET', body, key) => {
      const response = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return [response.status, await response.json()];
    };
    assert.equal((await req('/api/tasks'))[0], 200);
    assert.equal((await fetch(`${api}/api/tasks`)).status, 401);
    assert.equal((await req('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }))[0], 200);
    const tools = (await req('/mcp', 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }))[1];
    assert.equal(tools.result.tools.some((tool) => tool.name === 'read_task'), true);
    const replies = [];
    await dispatchFeishuMessage({ sender: { sender_id: { open_id: 'ou-alice' } }, message: { chat_id: 'allowed', message_type: 'text', message_id: 'm1', content: JSON.stringify({ text: '协作 创建 写一个标记 | 测试通过' }) } }, { service, accounts, allowedChatIds: ['allowed'], send: async (_id, reply) => replies.push(reply) });
    assert.match(replies[0], /已创建/);
    const task = (await store.list())[0];
    assert.equal(task.spec.source.chat_id, 'allowed');
    const id = task.spec.id;
    const assigned = (await req(`/api/tasks/${id}/assign`, 'POST', { assignee: 'bob' }))[1];
    assert.equal(assigned.state.status, 'assigned');
    const agentFactory = () => ({ startThread: ({ workingDirectory }) => ({ run: async () => {
      await writeFile(join(workingDirectory, 'finished.txt'), 'done\n');
      git(workingDirectory, 'add', '.'); git(workingDirectory, 'commit', '-m', 'Implement fixture');
      return { finalResponse: 'Finished work.' };
    } }) });
    const runner = new Runner({ repo, dataDir: join(root, 'runner'), api, token: 'bob-token-123456789012345678901234', userId: 'bob', agentFactory });
    // reviewer was not set at creation; register a new task with explicit reviewer to check full flow.
    const second = await service.create(accounts.users[0], { title: 'Second task', acceptance: ['pass test'], reviewer: 'alice', chatId: 'allowed', channel: 'feishu' }, 'second');
    await req(`/api/tasks/${second.spec.id}/assign`, 'POST', { assignee: 'bob' });
    // First task is intentionally not reviewable; failure is recorded and next run takes the second task.
    await assert.rejects(runner.once(), /task has no reviewer/);
    assert.equal((await store.read(id)).state.status, 'blocked');
    const reviewed = await runner.once();
    assert.equal(reviewed.state.status, 'review');
    assert.equal(reviewed.state.assignee, 'alice');
    assert.ok(reviewed.events.at(-1).refs.commit);
    assert.equal(await runner.once(), null);
    const reviewRunner = new Runner({ repo, dataDir: join(root, 'reviewer'), api, token, userId: 'alice', agentFactory: () => ({ startThread: () => ({ run: async () => ({ finalResponse: 'No issues found.' }) }) }) });
    const noted = await reviewRunner.once();
    assert.equal(noted.events.at(-1).type, 'review_note');
    assert.equal(await reviewRunner.once(), null);
    const send = async (_id, reply) => replies.push(reply);
    const command = async (messageId, text) => dispatchFeishuMessage({ sender: { sender_id: { open_id: 'ou-alice' } }, message: { chat_id: 'allowed', message_type: 'text', message_id: messageId, content: JSON.stringify({ text }) } }, { service, accounts, allowedChatIds: ['allowed'], send });
    await command('m2', `协作 审核 ${second.spec.id} 通过`);
    assert.equal((await store.read(second.spec.id)).state.status, 'approved');
    await command('m3', `协作 完成 ${second.spec.id}`);
    assert.equal((await store.read(second.spec.id)).state.status, 'completed');
    assert.match(replies.at(-1), /已完成/);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('runner commits tested tracked edits when Codex cannot write Git metadata, but rejects new files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collab-runner-fallback-'));
  let server;
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-b', 'main', repo]);
    git(repo, 'config', 'user.name', 'Test User'); git(repo, 'config', 'user.email', 'test@example.invalid');
    await writeFile(join(repo, 'greet.sh'), '#!/bin/sh\nprintf "hello, world\\n"\n');
    await writeFile(join(repo, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "hello, world" ]\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
    git(repo, 'branch', 'agent-collab');
    const store = await new GitTaskStore({ repo, dataDir: join(root, 'server') }).init();
    const users = [{ id: 'alice', role: 'admin', token_sha256: hashToken(token) },
      { id: 'bob', role: 'member', token_sha256: hashToken('bob-token-123456789012345678901234') }];
    const service = new CollaborationService(store, { repoId: 'fixture', defaultReviewer: 'alice', users });
    server = await startHttp({ service, accounts: new Accounts(users), port: 0 });
    const api = `http://127.0.0.1:${server.address().port}`;
    const makeTask = async (key) => {
      const task = await service.create(users[0], { title: 'Update greeting', acceptance: ['sh test.sh passes'] }, key);
      await service.assign(users[0], task.spec.id, 'bob');
      return task.spec.id;
    };
    const id = await makeTask('tracked-task');
    const runner = new Runner({ repo, dataDir: join(root, 'runner'), api, token: 'bob-token-123456789012345678901234', userId: 'bob',
      agentFactory: () => ({ startThread: ({ workingDirectory }) => ({ run: async () => {
        await writeFile(join(workingDirectory, 'greet.sh'), '#!/bin/sh\nprintf "HELLO, WORLD\\n"\n');
        await writeFile(join(workingDirectory, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "HELLO, WORLD" ]\n');
        return { finalResponse: 'Edited tracked files without a commit.' };
      } }) }) });
    const reviewed = await runner.once();
    assert.equal(reviewed.spec.id, id);
    assert.equal(reviewed.state.status, 'review');
    const refs = reviewed.events.at(-1).refs;
    assert.notEqual(refs.commit, git(repo, 'rev-parse', 'main'));
    assert.match(git(repo, 'show', `${refs.branch}:greet.sh`), /HELLO, WORLD/);
    assert.match(git(repo, 'show', 'main:greet.sh'), /hello, world/);

    const unsafeId = await makeTask('untracked-task');
    const unsafeRunner = new Runner({ repo, dataDir: join(root, 'unsafe-runner'), api, token: 'bob-token-123456789012345678901234', userId: 'bob',
      agentFactory: () => ({ startThread: ({ workingDirectory }) => ({ run: async () => {
        await writeFile(join(workingDirectory, 'untracked-secret.txt'), 'must never be committed');
        return { finalResponse: 'New file left untracked.' };
      } }) }) });
    await assert.rejects(unsafeRunner.once(), /untracked or newly staged files/);
    assert.equal((await service.read(unsafeId)).state.status, 'blocked');
    assert.equal(git(repo, 'ls-tree', '-r', '--name-only', 'main').includes('untracked-secret.txt'), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
