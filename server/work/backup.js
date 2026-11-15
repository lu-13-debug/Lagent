import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { APP_VERSION } from '../version.js';
import { workError } from './domain.js';

const derive = promisify(scrypt);
const MAGIC = 'LAGENT-BACKUP-1';
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const SCHEDULE_KEY = 'work-backup-log';

const passphraseOf = value => {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) throw workError('备份口令须为 8–200 个字符', 400);
  return value;
};

const trimLog = rows => rows.slice(0, 50);

export function createBackupService({ store, engine, dataDir, version = APP_VERSION, now = Date.now } = {}) {
  if (!store) throw new TypeError('备份服务需要 store');
  const dir = dataDir || path.dirname(store.dbPath);

  const log = (entry) => {
    const rows = trimLog([{ ...entry, at: new Date(now()).toISOString() }, ...(store.config(SCHEDULE_KEY) || [])]);
    store.config(SCHEDULE_KEY, rows);
  };

  // 备份库里的凭据是另一层 AES-GCM 密文；不需要凭据备份时直接从副本里删掉，
  // 避免把「无法解密但看起来像 Key」的数据一起带走。
  function withoutCredentials(bytes) {
    const temp = path.join(os.tmpdir(), `lagent-backup-nocreds-${randomBytes(8).toString('hex')}.sqlite`);
    try {
      writeFileSync(temp, bytes);
      const db = new DatabaseSync(temp);
      try { db.prepare("DELETE FROM config WHERE key LIKE 'credential-vault-v1:%'").run(); } finally { db.close(); }
      return readFileSync(temp);
    } finally { try { if (existsSync(temp)) rmSync(temp, { force: true }); } catch { /* 清理失败不影响导出。 */ } }
  }

  async function encrypt(bytes, passphrase) {
    const salt = randomBytes(16);
    const key = await derive(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${MAGIC}:1`));
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const header = {
      version: 1,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      createdAt: new Date(now()).toISOString(),
      appVersion: version,
      bytes: bytes.length
    };
    // 单文件格式：一行魔数 + 一行 JSON 头 + base64 密文，便于用户直接存网盘或拷贝。
    return Buffer.from(`${MAGIC}\n${JSON.stringify(header)}\n${ciphertext.toString('base64')}`);
  }

  async function decrypt(buffer, passphrase) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 64 || buffer.length > MAX_BACKUP_BYTES) throw workError('备份文件为空或过大', 400);
    const text = buffer.toString('utf8');
    const first = text.indexOf('\n');
    if (first < 0 || text.slice(0, first) !== MAGIC) throw workError('备份文件格式无效或版本不受支持', 400);
    const second = text.indexOf('\n', first + 1);
    if (second < 0) throw workError('备份文件格式无效', 400);
    let header;
    try { header = JSON.parse(text.slice(first + 1, second)); } catch { throw workError('备份文件头损坏', 400); }
    if (header.version !== 1 || header.algorithm !== 'aes-256-gcm' || header.kdf !== 'scrypt') throw workError('备份文件版本不受支持', 400);
    const ciphertext = Buffer.from(text.slice(second + 1).trim(), 'base64');
    try {
      const salt = Buffer.from(header.salt, 'base64');
      const nonce = Buffer.from(header.nonce, 'base64');
      const tag = Buffer.from(header.tag, 'base64');
      const key = await derive(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(Buffer.from(`${MAGIC}:1`));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch { throw workError('备份口令错误，或备份文件已损坏', 400); }
  }

  async function exportBundle({ passphrase, includeCredentials = true } = {}) {
    const secret = passphraseOf(passphrase);
    let bytes = store.exportDatabase();
    if (!includeCredentials) bytes = withoutCredentials(bytes);
    const payload = await encrypt(bytes, secret);
    log({ kind: 'export', bytes: payload.length, databaseBytes: bytes.length, includeCredentials: includeCredentials !== false, result: 'ok' });
    return {
      filename: `lagent-backup-${new Date(now()).toISOString().replace(/[:.]/g, '-')}.lagentbackup`,
      bytes: payload,
      size: payload.length
    };
  }

  async function restoreBundle(buffer, { passphrase } = {}) {
    const secret = passphraseOf(passphrase);
    const bytes = await decrypt(buffer, secret);
    if (bytes.subarray(0, 16).toString('utf8') !== 'SQLite format 3\0') throw workError('备份内容不是有效的 Lagent 数据库', 400);
    // 恢复会用快照覆盖当前库，先把恢复前的备份记录取出来，避免历史一起被回滚掉。
    const previous = store.config(SCHEDULE_KEY) || [];
    const result = store.replaceDatabase(bytes);
    store.config(SCHEDULE_KEY, trimLog([{ kind: 'restore', bytes: buffer.length, databaseBytes: bytes.length, result: 'ok', at: new Date(now()).toISOString() }, ...previous]));
    return { ...result, restoredAt: new Date(now()).toISOString() };
  }

  function diagnostics() {
    let stats = null;
    try { stats = store.stats(); } catch { /* 诊断包允许部分能力缺失。 */ }
    let policy = null;
    try { policy = engine?.policy?.() || null; } catch { /* 策略不可读时留空。 */ }
    let activeProfile = null;
    try { activeProfile = engine?.profilesActive?.()?.effective || null; } catch { /* 配置档不可读时留空。 */ }
    const env = process.env;
    return {
      generatedAt: new Date(now()).toISOString(),
      app: { name: 'Lagent', version },
      runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid, uptimeSeconds: Math.round(process.uptime()) },
      data: { ...(stats || {}), dataDir: path.basename(dir) },
      // 健康检查只给结论，不附原始日志：诊断包会被贴到工单里。
      health: {
        database: stats ? 'ok' : 'unavailable',
        workEngine: Boolean(engine),
        backupSchedule: Number(env.LAGENT_BACKUP_INTERVAL_HOURS) > 0 && Boolean(env.LAGENT_BACKUP_PASSPHRASE),
        smsProvider: env.LAGENT_SMS_PROVIDER || 'none',
        phoneVerification: env.LAGENT_REQUIRE_PHONE === '1'
      },
      policy,
      activeProfile,
      backups: store.config(SCHEDULE_KEY) || [],
      flags: {
        workEnabled: env.LAGENT_WORK_ENABLED !== '0',
        externalExecutors: env.LAGENT_ALLOW_EXTERNAL_EXECUTORS === '1',
        orchestratorLegacy: env.LAGENT_ORCHESTRATOR === 'legacy',
        requirePhone: env.LAGENT_REQUIRE_PHONE === '1',
        smsConfigured: Boolean(env.LAGENT_SMS_PROVIDER && env.LAGENT_SMS_PROVIDER !== 'none'),
        credentialVault: Boolean(env.LAGENT_CREDENTIAL_MASTER_KEY)
      },
      // 环境变量只列名字，不列值：诊断包经常被贴到工单里，值里可能有密钥。
      environment: Object.keys(env).filter(key => key.startsWith('LAGENT_') || key === 'NODE_ENV').sort()
    };
  }

  function listBackups() {
    return store.config(SCHEDULE_KEY) || [];
  }

  // 定时本地备份：口令来自环境变量，不写进数据库；失败只记录，不影响主服务。
  function startScheduledBackups({ hours = 0, targetDir = path.join(dir, 'backups'), passphrase, keep = 14 } = {}) {
    const intervalHours = Number(hours);
    if (!Number.isFinite(intervalHours) || intervalHours <= 0 || typeof passphrase !== 'string' || passphrase.length < 8) return () => {};
    mkdirSync(targetDir, { recursive: true });
    let running = false;
    const run = async () => {
      if (running) return; running = true;
      try {
        const bundle = await exportBundle({ passphrase });
        writeFileSync(path.join(targetDir, bundle.filename), bundle.bytes);
        const files = readdirSync(targetDir).filter(name => /^lagent-backup-.*\.lagentbackup$/.test(name)).sort();
        for (const name of files.slice(0, Math.max(0, files.length - keep))) {
          try { rmSync(path.join(targetDir, name), { force: true }); } catch { /* 旧备份清理失败不影响新备份。 */ }
        }
      } catch (error) {
        log({ kind: 'auto-export', result: 'failed', reason: String(error?.message || '').slice(0, 200) });
      } finally { running = false; }
    };
    const timer = setInterval(() => { void run(); }, intervalHours * 3600000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { exportBundle, restoreBundle, diagnostics, listBackups, startScheduledBackups };
}
