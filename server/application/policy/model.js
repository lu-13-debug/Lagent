// 执行策略的规则层：权限档位、预算范围、执行器白名单与策略规范化。
// 环境变量读取（LAGENT_WORK_ENABLED / LAGENT_ALLOW_EXTERNAL_EXECUTORS）留在 server/work/policy.js。
import path from 'node:path';

export const EXTERNAL_EXECUTORS = Object.freeze([
  'codex',
  'claude-code',
  'browser',
  'github',
  'codex-acp',
  'claude-acp',
  'dsh-acp',
  'opencode',
  'gemini',
  'qwen',
  'cursor-agent',
  'dsh',
  'codebuddy',
  'qoder',
  'iflow',
  'kimi',
  'workbuddy'
]);

export const WORK_POLICY_ID = 'default';

const defaults = Object.freeze({
  mode: 'personal',
  // 权限模式：read 仅查看、workspace 只在工作区内改、full 完全权限（越界不再问）。
  permission: 'workspace',
  acceptMode: 'explicit',
  allowedExecutors: Object.freeze(['analysis', 'terminal']),
  // 默认不再「先批准再执行」：需要额外权限时才会在对话里弹一次确认。
  requireApproval: false,
  budgets: Object.freeze({ maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 200000 }),
  limits: Object.freeze({ browserHosts: Object.freeze([]), githubRepos: Object.freeze([]), acpWrites: true, modelWrites: true, extraRoots: Object.freeze([]), confirmDanger: true })
});

export const PERMISSIONS = Object.freeze(['read', 'workspace', 'full']);

const clone = value => JSON.parse(JSON.stringify(value));
const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_WORK_POLICY' }); };
const integer = (value, label, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} 必须是 ${min} 到 ${max} 的整数`);
  return value;
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须为对象`);
  return value;
};
const onlyKeys = (value, allowed, label) => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail(`${label} 包含未知字段：${unknown.join('、')}`);
};
const stringList = (value, label, max = 50) => {
  if (!Array.isArray(value) || value.length > max) fail(`${label} 必须是不重复的字符串数组`);
  for (const item of value) if (typeof item !== 'string' || !item.trim() || item.length > 200) fail(`${label} 包含无效条目`);
  const result = value.map(item => item.trim());
  if (new Set(result).size !== result.length) fail(`${label} 必须是不重复的字符串数组`);
  return result;
};
const normalizedList = (value, label, max, normalize) => {
  const result = stringList(value, label, max).map(normalize);
  if (new Set(result).size !== result.length) fail(`${label} 包含规范化后重复的条目`);
  return result;
};
const browserHost = value => {
  const raw = value.trim().toLowerCase().replace(/\.+$/, '');
  if (!raw || /[\s*\/@?#]/.test(raw) || raw.includes('://')) fail('browserHosts 包含无效主机');
  let parsed;
  try {
    const host = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw;
    parsed = new URL(`http://${host}`);
  } catch { fail('browserHosts 包含无效主机'); }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) fail('browserHosts 只能包含精确主机名');
  return parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
};
const githubRepo = value => {
  const repo = value.toLowerCase();
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repo)) fail('githubRepos 必须使用 owner/repo 格式');
  return repo;
};
// 额外可访问目录：必须是本机绝对路径，规范化后去掉结尾分隔符，避免同一目录写成两种样子。
const extraRoot = value => {
  const raw = value.trim();
  if (!raw || raw.length > 400 || raw.includes('\0')) fail('extraRoots 包含无效路径');
  if (!path.isAbsolute(raw)) fail(`extraRoots 必须是绝对路径：${raw}`);
  const resolved = path.resolve(raw);
  if (resolved === path.parse(resolved).root) fail('extraRoots 不能是磁盘根目录');
  return resolved;
};

export function defaultPolicy() { return clone(defaults); }

