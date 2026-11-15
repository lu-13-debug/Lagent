import { randomUUID } from 'node:crypto';

const text = value => typeof value === 'string' ? value.replace(/[\r\n]/g, '').slice(0, 200) : '';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const instant = value => {
  const d = new Date(typeof value === 'function' ? value() : value ?? Date.now());
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
};
const day = value => {
  const iso = instant(value);
  return iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10) : null;
};

export function usageEntry({ ticketId, executorId, projectId, calls, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, totalTokens, durationMs, costEstimate, model, source, now } = {}) {
  return {
    id: randomUUID(),
    ticketId: text(ticketId),
    executorId: text(executorId),
    projectId: text(projectId),
    model: text(model),
    source: text(source) || 'ticket',
    calls: integer(calls),
    tokensIn: integer(tokensIn),
    tokensOut: integer(tokensOut),
    cacheReadTokens: integer(cacheReadTokens),
    cacheWriteTokens: integer(cacheWriteTokens),
    totalTokens: integer(totalTokens),
    durationMs: integer(durationMs),
    costEstimate: number(costEstimate),
    recordedAt: instant(now)
  };
}

function extractUsage(task, executorId) {
  if (!task) return {};
  const cli = task.artifacts?.cli;
  if (cli?.usage && typeof cli.usage === 'object') {
    const u = cli.usage;
    return {
      tokensIn: integer(u.input_tokens ?? u.inputTokens),
      tokensOut: integer(u.output_tokens ?? u.outputTokens),
      cacheReadTokens: integer(u.cache_read_input_tokens ?? u.cacheReadInputTokens),
      cacheWriteTokens: integer(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens),
      totalTokens: integer(u.total_tokens ?? u.totalTokens ?? ((u.input_tokens ?? u.inputTokens) + (u.output_tokens ?? u.outputTokens))),
      durationMs: integer(u.duration_ms ?? u.durationMs),
      costEstimate: number(u.total_cost_usd ?? u.totalCostUsd),
      model: text(u.model)
    };
  }
  if (executorId === 'model' && task.report?.aiUsage) {
    const u = task.report.aiUsage;
    return {
      tokensIn: integer(u.inputTokens ?? u.input_tokens),
      tokensOut: integer(u.outputTokens ?? u.output_tokens),
      cacheReadTokens: integer(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
      cacheWriteTokens: integer(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
      totalTokens: integer(u.totalTokens ?? u.total_tokens ?? ((u.inputTokens ?? u.input_tokens) + (u.outputTokens ?? u.output_tokens))),
      durationMs: integer(u.durationMs ?? u.duration_ms),
      costEstimate: number(u.totalCostUsd ?? u.total_cost_usd),
      model: text(u.model)
    };
  }
  if (task.usage && typeof task.usage === 'object') {
    const u = task.usage;
    return {
      tokensIn: integer(u.inputTokens ?? u.input_tokens),
      tokensOut: integer(u.outputTokens ?? u.output_tokens),
      cacheReadTokens: integer(u.cacheReadInputTokens ?? u.cache_read_input_tokens),
      cacheWriteTokens: integer(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens),
      totalTokens: integer(u.totalTokens ?? u.total_tokens ?? ((u.inputTokens ?? u.input_tokens) + (u.outputTokens ?? u.output_tokens))),
      durationMs: integer(u.durationMs ?? u.duration_ms),
      costEstimate: number(u.totalCostUsd ?? u.total_cost_usd),
      model: text(u.model)
    };
  }
  return {};
}

export function recordTicketUsage(store, { ticket, assignment, task, executorId, projectId, now } = {}) {
  const usage = extractUsage(task, executorId);
  const entry = usageEntry({
    ticketId: ticket?.id,
    executorId: executorId || assignment?.executor,
    projectId: projectId || '',
    calls: 1,
    ...usage,
    now
  });
  store.put('work-usage', entry);
  return entry;
}

export function ticketTokensUsed(store, ticketId) {
  return store.list('work-usage')
    .filter(row => row.ticketId === ticketId)
    .reduce((sum, row) => sum + integer(row.totalTokens), 0);
}

export function checkTokenBudget(store, ticketId, budget) {
  if (!Number.isSafeInteger(budget) || budget <= 0) return { ok: true };
  const used = ticketTokensUsed(store, ticketId);
  if (used >= budget) return { ok: false, used, budget };
  return { ok: true, used, budget };
}

const counters = () => ({ calls: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, durationMs: 0, costEstimate: 0 });
function add(row, call) {
  row.calls += integer(call.calls);
  row.tokensIn += integer(call.tokensIn);
  row.tokensOut += integer(call.tokensOut);
  row.cacheReadTokens += integer(call.cacheReadTokens);
  row.cacheWriteTokens += integer(call.cacheWriteTokens);
  row.totalTokens += integer(call.totalTokens);
  row.durationMs += integer(call.durationMs);
  row.costEstimate += number(call.costEstimate);
}

export function summarizeUsage(store, { projectId, executorId, from, to, days = 30, now, budgetTokens, extraRows = [] } = {}) {
  const toDay = to || day(now ?? Date.now());
  const fromDay = from || (days === 'all' ? null : new Date(Date.parse(`${toDay}T00:00:00Z`) - (Number(days) - 1) * 86400000).toISOString().slice(0, 10));
  const inRange = date => date && date <= toDay && (!fromDay || date >= fromDay);
  const budget = Number.isSafeInteger(budgetTokens) && budgetTokens > 0 ? budgetTokens : null;
  const totals = counters();
  const maps = {
    byExecutor: new Map(),
    byProject: new Map(),
    byDay: new Map(),
    byTicket: new Map()
  };
  const rows = [...store.list('work-usage'), ...extraRows];
  for (const raw of rows) {
    if (projectId && raw.projectId !== projectId) continue;
    if (executorId && raw.executorId !== executorId) continue;
    const date = day(raw.recordedAt);
    if (!inRange(date)) continue;
    const call = { ...raw, totalTokens: integer(raw.totalTokens || raw.tokensIn + raw.tokensOut) };
    add(totals, call);
    if (!maps.byExecutor.has(call.executorId)) maps.byExecutor.set(call.executorId, { executorId: call.executorId, ...counters() });
    add(maps.byExecutor.get(call.executorId), call);
    const projectKey = call.projectId || '';
    if (!maps.byProject.has(projectKey)) maps.byProject.set(projectKey, { projectId: projectKey, ...counters() });
    add(maps.byProject.get(projectKey), call);
    if (!maps.byDay.has(date)) maps.byDay.set(date, { date, ...counters() });
    add(maps.byDay.get(date), call);
    if (call.ticketId) {
      if (!maps.byTicket.has(call.ticketId)) maps.byTicket.set(call.ticketId, { ticketId: call.ticketId, executorId: call.executorId, ...counters() });
      add(maps.byTicket.get(call.ticketId), call);
    }
  }
  const byTicket = [...maps.byTicket.values()]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 100)
    .map(row => budget
      ? { ...row, ratio: row.totalTokens / budget, warning: row.totalTokens >= budget * 0.8 }
      : row);
  const result = {
    range: { days, from: fromDay, to: toDay, timeZone: 'Asia/Shanghai' },
    totals,
    budget: budget
      ? {
          maxTokensPerTicket: budget,
          warningRatio: 0.8,
          warnings: byTicket.filter(row => row.warning).map(row => ({ ticketId: row.ticketId, used: row.totalTokens, ratio: row.ratio }))
        }
      : null,
    byExecutor: [...maps.byExecutor.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byProject: [...maps.byProject.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: [...maps.byDay.values()].sort((a, b) => b.date.localeCompare(a.date)),
    byTicket,
    // 一次请求里就能回答「哪里最贵」：按项目占比 + 今日用量 + 用量最大的会话。
    alerts: {
      cacheHitRate: totals.tokensIn + totals.cacheReadTokens > 0 ? totals.cacheReadTokens / (totals.tokensIn + totals.cacheReadTokens) : 0,
      topProject: [...maps.byProject.values()].sort((a, b) => b.totalTokens - a.totalTokens)[0] || null,
      topTicket: byTicket[0] || null,
      today: [...maps.byDay.values()].find(row => row.date === toDay) || null
    }
  };
  return result;
}
