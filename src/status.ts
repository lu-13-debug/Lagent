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
