export const workEnabled = options => options?.workEnabled === true || (options?.workEnabled === undefined && process.env.DATAAGENT_WORK_ENABLED === '1');

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
  'dsh'
]);
export const WORK_POLICY_ID = 'default';

const defaults = Object.freeze({
  mode: 'personal',
  acceptMode: 'explicit',
  allowedExecutors: Object.freeze(['analysis', 'terminal']),
  requireApproval: true,
  budgets: Object.freeze({ maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 200000 }),
  limits: Object.freeze({ browserHosts: Object.freeze([]), githubRepos: Object.freeze([]), acpWrites: true })
});

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

export function defaultPolicy() { return clone(defaults); }

export function normalizePolicy(input = {}, base = defaults) {
  input = object(input, 'Work policy');
  onlyKeys(input, ['mode', 'acceptMode', 'allowedExecutors', 'requireApproval', 'budgets', 'limits'], 'Work policy');
  if (input.mode !== undefined && input.mode !== 'personal') fail('mode 仅支持 personal');
  if (input.acceptMode !== undefined && input.acceptMode !== 'explicit') fail('acceptMode 仅支持 explicit');
  if (input.requireApproval !== undefined && input.requireApproval !== true) fail('requireApproval 必须为 true');
  const allowedExecutors = input.allowedExecutors === undefined ? [...base.allowedExecutors] : stringList(input.allowedExecutors, 'allowedExecutors', 12);
  const unknown = allowedExecutors.filter(id => !['analysis', 'terminal', 'window', ...EXTERNAL_EXECUTORS].includes(id));
  if (unknown.length) fail(`未知执行器：${unknown.join('、')}`);
  const budgets = input.budgets === undefined ? clone(base.budgets) : object(input.budgets, 'budgets');
  if (input.budgets !== undefined) onlyKeys(budgets, ['maxConcurrent', 'maxCallsPerTicket', 'maxRuntimeMs', 'maxTokensPerTicket'], 'budgets');
  const limits = input.limits === undefined ? clone(base.limits) : object(input.limits, 'limits');
  if (input.limits !== undefined) onlyKeys(limits, ['browserHosts', 'githubRepos', 'acpWrites'], 'limits');
  if (limits.acpWrites !== undefined && typeof limits.acpWrites !== 'boolean') fail('acpWrites 必须是布尔值');
  const browserHosts = limits.browserHosts === undefined ? clone(base.limits.browserHosts) : normalizedList(limits.browserHosts, 'browserHosts', 50, browserHost);
  const githubRepos = limits.githubRepos === undefined ? clone(base.limits.githubRepos) : normalizedList(limits.githubRepos, 'githubRepos', 100, githubRepo);
  const acpWrites = limits.acpWrites === undefined ? (base.limits?.acpWrites !== false) : limits.acpWrites === true;
  return {
    mode: 'personal',
    acceptMode: 'explicit',
    allowedExecutors,
    requireApproval: true,
    budgets: {
      maxConcurrent: integer(budgets.maxConcurrent ?? base.budgets.maxConcurrent, 'maxConcurrent', 1, 8),
      maxCallsPerTicket: integer(budgets.maxCallsPerTicket ?? base.budgets.maxCallsPerTicket, 'maxCallsPerTicket', 1, 50),
      maxRuntimeMs: integer(budgets.maxRuntimeMs ?? base.budgets.maxRuntimeMs, 'maxRuntimeMs', 1000, 86400000),
      maxTokensPerTicket: integer(budgets.maxTokensPerTicket ?? base.budgets.maxTokensPerTicket, 'maxTokensPerTicket', 1000, 10000000)
    },
    limits: {
      browserHosts,
      githubRepos,
      acpWrites
    }
  };
}

export function externalExecutorsEnabled(env = process.env) {
  return env.DATAAGENT_ALLOW_EXTERNAL_EXECUTORS === '1';
}

export function externalExecutorAllowed(id, policy, env = process.env) {
  if (!EXTERNAL_EXECUTORS.includes(id)) return true;
  return externalExecutorsEnabled(env) && policy.allowedExecutors.includes(id);
}
