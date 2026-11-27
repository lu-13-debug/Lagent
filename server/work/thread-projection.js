import { publicApproval } from './approvals.js';

// P0.3：thread 读投影。不建新表，按请求把会话/工单/运行/事件/审批/产物聚成一份
// 「这条会话现在是什么状态」。默认 1 秒缓存，键 = threadId + 当前最新 seq。
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked']);
const RUNNING = new Set(['working', 'queued']);
const ACTIVE_RUNS = new Set(['drafting', 'awaiting_approval', 'running', 'verifying', 'repairing']);

const text = (value, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';

function projectionError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function threadStatusOf(tickets = [], approvals = [], runs = []) {
  if (approvals.some(item => item.status === 'pending')) return 'waiting_approval';
  if (tickets.some(item => item.status === 'awaiting_review')) return 'waiting_approval';
  if (tickets.some(item => RUNNING.has(item.status)) || runs.some(item => ['running', 'verifying', 'repairing'].includes(item.status))) return 'running';
  if (runs.some(item => item.status === 'paused')) return 'paused';
  const statuses = [...tickets.map(item => item.status), ...runs.map(item => item.status)].filter(Boolean);
  if (!statuses.length) return 'idle';
  if (statuses.some(status => ['failed', 'blocked'].includes(status))) return 'failed';
  if (statuses.every(status => TERMINAL.has(status))) return 'settled';
  return 'idle';
}

function ticketSummary(ticket) {
  return {
    id: ticket.id,
    title: text(ticket.title, 120) || '',
    status: text(ticket.status, 30) || 'unknown',
    ...(ticket.executor ? { executor: text(ticket.executor, 60) } : {}),
    summary: text(ticket.summary, 400) || '',
    createdAt: text(ticket.createdAt, 40) || null,
    updatedAt: text(ticket.updatedAt, 40) || null,
    ...(ticket.conversationId ? { conversationId: ticket.conversationId } : {}),
    ...(ticket.turnId ? { turnId: ticket.turnId } : {}),
    ...(ticket.approvalId ? { approvalId: ticket.approvalId } : {})
  };
}

function runSummary(run) {
  const steps = Array.isArray(run.steps) ? run.steps : [];
  return {
    id: run.id,
    goal: text(run.goal, 300) || '',
    status: text(run.status, 30) || 'unknown',
    ...(run.chatId ? { chatId: run.chatId } : {}),
    ...(run.projectId ? { projectId: run.projectId } : {}),
    ...(Number.isSafeInteger(run.currentStep) ? { currentStep: run.currentStep } : {}),
    totalSteps: steps.length,
    doneSteps: steps.filter(step => ['done', 'skipped'].includes(step.status)).length,
    createdAt: text(run.createdAt, 40) || null,
    updatedAt: text(run.updatedAt, 40) || null
  };
}

function approvalSummary(approval) {
  const result = publicApproval(approval);
  if (!result) return null;
  return {
    id: result.id,
    threadId: result.threadId,
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.ticketId ? { ticketId: result.ticketId } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    kind: result.kind,
    title: result.title,
    summary: result.summary,
    options: result.options,
    risk: result.risk,
    status: result.status,
    ...(result.decision ? { decision: result.decision } : {}),
    ...(result.decidedBy ? { decidedBy: result.decidedBy } : {}),
    createdAt: result.createdAt,
    expiresAt: result.expiresAt,
    ...(result.resolvedAt ? { resolvedAt: result.resolvedAt } : {})
  };
}

function activityRows(event, base, rows) {
  const activity = Array.isArray(event.payload?.activity) ? event.payload.activity.slice(-40) : [];
  for (const step of activity) {
    const kind = step.kind === 'thought' ? 'thinking'
      : step.kind === 'tool' ? 'tool'
      : step.kind === 'permission' ? 'approval'
      : step.kind === 'error' ? 'error'
      : 'text';
    rows.push({
      ...base,
      id: `${event.id}:${rows.length}`,
      kind,
      title: text(step.text, 300) || '',
      text: text(step.detail, 600) || '',
      ...(step.kind === 'permission' ? { kind: 'approval', status: step.decided === true ? 'resolved' : 'pending' } : {}),
      ...(step.at ? { at: step.at } : {})
    });
  }
}

// 把 run-event 映射成时间线行；旧 work-event 也走同一套映射，保证开关切换时形状一致。
function timelineRows(events) {
  const rows = [];
  for (const event of events) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const base = {
      at: text(event.createdAt, 40) || null,
      ...(event.ticketId ? { ticketId: event.ticketId } : {}),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
      eventType: event.type
    };
    if (event.type === 'activity') { activityRows({ ...event, payload }, base, rows); continue; }
    if (event.type === 'approval' || event.type === 'approval.requested' || event.type === 'approval.resolved') {
      rows.push({
        ...base,
        id: event.id,
        kind: 'approval',
        title: text(payload.title, 120) || '审批',
        text: text(payload.summary, 400) || '',
        status: text(payload.status, 20) || 'pending',
        ...(payload.approvalId ? { approvalId: payload.approvalId } : {})
      });
      continue;
    }
    if (event.type === 'ticket' || event.type === 'ticket.status') {
      rows.push({
        ...base,
        id: event.id,
        kind: payload.attention ? 'approval' : 'text',
        title: text(payload.title, 120) || text(payload.status, 30) || '工单',
        text: text(payload.summary, 400) || '',
        status: text(payload.status, 30) || undefined,
        ...(payload.approvalId ? { approvalId: payload.approvalId } : {})
      });
      continue;
    }
    if (event.type === 'run' || event.type === 'run.status' || event.type === 'run-step' || event.type === 'step.status') {
      rows.push({ ...base, id: event.id, kind: 'plan', title: text(payload.role, 60) || '运行', text: text(payload.summary, 400) || '', status: text(payload.status, 30) || undefined });
      continue;
    }
    if (event.type === 'report' || event.type === 'report.created' || event.type === 'artifact.created') {
      rows.push({ ...base, id: event.id, kind: 'artifact', title: '产物', text: text(payload.summary, 400) || '', ...(payload.id ? { artifactId: String(payload.id).slice(0, 100) } : {}) });
      continue;
    }
    if (event.type === 'team') {
      rows.push({ ...base, id: event.id, kind: 'subagent', title: '团队更新', text: text(JSON.stringify(payload.nodes || payload.team || '').slice(0, 400), 400) || '' });
      continue;
    }
    if (event.type === 'usage' || event.type === 'usage-alert') {
      rows.push({ ...base, id: event.id, kind: 'fold', title: '用量', text: '' });
      continue;
    }
    rows.push({ ...base, id: event.id, kind: 'text', title: text(event.type, 60) || '事件', text: '' });
  }
  return rows;
}

