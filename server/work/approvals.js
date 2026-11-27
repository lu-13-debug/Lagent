import { createHash, randomUUID } from 'node:crypto';

// P0.2：审批中心。待确认不再只散在 ticket.attention / run.status / 执行器内存里，
// 而是一条可查询、可过期、可审计的一等记录。
// P0 只开放 allow_once / deny；allow_session / allow_always 明确返回 409，
// 避免界面显示「已授权」但实际没有授权范围存储。
export const APPROVAL_STATUS = Object.freeze({
  pending: 'pending',
  resolved: 'resolved',
  expired: 'expired',
  cancelled: 'cancelled'
});

export const APPROVAL_KINDS = Object.freeze(['ticket', 'run', 'tool', 'command', 'write', 'network', 'secret', 'access']);
export const APPROVAL_OPTIONS = Object.freeze(['allow_once', 'allow_session', 'allow_always', 'deny']);
export const P0_DECISIONS = Object.freeze(['allow_once', 'deny']);
export const GRANT_NOT_ENABLED = 'GRANT_NOT_ENABLED';
const KINDS = new Set(APPROVAL_KINDS);
const OPTIONS = new Set(APPROVAL_OPTIONS);
const RISKS = new Set(['low', 'medium', 'high']);
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// 执行器交互授权底层有 5 分钟超时（模型）或更短（ACP），审批也跟着收口。
const EXECUTOR_TTL_MS = 5 * 60 * 1000;

function text(value, max = 300) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';
}

function integer(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// 指纹只覆盖「这条审批到底在问什么」：同一工具/路径/输入在同一 thread 里不重复弹窗。
export function approvalFingerprint(input = {}) {
  return createHash('sha256').update(stableStringify({
    kind: input.kind || null,
    executor: input.executor || null,
    requestId: input.requestId || null,
    scope: input.scope || null,
    input: input.input ?? null
  })).digest('hex').slice(0, 32);
}

export function approvalError(message, status = 400, code = undefined) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function riskOf(value) {
  return RISKS.has(value) ? value : 'medium';
}

function optionsOf(value) {
  const list = Array.isArray(value) ? value.filter(item => OPTIONS.has(item)) : [];
  const options = list.length ? [...new Set(list)] : [...P0_DECISIONS];
  if (!options.includes('deny')) options.push('deny');
  return options;
}

export function publicApproval(approval, { includeInput = false } = {}) {
  if (!approval) return null;
  const result = {
    id: approval.id,
    threadId: approval.threadId,
    ...(approval.runId ? { runId: approval.runId } : {}),
    ...(approval.ticketId ? { ticketId: approval.ticketId } : {}),
    ...(approval.requestId ? { requestId: approval.requestId } : {}),
    kind: approval.kind,
    ...(approval.executor ? { executor: approval.executor } : {}),
    title: approval.title,
    summary: approval.summary,
    options: approval.options,
    risk: approval.risk,
    ...(approval.scope ? { scope: approval.scope } : {}),
    fingerprint: approval.fingerprint,
    status: approval.status,
    ...(approval.decision ? { decision: approval.decision } : {}),
    ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {}),
    ...(approval.resolutionNote ? { resolutionNote: approval.resolutionNote } : {}),
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    ...(approval.resolvedAt ? { resolvedAt: approval.resolvedAt } : {})
  };
  if (includeInput && approval.input !== undefined) result.input = approval.input;
  return result;
}

/**
 * @param {import('../store.js').Store} store
 * @param {{ownerId?: string, publish?: Function, clock?: Function, now?: Function, ttlMs?: number}} options
 */
