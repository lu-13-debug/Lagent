// 工单模型的规则层：状态、合法动作与错误类型。
// 原来的 server/work/domain.js 保留为 re-export，现有 import 不受影响。

export const workError = (message, status = 400) => Object.assign(new Error(message), { status });
// 外部命令（Git / Claude Code）的失败信息是给用户看的，5xx 也应原样返回；
// 其余 5xx 继续走「敏感细节已隐藏」。
export const exposedWorkError = (message, status = 502) => Object.assign(workError(message, status), { expose: true });

export const actions = new Set(['approve', 'reject', 'stop', 'retry', 'resume', 'skip']);

// 每个动作允许从哪些状态进入。审批只能在待审时发生；跳过留给「这一步卡死」的计划。
const transitions = {
  approve: ['awaiting_review'],
  reject: ['awaiting_review'],
  stop: ['queued', 'working', 'awaiting_review', 'blocked', 'waiting'],
  retry: ['failed', 'cancelled', 'blocked'],
  resume: ['waiting'],
  skip: ['failed', 'blocked', 'waiting', 'cancelled']
};

export function assertWorkAction(status, action) {
  if (!actions.has(action)) throw workError('未知工单操作');
  if (!transitions[action].includes(status)) throw workError('当前工单状态不支持此操作', 409);
}
