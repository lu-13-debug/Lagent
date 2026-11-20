// 命令规则的唯一来源：同一张表既决定「要不要问」（action），也决定「算哪一档」（level）。
// 以前规则表与 command-risk 的三张名单各维护一份，新增规则很容易只改一侧；
// 现在 classifyCommand 直接从 COMMAND_RULES 推导等级。
// 动作含义：
//   stop      直接拒绝，不进入执行器
//   ask       弹窗确认（即使用户开了完全权限，也不静默执行）
//   rewrite   换成更安全的等价写法后继续
//   llm_check 语义模糊，交给调用方标记为「需人工判断」，按 ask 处理
//   allow     只参与分级，不参与审批弹窗
const pathLike = /(?:^|[\s"'`])(?:[A-Za-z]:[\\/]|\/|~[\\/])/;

const rule = (id, action, reason, test, extra = {}) => Object.freeze({ id, event: 'command', action, reason, test, policy: true, ...extra });
// 只用于分级、不产生审批动作的规则。
const level = (id, value, reason, test) => rule(id, 'allow', reason, test, { policy: false, level: value });

export const COMMAND_RULES = Object.freeze([
  // ── 直接阻断 ─────────────────────────────────────────────
  rule('root-delete', 'stop', '递归删除根目录或家目录', command => /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$HOME)(?:\s|$)/.test(command), { level: 'blocked' }),
  rule('disk-format', 'stop', '格式化磁盘', command => /\b(?:mkfs|mke2fs|format(?:\.com)?)\b/i.test(command), { level: 'blocked' }),
  rule('raw-device-write', 'stop', '直接写块设备', command => /\bdd\s+[^|]*\bof=\/dev\//i.test(command), { level: 'blocked' }),
  rule('power-control', 'stop', '关机或重启', command => /\b(?:shutdown|reboot|poweroff|halt)\b/i.test(command), { level: 'blocked' }),
  rule('diskpart', 'stop', '磁盘分区工具', command => /\bdiskpart\b/i.test(command), { level: 'blocked' }),
  rule('drive-root-delete', 'stop', '删除盘符根目录', command => /\b(?:del\s+(?:\/[a-z]\s+)*[a-z]:\\?(?:\s|$)|rd\s+\/s\s+\/q\s+[a-z]:\\?(?:\s|$))/i.test(command), { level: 'blocked' }),
  rule('fork-bomb', 'stop', 'fork bomb', command => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command), { level: 'blocked' }),
  rule('download-exec', 'stop', '下载后直接执行远程脚本', command => /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(?:sh|bash|zsh|powershell|pwsh|iex)\b/i.test(command), { level: 'blocked' }),
  rule('encoded-powershell', 'stop', '编码后的 PowerShell 命令无法审查', command => /-enc(?:odedcommand)?\s+[A-Za-z0-9+/=]{20,}/i.test(command), { level: 'blocked' }),
  rule('secret-write', 'stop', '写入凭据或密钥目录', command => /(?:>|>>|set-content|out-file|add-content)[^;|]*(?:\.env|\.ssh[\\/]|id_rsa|credentials)/i.test(command), { level: 'blocked' }),
  rule('db-destructive', 'stop', '删除数据库或表', command => /\b(?:drop\s+(?:table|database)|truncate\s+table)\b/i.test(command), { level: 'blocked' }),
  // PowerShell 动态执行按阻断处理；eval 等其它形式只要求人工判断。
  level('dynamic-exec-blocked', 'blocked', '动态执行字符串', command => /\b(?:invoke-expression|iex)\s*[\(`]/i.test(command)),

  // ── 需要确认 / 危险 ──────────────────────────────────────
  rule('force-push', 'rewrite', '强制推送会覆盖远端历史，已改为 force-with-lease', command => /\bgit\s+push\b[^;|]*\s(?:--force|-f)\b/i.test(command), { level: 'danger', rewrite: command => command.replace(/(--force|-f)\b/g, '--force-with-lease') }),
  rule('reset-hard', 'ask', '丢弃未提交改动的操作需要确认', command => /\bgit\s+reset\s+--hard\b/i.test(command), { level: 'danger' }),
  rule('clean-force', 'ask', '删除未跟踪文件的操作需要确认', command => /\bgit\s+clean\s+-[a-z]*f/i.test(command), { level: 'danger' }),
  rule('secret-read', 'ask', '读取凭据或密钥需要确认', command => /(?:^|[\s;|])(?:cat|type|get-content|more|less)\b[^;|]*(?:\.env|\.ssh[\\/]|id_rsa|credentials)/i.test(command), { level: 'danger' }),
  rule('privilege-change', 'ask', '提权或修改系统权限需要确认', command => /\b(?:sudo|runas|takeown|icacls|reg\s+delete)\b/i.test(command), { level: 'danger' }),
  rule('package-publish', 'ask', '发布包或镜像会对外产生副作用', command => /\b(?:npm\s+publish|yarn\s+publish|pnpm\s+publish|docker\s+push|cargo\s+publish|twine\s+upload)\b/i.test(command), { level: 'write' }),
  rule('mass-delete', 'ask', '批量删除需要确认范围', command => /(?:^|[\s;|])(?:find\b[^;|]*-delete|\bdel\s+(?:\/[a-z]\s+)*\/[sq]\b|\brd\s+\/s\b|\brm\s+-r\b)/i.test(command), { level: 'danger' }),
  rule('dynamic-exec', 'llm_check', '动态执行字符串无法静态判断内容', command => /\b(?:eval|invoke-expression|iex)\s*[\(`"']/i.test(command), { level: 'danger', review: true }),
  rule('wildcard-write', 'llm_check', '通配符写入可能影响工作区外文件', command => pathLike.test(command) && /(?:\*|\?)/.test(command) && /(?:>|>>|set-content|remove-item|rm\s)/i.test(command), { level: 'danger', review: true }),

  // ── 删除类分级（审批动作由上面的规则覆盖）────────────────
  level('recursive-delete', 'danger', '递归或强制删除', command => /\brm\s+-[a-zA-Z]*[rf]/i.test(command)),
  level('remove-item-recurse', 'danger', '递归或强制删除（PowerShell）', command => /\bremove-item\b[^;|]*\s-(?:recurse|force)\b/i.test(command)),
  level('permission-recursive', 'danger', '递归修改权限或属主', command => /\b(?:chmod|chown)\s+-R\b/i.test(command)),
  level('force-kill', 'danger', '强制结束进程', command => /\b(?:taskkill|stop-process)\b[^;|]*\s-(?:f|force)\b|\btaskkill\b[^;|]*\/f\b/i.test(command)),
  level('protected-path', 'danger', '触碰受保护路径', command => /(?:^|[\s;|])(?:\.git|\.ssh|\.env)\b/i.test(command)),

  // ── 写入 ────────────────────────────────────────────────
  level('redirect-write', 'write', '重定向写入', command => /(?:^|[^<])>{1,2}(?!&)/.test(command)),
  level('powershell-write', 'write', 'PowerShell 写入', command => /\b(?:set-content|out-file|add-content|new-item|tee-object)\b/i.test(command)),
  level('file-write', 'write', '文件写入或复制', command => /\b(?:tee|mkdir|touch|cp|copy|mv|move|cpio|tar\s+-x)\b/i.test(command)),
  level('git-state', 'write', '修改版本库状态', command => /\bgit\s+(?:add|commit|merge|rebase|checkout|switch|stash|cherry-pick|apply)\b/i.test(command)),
  level('node-deps', 'write', '安装或发布依赖', command => /\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|publish)\b/i.test(command)),
  level('python-deps', 'write', '安装或移除 Python 依赖', command => /\b(?:pip|pip3|poetry|uv)\s+(?:install|add|remove|uninstall)\b/i.test(command)),
  level('other-deps', 'write', '安装依赖', command => /\b(?:go\s+get|cargo\s+(?:add|install)|dotnet\s+add)\b/i.test(command)),

  // ── 只读（按段匹配，全部命中才算只读）───────────────────
  level('read-git', 'read', '只读 git 命令', command => /^(?:git\s+(?:status|diff|log|show|rev-parse|ls-files|describe|shortlog)\b)/i.test(command)),
  level('read-shell', 'read', '只读 shell 命令', command => /^(?:ls|dir|pwd|cat|type|head|tail|wc|find|grep|rg|which|where|echo)\b/i.test(command)),
  level('read-powershell', 'read', '只读 PowerShell 命令', command => /^(?:get-childitem|get-content|get-item|get-location|test-path|resolve-path|select-string)\b/i.test(command)),
  level('read-version', 'read', '只读版本查询', command => /^(?:node\s+--version|npm\s+--version|python\s+--version|go\s+version)\b/i.test(command)),
  level('read-npm', 'read', '只读 npm 脚本', command => /^(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|coverage)))\b/i.test(command)),
  level('read-test', 'read', '只读测试命令', command => /^(?:node\s+--test|pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test)\b/i.test(command))
]);

const ORDER = Object.freeze({ stop: 5, rewrite: 4, ask: 3, llm_check: 2, allow: 0 });

/**
 * 规则表求值。返回命中动作最严格的一条；未命中返回 allow。
 * 只做字符串匹配，不做 shell 解析，目标是把明显危险的动作挡在启动之前。
 */
export function evaluateCommandPolicy(command, { approved = false } = {}) {
  const value = String(command || '').trim();
  if (!value) return { action: 'allow', ruleId: '', reason: '', command: value };
  let best = { action: 'allow', ruleId: '', reason: '', command: value };
  for (const item of COMMAND_RULES) {
    if (!item.policy) continue;
    if (!item.test(value)) continue;
    if (ORDER[item.action] <= ORDER[best.action] && best.action !== 'allow') continue;
    const rewritten = item.action === 'rewrite' && typeof item.rewrite === 'function' ? item.rewrite(value) : value;
    best = {
      action: item.action,
      ruleId: item.id,
      reason: item.reason,
      command: rewritten,
      ...(item.review ? { requiresReview: true } : {})
    };
  }
  // 已经人工确认过的命令不再重复要求确认，但 stop 不受影响。
  if (approved && best.action === 'ask') return { ...best, action: 'allow', confirmed: true };
  return best;
}

export function ruleSummary() {
  return COMMAND_RULES.filter(item => item.policy).map(({ id, action, reason }) => ({ id, action, reason }));
}
