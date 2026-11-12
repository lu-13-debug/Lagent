// 把多步计划投影成与编排 run 相同的形状，前端只需要认一种「运行」。
// 注意：这只是投影，不改存储；plan 仍是计划的真相，run 仍是编排的真相。
const RUN_STATUS_BY_PLAN = Object.freeze({
  active: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled'
});

const STEP_STATUS_BY_TICKET = Object.freeze({
  completed: 'done',
  failed: 'failed',
  blocked: 'failed',
  cancelled: 'skipped',
  working: 'running',
  queued: 'pending',
  awaiting_review: 'pending',
  waiting: 'pending',
  missing: 'pending',
  pending: 'pending'
});

export function planStepToRunStep(step = {}) {
  return {
    index: Number.isSafeInteger(step.index) ? step.index : 0,
    role: typeof step.title === 'string' && step.title ? step.title : `步骤 ${(step.index ?? 0) + 1}`,
    need: {},
    executorId: step.executorId || null,
    ticketId: step.ticketId || null,
    status: STEP_STATUS_BY_TICKET[step.status] || 'pending',
    summary: '',
    ...(Array.isArray(step.dependsOn) && step.dependsOn.length ? { dependsOn: [...step.dependsOn] } : {}),
    ...(Array.isArray(step.scope) && step.scope.length ? { scope: [...step.scope] } : {})
  };
}

/**
 * plan 的公共投影（engine.getPlan/listPlans 的输出）→ 统一 Run。
 * 只补齐前端需要的字段；不伪造编排器独有的 board/digest。
 */
export function planToRun(plan = {}) {
  const status = RUN_STATUS_BY_PLAN[plan.status] || 'running';
  const terminal = ['completed', 'failed', 'cancelled'].includes(status);
  return {
    id: plan.id,
    kind: 'plan',
    goal: typeof plan.goal === 'string' ? plan.goal : '',
    projectId: typeof plan.projectId === 'string' ? plan.projectId : null,
    chatId: typeof plan.projectChatId === 'string' ? plan.projectChatId : null,
    templateId: 'plan',
    templateLabel: '多步计划',
    confidence: 1,
    status,
    createdAt: plan.createdAt || '',
    updatedAt: plan.updatedAt || '',
    endedAt: terminal ? plan.updatedAt || '' : null,
    rounds: 0,
    maxRounds: 2,
    steps: Array.isArray(plan.steps) ? plan.steps.map(planStepToRunStep) : [],
    board: [],
    digest: '',
    error: null
  };
}

/** 编排 run 补上 kind，前端不用判断有没有这个字段。 */
export function taggedRun(run) {
  return run && typeof run === 'object' ? { ...run, kind: run.kind || 'orchestrator' } : run;
}

export function mergeRuns(orchestratorRuns = [], planRuns = [], limit = 20) {
  const rows = [...orchestratorRuns.map(taggedRun), ...planRuns.map(planToRun)];
  return rows
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, limit);
}
