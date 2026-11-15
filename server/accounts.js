import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const authError = (message, status = 400) => Object.assign(new Error(message), { status });
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
// 手机号永远只返回掩码；完整号码只在服务端校验时短暂存在。
export const maskPhone = phone => {
  const value = String(phone || '');
  return /^\d{11}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(-4)}` : '';
};
export const publicUser = row => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  createdAt: row.created_at,
  ...(row.phone ? { phoneMasked: maskPhone(row.phone) } : {}),
  phoneVerified: Boolean(row.phone_verified_at)
});
export function usernameValue(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(value)) throw authError('用户名须为 3–32 个英文字母、数字或下划线');
  return value.toLowerCase();
}
export function passwordValue(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw authError('密码须为 10–128 个字符');
  return value;
}

// Bound both memory-intensive scrypt operations and their waiting queue.
export class PasswordHasher {
  constructor({ maxConcurrent = 2, maxQueue = 16 } = {}) { this.active = 0; this.queue = []; this.maxConcurrent = maxConcurrent; this.maxQueue = maxQueue; }
  async run(fn) {
    if (this.active >= this.maxConcurrent) {
      if (this.queue.length >= this.maxQueue) throw authError('认证服务繁忙，请稍后重试', 503);
      await new Promise(resolve => this.queue.push(resolve));
    } else this.active++;
    try { return await fn(); }
    finally { const next = this.queue.shift(); if (next) next(); else this.active--; }
  }
  async hash(password) {
    return this.run(async () => {
      const salt = randomBytes(16); const hash = await derive(password, salt, 32, params);
      return `scrypt$32768$8$3$${salt.toString('hex')}$${hash.toString('hex')}`;
    });
  }
  async verify(password, encoded) {
    return this.run(async () => {
      const parts = encoded?.split('$');
      const valid = parts?.length === 6 && parts.slice(0, 4).join('$') === 'scrypt$32768$8$3' && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{64}$/.test(parts[5]);
      // Unknown users still incur the same KDF work and constant-time comparison.
      const salt = valid ? Buffer.from(parts[4], 'hex') : Buffer.alloc(16);
      const expected = valid ? Buffer.from(parts[5], 'hex') : Buffer.alloc(32);
      const actual = await derive(password, salt, 32, params);
      return timingSafeEqual(actual, expected) && Boolean(valid);
    });
  }
}

export const validShareToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export class Accounts {
  constructor(dataDir, { now = Date.now, sessionTtlMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.now = now; this.sessionTtlMs = sessionTtlMs;
    this.db = new DatabaseSync(path.join(dataDir, 'accounts.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), task_id TEXT NOT NULL, snapshot TEXT NOT NULL, hide_revenue INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS shares_owner_task ON shares(owner_id,task_id);
      CREATE TABLE IF NOT EXISTS share_visits (share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, visitor_hash TEXT NOT NULL, PRIMARY KEY(share_id,visitor_hash));
      CREATE TABLE IF NOT EXISTS share_registrations (share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, visitor_hash TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), PRIMARY KEY(share_id,visitor_hash));
      CREATE TABLE IF NOT EXISTS phone_codes (id TEXT PRIMARY KEY, phone_hash TEXT NOT NULL, code_hash TEXT NOT NULL, salt TEXT NOT NULL, purpose TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, ip_hash TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS phone_codes_lookup ON phone_codes(phone_hash,purpose,created_at);
      CREATE TABLE IF NOT EXISTS trusted_devices (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_hash TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(user_id,device_hash));
      CREATE TABLE IF NOT EXISTS auth_audit (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, result TEXT NOT NULL, phone_hash TEXT, ip_hash TEXT, device_hash TEXT, reason TEXT, created_at INTEGER NOT NULL);
      -- 云端作用域 MCP 令牌索引：外部 Agent 只带令牌，没有会话，需要先查到令牌属于哪个账号。
      CREATE TABLE IF NOT EXISTS mcp_token_index (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`);
    // 存量库只补列，不动已有账号；老账号 phone 为空时仍可用用户名密码登录。
    const columns = new Set(this.db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
    if (!columns.has('phone')) this.db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
    if (!columns.has('phone_verified_at')) this.db.exec('ALTER TABLE users ADD COLUMN phone_verified_at TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users(phone) WHERE phone IS NOT NULL');
    this.credentials = new Map();
    this.prune();
  }
  userByName(username) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(username); }
  userById(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id); }
  userByPhone(phone) { return this.db.prepare('SELECT * FROM users WHERE phone=?').get(phone); }
  setPhone(userId, phone) {
    const verifiedAt = new Date(this.now()).toISOString();
    const result = this.db.prepare('UPDATE users SET phone=?,phone_verified_at=? WHERE id=?').run(phone, verifiedAt, userId);
    if (!result.changes) throw authError('账号不存在', 404);
    return this.userById(userId);
  }
  clearPhone(userId) { this.db.prepare('UPDATE users SET phone=NULL,phone_verified_at=NULL WHERE id=?').run(userId); }
  // 验证码：同一手机号同一用途只保留一条可用记录，重发即让旧码失效。
  savePhoneCode({ phoneHash, codeHash, salt, purpose, expiresAt, ipHash }) {
    const createdAt = this.now();
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 过期一天以上的验证码没有校验价值，顺手清理，避免表无限增长。
      this.db.prepare('DELETE FROM phone_codes WHERE expires_at<=?').run(createdAt - 86400000);
      this.db.prepare('UPDATE phone_codes SET used=1 WHERE phone_hash=? AND purpose=? AND used=0').run(phoneHash, purpose);
      this.db.prepare('INSERT INTO phone_codes(id,phone_hash,code_hash,salt,purpose,expires_at,attempts,used,ip_hash,created_at) VALUES(?,?,?,?,?,?,0,0,?,?)')
        .run(id, phoneHash, codeHash, salt, purpose, expiresAt, ipHash || null, createdAt);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return id;
  }
  latestPhoneCode(phoneHash, purpose) {
    return this.db.prepare('SELECT * FROM phone_codes WHERE phone_hash=? AND purpose=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(phoneHash, purpose);
  }
  consumePhoneCode(id) {
    return this.db.prepare('UPDATE phone_codes SET used=1 WHERE id=? AND used=0 AND expires_at>?').run(id, this.now()).changes > 0;
  }
  bumpPhoneCodeAttempts(id) { this.db.prepare('UPDATE phone_codes SET attempts=attempts+1 WHERE id=?').run(id); }
  phoneCodeCount({ phoneHash, ipHash, since }) {
    if (phoneHash !== undefined) return this.db.prepare('SELECT COUNT(*) AS n FROM phone_codes WHERE phone_hash=? AND created_at>=?').get(phoneHash, since).n;
    return this.db.prepare('SELECT COUNT(*) AS n FROM phone_codes WHERE ip_hash=? AND created_at>=?').get(ipHash, since).n;
  }
  lastPhoneCodeAt(phoneHash, purpose) {
    return this.db.prepare('SELECT created_at FROM phone_codes WHERE phone_hash=? AND purpose=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(phoneHash, purpose)?.created_at || 0;
  }
  failedPhoneVerifications(phoneHash, since) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE phone_hash=? AND action='sms_verify' AND result='fail' AND created_at>=?").get(phoneHash, since).n;
  }
  auditAuth({ userId = null, action, result, phoneHash = null, ipHash = null, deviceHash = null, reason = '' }) {
    this.db.prepare('INSERT INTO auth_audit(id,user_id,action,result,phone_hash,ip_hash,device_hash,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), userId, String(action).slice(0, 40), String(result).slice(0, 20), phoneHash, ipHash, deviceHash, String(reason).slice(0, 200), this.now());
    // 审计保留 180 天，避免无限增长。
    this.db.prepare('DELETE FROM auth_audit WHERE created_at<=?').run(this.now() - 180 * 86400000);
  }
  trustDevice(userId, deviceHash, expiresAt) {
    const current = this.now();
    this.db.prepare('INSERT INTO trusted_devices(user_id,device_hash,created_at,expires_at,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(user_id,device_hash) DO UPDATE SET expires_at=excluded.expires_at,last_seen=excluded.last_seen')
      .run(userId, deviceHash, current, expiresAt, current);
  }
  isTrustedDevice(userId, deviceHash) {
    if (!deviceHash) return false;
    const row = this.db.prepare('SELECT expires_at FROM trusted_devices WHERE user_id=? AND device_hash=?').get(userId, deviceHash);
    if (!row || row.expires_at <= this.now()) return false;
    this.db.prepare('UPDATE trusted_devices SET last_seen=? WHERE user_id=? AND device_hash=?').run(this.now(), userId, deviceHash);
    return true;
  }
  revokeOtherSessions(userId, keepHash) {
    if (keepHash) return this.db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, keepHash).changes;
    return this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId).changes;
  }
  revokeOtherTrustedDevices(userId, keepHash) {
    if (keepHash) return this.db.prepare('DELETE FROM trusted_devices WHERE user_id=? AND device_hash<>?').run(userId, keepHash).changes;
    return this.db.prepare('DELETE FROM trusted_devices WHERE user_id=?').run(userId).changes;
  }
  // 作用域 MCP 令牌索引：只存哈希，不存明文；撤销后立即拒绝。
  registerMcpToken(tokenHash, userId) {
    this.db.prepare('INSERT INTO mcp_token_index(token_hash,user_id,revoked,created_at) VALUES(?,?,0,?) ON CONFLICT(token_hash) DO UPDATE SET user_id=excluded.user_id,revoked=0')
      .run(tokenHash, userId, this.now());
  }
  revokeMcpToken(tokenHash) {
    this.db.prepare('UPDATE mcp_token_index SET revoked=1 WHERE token_hash=?').run(tokenHash);
  }
  mcpTokenUser(tokenHash) {
    return this.db.prepare('SELECT user_id FROM mcp_token_index WHERE token_hash=? AND revoked=0').get(tokenHash)?.user_id || null;
  }
  register(username, displayName, passwordHash, attribution = {}, { phone = null, phoneVerifiedAt = null } = {}) {
    const user = { id: randomUUID(), username, display_name: displayName, password_hash: passwordHash, created_at: new Date(this.now()).toISOString(), phone: phone || null, phone_verified_at: phone ? (phoneVerifiedAt || user.created_at) : null };
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO users(id,username,display_name,password_hash,created_at,phone,phone_verified_at) VALUES(?,?,?,?,?,?,?)').run(user.id, username, displayName, passwordHash, user.created_at, user.phone, user.phone_verified_at);
      const share = this.validShare(attribution.shareToken);
      if (share && validShareToken(attribution.visitorToken) && this.db.prepare('SELECT COUNT(*) AS n FROM share_registrations WHERE share_id=?').get(share.id).n < 10000) this.db.prepare('INSERT OR IGNORE INTO share_registrations VALUES(?,?,?)').run(share.id, tokenHash(attribution.visitorToken), user.id);
      this.db.exec('COMMIT');
    }
    catch (error) { this.db.exec('ROLLBACK'); if (error.code?.includes('SQLITE_CONSTRAINT') || error.errcode === 2067) throw authError('无法注册该账号，请检查输入或改用其他用户名', 409); throw error; }
    return user;
  }
  pruneShares() { this.db.prepare('DELETE FROM shares WHERE expires_at<=?').run(this.now() - 30 * 86400000); }
  validShare(token) {
    if (!validShareToken(token)) return null;
    return this.db.prepare('SELECT * FROM shares WHERE token_hash=? AND revoked=0 AND expires_at>?').get(tokenHash(token), this.now()) || null;
  }
  createShare(ownerId, taskId, snapshot, days, hideRevenue) {
    this.pruneShares();
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner_id=?').get(ownerId).n;
    if (this.db.prepare('SELECT COUNT(*) AS n FROM shares WHERE owner_id=? AND task_id=?').get(ownerId, taskId).n >= 20) throw authError('单份报告的分享数量已达上限', 429);
    if (count >= 100) throw authError('分享数量已达上限，请等待过期记录清理', 429);
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), created = this.now(), expires = created + days * 86400000;
    this.db.prepare('INSERT INTO shares VALUES(?,?,?,?,?,?,?,?,0)').run(id, tokenHash(token), ownerId, taskId, JSON.stringify(snapshot), Number(hideRevenue), created, expires);
    return { token, share: { id, expiresAt: new Date(expires).toISOString(), hideRevenue, views: 0, registrations: 0 } };
  }
  shares(ownerId, taskId) {
    this.pruneShares();
    return this.db.prepare(`SELECT s.id,s.expires_at,s.hide_revenue,s.revoked,
      (SELECT COUNT(*) FROM share_visits v WHERE v.share_id=s.id) AS views,
      (SELECT COUNT(*) FROM share_registrations r WHERE r.share_id=s.id) AS registrations
      FROM shares s WHERE s.owner_id=? AND s.task_id=? ORDER BY s.created_at DESC,s.rowid DESC`).all(ownerId, taskId).map(s => ({ id:s.id, expiresAt:new Date(s.expires_at).toISOString(), hideRevenue:Boolean(s.hide_revenue), revoked:Boolean(s.revoked), views:s.views, registrations:s.registrations }));
  }
  revokeShare(ownerId, id) { return this.db.prepare('UPDATE shares SET revoked=1 WHERE id=? AND owner_id=?').run(id, ownerId).changes > 0; }
  visitShare(share, visitor) {
    if (!validShareToken(visitor)) throw authError('访客标识无效');
    const hash = tokenHash(visitor);
    if (this.db.prepare('SELECT 1 FROM share_visits WHERE share_id=? AND visitor_hash=?').get(share.id, hash)) return;
    if (this.db.prepare('SELECT COUNT(*) AS n FROM share_visits WHERE share_id=?').get(share.id).n >= 10000) throw authError('访问计数已达上限', 429);
    this.db.prepare('INSERT OR IGNORE INTO share_visits VALUES(?,?)').run(share.id, hash);
  }
  createSession(userId) {
    this.prune();
    // A bounded number of live sessions also bounds in-memory credentials per account.
    const old = this.db.prepare('SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 19').all(userId);
    for (const row of old) this.revoke(row.token_hash);
    const token = randomBytes(32).toString('base64url'); const hash = tokenHash(token);
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash, userId, this.now() + this.sessionTtlMs, this.now());
    return token;
  }
  session(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = tokenHash(token);
    const row = this.db.prepare('SELECT s.token_hash,s.expires_at,u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?').get(hash);
    if (!row) return null;
    if (row.expires_at <= this.now()) { this.revoke(hash); return null; }
    return { hash, user: publicUser(row), passwordHash: row.password_hash };
  }
  getKey(hash, baseUrl) {
    const credential = this.credentials.get(hash);
    if (!credential || credential.expiresAt <= this.now()) { this.credentials.delete(hash); return ''; }
    return baseUrl !== undefined && credential.baseUrl !== baseUrl ? '' : credential.key;
  }
  setKey(hash, key, baseUrl) {
    if (!key) { this.credentials.delete(hash); return; }
    const row = this.db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?').get(hash);
    if (!row || row.expires_at <= this.now()) throw authError('登录已失效，请重新登录', 401);
    this.credentials.set(hash, { key, baseUrl, userId: row.user_id, expiresAt: row.expires_at });
  }
  revoke(hash) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash); this.credentials.delete(hash); }
  changePassword(userId, passwordHash) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, userId); this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const [hash, credential] of this.credentials) if (credential.userId === userId) this.credentials.delete(hash);
  }
  prune() {
    const now = this.now(); this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    this.db.prepare('DELETE FROM trusted_devices WHERE expires_at<=?').run(now);
    for (const [hash, credential] of this.credentials) if (credential.expiresAt <= now) this.credentials.delete(hash);
  }
  close() { this.credentials.clear(); this.db.close(); }
}

export class AuthRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, maxIp = 40, maxUsername = 12, maxEntries = 10000 } = {}, now = Date.now) {
    this.entries = new Map(); this.windowMs = windowMs; this.maxIp = maxIp; this.maxUsername = maxUsername; this.maxEntries = maxEntries; this.now = now;
  }
  consume(ip, username) {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.until <= now) this.entries.delete(key);
    const keys = [[`ip:${ip}`, this.maxIp], [`user:${username}`, this.maxUsername]];
    for (const [key, max] of keys) {
      const entry = this.entries.get(key);
      if ((entry?.count || 0) >= max || (!entry && this.entries.size >= this.maxEntries)) throw authError('尝试次数过多，请稍后再试', 429);
    }
    for (const [key] of keys) { const value = this.entries.get(key) || { count: 0, until: now + this.windowMs }; value.count++; this.entries.set(key, value); }
  }
}