export function normalizePolicy(input = {}, base = defaults) {
  input = object(input, 'Work policy');
  onlyKeys(input, ['mode', 'permission', 'acceptMode', 'allowedExecutors', 'requireApproval', 'budgets', 'limits'], 'Work policy');
  if (input.mode !== undefined && input.mode !== 'personal') fail('mode 仅支持 personal');
  if (input.permission !== undefined && !PERMISSIONS.includes(input.permission)) fail('permission 仅支持 read、workspace、full');
  if (input.acceptMode !== undefined && !['auto', 'explicit'].includes(input.acceptMode)) fail('acceptMode 仅支持 auto、explicit');
  if (input.requireApproval !== undefined && typeof input.requireApproval !== 'boolean') fail('requireApproval 必须是布尔值');
  const permission = input.permission === undefined ? (base.permission || 'workspace') : input.permission;
  const allowedExecutors = input.allowedExecutors === undefined ? [...base.allowedExecutors] : stringList(input.allowedExecutors, 'allowedExecutors', 12);
  const unknown = allowedExecutors.filter(id => !['analysis', 'terminal', 'window', 'model', ...EXTERNAL_EXECUTORS].includes(id));
  if (unknown.length) fail(`未知执行器：${unknown.join('、')}`);
  const budgets = input.budgets === undefined ? clone(base.budgets) : object(input.budgets, 'budgets');
  if (input.budgets !== undefined) onlyKeys(budgets, ['maxConcurrent', 'maxCallsPerTicket', 'maxRuntimeMs', 'maxTokensPerTicket'], 'budgets');
  const limits = input.limits === undefined ? clone(base.limits) : object(input.limits, 'limits');
  if (input.limits !== undefined) onlyKeys(limits, ['browserHosts', 'githubRepos', 'acpWrites', 'modelWrites', 'extraRoots', 'confirmDanger'], 'limits');
  if (limits.acpWrites !== undefined && typeof limits.acpWrites !== 'boolean') fail('acpWrites 必须是布尔值');
  if (limits.modelWrites !== undefined && typeof limits.modelWrites !== 'boolean') fail('modelWrites 必须是布尔值');
  if (limits.confirmDanger !== undefined && typeof limits.confirmDanger !== 'boolean') fail('confirmDanger 必须是布尔值');
  const browserHosts = limits.browserHosts === undefined ? clone(base.limits.browserHosts) : normalizedList(limits.browserHosts, 'browserHosts', 50, browserHost);
  const githubRepos = limits.githubRepos === undefined ? clone(base.limits.githubRepos) : normalizedList(limits.githubRepos, 'githubRepos', 100, githubRepo);
  const extraRoots = limits.extraRoots === undefined ? clone(base.limits.extraRoots || []) : normalizedList(limits.extraRoots, 'extraRoots', 10, extraRoot);
  // 写权限由权限模式决定：仅查看时一律不给写，工作区/完全权限都给写。
  const acpWrites = permission !== 'read';
  const modelWrites = permission !== 'read';
  // 危险操作（递归删除、白名单外的命令等）只在「仅工作区内修改」下逐次询问。
  const confirmDanger = permission === 'workspace'
    ? (limits.confirmDanger === undefined ? base.limits?.confirmDanger !== false : limits.confirmDanger === true)
    : false;
  // 兼容旧字段：显式传 acpWrites/modelWrites 时以权限模式为准，避免出现「模式说只读、开关说可写」。
  return {
    mode: 'personal',
    permission,
    acceptMode: input.acceptMode === undefined ? (base.acceptMode === 'explicit' ? 'explicit' : 'auto') : input.acceptMode,
    allowedExecutors,
    requireApproval: input.requireApproval === undefined ? base.requireApproval === true : input.requireApproval === true,
    budgets: {
      maxConcurrent: integer(budgets.maxConcurrent ?? base.budgets.maxConcurrent, 'maxConcurrent', 1, 8),
      maxCallsPerTicket: integer(budgets.maxCallsPerTicket ?? base.budgets.maxCallsPerTicket, 'maxCallsPerTicket', 1, 50),
      maxRuntimeMs: integer(budgets.maxRuntimeMs ?? base.budgets.maxRuntimeMs, 'maxRuntimeMs', 1000, 86400000),
      maxTokensPerTicket: integer(budgets.maxTokensPerTicket ?? base.budgets.maxTokensPerTicket, 'maxTokensPerTicket', 1000, 10000000)
    },
    limits: {
      browserHosts,
      githubRepos,
      acpWrites,
      modelWrites,
      extraRoots,
      confirmDanger
    }
  };
}
