import { randomUUID } from 'node:crypto';

// P0.1：有序、只追加的运行事件日志。
// 与 work-event 双写：work-event 继续服务通知与旧客户端，run-event 负责续传、回放与跨端一致。
// 这里只依赖 Store 的 db / atomic / get / put 四个口子，方便单测直接换内存库。
export const RUN_EVENT_LIMITS = Object.freeze({
  payloadBytes: 32 * 1024,
  replay: 500,
  mobileReplay: 200,
  perThread: 5000,
  maxAgeDays: 30
});

// 旧 work 事件类型 → 新事件类型。未知类型原样保留，避免新增事件被日志丢掉。
const WORK_TYPE_TO_EVENT_TYPE = Object.freeze({
  ticket: 'ticket.status',
  run: 'run.status',
  'run-step': 'step.status',
  'run-chat': 'thread.created',
  activity: 'activity',
  team: 'team',
  delete: 'delete',
  'usage-alert': 'usage',
  report: 'report.created',
  assignment: 'run.assignment',
  // 审批服务会在 source.eventType 里区分 requested/resolved；默认归到 requested。
  approval: 'approval.requested'
});

const EVENT_TYPES = new Set([
  'thread.created', 'run.started', 'run.status', 'step.status', 'ticket.status',
  'approval.requested', 'approval.resolved', 'tool.call', 'tool.result',
  'artifact.created', 'usage', 'error', 'activity', 'team', 'delete', 'report.created', 'run.assignment'
]);

export function normalizeThreadId(input = {}) {
  for (const value of [input.conversationId, input.chatId, input.threadId, input.ticketId, input.runId]) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 100);
  }
  return null;
}

function text(value, max = 100) {
  return typeof value === 'string' && value ? value.slice(0, max) : null;
}

function clampPayload(payload, maxBytes) {
  let json;
  try { json = JSON.stringify(payload ?? null); }
  catch { return { payload: { truncated: true, reason: 'unserializable' }, truncated: true }; }
  if (typeof json !== 'string') return { payload: { truncated: true, reason: 'unserializable' }, truncated: true };
  const bytes = Buffer.byteLength(json);
  if (bytes <= maxBytes) return { payload: payload ?? null, truncated: false };
  // 截断后的预览要重新序列化，引号/反斜杠会膨胀；逐步收缩直到落进上限。
  let cut = Math.min(json.length, maxBytes);
  for (let attempt = 0; attempt < 12 && cut > 0; attempt++) {
    const candidate = { truncated: true, bytes, preview: json.slice(0, cut) };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) return { payload: candidate, truncated: true };
    cut = Math.floor(cut * 0.8);
  }
  return { payload: { truncated: true, bytes }, truncated: true };
}

/**
 * 把一条 work 事件归一成 run-event（不含 seq，seq 由存储层分配）。
 * 线程归一：conversationId > chatId > ticketId > runId；run 事件的 chatId 可来自
 * run-chat 事件缓存或 work-run 记录，避免同一次会话被拆成两个 thread。
 */
export function toRunEvent(event, { ownerId = 'local', lookupRun = null } = {}) {
  const source = event && typeof event === 'object' ? event : {};
  const payload = source.payload && typeof source.payload === 'object' ? source.payload : {};
  const runId = text(source.runId) || text(payload.runId);
  const ticketId = text(source.ticketId) || text(payload.ticketId);
  let chatId = text(payload.chatId) || text(payload.conversationId);
  if (!chatId && runId && lookupRun) {
    try { chatId = text(lookupRun(runId)?.chatId); } catch { /* 查询失败时退回 ticket/run。 */ }
  }
  const workType = text(source.workType, 40) || text(source.type, 40) || 'event';
  const declared = text(source.eventType, 60);
  const mapped = WORK_TYPE_TO_EVENT_TYPE[workType] || workType;
  const type = declared && EVENT_TYPES.has(declared) ? declared
    : (source.workType && EVENT_TYPES.has(source.type) ? source.type : mapped);
  const threadId = normalizeThreadId({ conversationId: payload.conversationId, chatId, threadId: text(source.threadId), ticketId, runId }) || 'global';
  return {
    id: text(source.id, 100) || randomUUID(),
    threadId,
    ...(runId ? { runId } : {}),
    ...(ticketId ? { ticketId } : {}),
    type: EVENT_TYPES.has(type) ? type : type.slice(0, 60),
    workType,
    payload,
    createdAt: text(source.createdAt, 40) || new Date().toISOString(),
    schemaVersion: 1,
    ownerId: text(ownerId, 100) || 'local'
  };
}

