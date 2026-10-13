#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createIdentityFiles } from '../scripts/peer/onboarding.mjs';
import { wecomDiagnostic } from '../scripts/wecom-diagnostic.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);

function usage() {
  console.log(`Codex Collab

Usage:
  codex-collab setup [--no-open]
  codex-collab setup --terminal [--role admin|member]
  codex-collab
  codex-collab identity create <agent-id> [--dir /absolute/private/directory]
  codex-collab wecom discover
  codex-collab refresh-project /absolute/private-peer.json
  codex-collab <doctor|start|stop|status|list|read|review|complete|reopen|...> /abs/private-peer.json [args]

setup opens the local web wizard. --terminal keeps the legacy terminal workflow. Never pass a bot Secret as a command argument.`);
}

async function discoverWeCom() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('WeCom discovery requires an interactive terminal.');
  const { createPrompts } = await import('../scripts/peer/onboarding.mjs');
  const prompts = createPrompts(process.stdin, process.stdout);
  let client;
  try {
    const botId = (await prompts.required('企业微信机器人 Bot ID')).trim();
    const secret = await prompts.secret('企业微信机器人 Secret（输入不回显）');
    prompts.close();
    const AiBot = (await import('@wecom/aibot-node-sdk')).default;
    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    client = new AiBot.WSClient({ botId, secret, logger });
    client.on('connected', () => console.log('WeCom WebSocket connected; waiting for authentication.'));
    client.on('authenticated', () => console.log('WeCom authenticated; send a text message to the bot in the target group. Stop with Ctrl-C.'));
    client.on('error', (error) => console.error(`WeCom: ${wecomDiagnostic(error)}`));
    client.on('message.text', (frame) => {
      const { chattype, chatid, from } = frame?.body || {};
      if (chattype === 'group' && chatid && from?.userid) console.log(JSON.stringify({ chatid, userid: from.userid }));
    });
    const stop = () => { client?.disconnect(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    client.connect();
    console.log('WeCom group ID discovery connecting. Do not run this alongside the same bot Runner.');
  } finally {
    prompts.close();
  }
}

async function main() {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') return usage();

  if (args[0] === 'identity') {
    if (args[1] !== 'create' || !args[2]) throw new Error('usage: codex-collab identity create <agent-id> [--dir /absolute/private/directory]');
    let directory = join(homedir(), '.config', 'codex-collab', 'identities');
    for (let i = 3; i < args.length; i++) {
      if (args[i] !== '--dir' || !args[i + 1]) throw new Error('usage: codex-collab identity create <agent-id> [--dir /absolute/private/directory]');
      directory = resolve(args[++i]);
    }
    const files = await createIdentityFiles(args[2], directory);
    console.log(`Agent ID: ${files.agent_id}`);
    console.log(`Private identity (keep local): ${files.private_key_file}`);
    console.log(`Public key (share with team admin): ${files.public_key_file}`);
    return;
  }

  if (args[0] === 'refresh-project') {
    if (args.length !== 2) throw new Error('usage: codex-collab refresh-project /absolute/private-peer.json');
    const { refreshProject } = await import('../scripts/peer/refresh-project.mjs');
    console.log(JSON.stringify(await refreshProject({ configPath: args[1] }), null, 2));
    return;
  }

  if (args[0] === 'wecom') {
    if (args.length !== 2 || args[1] !== 'discover') throw new Error('usage: codex-collab wecom discover');
    await discoverWeCom();
    return;
  }

  if (args[0] === 'setup' || args.length === 0) {
    const options = args[0] === 'setup' ? args.slice(1) : [];
    let role, terminal = false, open = true;
    for (let i = 0; i < options.length; i++) {
      if (options[i] === '--role' && ['admin', 'member'].includes(options[i + 1])) { role = options[++i]; terminal = true; }
      else if (options[i] === '--terminal') terminal = true;
      else if (options[i] === '--no-open') open = false;
      else throw new Error('usage: codex-collab setup [--no-open] or setup --terminal [--role admin|member]');
    }
    if (terminal) { const { runSetupWizard } = await import('../scripts/peer/onboarding.mjs'); await runSetupWizard({ role }); }
    else { const { runLocalSetup } = await import('../apps/onboarding/main.mjs'); await runLocalSetup({ open }); }
    return;
  }

  process.argv = [process.execPath, join(packageRoot, 'scripts/peer/cli.mjs'), ...args];
  await import('../scripts/peer/cli.mjs');
}

main().catch((error) => {
  console.error(`codex-collab: ${error.message}`);
  process.exitCode = 1;
});
