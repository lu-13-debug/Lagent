// 计划的对外投影：步骤状态来自工单，调用方通过 ticketOf 提供查询，避免内层直接碰存储。
export const publicPlan = (plan, ticketOf = () => null) => ({
  id: plan.id,
  goal: plan.goal,
  status: plan.status,
  autoRun: plan.autoRun === true,
  currentStep: plan.currentStep,
  totalSteps: plan.steps.length,
  projectChatId: typeof plan.projectChatId === 'string' ? plan.projectChatId : null,
  projectId: typeof plan.projectId === 'string' ? plan.projectId : null,
  steps: plan.steps.map(step => {
    const ticket = ticketOf(step.ticketId);
    return {
      index: step.index,
      ticketId: step.ticketId,
      executorId: step.executorId,
      title: step.title,
      status: ticket?.status || 'missing',
      dependsOn: Array.isArray(step.dependsOn) ? [...step.dependsOn] : [],
      ...(typeof step.role === 'string' && step.role ? { role: step.role } : {}),
      ...(Array.isArray(step.scope) && step.scope.length ? { scope: [...step.scope] } : {}),
      ...(step.compensate ? { compensate: { ...step.compensate } } : {}),
      ...(ticket?.preview ? { preview: ticket.preview } : {}),
      ...(ticket?.verify ? { verify: ticket.verify } : {}),
      ...(ticket?.acceptance ? { acceptance: ticket.acceptance } : {}),
      ...(ticket?.contract ? { contract: ticket.contract } : {}),
      projectChatId: ticket?.projectChatId || step.projectChatId || null
    };
  }),
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt
});
