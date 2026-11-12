// Agent 档案（roster）：把「探测到的程序」升级成「可路由的同事」。
// 只聚合已有数据（agents + tickets + work-usage），不引入新的状态存储。
const FINISHED = new Set(['completed', 'failed', 'blocked', 'cancelled']);

const bestForOf = capabilities => {
  const has = capability => capabilities.includes(capability);
  if (has('commands') || has('terminal')) return '验证与命令';
  if (has('code') || has('writes')) return '实现与修复';
  if (has('browser')) return '网页读取';
  if (has('github')) return '仓库与代码检索';
  if (has('window')) return '桌面协作';
  if (has('data analysis') || has('reports')) return '数据分析';
  if (has('read') || has('reads')) return '调研与阅读';
  return '通用任务';
};

const healthOf = agent => {
  if (agent.status === 'available') return 'available';
  if (agent.status === 'needs_setup' || agent.status === 'needs_auth') return 'needs_setup';
  return 'unavailable';
};

/**
 * @param {object} input
 * @param {Array} input.agents 执行器 bootstrap 投影 [{id,name,kind,status,capabilities}]
 * @param {Array} input.tickets 工单（公开投影即可）
 * @param {Array} input.usage work-usage 行
 * @param {object} input.policy 当前策略
 */
export function buildRoster({ agents = [], tickets = [], usage = [], policy = null } = {}) {
  const byExecutor = new Map();
  for (const row of usage) {
    const key = row.executorId || '';
    if (!key) continue;
    if (!byExecutor.has(key)) byExecutor.set(key, { calls: 0, tokens: 0, durationMs: 0, cost: 0 });
    const entry = byExecutor.get(key);
    entry.calls += Number.isSafeInteger(row.calls) ? row.calls : 1;
    entry.tokens += Number.isSafeInteger(row.totalTokens) ? row.totalTokens : 0;
    entry.durationMs += Number.isSafeInteger(row.durationMs) ? row.durationMs : 0;
    entry.cost += Number.isFinite(row.costEstimate) ? row.costEstimate : 0;
  }

  const ticketsByExecutor = new Map();
  for (const ticket of tickets) {
    const key = ticket.executor || '';
    if (!key) continue;
    if (!ticketsByExecutor.has(key)) ticketsByExecutor.set(key, []);
    ticketsByExecutor.get(key).push(ticket);
  }

  const allowed = new Set(Array.isArray(policy?.allowedExecutors) ? policy.allowedExecutors : []);
  return agents.map(agent => {
    const history = ticketsByExecutor.get(agent.id) || [];
    const finished = history.filter(ticket => FINISHED.has(ticket.status));
    const succeeded = finished.filter(ticket => ticket.status === 'completed').length;
    const failed = finished.filter(ticket => ['failed', 'blocked'].includes(ticket.status)).length;
    const usageRow = byExecutor.get(agent.id) || { calls: 0, tokens: 0, durationMs: 0, cost: 0 };
    const lastUsedAt = history.reduce((latest, ticket) => {
      const stamp = ticket.updatedAt || ticket.createdAt || '';
      return stamp > latest ? stamp : latest;
    }, '');
    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      health: healthOf(agent),
      capabilities: Array.isArray(agent.capabilities) ? [...agent.capabilities] : [],
      permissions: {
        allowed: allowed.size === 0 ? true : allowed.has(agent.id),
        mode: policy?.permission || 'workspace'
      },
      costProfile: {
        calls: usageRow.calls,
        avgTokens: usageRow.calls ? Math.round(usageRow.tokens / usageRow.calls) : 0,
        totalTokens: usageRow.tokens,
        avgDurationMs: usageRow.calls ? Math.round(usageRow.durationMs / usageRow.calls) : 0,
        costEstimate: Math.round(usageRow.cost * 10000) / 10000
      },
      reliability: {
        finished: finished.length,
        succeeded,
        failed,
        successRate: finished.length ? Math.round((succeeded / finished.length) * 100) / 100 : null,
        lastStatus: history[0]?.status || null
      },
      bestFor: bestForOf(Array.isArray(agent.capabilities) ? agent.capabilities : []),
      lastUsedAt: lastUsedAt || null
    };
  }).sort((left, right) => {
    const health = { available: 0, needs_setup: 1, unavailable: 2 };
    return (health[left.health] ?? 3) - (health[right.health] ?? 3)
      || (right.reliability.finished - left.reliability.finished)
      || String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || ''));
  });
}
