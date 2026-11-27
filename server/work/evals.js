import { randomUUID } from 'node:crypto';

// 评测：不对已有工单打分，只把真实运行记录汇成一张对比表——
// 状态、耗时、调用次数、Token/成本、验证结果、改动文件数。
// 数据全部来自现有实体（ticket / assignment / usage / audit / change），不额外埋点。
const MAX_TICKETS = 50;

const text = (value, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';

function evalError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createEvalService(store, { now = () => new Date().toISOString() } = {}) {
  if (!store?.put) throw new TypeError('评测服务需要 Store');

  function rowsOf(kind) { return store.list(kind); }

  function evaluateTicket(ticket) {
    const assignments = rowsOf('work-assignment').filter(row => row.ticketId === ticket.id);
    const usage = rowsOf('work-usage').filter(row => row.ticketId === ticket.id);
    const audits = rowsOf('work-audit').filter(row => row.ticketId === ticket.id);
    const verify = audits.filter(row => String(row.action || '').startsWith('verify')).sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))[0] || null;
    const started = assignments.map(row => Date.parse(row.startedAt || '')).filter(Number.isFinite);
    const ended = assignments.map(row => Date.parse(row.endedAt || '')).filter(Number.isFinite);
    const durationMs = started.length && ended.length ? Math.max(0, Math.max(...ended) - Math.min(...started)) : 0;
    const tokens = usage.reduce((sum, row) => sum + (Number.isFinite(row.totalTokens) ? row.totalTokens : 0), 0);
    const cost = usage.reduce((sum, row) => sum + (Number.isFinite(row.costEstimate) ? row.costEstimate : 0), 0);
    const change = rowsOf('work-project-change').find(row => row.ticketId === ticket.id) || null;
    const verifyResult = verify ? (verify.result === 'passed' ? 'passed' : verify.result === 'failed' ? 'failed' : 'unknown') : 'none';
    const outcome = ticket.status === 'completed'
      ? (verifyResult === 'failed' ? 'failed' : 'passed')
      : ['failed', 'cancelled', 'blocked'].includes(ticket.status) ? 'failed' : 'incomplete';
    return {
      ticketId: ticket.id,
      title: text(ticket.title, 120),
      executor: text(ticket.executor, 60),
      status: text(ticket.status, 30),
      outcome,
      verify: verifyResult,
      durationMs,
      calls: assignments.length,
      tokens,
      cost: Number(cost.toFixed(4)),
      files: Array.isArray(change?.files) ? change.files.length : 0,
      createdAt: text(ticket.createdAt, 40) || null
    };
  }

  function summarize(tickets) {
    const total = tickets.length;
    const passed = tickets.filter(row => row.outcome === 'passed').length;
    const failed = tickets.filter(row => row.outcome === 'failed').length;
    const verified = tickets.filter(row => row.verify === 'passed').length;
    const durations = tickets.map(row => row.durationMs).filter(value => value > 0);
    return {
      total, passed, failed, incomplete: total - passed - failed,
      passRate: total ? Number((passed / total).toFixed(3)) : 0,
      verified,
      avgDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
      totalTokens: tickets.reduce((sum, row) => sum + row.tokens, 0),
      totalCost: Number(tickets.reduce((sum, row) => sum + row.cost, 0).toFixed(4))
    };
  }

  // ticketIds 为空时取最近完成/失败的工单，方便「看一眼最近跑得怎么样」。
  function evaluate({ ticketIds = [], name = '', limit = 20 } = {}) {
    const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_TICKETS) : 20;
    let tickets;
    if (Array.isArray(ticketIds) && ticketIds.length) {
      if (ticketIds.length > MAX_TICKETS) throw evalError(`一次最多评测 ${MAX_TICKETS} 个工单`, 400);
      tickets = ticketIds.map(id => {
        const row = store.get('work-ticket', text(id, 100));
        if (!row) throw evalError(`工单不存在：${String(id).slice(0, 40)}`, 404);
        return row;
      });
    } else {
      tickets = rowsOf('work-ticket')
        .filter(row => ['completed', 'failed', 'cancelled', 'blocked'].includes(row.status))
        .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
        .slice(0, cap);
    }
    const rows = tickets.map(evaluateTicket);
    const summary = summarize(rows);
    const record = {
      id: randomUUID(),
      name: text(name, 60) || '最近工单',
      at: now(),
      ticketIds: rows.map(row => row.ticketId),
      summary,
      tickets: rows
    };
    store.put('eval', record);
    // 评测快照保留最近 100 份。
    for (const old of rowsOf('eval').slice(100)) store.delete('eval', old.id);
    return record;
  }

  function list({ limit = 20 } = {}) {
    const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
    return rowsOf('eval')
      .sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')))
      .slice(0, cap);
  }

  function get(id) {
    const row = store.get('eval', text(id, 100));
    if (!row) throw evalError('评测记录不存在', 404);
    return row;
  }

  return { evaluate, list, get };
}
