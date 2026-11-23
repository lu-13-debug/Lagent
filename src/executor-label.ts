// 执行器显示名的唯一静态兜底表。
// 页面应优先用 /api/work/bootstrap 返回的 agents[].name；这张表只负责离线、首帧和旧数据。
export const EXECUTOR_LABELS: Record<string, string> = {
  analysis: '数据分析',
  terminal: '受控终端',
  browser: '浏览器',
  github: 'GitHub',
  window: '窗口 Agent',
  model: 'Lagent',
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  'claude-acp': 'Claude ACP',
  'codex-acp': 'Codex ACP',
  'dsh-acp': 'DSH ACP',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  'cursor-agent': 'Cursor Agent',
  dsh: 'DSH CLI',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  iflow: 'iFlow',
  kimi: 'Kimi CLI',
  workbuddy: 'WorkBuddy',
  manual: '人工补录'
};

// 本机执行节点的执行器 id 形如 node-1a2b3c4d-claude-code；显示名和图标要退回它对应的那个 Agent。
export const NODE_EXECUTOR_PREFIX = /^node-[a-z0-9]{1,8}-/;
export const baseExecutorId = (id: string) => id.replace(NODE_EXECUTOR_PREFIX, '');

export function executorLabel(id: string, agents?: { id: string; name?: string }[]): string {
  if (!id) return '';
  const named = agents?.find(agent => agent.id === id)?.name;
  return named || EXECUTOR_LABELS[id] || EXECUTOR_LABELS[baseExecutorId(id)] || id;
}
