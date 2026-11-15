import { randomUUID } from 'node:crypto';
import { vaultError } from './credential-vault.js';

// Provider/Key 池：一个池绑定同一提供商、同一接口地址与协议的多把 Key。
// 只保存凭据 ID，不复制或缓存明文 Key；运行时状态（冷却、配额、延迟）只在内存中维护。
export const POOL_STRATEGIES = Object.freeze(['priority', 'round-robin', 'least-failed', 'cheapest']);
const MAX_POOLS = 50;
const MAX_MEMBERS = 20;
const MAX_ATTEMPTS = 5;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const ISOLATE = new Set([401, 403]);

const text = (value, label, max = 80) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\r\n]/.test(value)) throw vaultError(`${label}格式无效`);
  return value.trim();
};
const publicMember = (member, runtime = {}) => ({
  credentialId: member.credentialId,
  weight: member.weight,
  dailyCalls: member.dailyCalls,
  priority: member.priority,
  costPer1k: member.costPer1k,
  ...(member.keyHint ? { keyHint: member.keyHint } : {}),
  ...(runtime.cooldownUntil > Date.now() ? { coolingUntil: new Date(runtime.cooldownUntil).toISOString() } : {}),
  ...(runtime.failures ? { failures: runtime.failures } : {}),
  ...(runtime.lastError ? { lastError: runtime.lastError } : {}),
  ...(runtime.usedToday ? { usedToday: runtime.usedToday } : {})
});
const publicPool = row => ({
  id: row.id,
  name: row.name,
  provider: row.provider,
  baseUrl: row.baseUrl,
  protocol: row.protocol,
  strategy: row.strategy,
  maxAttempts: row.maxAttempts,
  cooldownMs: row.cooldownMs,
  version: row.version || 1,
  members: (row.members || []).map(member => publicMember(member)),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export function createProviderPool({ store, vault, ownerId = 'local', now = Date.now, fetchImpl = fetch } = {}) {
  if (!store || !vault) throw new TypeError('Provider 池需要 store 与凭据库');
  const configKey = `provider-pool-v1:${ownerId}`;
  const runtime = new Map(); // `${poolId}:${credentialId}` -> { failures, cooldownUntil, usedDay, usedToday, lastError, lastUsedAt, goodAffinity }
  const cursor = new Map(); // poolId -> round-robin index
  const affinityGood = new Map(); // `${poolId}:${affinity}` -> credentialId

  const rows = () => store.config(configKey) || [];
  const find = id => {
    const row = rows().find(item => item.id === id);
    if (!row) throw vaultError('Provider 池不存在', 404);
    return row;
  };
  const stateOf = (poolId, credentialId) => {
    const key = `${poolId}:${credentialId}`;
    let state = runtime.get(key);
    if (!state) { state = { failures: 0, cooldownUntil: 0, usedDay: '', usedToday: 0, lastError: '', lastUsedAt: 0 }; runtime.set(key, state); }
    const day = new Date(now()).toISOString().slice(0, 10);
    if (state.usedDay !== day) { state.usedDay = day; state.usedToday = 0; }
    return state;
  };

  function normalizeMembers(input, base) {
    const raw = Array.isArray(input) ? input : [];
    if (!raw.length || raw.length > MAX_MEMBERS) throw vaultError(`Key 池需要 1–${MAX_MEMBERS} 个成员`);
    const members = [];
    for (const [index, item] of raw.entries()) {
      const value = typeof item === 'string' ? { credentialId: item } : (item && typeof item === 'object' && !Array.isArray(item) ? item : null);
      if (!value) throw vaultError('Key 池成员格式无效');
      const credentialId = text(value.credentialId, '凭据 ID', 100);
      if (members.some(member => member.credentialId === credentialId)) continue;
      const weight = value.weight === undefined ? 1 : Number(value.weight);
      if (!Number.isFinite(weight) || weight < 1 || weight > 100) throw vaultError('权重必须在 1–100 之间');
      const dailyCalls = value.dailyCalls === undefined || value.dailyCalls === null || value.dailyCalls === ''
        ? 0
        : Number(value.dailyCalls);
      if (!Number.isSafeInteger(dailyCalls) || dailyCalls < 0 || dailyCalls > 1_000_000) throw vaultError('每日配额必须是 0–1000000 的整数');
      const priority = value.priority === undefined ? index : Number(value.priority);
      if (!Number.isSafeInteger(priority) || priority < 0 || priority > 1000) throw vaultError('优先级必须是 0–1000 的整数');
      const costPer1k = value.costPer1k === undefined || value.costPer1k === null || value.costPer1k === ''
        ? 0
        : Number(value.costPer1k);
      if (!Number.isFinite(costPer1k) || costPer1k < 0 || costPer1k > 1000) throw vaultError('每千 Token 成本无效');
      let credential;
      try { credential = vault.get(credentialId); } catch { throw vaultError(`凭据不存在：${credentialId}`, 404); }
      members.push({ credentialId, weight, dailyCalls, priority, costPer1k, keyHint: credential.keyHint });
    }
    if (!members.length) throw vaultError('Key 池至少需要一个有效的凭据');
    const first = vault.get(members[0].credentialId);
    for (const member of members.slice(1)) {
      const credential = vault.get(member.credentialId);
      if (credential.baseUrl !== first.baseUrl || credential.protocol !== first.protocol || credential.provider !== first.provider) {
        throw vaultError('同一 Key 池中的凭据必须使用相同的提供商、接口地址与协议');
      }
    }
    return { members, provider: first.provider, baseUrl: first.baseUrl, protocol: first.protocol };
  }

  function save(input = {}) {
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : '';
    const current = id ? find(id) : null;
    if (!current && rows().length >= MAX_POOLS) throw vaultError(`最多创建 ${MAX_POOLS} 个 Key 池`, 429);
    const name = text(input.name ?? current?.name, 'Key 池名称', 80);
    const normalized = normalizeMembers(input.members ?? current?.members, current);
    const strategy = input.strategy ?? current?.strategy ?? 'priority';
    if (!POOL_STRATEGIES.includes(strategy)) throw vaultError('路由策略仅支持 priority/round-robin/least-failed/cheapest');
    const maxAttempts = Number(input.maxAttempts ?? current?.maxAttempts ?? 3);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) throw vaultError(`最多尝试次数为 1–${MAX_ATTEMPTS}`);
    const cooldownMs = Number(input.cooldownMs ?? current?.cooldownMs ?? 60000);
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 5000 || cooldownMs > 24 * 60 * 60 * 1000) throw vaultError('冷却时间必须在 5 秒到 24 小时之间');
    const stamp = new Date(now()).toISOString();
    const row = {
      id: current?.id || randomUUID(),
      name,
      provider: normalized.provider,
      baseUrl: normalized.baseUrl,
      protocol: normalized.protocol,
      strategy,
      maxAttempts,
      cooldownMs,
      members: normalized.members,
      version: (current?.version || 0) + 1,
      createdAt: current?.createdAt || stamp,
      updatedAt: stamp
    };
    store.config(configKey, current ? rows().map(item => item.id === current.id ? row : item) : [...rows(), row]);
    return publicPool(row);
  }

  function remove(id) {
    const row = find(id);
    store.config(configKey, rows().filter(item => item.id !== row.id));
    for (const key of runtime.keys()) if (key.startsWith(`${row.id}:`)) runtime.delete(key);
    for (const key of affinityGood.keys()) if (key.startsWith(`${row.id}:`)) affinityGood.delete(key);
    return { ok: true, id: row.id };
  }

  function remaining(member, state) {
    return member.dailyCalls > 0 ? Math.max(0, member.dailyCalls - state.usedToday) : Infinity;
  }

  function available(member, state, current) {
    if (state.cooldownUntil > current) return false;
    return remaining(member, state) > 0;
  }

  function choose(row, members, exclude, affinity) {
    const current = now();
    const candidates = members.filter(member => !exclude.has(member.credentialId) && available(member, stateOf(row.id, member.credentialId), current));
    if (!candidates.length) return null;
    const preferred = affinity ? affinityGood.get(`${row.id}:${affinity}`) : '';
    if (preferred) {
      const match = candidates.find(member => member.credentialId === preferred);
      if (match) return { member: match, reason: '复用缓存亲和 Key' };
    }
    if (row.strategy === 'priority') return { member: candidates.slice().sort((a, b) => a.priority - b.priority)[0], reason: '按优先级选择' };
    if (row.strategy === 'cheapest') return { member: candidates.slice().sort((a, b) => a.costPer1k - b.costPer1k || a.priority - b.priority)[0], reason: '按每千 Token 成本选择' };
    if (row.strategy === 'least-failed') {
      return { member: candidates.slice().sort((a, b) => stateOf(row.id, a.credentialId).failures - stateOf(row.id, b.credentialId).failures || stateOf(row.id, a.credentialId).lastUsedAt - stateOf(row.id, b.credentialId).lastUsedAt)[0], reason: '选择失败次数最少的 Key' };
    }
    // 加权轮询：按权重展开后取当前游标，权重越大命中越多。
    const expanded = candidates.flatMap(member => Array.from({ length: Math.min(member.weight, 100) }, () => member));
    const index = (cursor.get(row.id) || 0) % expanded.length;
    cursor.set(row.id, index + 1);
    return { member: expanded[index], reason: '加权轮询' };
  }

  function lease(poolId, { exclude = new Set(), affinity = '', model = '' } = {}) {
    const row = find(poolId);
    const picked = choose(row, row.members, exclude instanceof Set ? exclude : new Set(exclude), affinity);
    if (!picked) {
      // 全部 Key 都在冷却或配额耗尽：给出最早恢复时间，调用方可以决定排队或报错。
      const current = now();
      const waits = row.members.map(member => Math.max(0, stateOf(row.id, member.credentialId).cooldownUntil - current));
      const retryAfter = waits.length ? Math.min(...waits) : row.cooldownMs;
      throw Object.assign(vaultError('所有 Key 都在冷却或已达配额，请稍后再试', 429), { retryAfter: Math.max(1, Math.ceil(retryAfter / 1000)), poolId: row.id });
    }
    const member = picked.member;
    let credential;
    try { credential = vault.get(member.credentialId); } catch { throw vaultError('池中的凭据已被删除，请更新 Key 池', 409); }
    if (credential.baseUrl !== row.baseUrl || credential.protocol !== row.protocol) throw vaultError('凭据与 Key 池接口绑定不匹配，请重新保存 Key 池', 409);
    return {
      poolId: row.id,
      poolName: row.name,
      credentialId: member.credentialId,
      credentialVersion: credential.version,
      keyHint: credential.keyHint,
      key: vault.decrypt(member.credentialId, credential.version),
      settings: { provider: row.provider, baseUrl: row.baseUrl, protocol: row.protocol, ...(model ? { model } : {}) },
      reason: picked.reason,
      strategy: row.strategy,
      maxAttempts: row.maxAttempts,
      ...(affinity ? { affinity } : {}),
      ...(model ? { model } : {})
    };
  }

  function report(leaseValue, { ok, status = 0, error = '', latencyMs = 0 } = {}) {
    if (!leaseValue?.poolId || !leaseValue?.credentialId) return;
    const state = stateOf(leaseValue.poolId, leaseValue.credentialId);
    const row = find(leaseValue.poolId);
    state.usedToday++;
    state.lastUsedAt = now();
    if (ok) {
      state.failures = 0;
      state.cooldownUntil = 0;
      state.lastError = '';
      if (leaseValue.affinity) affinityGood.set(`${leaseValue.poolId}:${leaseValue.affinity}`, leaseValue.credentialId);
    } else {
      state.failures++;
      state.lastError = String(error || `HTTP ${status}`).slice(0, 200);
      if (RETRYABLE.has(status) || ISOLATE.has(status)) {
        const base = ISOLATE.has(status) ? Math.max(row.cooldownMs, 10 * 60 * 1000) : row.cooldownMs;
        const factor = Math.min(2 ** Math.max(0, state.failures - 1), 16);
        state.cooldownUntil = now() + Math.min(base * factor, 24 * 60 * 60 * 1000);
      }
    }
    try {
      store.put('model-route', {
        id: randomUUID(),
        poolId: leaseValue.poolId,
        credentialId: leaseValue.credentialId,
        provider: row.provider,
        model: leaseValue.settings?.model || '',
        status: ok ? 200 : Number(status) || 0,
        ok: Boolean(ok),
        latencyMs: Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0,
        error: String(error || '').slice(0, 200),
        at: new Date(now()).toISOString()
      });
      const all = store.list('model-route');
      for (const stale of all.slice(2000)) store.delete('model-route', stale.id);
    } catch { /* 路由日志失败不能影响模型请求。 */ }
  }

  // 401/403 说明这把 Key 失效，隔离后换下一把；400/422/404 是参数或模型问题，换 Key 也没用。
  function shouldRetryStatus(status) { return RETRYABLE.has(status) || ISOLATE.has(status); }

  // 执行一次带故障转移的请求。attempt 收到 { key, settings, lease }，返回 Response 或任意结果。
  // 返回 { result, attempts, lease }；不重试 400/422/404 这类参数错误。
  async function execute(poolId, attempt, options = {}) {
    const row = find(poolId);
    const maxAttempts = Math.min(MAX_ATTEMPTS, Number.isSafeInteger(options.maxAttempts) ? options.maxAttempts : row.maxAttempts);
    const exclude = new Set();
    let lastError = null;
    let attempts = 0;
    for (let index = 0; index < maxAttempts; index++) {
      let leaseValue;
      try {
        leaseValue = lease(poolId, { exclude, affinity: options.affinity || '', model: options.model || '' });
      } catch (error) {
        if (lastError) throw Object.assign(lastError, { poolAttempts: attempts, poolId, cause: error });
        throw error;
      }
      const started = now();
      attempts++;
      try {
        const result = await attempt({ key: leaseValue.key, settings: leaseValue.settings, lease: leaseValue });
        // 允许调用方返回原始 Response，或包一层 { response, request } 以保留协议信息。
        const responseLike = result && typeof result === 'object' && result.response && typeof result.response.ok === 'boolean' ? result.response : result;
        if (responseLike && typeof responseLike === 'object' && responseLike.ok === false) {
          const status = Number(responseLike.status) || 0;
          report(leaseValue, { ok: false, status, error: `HTTP ${status}`, latencyMs: now() - started });
          // 保留原始响应，调用方仍需读取错误正文判断是参数不兼容还是模型不存在。
          lastError = Object.assign(new Error(`模型服务返回 HTTP ${status}`), { status, poolStatus: status, poolId, poolAttempts: attempts, response: responseLike });
          if (!shouldRetryStatus(status)) throw lastError;
          exclude.add(leaseValue.credentialId);
          continue;
        }
        report(leaseValue, { ok: true, status: 200, latencyMs: now() - started });
        return { result, attempts, lease: leaseValue };
      } catch (error) {
        if (error?.status && !shouldRetryStatus(error.status)) {
          report(leaseValue, { ok: false, status: error.status, error: error.message, latencyMs: now() - started });
          throw Object.assign(error, { poolAttempts: attempts, poolId });
        }
        // 网络异常也换 Key；调用方仍可以从最后一个 error 判断原因。
        report(leaseValue, { ok: false, status: Number(error?.status) || 0, error: error?.message || '请求失败', latencyMs: now() - started });
        lastError = error;
        exclude.add(leaseValue.credentialId);
      }
    }
    throw Object.assign(lastError || vaultError('Key 池请求失败', 502), { poolAttempts: attempts, poolId });
  }

  function explain(poolId) {
    const row = find(poolId);
    const current = now();
    const members = row.members.map(member => {
      const state = stateOf(row.id, member.credentialId);
      const cooling = state.cooldownUntil > current;
      const quota = remaining(member, state);
      const status = cooling ? 'cooling' : quota <= 0 ? 'quota' : 'ready';
      return {
        credentialId: member.credentialId,
        keyHint: member.keyHint,
        weight: member.weight,
        priority: member.priority,
        costPer1k: member.costPer1k,
        usedToday: state.usedToday,
        dailyCalls: member.dailyCalls,
        failures: state.failures,
        status,
        ...(cooling ? { coolingUntil: new Date(state.cooldownUntil).toISOString() } : {}),
        ...(state.lastError ? { lastError: state.lastError } : {})
      };
    });
    const ready = members.filter(member => member.status === 'ready');
    return {
      poolId: row.id,
      name: row.name,
      strategy: row.strategy,
      reason: row.strategy === 'priority' ? '按优先级顺序使用，失败或限流后自动切换'
        : row.strategy === 'cheapest' ? '在可用 Key 中选择每千 Token 成本最低的'
          : row.strategy === 'least-failed' ? '选择失败次数最少、最近未使用的 Key'
            : '按权重轮询，权重越高分配越多',
      ready: ready.length,
      members
    };
  }

  return {
    list: () => rows().map(publicPool),
    get: id => publicPool(find(id)),
    save,
    remove,
    lease,
    report,
    execute,
    explain,
    state: poolId => ({
      poolId,
      members: find(poolId).members.map(member => {
        const state = stateOf(poolId, member.credentialId);
        return { credentialId: member.credentialId, failures: state.failures, usedToday: state.usedToday, cooldownUntil: state.cooldownUntil || null };
      })
    })
  };
}
