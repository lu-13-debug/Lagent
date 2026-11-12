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

export function usageEntry({ ticketId, executorId, projectId, calls, tokensIn, tokensOut, totalTokens, durationMs, costEstimate, now } = {}) {
  return {
    id: randomUUID(),
    ticketId: text(ticketId),
    executorId: text(executorId),
    projectId: text(projectId),
    calls: integer(calls),
    tokensIn: integer(tokensIn),
    tokensOut: integer(tokensOut),
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
      totalTokens: integer(u.total_tokens ?? u.totalTokens ?? ((u.input_tokens ?? u.inputTokens) + (u.output_tokens ?? u.outputTokens))),
      durationMs: integer(u.duration_ms ?? u.durationMs),
      costEstimate: number(u.total_cost_usd ?? u.totalCostUsd)
    };
  }
  if (executorId === 'model' && task.report?.aiUsage) {
    const u = task.report.aiUsage;
    return {
      tokensIn: integer(u.inputTokens ?? u.input_tokens),
      tokensOut: integer(u.outputTokens ?? u.output_tokens),
      totalTokens: integer(u.totalTokens ?? u.total_tokens ?? ((u.inputTokens ?? u.input_tokens) + (u.outputTokens ?? u.output_tokens))),
      durationMs: integer(u.durationMs ?? u.duration_ms),
      costEstimate: number(u.totalCostUsd ?? u.total_cost_usd)
    };
  }
  if (task.usage && typeof task.usage === 'object') {
    const u = task.usage;
    return {
      tokensIn: integer(u.inputTokens ?? u.input_tokens),
      tokensOut: integer(u.outputTokens ?? u.output_tokens),
      totalTokens: integer(u.totalTokens ?? u.total_tokens ?? ((u.inputTokens ?? u.input_tokens) + (u.outputTokens ?? u.output_tokens))),
      durationMs: integer(u.durationMs ?? u.duration_ms),
      costEstimate: number(u.totalCostUsd ?? u.total_cost_usd)
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

const counters = () => ({ calls: 0, tokensIn: 0, tokensOut: 0, totalTokens: 0, durationMs: 0, costEstimate: 0 });
function add(row, call) {
  row.calls += integer(call.calls);
  row.tokensIn += integer(call.tokensIn);
  row.tokensOut += integer(call.tokensOut);
  row.totalTokens += integer(call.totalTokens);
  row.durationMs += integer(call.durationMs);
  row.costEstimate += number(call.costEstimate);
}

export function summarizeUsage(store, { projectId, executorId, from, to, days = 30, now } = {}) {
  const toDay = to || day(now ?? Date.now());
  const fromDay = from || (days === 'all' ? null : new Date(Date.parse(`${toDay}T00:00:00Z`) - (Number(days) - 1) * 86400000).toISOString().slice(0, 10));
  const inRange = date => date && date <= toDay && (!fromDay || date >= fromDay);
  const totals = counters();
  const maps = {
    byExecutor: new Map(),
    byDay: new Map(),
    byTicket: new Map()
  };
  const rows = store.list('work-usage');
  for (const raw of rows) {
    if (projectId && raw.projectId !== projectId) continue;
    if (executorId && raw.executorId !== executorId) continue;
    const date = day(raw.recordedAt);
    if (!inRange(date)) continue;
    const call = { ...raw, totalTokens: integer(raw.totalTokens || raw.tokensIn + raw.tokensOut) };
    add(totals, call);
    if (!maps.byExecutor.has(call.executorId)) maps.byExecutor.set(call.executorId, { executorId: call.executorId, ...counters() });
    add(maps.byExecutor.get(call.executorId), call);
    if (!maps.byDay.has(date)) maps.byDay.set(date, { date, ...counters() });
    add(maps.byDay.get(date), call);
    if (call.ticketId) {
      if (!maps.byTicket.has(call.ticketId)) maps.byTicket.set(call.ticketId, { ticketId: call.ticketId, executorId: call.executorId, ...counters() });
      add(maps.byTicket.get(call.ticketId), call);
    }
  }
  const result = {
    range: { days, from: fromDay, to: toDay, timeZone: 'Asia/Shanghai' },
    totals,
    byExecutor: [...maps.byExecutor.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    byDay: [...maps.byDay.values()].sort((a, b) => b.date.localeCompare(a.date)),
    byTicket: [...maps.byTicket.values()].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 100)
  };
  return result;
}
