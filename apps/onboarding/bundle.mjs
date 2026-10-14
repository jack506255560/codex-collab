import { SetupError } from './errors.mjs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
export function encryptBundle(value, password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new SetupError('接入包密码至少 12 个字符，请单独交给成员。');
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { schema_version: 1, kind: 'codex-collab-encrypted-invite', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function decryptBundle(value, password) {
  if (typeof password !== 'string' || !password.trim()) throw new SetupError('请填写接入包密码；若管理员页面未保存密码，请由管理员重新生成接入包。');
  try {
    if (value?.schema_version !== 1 || value.kind !== 'codex-collab-encrypted-invite' || typeof password !== 'string' || password.length > 256) throw new Error();
    const salt = Buffer.from(value.salt, 'base64'), iv = Buffer.from(value.iv, 'base64'), tag = Buffer.from(value.tag, 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || typeof value.ciphertext !== 'string' || value.ciphertext.length > 500000) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', scryptSync(password, salt, 32), iv); decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  } catch { throw new SetupError('接入包或密码无效，请确认文件完整且密码正确。'); }
}
export function remoteIdentity(remote) {
  const scp = remote.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  try { const url = new URL(remote); if (['https:', 'http:', 'ssh:'].includes(url.protocol)) return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')}`; } catch {}
  if (scp && !remote.startsWith('/')) return `${scp[1].toLowerCase()}/${scp[2].replace(/\/+$/g, '').replace(/\.git$/, '')}`;
  return remote;
}
