import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const aliceToken = 'alice-secret-1234567890123456789012';
const bobToken = 'bob-secret-123456789012345678901234';

for (const sharedRemote of [false, true]) {
  test(`handoff: desktop Alice commit -> WeCom @Bob -> Bob Codex resumes pinned code (${sharedRemote ? 'remote Git' : 'local Git'})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'collab-handoff-'));
    let server;
    try {
      const repo = join(root, 'repo');
      if (sharedRemote) {
        execFileSync('git', ['init', '--bare', '-b', 'main', join(root, 'remote.git')]);
        execFileSync('git', ['clone', join(root, 'remote.git'), repo]);
      } else execFileSync('git', ['init', '-b', 'main', repo]);
      git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'test@example.invalid');
      await writeFile(join(repo, 'greet.sh'), '#!/bin/sh\nprintf "hello, world\\n"\n');
      await writeFile(join(repo, 'test.sh'), '#!/bin/sh\nset -eu\n[ "$(sh greet.sh)" = "HELLO, TEAM" ]\n');
      git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
      git(repo, 'branch', 'agent-collab');
      if (sharedRemote) { git(repo, 'push', 'origin', 'main'); git(repo, 'push', 'origin', 'agent-collab'); }
      const store = await new GitTaskStore({ repo, dataDir: join(root, 'server'), push: sharedRemote }).init();
      const accounts = new Accounts([
        { id: 'alice', role: 'admin', wecom_userid: 'alice-wx', token_sha256: hashToken(aliceToken) },
        { id: 'bob', role: 'member', wecom_userid: 'bob-wx', token_sha256: hashToken(bobToken) }
      ]);
      const service = new CollaborationService(store, { repoId: 'fixture', defaultReviewer: 'alice', users: accounts.users });
      server = await startHttp({ service, accounts, port: 0 });
      const api = `http://127.0.0.1:${server.address().port}`;
      const replies = [];
      const group = (text, msgid) => dispatchWecomMessage({ body: {
        chattype: 'group', chatid: 'the-group', from: { userid: 'alice-wx' },
        msgid, msgtype: 'text', text: { content: text }
      } }, { service, accounts, allowedChatIds: ['the-group'], reply: async (_frame, value) => replies.push(value) });
      await group('协作 创建 分两人完成 greeting | sh test.sh 通过', 'create-1');
      const created = (await store.list())[0];
      const assigned = await store.read(created.spec.id);
      assert.equal(assigned.state.status, 'open');
      const work = join(root, 'alice-worktree');
      git(repo, 'worktree', 'add', '-b', 'codex/alice-piece', work, 'main');
      await writeFile(join(work, 'greet.sh'), '#!/bin/sh\nprintf "HELLO, WORLD\\n"\n');
      git(work, 'add', 'greet.sh'); git(work, 'commit', '-m', 'Alice implements uppercase');
      const commit = git(work, 'rev-parse', 'HEAD');
      if (sharedRemote) git(work, 'push', 'origin', 'codex/alice-piece');
      const handoff = { type: 'handoff', summary: 'Uppercase is done; replace WORLD with TEAM and make test.sh pass.',
        refs: { branch: 'codex/alice-piece', commit, tests: 'sh greet.sh produced HELLO, WORLD' } };
      await assert.rejects(service.report(accounts.users[1], created.spec.id, handoff, assigned.state.seq), /another agent/);
      await assert.rejects(service.report(accounts.users[0], created.spec.id, { ...handoff, refs: { ...handoff.refs, commit: 'a'.repeat(40) } }, assigned.state.seq), /branch tip/);
      assert.equal((await store.read(created.spec.id)).state.status, 'open');
      const mcp = async (id, method, params) => fetch(`${api}/mcp`, { method: 'POST', headers: {
        authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream'
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      await mcp(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'handoff-test', version: '1' } });
      const before = await mcp(2, 'tools/list', {});
      const tools = (await before.json()).result.tools;
      assert.ok(tools.some((tool) => tool.name === 'handoff_task'));
      const mcpResult = await mcp(3, 'tools/call', { name: 'handoff_task', arguments: {
        task_id: created.spec.id, expected_seq: assigned.state.seq, summary: handoff.summary,
        ...handoff.refs, idempotency_key: 'alice-handoff-1'
      } });
      assert.equal((await mcpResult.json()).result.isError, undefined);
      const handed = await store.read(created.spec.id);
      assert.equal(handed.state.status, 'waiting');
      await group(`@BobBot 协作 交接 ${created.spec.id} bob`, 'assign-bob');
      assert.match(replies.at(-1), /已分配给 bob/);
      assert.equal((await store.read(created.spec.id)).state.assignee, 'bob');
      const bobRepo = sharedRemote ? join(root, 'bob-repo') : repo;
      if (sharedRemote) {
        execFileSync('git', ['clone', join(root, 'remote.git'), bobRepo]);
        git(bobRepo, 'config', 'user.name', 'Fixture'); git(bobRepo, 'config', 'user.email', 'test@example.invalid');
      }
      const bob = new Runner({ repo: bobRepo, dataDir: join(root, 'bob'), api, token: bobToken, userId: 'bob', push: sharedRemote,
        agentFactory: () => ({ startThread: ({ workingDirectory }) => ({ run: async (prompt) => {
          assert.equal(git(workingDirectory, 'rev-parse', 'HEAD'), commit);
          assert.match(await readFile(join(workingDirectory, 'greet.sh'), 'utf8'), /HELLO, WORLD/);
          assert.match(prompt, /Uppercase is done/);
          await writeFile(join(workingDirectory, 'greet.sh'), '#!/bin/sh\nprintf "HELLO, TEAM\\n"\n');
          git(workingDirectory, 'add', 'greet.sh'); git(workingDirectory, 'commit', '-m', 'Bob finishes greeting');
          return { finalResponse: 'Finished on Alice commit' };
        } }) }) });
      const reviewed = await bob.once();
      assert.equal(reviewed.state.status, 'review');
      const finished = reviewed.events.at(-1).refs.commit;
      assert.equal(git(bobRepo, 'merge-base', '--is-ancestor', commit, finished), '');
      assert.match(git(bobRepo, 'show', `${finished}:greet.sh`), /HELLO, TEAM/);
      assert.match(git(repo, 'show', 'main:greet.sh'), /hello, world/);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
