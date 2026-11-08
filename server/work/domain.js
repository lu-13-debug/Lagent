export const workError = (message, status = 400) => Object.assign(new Error(message), { status });
export const actions = new Set(['approve', 'reject', 'stop', 'retry', 'resume']);
const transitions = { approve:['awaiting_review'], reject:['awaiting_review'], stop:['queued','working','awaiting_review','blocked','waiting'], retry:['failed','cancelled','blocked'], resume:['waiting'] };
export function assertWorkAction(status, action) {
  if (!actions.has(action)) throw workError('未知工单操作');
  if (!transitions[action].includes(status)) throw workError('当前工单状态不支持此操作',409);
}
