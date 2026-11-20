// 工单的对外投影：把执行输入、审批快照等控制字段剥掉，只留界面需要的内容。
// 纯函数，不读存储；调用方负责传入原始记录。
export const publicTicket = ({
  clientRequestId, command, lastAction, datasetId, useAI, approvalSnapshot,
  executorInput, artifacts, prompt, parentTicketId, chainRootId, handoffDepth,
  handoffSummary, handoffChildId, planId, planStep, planTotal, origin, ...ticket
}) => ({
  ...ticket,
  datasetId: datasetId ?? null,
  parentTicketId: parentTicketId ?? null,
  chainRootId: chainRootId ?? null,
  handoffDepth: Number.isSafeInteger(handoffDepth) && handoffDepth > 0 ? handoffDepth : 0,
  handoffSummary: typeof handoffSummary === 'string' ? handoffSummary.slice(0, 400) : null,
  handoffChildId: handoffChildId ?? null,
  planId: typeof planId === 'string' ? planId : null,
  planStep: Number.isSafeInteger(planStep) ? planStep : null,
  planTotal: Number.isSafeInteger(planTotal) ? planTotal : null,
  preview: ticket.preview && typeof ticket.preview === 'object' ? ticket.preview : null,
  verify: ticket.verify && typeof ticket.verify === 'object' ? ticket.verify : null,
  acceptance: ticket.acceptance && typeof ticket.acceptance === 'object' ? ticket.acceptance : null,
  contract: ticket.contract && typeof ticket.contract === 'object' ? ticket.contract : null,
  handoff: ticket.handoff && typeof ticket.handoff === 'object' ? ticket.handoff : null
});
