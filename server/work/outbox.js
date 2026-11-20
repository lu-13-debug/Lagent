import { randomUUID } from 'node:crypto';
import { idempotencyKey as makeIdempotencyKey } from './transaction.js';

export const EFFECT_KINDS = Object.freeze({
  launch: 'launch',
  verify: 'verify',
  notify: 'notify',
  publish: 'publish',
  memory: 'memory'
});

export const WORK_EFFECT_KIND = EFFECT_KINDS.launch;
export const OUTBOX_BASE_DELAY_MS = 2000;
export const OUTBOX_MAX_RETRIES = 3;

const clone = value => JSON.parse(JSON.stringify(value));

function timestamp(value = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'function') return timestamp(value());
  if (typeof value?.now === 'function') return timestamp(value.now());
  if (typeof value?.now === 'number') return timestamp(value.now);
  throw new TypeError('outbox 时间必须是毫秒时间戳');
}

function optionsAt(options, fallback, explicit) {
  if (explicit !== undefined) return timestamp(explicit);
  if (typeof options === 'number' || options instanceof Date) return timestamp(options);
  return timestamp(options?.now ?? fallback);
}

const atomically = (store, operation) => {
  if (store.inTransaction) return operation();
  return store.atomic(operation);
};

function requiredString(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${label} 必须是非空字符串`);
  return value.trim();
}

export function sanitizeOutboxError(error) {
  const status = Number.isSafeInteger(error?.status) ? error.status : null;
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : null;
  if (code && status) return `执行器启动失败（${code}/${status}）`;
  if (code) return `执行器启动失败（${code}）`;
  if (status) return `执行器启动失败（状态 ${status}）`;
  return '执行器启动失败';
}

export function outboxRetryDelay(attempts) {
  const count = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  return OUTBOX_BASE_DELAY_MS * (2 ** (count - 1));
}

export function enqueue(store, input, options = {}) {
  const now = optionsAt(options, Date.now());
  const kind = requiredString(input?.kind || WORK_EFFECT_KIND, 'kind', 40);
  const key = requiredString(input?.key, 'key', 200);
  const ticketId = requiredString(input?.ticketId, 'ticketId', 100);
  const stepId = typeof input?.stepId === 'string' && input.stepId.trim() ? input.stepId.trim().slice(0, 100) : null;
  // 优先级越小越先执行：用户交互 0 > 系统回报 1 > routine 2。
  const priority = Number.isSafeInteger(input?.priority) ? Math.max(0, Math.min(9, input.priority)) : 0;
  const attempt = Number.isSafeInteger(input?.attempt) && input.attempt > 0 ? input.attempt : 1;
  const idempotencyKey = typeof input?.idempotencyKey === 'string' && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim().slice(0, 200)
    : makeIdempotencyKey({ ticketId, stepId, attempt, kind, key });
  if (!input?.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new TypeError('payload 必须是对象');
  const payload = clone(input.payload);
  return atomically(store, () => {
    const effects = store.list('work-effect');
    const exact = effects.find(effect => effect.idempotencyKey === idempotencyKey);
    // 兼容旧记录：没有幂等键时按 kind + key 找；同一 key 的第二次 attempt 视为新副作用。
    const existing = exact || (attempt === 1 ? effects.find(effect => !effect.idempotencyKey && effect.kind === kind && effect.key === key) : null);
    // 同一幂等键已经执行完，就不再产生第二次副作用。
    if (exact && exact.status === 'done') return exact;
    const stamp = new Date(now).toISOString();
    const effect = existing
      ? { ...existing, ticketId, stepId, priority, attempt, idempotencyKey, payload, status: 'pending', nextAt: now, lastError: null, updatedAt: stamp }
      : {
          id: randomUUID(),
          kind,
          key,
          ticketId,
          stepId,
          priority,
          attempt,
          idempotencyKey,
          payload,
          status: 'pending',
          attempts: 0,
          nextAt: now,
          lastError: null,
          createdAt: stamp,
          updatedAt: stamp
        };
    store.put('work-effect', effect);
    return effect;
  });
}

export function claimDue(store, limitOrOptions = 10, explicitNow) {
  const options = typeof limitOrOptions === 'object' && !(limitOrOptions instanceof Date) ? limitOrOptions : {};
  const limit = typeof limitOrOptions === 'number' ? limitOrOptions : options.limit ?? 10;
  const kind = options.kind ?? WORK_EFFECT_KIND;
  // 同一工单同时最多跑 N 个 effect，避免一个长任务把队列占满。
  const maxPerTicket = Number.isSafeInteger(options.maxPerTicket) && options.maxPerTicket > 0 ? options.maxPerTicket : 1;
  const now = optionsAt(options, Date.now(), explicitNow);
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('limit 必须是非负整数');
  return atomically(store, () => {
    const all = store.list('work-effect');
    const runningByTicket = new Map();
    for (const effect of all) {
      if (effect.kind !== kind || effect.status !== 'running') continue;
      runningByTicket.set(effect.ticketId, (runningByTicket.get(effect.ticketId) || 0) + 1);
    }
    const order = all
      .filter(effect => effect.kind === kind && effect.status === 'pending' && effect.nextAt <= now)
      .sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0)
        || left.nextAt - right.nextAt
        || left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id));
    // 同一批里也要算上刚领走的 effect，否则同一工单会在一批内被领走多个。
    const picked = [];
    const pickedByTicket = new Map();
    for (const effect of order) {
      if (picked.length >= limit) break;
      const inFlight = (runningByTicket.get(effect.ticketId) || 0) + (pickedByTicket.get(effect.ticketId) || 0);
      if (inFlight >= maxPerTicket) continue;
      picked.push(effect);
      pickedByTicket.set(effect.ticketId, (pickedByTicket.get(effect.ticketId) || 0) + 1);
    }
    return picked.map(effect => {
      const claimed = {
        ...effect,
        status: 'running',
        attempts: (Number.isSafeInteger(effect.attempts) ? effect.attempts : 0) + 1,
        updatedAt: new Date(now).toISOString()
      };
      store.put('work-effect', claimed);
      return claimed;
    });
  });
}

export function complete(store, id, options = {}) {
  const now = optionsAt(options, Date.now());
  return atomically(store, () => {
    const effect = store.get('work-effect', id);
    if (!effect) return null;
    if (effect.status === 'done') return effect;
    const done = { ...effect, status: 'done', lastError: null, updatedAt: new Date(now).toISOString() };
    store.put('work-effect', done);
    return done;
  });
}

export function fail(store, id, error, options = {}) {
  const now = optionsAt(options, Date.now());
  return atomically(store, () => {
    const effect = store.get('work-effect', id);
    if (!effect) return null;
    if (effect.status === 'done' || effect.status === 'failed') return effect;
    const attempts = Number.isSafeInteger(effect.attempts) ? effect.attempts : 1;
    const retry = attempts <= OUTBOX_MAX_RETRIES;
    const failed = {
      ...effect,
      status: retry ? 'pending' : 'failed',
      nextAt: retry ? now + outboxRetryDelay(attempts) : effect.nextAt,
      lastError: sanitizeOutboxError(error),
      updatedAt: new Date(now).toISOString()
    };
    store.put('work-effect', failed);
    return failed;
  });
}

export function cancel(store, id, options = {}) {
  const now = optionsAt(options, Date.now());
  return atomically(store, () => {
    const effect = store.get('work-effect', id);
    if (!effect || effect.status === 'done' || effect.status === 'failed') return effect;
    const done = { ...effect, status: 'done', lastError: null, updatedAt: new Date(now).toISOString() };
    store.put('work-effect', done);
    return done;
  });
}

export function cancelTicketEffects(store, ticketId, options = {}) {
  const now = optionsAt(options, Date.now());
  return atomically(store, () => store.list('work-effect')
    .filter(effect => effect.ticketId === ticketId && ['pending', 'running'].includes(effect.status))
    .map(effect => {
      const done = { ...effect, status: 'done', lastError: null, updatedAt: new Date(now).toISOString() };
      store.put('work-effect', done);
      return done;
    }));
}

export function recoverRunningEffects(store, options = {}) {
  const now = optionsAt(options, Date.now());
  return atomically(store, () => store.list('work-effect')
    .filter(effect => effect.status === 'running')
    .map(effect => {
      const attempts = Number.isSafeInteger(effect.attempts) ? effect.attempts : 1;
      const recovered = attempts <= 1
        ? { ...effect, status: 'pending', nextAt: now, lastError: '服务重启后重新排队', updatedAt: new Date(now).toISOString() }
        : { ...effect, status: 'failed', lastError: '服务重启恢复重试失败', updatedAt: new Date(now).toISOString() };
      store.put('work-effect', recovered);
      return recovered;
    }));
}

export function effectForLaunch(store, ticketId, assignmentId) {
  return store.list('work-effect').find(effect => effect.kind === WORK_EFFECT_KIND && effect.ticketId === ticketId
    && effect.payload?.assignmentId === assignmentId && ['pending', 'running'].includes(effect.status)) || null;
}

export function listEffects(store, options = {}) {
  const ticketId = options.ticketId;
  const kind = options.kind;
  const status = options.status;
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : 200;
  return store.list('work-effect')
    .filter(effect => {
      if (ticketId && effect.ticketId !== ticketId) return false;
      if (kind && effect.kind !== kind) return false;
      if (status && effect.status !== status) return false;
      return true;
    })
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
    .slice(0, limit);
}

export function retryEffect(store, id, options = {}) {
  const now = optionsAt(options, Date.now());
  return atomically(store, () => {
    const effect = store.get('work-effect', id);
    if (!effect) {
      const error = new TypeError('effect 不存在');
      error.status = 404;
      throw error;
    }
    if (!['pending', 'running'].includes(effect.status) && effect.status !== 'failed') {
      const error = new TypeError('只有 pending、running 或 failed 的 effect 可以重试');
      error.status = 409;
      throw error;
    }
    const reset = { ...effect, status: 'pending', nextAt: now, attempts: 0, lastError: null, updatedAt: new Date(now).toISOString() };
    store.put('work-effect', reset);
    return reset;
  });
}
