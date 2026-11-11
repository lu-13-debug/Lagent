// 改名前的环境变量前缀是 DATAAGENT_，现在统一用 LAGENT_。
// 老用户的启动脚本、批处理、系统环境变量里还留着旧名字，这里在进程启动时
// 把 DATAAGENT_* 复制成 LAGENT_*，避免升级后配置突然失效（已显式设置的新名优先）。

const LEGACY_PREFIX = 'DATAAGENT_';
const PREFIX = 'LAGENT_';

/**
 * 把旧前缀的环境变量搬到新前缀上。
 * @param {NodeJS.ProcessEnv} [env] 默认 process.env
 * @returns {string[]} 实际被采纳的新变量名
 */
export function adoptLegacyEnv(env = process.env) {
  const adopted = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const current = PREFIX + key.slice(LEGACY_PREFIX.length);
    const value = env[key];
    if (value === undefined || value === '') continue;
    if (env[current] !== undefined && env[current] !== '') continue;
    env[current] = value;
    adopted.push(current);
  }
  return adopted;
}

adoptLegacyEnv();
