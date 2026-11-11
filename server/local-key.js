import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * 本机单用户模式的凭据主密钥。
 * 部署方显式配置 LAGENT_CREDENTIAL_MASTER_KEY 时优先使用环境变量；
 * 没有配置时，为本地模式生成一次并保存在数据目录，避免「凭据库不可用 → 模型中心无法配置」。
 * 云端模式不会调用这里，仍要求显式主密钥。
 */
export function localCredentialKey(dataDir) {
  const file = path.join(dataDir, 'credential-master-key');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (KEY_PATTERN.test(existing)) return existing;
  } catch { /* 首次运行或文件不可读，下面重新生成。 */ }
  const key = randomBytes(32).toString('base64');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch {
    // 并发启动时另一个进程可能已写入：读回它生成的密钥，保证同机一致。
    try {
      const existing = readFileSync(file, 'utf8').trim();
      if (KEY_PATTERN.test(existing)) return existing;
    } catch { /* 落盘失败则退化为进程内密钥。 */ }
    return key;
  }
}

export function credentialKeyPath(dataDir) {
  return path.join(dataDir, 'credential-master-key');
}
