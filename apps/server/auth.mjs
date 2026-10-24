import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export class Accounts {
  constructor(users) {
    if (!Array.isArray(users) || users.length === 0) throw new Error('at least one account is required');
    for (const user of users) {
      if (!user.id || !/^[a-f0-9]{64}$/.test(user.token_sha256 ?? '') || !['admin', 'member'].includes(user.role)) throw new Error('invalid accounts configuration');
    }
    for (const field of ['id', 'token_sha256', 'wecom_userid']) {
      const values = users.map((user) => user[field]).filter(Boolean);
      if (new Set(values).size !== values.length) throw new Error(`duplicate account ${field}`);
    }
    this.users = users;
  }

  static async fromFile(path) {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return new Accounts(parsed.users);
  }

  token(raw) {
    if (typeof raw !== 'string' || raw.length < 24) return null;
    const digest = Buffer.from(hashToken(raw), 'hex');
    return this.users.find((user) => timingSafeEqual(digest, Buffer.from(user.token_sha256, 'hex'))) ?? null;
  }

  wecom(userid) {
    return this.users.find((user) => user.wecom_userid && user.wecom_userid === userid) ?? null;
  }
}

export class Forbidden extends Error {
  constructor(message = 'forbidden') { super(message); this.status = 403; }
}
export class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; }
}
