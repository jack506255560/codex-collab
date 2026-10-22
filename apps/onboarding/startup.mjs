import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const entry = fileURLToPath(new URL('./main.mjs', import.meta.url));
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const unitArg = (value, expand = true) => {
  let text = String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  if (expand) text = text.replaceAll('$', () => '$$');
  return `"${text}"`;
};
export function startupDefinition({ home, platform = process.platform, userHome = homedir(), node = process.execPath, path = process.env.PATH || '/usr/bin:/bin' }) {
  if ([home, userHome, node, path].some((value) => typeof value !== 'string' || /[\x00\r\n]/.test(value))) throw new Error('自启路径不能包含换行或空字符。');
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const label = `com.codex-collab.${suffix}`;
  const log = join(home, 'service.log');
  if (platform === 'darwin') return { kind: 'launchd', label, path: join(userHome, 'Library/LaunchAgents', `${label}.plist`), content: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, entry, '--home', home].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>15</integer><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict><key>Umask</key><integer>63</integer><key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string></dict></plist>\n` };
  if (platform === 'linux') return { kind: 'systemd', label: `${label}.service`, path: join(userHome, '.config/systemd/user', `${label}.service`), content: `[Unit]\nDescription=Codex Collab local workspace\n[Service]\nType=simple\nExecStart=${[node, entry, '--home', home].map((arg) => unitArg(arg)).join(' ')}\nEnvironment=${unitArg(`PATH=${path}`, false)}\nRestart=on-failure\nRestartSec=15\nUMask=0077\n[Install]\nWantedBy=default.target\n` };
  return null;
}
export async function configureStartup({ home, enabled = true, start = false, platform = process.platform, userHome = homedir(), execute = exec } = {}) {
  const definition = startupDefinition({ home, platform, userHome });
  const status = { enabled: false, supported: !!definition, kind: definition?.kind || null };
  await mkdir(home, { recursive: true, mode: 0o700 });
  const run = (command, args) => execute(command, args, { timeout: 10000, maxBuffer: 10000 });
  if (definition) {
    try {
      if (enabled) {
        const logPath = join(home, 'service.log');
        const log = await open(logPath, 'a', 0o600); await log.close(); await chmod(logPath, 0o600);
        await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
        await writeFile(definition.path, definition.content, { mode: 0o600 });
        if (definition.kind === 'launchd') {
          const domain = `gui/${process.getuid()}`;
          if (start) {
            try { await run('launchctl', ['bootstrap', domain, definition.path]); }
            catch { await run('launchctl', ['kickstart', `${domain}/${definition.label}`]); }
          }
        } else {
          await run('systemctl', ['--user', 'daemon-reload']);
          await run('systemctl', ['--user', 'enable', ...(start ? ['--now'] : []), definition.label]);
        }
        status.enabled = true;
      } else {
        if (definition.kind === 'launchd') await run('launchctl', ['bootout', `gui/${process.getuid()}/${definition.label}`]).catch(() => {});
        else await run('systemctl', ['--user', 'disable', definition.label]);
        await rm(definition.path, { force: true });
      }
    } catch { status.error = '登录自启未完成。后台连接仍可使用，可运行 codex-collab autostart on 重试。'; }
  } else if (enabled) status.error = '此系统暂不支持自动配置登录自启；本次后台服务已独立运行。';
  await writeFile(join(home, 'startup.json'), JSON.stringify(status) + '\n', { mode: 0o600 });
  return status;
}
export async function startupStatus(home) {
  try { return JSON.parse(await readFile(join(home, 'startup.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { enabled: false, supported: ['darwin', 'linux'].includes(process.platform) }; throw error; }
}
