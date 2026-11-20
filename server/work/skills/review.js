// 技能安装期审查：在写进工作区之前，先看清它会联网、读环境变量、写文件还是执行子进程。
// 不追求沙箱级判定；目标是把高风险技能的权限清单摆在用户面前，并默认不启用。
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const TEXT_FILE = /\.(?:md|txt|js|mjs|cjs|jsx|ts|tsx|py|sh|bash|zsh|ps1|bat|cmd|json|ya?ml|toml)$/i;
const MAX_SCAN_BYTES = 256 * 1024;

const PATTERNS = {
  network: [
    /\bfetch\s*\(/, /\baxios\b/, /\bhttps?\.request\b/, /\bnet\.connect\b/,
    /\bcurl\s+https?:/, /\bwget\s+https?:/, /\bInvoke-WebRequest\b/i,
    /\brequests\.(?:get|post|put|delete)\s*\(/, /\burllib\b/, /\bhttpx?\b/
  ],
  env: [
    /\bprocess\.env\b/, /\bos\.environ\b/, /\bgetenv\s*\(/, /\$env:[A-Za-z_]/i,
    /\bDeno\.env\b/
  ],
  files: [
    /\bwriteFile(?:Sync)?\s*\(/, /\bappendFile(?:Sync)?\s*\(/, /\bcreateWriteStream\s*\(/,
    /\bfs\.(?:write|rm|unlink|rename|copyFile)\b/, /\bopen\s*\([^)]*['"][wa]\+?['"]/,
    /\bSet-Content\b/i, /\bOut-File\b/i, /\bAdd-Content\b/i, /\bRemove-Item\b/i,
    /(?:^|[^<])>{1,2}(?!&)/
  ],
  exec: [
    /\bchild_process\b/, /\bexecSync\s*\(/, /\bexec\s*\(/, /\bspawn(?:Sync)?\s*\(/,
    /\bsubprocess\./, /\bos\.system\s*\(/, /\bInvoke-Expression\b/i, /\beval\s*\(/
  ],
  secrets: [
    /\.ssh[\\/]/, /\bid_rsa\b/, /\.env\b/, /\bcredentials\b/i, /\.aws[\\/]/,
    /\bapi[_-]?key\b/i, /\baccess[_-]?token\b/i
  ]
};

const LABELS = {
  network: '联网请求',
  env: '读取环境变量',
  files: '写文件',
  exec: '执行命令/子进程',
  secrets: '触碰凭据或密钥'
};

const RISK_LABELS = { high: '高', medium: '中', low: '低' };

function scanFile(file) {
  try {
    const full = path.resolve(file.root, file.path);
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return '';
    return readFileSync(full, 'utf8');
  } catch {
    return '';
  }
}

/**
 * @param {{root:string, files:Array<{path:string}>, provenance?:object}} input
 * @returns {{risk:'low'|'medium'|'high', enabledByDefault:boolean, permissions:object, summary:string, provenance:object}}
 */
export function reviewSkill({ root = '', files = [], provenance = {} } = {}) {
  const permissions = Object.fromEntries(Object.keys(PATTERNS).map(kind => [kind, []]));
  const seen = new Set();
  for (const file of files) {
    const relative = String(file?.path || '').replaceAll('\\', '/');
    if (!relative || !TEXT_FILE.test(relative)) continue;
    const body = scanFile({ root, path: relative });
    if (!body) continue;
    for (const [kind, patterns] of Object.entries(PATTERNS)) {
      const hit = patterns.find(pattern => pattern.test(body) || pattern.test(relative));
      if (!hit) continue;
      const key = `${kind}:${relative}`;
      if (seen.has(key)) continue;
      seen.add(key);
      permissions[kind].push({ file: relative, detail: LABELS[kind] });
    }
  }
  const has = kind => permissions[kind].length > 0;
  // 能执行命令又联网/碰凭据，风险最高：它可以在用户不知情时把数据带出去或改系统。
  const high = (has('exec') && has('network')) || (has('exec') && has('secrets')) || (has('network') && has('secrets'));
  const medium = !high && (has('exec') || has('network') || has('env'));
  const risk = high ? 'high' : medium ? 'medium' : 'low';
  const kinds = Object.keys(permissions).filter(has).map(kind => LABELS[kind]);
  const summary = kinds.length
    ? `该技能会：${kinds.join('、')}。风险等级：${RISK_LABELS[risk]}。`
    : '没有发现联网、读写文件或执行命令的迹象。';
  return {
    risk,
    enabledByDefault: risk !== 'high',
    permissions,
    summary,
    provenance: {
      repo: String(provenance.repo || ''),
      ref: String(provenance.ref || ''),
      commit: String(provenance.commit || ''),
      path: String(provenance.path || ''),
      digest: String(provenance.digest || ''),
      ...(provenance.repo ? { url: `https://github.com/${provenance.repo}` } : {})
    }
  };
}
