// 全站统一的状态词与「未结束」判定。
// 目标只有六类：排队中 / 执行中 / 需要你 / 已完成 / 已停止 / 失败。
// 原始状态仍保留在后端与审计里，界面只做展示映射。
export const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  pending: '排队中',
  waiting: '排队中',
  running: '执行中',
  working: '执行中',
  verifying: '执行中',
  repairing: '执行中',
  awaiting_review: '需要你',
  blocked: '需要你',
  completed: '已完成',
  cancelled: '已停止',
  interrupted: '已停止',
  failed: '失败'
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  drafting: '分析中',
  awaiting_approval: '需要你',
  running: '执行中',
  verifying: '执行中',
  repairing: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
  interrupted: '已停止',
  paused: '已暂停'
};

export const RUN_STEP_LABELS: Record<string, string> = {
  pending: '排队中',
  waiting: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过'
};

// 工单还在推进：这些状态需要轮询，别把它当历史记录。
export const ACTIVE_TICKET_STATUS = new Set(['queued', 'working', 'awaiting_review', 'waiting', 'pending', 'running']);