export function createApprovalService(store, {
  ownerId = 'local',
  publish = () => {},
  clock = () => new Date().toISOString(),
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS
} = {}) {
  if (!store?.put || !store?.list) throw new TypeError('审批中心需要 Store');

  const emit = (eventType, approval) => {
    try {
      publish({
        type: 'approval',
        eventType,
        threadId: approval.threadId,
        ...(approval.runId ? { runId: approval.runId } : {}),
        ...(approval.ticketId ? { ticketId: approval.ticketId } : {}),
        payload: {
          approvalId: approval.id,
          kind: approval.kind,
          title: approval.title,
          summary: approval.summary,
          status: approval.status,
          options: approval.options,
          risk: approval.risk,
          expiresAt: approval.expiresAt,
          ...(approval.decision ? { decision: approval.decision } : {}),
          ...(approval.decidedBy ? { decidedBy: approval.decidedBy } : {})
        }
      });
    } catch { /* 事件推送失败不影响审批落库。 */ }
  };

  const all = () => store.list('approval');

  function get(id) {
    const approval = typeof id === 'string' && id ? store.get('approval', id) : null;
    if (!approval) throw approvalError('审批不存在', 404, 'APPROVAL_NOT_FOUND');
    return approval;
  }

  function pendingMatches(input) {
    const threadId = input.threadId;
    return all().find(approval => approval.status === APPROVAL_STATUS.pending
      && approval.threadId === threadId
      && approval.fingerprint === input.fingerprint
      && (approval.requestId || null) === (input.requestId || null)
      && (approval.ticketId || null) === (input.ticketId || null));
  }

  function request(input = {}) {
    const kind = KINDS.has(input.kind) ? input.kind : 'ticket';
    const ticketId = text(input.ticketId, 100) || undefined;
    const runId = text(input.runId, 100) || undefined;
    const requestId = text(input.requestId, 120) || undefined;
    const threadId = text(input.threadId, 100) || ticketId || runId;
    if (!threadId) throw approvalError('审批必须归属到一个会话、工单或运行', 400);
    const title = text(input.title, 120) || '等待确认';
    const summary = text(input.summary, 600);
    const scope = input.scope && typeof input.scope === 'object' && !Array.isArray(input.scope) ? input.scope : undefined;
    const fingerprint = text(input.fingerprint, 64) || approvalFingerprint({ kind, executor: input.executor, requestId, scope, input: input.input });
    const candidate = { threadId, ticketId, requestId, fingerprint };

    const existing = pendingMatches(candidate);
    if (existing) return publicApproval(existing);

    const at = clock();
    const ttl = integer(input.ttlMs) && input.ttlMs > 0
      ? input.ttlMs
      : ['access', 'tool'].includes(kind) ? EXECUTOR_TTL_MS : ttlMs;
    const approval = {
      id: randomUUID(),
      threadId,
      ...(runId ? { runId } : {}),
      ...(ticketId ? { ticketId } : {}),
      ...(requestId ? { requestId } : {}),
      kind,
      ...(text(input.executor, 60) ? { executor: text(input.executor, 60) } : {}),
      title,
      summary,
      ...(input.input !== undefined ? { input: input.input } : {}),
      options: optionsOf(input.options),
      risk: riskOf(input.risk),
      ...(scope ? { scope } : {}),
      fingerprint,
      status: APPROVAL_STATUS.pending,
      createdAt: at,
      expiresAt: now() + ttl,
      ownerId
    };
    store.put('approval', approval);
    emit('approval.requested', approval);
    return publicApproval(approval);
  }

  function normalizeDecision(decision) {
    if (decision === 'allow') return 'allow_once';
    if (decision === 'reject') return 'deny';
    return decision;
  }

  function validate(approval, decision) {
    const normalized = normalizeDecision(decision);
    if (!OPTIONS.has(normalized)) throw approvalError('授权决定无效', 400, 'APPROVAL_DECISION_INVALID');
    if (!P0_DECISIONS.includes(normalized)) {
      throw approvalError('授权范围（本会话/始终允许）尚未启用，请选择「仅本次」或「拒绝」', 409, GRANT_NOT_ENABLED);
    }
    if (!approval.options.includes(normalized)) throw approvalError('这个审批不支持该选项', 400, 'APPROVAL_OPTION_UNSUPPORTED');
    if (approval.status !== APPROVAL_STATUS.pending) {
      throw approvalError(approval.status === APPROVAL_STATUS.resolved ? '这条审批已经处理过了' : '审批已失效，请重新发起', 409, 'APPROVAL_ALREADY_SETTLED');
    }
    if (Number.isFinite(approval.expiresAt) && approval.expiresAt <= now()) {
      expireRecord(approval, '等待超时，已自动过期');
      throw approvalError('审批已过期', 409, 'APPROVAL_EXPIRED');
    }
    return normalized;
  }

  function commit(approval, patch, eventType) {
    const updated = { ...approval, ...patch };
    store.put('approval', updated);
    emit(eventType, updated);
    return updated;
  }

  // 先落决议再执行副作用：重复点击/跨端同时点，第二次会稳定拿到 409。
  function resolve(id, decision, { by = 'desktop', note = '' } = {}) {
    const approval = get(id);
    const normalized = validate(approval, decision);
    return commit(approval, {
      status: APPROVAL_STATUS.resolved,
      decision: normalized,
      decidedBy: text(by, 100) || 'desktop',
      resolvedAt: clock(),
      ...(text(note, 300) ? { resolutionNote: text(note, 300) } : {})
    }, 'approval.resolved');
  }

  function expireRecord(approval, reason = '审批已过期') {
    if (approval.status !== APPROVAL_STATUS.pending) return approval;
    return commit(approval, {
      status: APPROVAL_STATUS.expired,
      resolvedAt: clock(),
      resolutionNote: text(reason, 300) || '审批已过期'
    }, 'approval.resolved');
  }

  // 副作用失败（执行器重启、任务已结束）时把已提交的审批改成过期，而不是假装成功。
  function expire(id, reason = '审批已失效') {
    const approval = get(id);
    if (approval.status === APPROVAL_STATUS.expired || approval.status === APPROVAL_STATUS.cancelled) return publicApproval(approval);
    return publicApproval(expireRecord({ ...approval, status: APPROVAL_STATUS.pending }, reason));
  }

  function cancelRecord(approval, reason) {
    if (approval.status !== APPROVAL_STATUS.pending) return approval;
    return commit(approval, {
      status: APPROVAL_STATUS.cancelled,
      resolvedAt: clock(),
      resolutionNote: text(reason, 300) || '审批已取消'
    }, 'approval.resolved');
  }

  // 旧 UI 的工单按钮（批准/退回/停止）直接落一个决议：匹配的 pending 审批按同义决定结束，
  // 其余 pending（例如同一工单上另一个交互授权）一并取消，避免遗留僵尸待办。
  function resolveForTicket(ticketId, decision, by = 'desktop') {
    const id = text(ticketId, 100);
    const normalized = normalizeDecision(decision);
    if (!id || !P0_DECISIONS.includes(normalized)) return 0;
    let count = 0;
    for (const approval of all()) {
      if (approval.ticketId !== id || approval.status !== APPROVAL_STATUS.pending) continue;
      if (approval.options.includes(normalized)) {
        try { resolve(approval.id, normalized, { by }); count++; }
        catch { /* 已被另一端处理，跳过。 */ }
      } else {
        cancelRecord(approval, '工单已由旧入口处理');
      }
    }
    return count;
  }

  function cancelForTicket(ticketId, reason = '工单已处理') {
    const id = text(ticketId, 100);
    if (!id) return 0;
    let count = 0;
    for (const approval of all()) {
      if (approval.ticketId === id && approval.status === APPROVAL_STATUS.pending) { cancelRecord(approval, reason); count++; }
    }
    return count;
  }

  function cancelForRun(runId, reason = '运行已继续') {
    const id = text(runId, 100);
    if (!id) return 0;
    let count = 0;
    for (const approval of all()) {
      if (approval.runId === id && approval.status === APPROVAL_STATUS.pending) { cancelRecord(approval, reason); count++; }
    }
    return count;
  }

  function findByRequest({ ticketId, requestId } = {}) {
    const tid = text(ticketId, 100);
    const rid = text(requestId, 120);
    if (!rid) return null;
    return all().find(approval => approval.status === APPROVAL_STATUS.pending
      && approval.requestId === rid
      && (!tid || approval.ticketId === tid)) || null;
  }

  // 旧接口（/permissions/:requestId）的决定回写到新审批；没有对应记录时静默跳过。
  function resolveByRequest({ ticketId, requestId, decision, by = 'desktop' } = {}) {
    const approval = findByRequest({ ticketId, requestId });
    if (!approval) return null;
    try { return publicApproval(resolve(approval.id, decision, { by })); }
    catch (error) {
      if (error?.code === GRANT_NOT_ENABLED) return null;
      throw error;
    }
  }

  function list({ status = null, threadId = null, runId = null, ticketId = null, limit = 100 } = {}) {
    const cap = integer(limit) && limit > 0 ? Math.min(limit, 500) : 100;
    const thread = text(threadId, 100);
    const run = text(runId, 100);
    const ticket = text(ticketId, 100);
    const rows = all()
      .filter(approval => !status || approval.status === status)
      .filter(approval => !thread || approval.threadId === thread)
      .filter(approval => !run || approval.runId === run)
      .filter(approval => !ticket || approval.ticketId === ticket)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    return rows.slice(0, cap).map(approval => publicApproval(approval, { includeInput: false }));
  }

  function detail(id) {
    return publicApproval(get(id), { includeInput: true });
  }

  function expireStale() {
    const expired = [];
    for (const approval of all()) {
      if (approval.status !== APPROVAL_STATUS.pending) continue;
      if (Number.isFinite(approval.expiresAt) && approval.expiresAt <= now()) {
        expireRecord(approval, '等待超时，已自动过期');
        expired.push(approval.id);
      }
    }
    return expired;
  }

  function startMaintenance({ intervalMs = 60 * 1000 } = {}) {
    const timer = setInterval(() => { try { expireStale(); } catch { /* 维护失败不影响主流程。 */ } }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  function stats() {
    const rows = all();
    const count = status => rows.filter(approval => approval.status === status).length;
    return {
      total: rows.length,
      pending: count(APPROVAL_STATUS.pending),
      resolved: count(APPROVAL_STATUS.resolved),
      expired: count(APPROVAL_STATUS.expired),
      cancelled: count(APPROVAL_STATUS.cancelled)
    };
  }

  return {
    ownerId,
    request,
    resolve,
    expire,
    expireStale,
    cancelForTicket,
    cancelForRun,
    resolveForTicket,
    findByRequest,
    resolveByRequest,
    list,
    detail,
    get,
    stats,
    startMaintenance,
    close() { /* 无外部句柄；保留与 run-event 日志一致的收尾接口。 */ }
  };
}