// SSE 线上形状：type 保持旧值（ticket/activity/...），新增 seq/threadId/eventType。
// 这样旧客户端 onmessage 继续按 data.type 分发，新客户端用 id/seq 续传。
export function wireEvent(event) {
  if (!event || !Number.isSafeInteger(event.seq)) return event;
  return {
    type: event.workType || event.type,
    ticketId: event.ticketId ?? null,
    ...(event.runId ? { runId: event.runId } : {}),
    payload: event.payload ?? null,
    createdAt: event.createdAt,
    seq: event.seq,
    threadId: event.threadId,
    eventType: event.type,
    schemaVersion: event.schemaVersion ?? 1
  };
}

export function createRunEventLog(store, { ownerId = 'local', lookupRun = null, limits = {}, archive = null } = {}) {
  if (!store?.db) throw new TypeError('run-event 日志需要 Store');
  const config = { ...RUN_EVENT_LIMITS, ...limits };
  // run-chat 会告诉我们 run 属于哪个会话；后续 run/run-step 不必每次查库。
  const runChats = new Map();

  // SCHEMA 里已经建过；这里再保证一次，单独拿 Store 做迁移或测试时也能用。
  store.db.exec(`CREATE TABLE IF NOT EXISTS event_seq (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS run_event_seq ON entities(json_extract(body,'$.seq')) WHERE kind='run-event';
    CREATE INDEX IF NOT EXISTS run_event_thread ON entities(json_extract(body,'$.threadId'),json_extract(body,'$.seq')) WHERE kind='run-event';
    CREATE INDEX IF NOT EXISTS run_event_owner ON entities(json_extract(body,'$.ownerId'),json_extract(body,'$.seq')) WHERE kind='run-event';
    INSERT OR IGNORE INTO event_seq VALUES(1,(SELECT COALESCE(MAX(json_extract(body,'$.seq')),0) FROM entities WHERE kind='run-event'));`);

  function rememberRunChat(runId, chatId) {
    if (!runId || !chatId) return;
    runChats.set(runId, chatId);
    if (runChats.size > 2000) runChats.delete(runChats.keys().next().value);
  }

  function resolveChat(runId) {
    if (!runId) return null;
    if (runChats.has(runId)) return { chatId: runChats.get(runId) };
    if (!lookupRun) return null;
    try {
      const chatId = text(lookupRun(runId)?.chatId);
      if (!chatId) return null;
      rememberRunChat(runId, chatId);
      return { chatId };
    } catch { return null; }
  }

  function prepare(event) {
    const body = toRunEvent(event, { ownerId, lookupRun: resolveChat });
    if (body.workType === 'run-chat') rememberRunChat(body.runId, body.payload?.chatId);
    const clamped = clampPayload(body.payload, config.payloadBytes);
    return {
      ...body,
      payload: clamped.payload,
      ...(clamped.truncated ? { truncated: true } : {})
    };
  }

  function nextSeq() {
    // 恢复正常备份或手工改库后，计数行可能缺失；补一行再自增。
    store.db.prepare('INSERT OR IGNORE INTO event_seq VALUES(1,0)').run();
    store.db.prepare('UPDATE event_seq SET value=value+1 WHERE id=1').run();
    return store.db.prepare('SELECT value FROM event_seq WHERE id=1').get().value;
  }

  function writePrepared(bodies) {
    const stored = [];
    for (const body of bodies) {
      const previous = store.get('run-event', body.id);
      if (previous) { stored.push(previous); continue; }
      const event = { ...body, seq: nextSeq() };
      store.put('run-event', event);
      stored.push(event);
    }
    return stored;
  }

  function appendMany(events) {
    const bodies = (Array.isArray(events) ? events : [events]).filter(Boolean).map(prepare);
    if (!bodies.length) return [];
    return store.inTransaction ? writePrepared(bodies) : store.atomic(() => writePrepared(bodies));
  }

  return {
    limits: config,
    ownerId,
    append(event) { return appendMany([event])[0]; },
    appendMany,
    record(event) { return appendMany([event])[0]; },
    recordMany(events) { return appendMany(events); },

    listAfter(afterSeq = 0, limit = config.replay, { ownerId: filterOwner = null } = {}) {
      const cursor = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
      const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 5000) : config.replay;
      const rows = filterOwner
        ? store.db.prepare(`SELECT body FROM entities WHERE kind='run-event'
            AND json_extract(body,'$.seq')>? AND json_extract(body,'$.ownerId')=?
            ORDER BY json_extract(body,'$.seq') ASC LIMIT ?`).all(cursor, filterOwner, size)
        : store.db.prepare(`SELECT body FROM entities WHERE kind='run-event'
            AND json_extract(body,'$.seq')>? ORDER BY json_extract(body,'$.seq') ASC LIMIT ?`).all(cursor, size);
      return rows.map(row => JSON.parse(row.body));
    },

    // thread 投影用：一次会话的事件按 seq 升序取，afterSeq 支持深链游标。
    listThread(threadId, { afterSeq = 0, limit = config.replay } = {}) {
      const thread = text(threadId, 100);
      if (!thread) return [];
      const cursor = Number.isSafeInteger(afterSeq) && afterSeq > 0 ? afterSeq : 0;
      const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 5000) : config.replay;
      return store.db.prepare(`SELECT body FROM entities WHERE kind='run-event'
          AND json_extract(body,'$.threadId')=? AND json_extract(body,'$.seq')>?
          ORDER BY json_extract(body,'$.seq') ASC LIMIT ?`).all(thread, cursor, size)
        .map(row => JSON.parse(row.body));
    },

    latestSeqForThread(threadId) {
      const thread = text(threadId, 100);
      if (!thread) return 0;
      const row = store.db.prepare("SELECT MAX(json_extract(body,'$.seq')) AS seq FROM entities WHERE kind='run-event' AND json_extract(body,'$.threadId')=?").get(thread);
      return row?.seq ?? 0;
    },

    oldestSeq({ ownerId: filterOwner = null } = {}) {
      const row = filterOwner
        ? store.db.prepare("SELECT MIN(json_extract(body,'$.seq')) AS seq FROM entities WHERE kind='run-event' AND json_extract(body,'$.ownerId')=?").get(filterOwner)
        : store.db.prepare("SELECT MIN(json_extract(body,'$.seq')) AS seq FROM entities WHERE kind='run-event'").get();
      return row?.seq ?? null;
    },

    latestSeq({ ownerId: filterOwner = null } = {}) {
      const row = filterOwner
        ? store.db.prepare("SELECT MAX(json_extract(body,'$.seq')) AS seq FROM entities WHERE kind='run-event' AND json_extract(body,'$.ownerId')=?").get(filterOwner)
        : store.db.prepare("SELECT MAX(json_extract(body,'$.seq')) AS seq FROM entities WHERE kind='run-event'").get();
      return row?.seq ?? null;
    },

    // 每 thread 保留最近 N 条 + 超过保留天数的清掉；只删旧事件，不动 seq 计数。
    // 配置了归档时先把要删的行交给归档器；归档失败则保留数据，宁可多占空间也不丢审计。
    prune({ perThread = config.perThread, maxAgeDays = config.maxAgeDays, now = Date.now() } = {}) {
      const run = () => {
        const archiveThenDelete = (selectSql, deleteSql, params) => {
          if (archive) {
            let rows;
            try { rows = store.db.prepare(selectSql).all(...params).map(row => JSON.parse(row.body)); }
            catch (error) { console.error('[run-events] 读取待归档事件失败', error?.message || error); return 0; }
            try { archive(rows); }
            catch (error) { console.error('[run-events] 归档失败，暂停本次清理', error?.message || error); return 0; }
          }
          return store.db.prepare(deleteSql).run(...params).changes || 0;
        };
        let threads = 0;
        if (Number.isSafeInteger(perThread) && perThread > 0) {
          threads = archiveThenDelete(
            `SELECT body FROM entities WHERE kind='run-event' AND rowid IN (
              SELECT rowid FROM (
                SELECT rowid, ROW_NUMBER() OVER (
                  PARTITION BY json_extract(body,'$.threadId')
                  ORDER BY json_extract(body,'$.seq') DESC
                ) AS rn FROM entities WHERE kind='run-event'
              ) WHERE rn > ?
            )`,
            `DELETE FROM entities WHERE kind='run-event' AND rowid IN (
              SELECT rowid FROM (
                SELECT rowid, ROW_NUMBER() OVER (
                  PARTITION BY json_extract(body,'$.threadId')
                  ORDER BY json_extract(body,'$.seq') DESC
                ) AS rn FROM entities WHERE kind='run-event'
              ) WHERE rn > ?
            )`,
            [perThread]
          );
        }
        let aged = 0;
        if (Number.isFinite(maxAgeDays) && maxAgeDays > 0) {
          const cutoff = new Date(now - maxAgeDays * 86400000).toISOString();
          aged = archiveThenDelete(
            "SELECT body FROM entities WHERE kind='run-event' AND json_extract(body,'$.createdAt')<?",
            "DELETE FROM entities WHERE kind='run-event' AND json_extract(body,'$.createdAt')<?",
            [cutoff]
          );
        }
        return { threads, aged };
      };
      return store.inTransaction ? run() : store.atomic(run);
    },

    // 后台维护：每 10 分钟清一次；进程退出时 unref，不会拖住测试。
    startMaintenance({ intervalMs = 10 * 60 * 1000 } = {}) {
      const timer = setInterval(() => { try { this.prune(); } catch { /* 维护失败不影响主流程。 */ } }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    stats() {
      const row = store.db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind='run-event'").get();
      return { count: row?.n || 0, oldestSeq: this.oldestSeq(), latestSeq: this.latestSeq() };
    },

    close() { runChats.clear(); }
  };
}
