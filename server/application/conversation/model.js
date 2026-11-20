// 会话的纯规则层：Lagent 永远是主控，外部 Agent 只能作为协作方。
// 这一层不碰数据库、网络或进程环境，方便引擎、路由和测试共用同一套判定。

export const LAGENT_EXECUTOR_ID = 'model';
export const LAGENT_DISPLAY_NAME = 'Lagent';
export const MAX_COLLABORATORS = 3;
export const MAX_TURN_AGENTS = MAX_COLLABORATORS + 1;
export const CONVERSATION_ROLES = Object.freeze(['answer', 'synthesis', 'step', 'coordination']);

const AGENT_ID = /^[A-Za-z0-9._:-]{1,60}$/;

/** 过滤出格式合法的 Agent id。 */
export function normalizeAgentId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return AGENT_ID.test(id) ? id : '';
}

/**
 * 会话里所有参与者都从 Lagent 开始：外部 Agent 可以增减，但主控不能被移除。
 * 返回新数组，不修改入参。
 */
export function normalizeManagedAgents(input) {
  const requested = Array.isArray(input) ? input : [];
  const collaborators = [];
  for (const item of requested) {
    const id = normalizeAgentId(item);
    if (!id || id === LAGENT_EXECUTOR_ID || collaborators.includes(id)) continue;
    collaborators.push(id);
    if (collaborators.length >= MAX_COLLABORATORS) break;
  }
  return [LAGENT_EXECUTOR_ID, ...collaborators];
}

/** 只保留协作 Agent（去掉主控），用于展示与存储 collaborators。 */
export function collaboratorsOf(input) {
  return normalizeManagedAgents(input).filter(id => id !== LAGENT_EXECUTOR_ID);
}

/**
 * Lagent 是否可接手这一轮：只检查模型是否配置可用，不把「策略白名单」当成可关闭项。
 * code 会被路由原样透出，前端据此给出「去设置模型」的入口。
 */
export function lagentReadiness({ configured = false, available = false } = {}) {
  if (!configured) {
    return {
      ready: false,
      configured: false,
      code: 'LAGENT_MODEL_NOT_CONFIGURED',
      reason: 'Lagent 尚未配置模型。请到「设置 → 模型与 API」配置后重试；外部 Agent 不能绕过 Lagent 主控。'
    };
  }
  if (!available) {
    return {
      ready: false,
      configured: true,
      code: 'LAGENT_MODEL_UNAVAILABLE',
      reason: 'Lagent 的模型当前不可用，请检查网络、额度或模型配置后重试。'
    };
  }
  return { ready: true, configured: true, code: '', reason: '' };
}

/**
 * 执行器是否可用：Lagent 不受 allowedExecutors 开关限制，避免用户误关主控；
 * 其余执行器仍按策略白名单判定。外部执行器的总开关由 work/policy.js 负责。
 */
export function isExecutorAllowed(policy, executorId) {
  if (executorId === LAGENT_EXECUTOR_ID) return true;
  return Boolean(policy && Array.isArray(policy.allowedExecutors) && policy.allowedExecutors.includes(executorId));
}

/**
 * 一轮受管任务需要哪些角色：
 * - 只有 Lagent：直接作答，不再多造协调/汇总步骤；
 * - Lagent + 协作 Agent：Lagent 分工 → 协作方执行 → Lagent 汇总；
 * - 计划模式仍由 Lagent 先拆步骤。
 * 返回的 steps 只描述角色语义，具体执行器由引擎决定。
 */
export function managedTurnShape({ mode = 'auto', collaborators = [] } = {}) {
  const list = (Array.isArray(collaborators) ? collaborators : [])
    .filter(id => id && id !== LAGENT_EXECUTOR_ID)
    .slice(0, MAX_COLLABORATORS);
  if (!list.length) return { kind: 'direct', collaborators: [] };
  if (mode === 'plan') return { kind: 'plan', collaborators: list };
  return { kind: 'coordinated', collaborators: list };
}
