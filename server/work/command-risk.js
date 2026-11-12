// 命令风险分类：给 shell 命令一个粗粒度等级，用于审批与阻断。
// 不追求完整解析 shell；规则偏好「宁可多问一次」。
const BLOCKED = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(?:\/|~|\$HOME)(?:\s|$)/i, reason: '递归删除根目录/家目录' },
  { pattern: /\b(?:mkfs|mke2fs|format(?:\.com)?)\b/i, reason: '格式化磁盘' },
  { pattern: /\bdd\s+[^|]*\bof=\/dev\//i, reason: '直接写块设备' },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i, reason: '关机/重启' },
  { pattern: /\bdiskpart\b/i, reason: '磁盘分区工具' },
  { pattern: /\bdel\s+(?:\/[a-z]\s+)*[a-z]:\\?(?:\s|$)/i, reason: '删除盘符根目录' },
  { pattern: /\brd\s+\/s\s+\/q\s+[a-z]:\\?(?:\s|$)/i, reason: '递归删除盘符根目录' },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  { pattern: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(?:sh|bash|zsh|powershell|pwsh|iex)\b/i, reason: '下载后直接执行远程脚本' },
  { pattern: /\b(?:invoke-expression|iex)\s*[\(`]/i, reason: '动态执行字符串' },
  { pattern: /-enc(?:odedcommand)?\s+[A-Za-z0-9+/=]{20,}/i, reason: '编码后的 PowerShell 命令' }
];

const DANGER = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)/i, reason: '递归/强制删除' },
  { pattern: /\b(?:del|erase)\s+(?:\/[a-z]\s+)*\/[sq]\b/i, reason: '静默/递归删除' },
  { pattern: /\b(?:rd|rmdir)\s+\/s\b/i, reason: '递归删除目录' },
  { pattern: /\bremove-item\b[^;|]*\s-(?:recurse|force)\b/i, reason: '递归/强制删除（PowerShell）' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: '丢弃未提交改动' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: '删除未跟踪文件' },
  { pattern: /\bgit\s+push\b[^;|]*\s(?:--force|-f)\b/i, reason: '强制推送' },
  { pattern: /\b(?:chmod|chown)\s+-R\b/i, reason: '递归修改权限/属主' },
  { pattern: /\b(?:sudo|runas|takeown|icacls|reg\s+delete)\b/i, reason: '提权或修改系统权限' },
  { pattern: /\b(?:taskkill|stop-process)\b[^;|]*\s-(?:f|force)\b|\btaskkill\b[^;|]*\/f\b/i, reason: '强制结束进程' },
  { pattern: /(?:^|[\s;|])(?:\.git|\.ssh|\.env)\b/i, reason: '触碰受保护路径' }
];

const WRITE = [
  { pattern: /(?:^|[^<])>{1,2}(?!&)/, reason: '重定向写入' },
  { pattern: /\b(?:set-content|out-file|add-content|new-item|tee-object)\b/i, reason: 'PowerShell 写入' },
  { pattern: /\b(?:tee|mkdir|touch|cp|copy|mv|move|cpio|tar\s+-x)\b/i, reason: '文件写入/复制' },
  { pattern: /\bgit\s+(?:add|commit|merge|rebase|checkout|switch|stash|cherry-pick|apply)\b/i, reason: '修改版本库状态' },
  { pattern: /\b(?:npm|pnpm|yarn)\s+(?:install|add|remove|uninstall|publish)\b/i, reason: '安装/发布依赖' },
  { pattern: /\b(?:pip|pip3|poetry|uv)\s+(?:install|add|remove|uninstall)\b/i, reason: '安装/移除 Python 依赖' },
  { pattern: /\b(?:go\s+get|cargo\s+(?:add|install)|dotnet\s+add)\b/i, reason: '安装依赖' }
];

const READ = [
  /^(?:git\s+(?:status|diff|log|show|rev-parse|ls-files|describe|shortlog)\b)/i,
  /^(?:ls|dir|pwd|cat|type|head|tail|wc|find|grep|rg|which|where|echo)\b/i,
  /^(?:get-childitem|get-content|get-item|get-location|test-path|resolve-path|select-string)\b/i,
  /^(?:node\s+--version|npm\s+--version|python\s+--version|go\s+version)\b/i,
  /^(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check|coverage)))\b/i,
  /^(?:node\s+--test|pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test)\b/i
];

function firstMatch(list, value) {
  for (const rule of list) if (rule.pattern.test(value)) return rule.reason;
  return '';
}

/**
 * @returns {{level:'read'|'write'|'danger'|'blocked', reasons:string[]}}
 */
export function classifyCommand(command) {
  const value = String(command || '').trim();
  if (!value) return { level: 'read', reasons: [] };

  const blocked = firstMatch(BLOCKED, value);
  if (blocked) return { level: 'blocked', reasons: [blocked] };

  const reasons = [];
  const danger = firstMatch(DANGER, value);
  if (danger) reasons.push(danger);

  const write = firstMatch(WRITE, value);
  if (write) reasons.push(write);

  if (danger) return { level: 'danger', reasons };
  if (write) return { level: 'write', reasons };

  // 分号/管道按段判断：每段都是只读才算只读。
  const segments = value.split(/[;|]/).map(part => part.trim()).filter(Boolean);
  if (segments.length && segments.every(segment => READ.some(pattern => pattern.test(segment)))) {
    return { level: 'read', reasons: [] };
  }
  return { level: 'write', reasons: ['未识别的命令，按写入处理'] };
}

export function isBlockedCommand(command) {
  return classifyCommand(command).level === 'blocked';
}
