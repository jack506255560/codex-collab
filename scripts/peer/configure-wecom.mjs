import { chmod, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { readPrivateJson, validateTeam } from '../../packages/peer/config.mjs';

const [configPath, botId, chatIds, flag, ...extra] = process.argv.slice(2);
if (!configPath || !isAbsolute(configPath) || !botId || !chatIds || extra.length || flag !== undefined && flag !== '--notify-only') throw new Error('usage: WECOM_BOT_SECRET=... node scripts/peer/configure-wecom.mjs /abs/private-peer.json BOT_ID chatid1,chatid2 [--notify-only]');
const secret = process.env.WECOM_BOT_SECRET;
if (!secret) throw new Error('provide WECOM_BOT_SECRET only in the local process environment; never put it in shell history or Git');
const current = await readPrivateJson(resolve(configPath));
const team = validateTeam(JSON.parse(await readFile(resolve(current.team_file), 'utf8')));
if (flag !== '--notify-only' && !team.agents[current.agent_id]?.wecom_userid) throw new Error('team policy must pin this agent\'s WeCom userid before enabling bot commands');
const ids = chatIds.split(',').map((id) => id.trim()).filter(Boolean);
if (!ids.length || ids.some((id) => id.length > 200)) throw new Error('provide at least one valid WeCom chat ID');
const next = { ...current, wecom: { bot_id: botId, secret, chat_ids: ids, commands_enabled: flag !== '--notify-only' } };
await writeFile(resolve(configPath), JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'w' });
await chmod(resolve(configPath), 0o600);
console.log(`WeCom settings written to ${resolve(configPath)}; secret was not printed.`);