export function createThreadProjection({
  store,
  runEvents = null,
  budgetTokens = undefined,
  cacheMs = 1000,
  now = () => Date.now()
} = {}) {
  if (!store?.list) throw new TypeError('thread 投影需要 Store');
  const cache = new Map();
  const tickets = () => store.list('work-ticket');
  const runs = () => store.list('work-run');
  const conversations = () => store.list('conversation');
  const chats = () => store.list('project-chat');
  const approvalsRows = () => store.list('approval');

  function resolve(input) {
    const id = text(input, 120);
    if (!id) throw projectionError('thread id 无效', 400);
    const conversation = store.get('conversation', id);
    if (conversation) return { threadId: conversation.id, conversation };
    const ticket = store.get('work-ticket', id);
    if (ticket) return { threadId: ticket.conversationId || ticket.id, ticket };
    const run = store.get('work-run', id);
    if (run) return { threadId: run.chatId || run.id, run };
    const approval = store.get('approval', id);
    if (approval?.threadId) return { threadId: approval.threadId, approval };
    const chat = store.get('project-chat', id);
    if (chat) return { threadId: chat.conversationId || chat.id, chat };
    // 调用方也可能直接给 threadId（conversationId / chatId）。
    if (tickets().some(item => item.conversationId === id)) return { threadId: id };
    if (runs().some(item => item.chatId === id)) return { threadId: id };
    if (approvalsRows().some(item => item.threadId === id)) return { threadId: id };
    throw projectionError('会话不存在', 404);
  }

  function collect(threadId) {
    const chatIds = new Set(chats()
      .filter(chat => chat.id === threadId || chat.conversationId === threadId)
      .map(chat => chat.id));
    const threadTickets = tickets()
      .filter(ticket => ticket.conversationId === threadId
        || (!ticket.conversationId && (ticket.id === threadId || chatIds.has(ticket.projectChatId))))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    const ticketIds = new Set(threadTickets.map(ticket => ticket.id));
    const threadRuns = runs()
      .filter(run => run.chatId === threadId || run.id === threadId)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
    const threadApprovals = approvalsRows()
      .filter(approval => approval.threadId === threadId || (approval.ticketId && ticketIds.has(approval.ticketId)))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    return { chatIds, threadTickets, ticketIds, threadRuns, threadApprovals };
  }

  function eventsOf(threadId, { afterSeq = 0, limit = 500, ticketIds = new Set() } = {}) {
    if (runEvents) {
      const stored = runEvents.listThread(threadId, { afterSeq, limit });
      if (stored.length || afterSeq > 0) return stored.map(event => ({ ...event, eventType: event.type }));
    }
    // 开关打开前只有 work-event：按工单过滤，形状对齐 run-event（没有全局 seq）。
    return store.list('work-event')
      .filter(event => ticketIds.has(event.ticketId))
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))
      .slice(-limit)
      .map(event => ({ ...event, eventType: event.type }));
  }

  function build(threadId, { afterSeq = 0, timelineLimit = 500 } = {}) {
    const { threadTickets, ticketIds, threadRuns, threadApprovals } = collect(threadId);
    const conversation = store.get('conversation', threadId) || null;
    const events = eventsOf(threadId, { afterSeq, limit: timelineLimit, ticketIds });
    const timeline = timelineRows(events);
    const pendingApprovals = threadApprovals.filter(approval => approval.status === 'pending').map(approvalSummary).filter(Boolean);
    const reports = store.list('work-report')
      .filter(report => ticketIds.has(report.ticketId))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    const usageRows = store.list('work-usage').filter(row => ticketIds.has(row.ticketId));
    const usage = usageRows.reduce((sum, row) => ({
      tokens: sum.tokens + (Number.isFinite(row.totalTokens) ? row.totalTokens : 0),
      cost: sum.cost + (Number.isFinite(row.costEstimate) ? row.costEstimate : 0),
      calls: sum.calls + (Number.isFinite(row.calls) ? row.calls : 0)
    }), { tokens: 0, cost: 0, calls: 0 });
    const updatedAt = [
      conversation?.updatedAt,
      ...threadTickets.map(ticket => ticket.updatedAt),
      ...threadRuns.map(run => run.updatedAt),
      ...threadApprovals.map(approval => approval.resolvedAt || approval.createdAt)
    ].filter(Boolean).sort().at(-1) || null;
    // 空会话（还没有工单/运行）用会话自身的状态兜底，避免列表里显示成 idle。
    const conversationStatus = { completed: 'settled', failed: 'failed', working: 'running', awaiting_review: 'waiting_approval' }[conversation?.status];
    const status = threadStatusOf(threadTickets, threadApprovals, threadRuns);
    return {
      id: threadId,
      title: text(conversation?.title, 120) || text(threadTickets[0]?.title, 120) || text(threadRuns[0]?.goal, 120) || threadId,
      status: status === 'idle' && conversationStatus ? conversationStatus : status,
      ...(conversation?.projectId ? { projectId: conversation.projectId } : {}),
      ...(text(conversation?.id, 100) ? { conversationId: conversation.id } : {}),
      runs: threadRuns.map(runSummary),
      tickets: threadTickets.map(ticketSummary),
      approvals: threadApprovals.map(approvalSummary).filter(Boolean),
      timeline,
      inspector: {
        pendingApprovals,
        running: threadRuns.filter(run => ACTIVE_RUNS.has(run.status)).map(runSummary),
        artifacts: reports.slice(0, 20).map(report => ({
          id: report.id,
          ticketId: report.ticketId,
          kind: text(report.kind, 30) || 'report',
          summary: text(report.summary, 400) || '',
          createdAt: text(report.createdAt, 40) || null
        })),
        usage: { ...usage, ...(Number.isFinite(budgetTokens) ? { budget: budgetTokens } : {}) }
      },
      cursor: {
        lastSeq: runEvents ? runEvents.latestSeqForThread(threadId) : (Number.isFinite(events.at(-1)?.seq) ? events.at(-1).seq : 0),
        updatedAt
      }
    };
  }

  function stampOf(threadId) {
    if (runEvents) return runEvents.latestSeqForThread(threadId);
    const { threadTickets, threadRuns, threadApprovals } = collect(threadId);
    return `${threadTickets.length}:${threadRuns.length}:${threadApprovals.length}:${threadTickets[0]?.updatedAt || ''}:${threadRuns[0]?.updatedAt || ''}`;
  }

  function get(input, options = {}) {
    const { threadId } = resolve(input);
    // 带游标的请求只取增量，不走缓存，避免返回上一次的整份时间线。
    if (options.afterSeq) return build(threadId, options);
    const at = now();
    const stamp = stampOf(threadId);
    const cached = cache.get(threadId);
    if (cached && cached.stamp === stamp && at - cached.at < cacheMs) return cached.value;
    const value = build(threadId, options);
    cache.set(threadId, { stamp, at, value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  function list({ limit = 50 } = {}) {
    const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    const ids = new Set();
    for (const conversation of conversations()) ids.add(conversation.id);
    for (const ticket of tickets()) ids.add(ticket.conversationId || ticket.id);
    for (const run of runs()) if (run.chatId) ids.add(run.chatId);
    for (const chat of chats()) if (chat.conversationId) ids.add(chat.conversationId);
    return [...ids].slice(0, 500).map(id => {
      const projection = get(id);
      return {
        id: projection.id,
        title: projection.title,
        status: projection.status,
        ...(projection.conversationId ? { conversationId: projection.conversationId } : {}),
        ...(projection.projectId ? { projectId: projection.projectId } : {}),
        ticketCount: projection.tickets.length,
        runCount: projection.runs.length,
        pendingApprovals: projection.inspector.pendingApprovals.length,
        cursor: projection.cursor
      };
    }).sort((left, right) => String(right.cursor.updatedAt || '').localeCompare(String(left.cursor.updatedAt || ''))).slice(0, cap);
  }

  function listEvents(input, { afterSeq = 0, limit = 500 } = {}) {
    const { threadId } = resolve(input);
    const { ticketIds } = collect(threadId);
    const events = eventsOf(threadId, { afterSeq, limit, ticketIds });
    return {
      threadId,
      afterSeq,
      latestSeq: runEvents ? runEvents.latestSeqForThread(threadId) : (Number.isFinite(events.at(-1)?.seq) ? events.at(-1).seq : 0),
      events
    };
  }

  function invalidate(threadId = null) {
    if (threadId === null) { cache.clear(); return; }
    try { cache.delete(resolve(threadId).threadId); } catch { /* 无效 id 无需清理。 */ }
  }

  return { resolve, get, list, listEvents, invalidate, cacheSize: () => cache.size };
}
