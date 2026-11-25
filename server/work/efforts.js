import { workError } from './domain.js';

export const EFFORTS = Object.freeze(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
const allowed = new Set(EFFORTS);
export const isEffort = value => typeof value === 'string' && allowed.has(value);

// 没有映射（桌面旧调用）→ 全局 effort；有映射 → 该 Agent 的档位，缺失则用 fallback。
export function agentEffort(efforts, agentId, fallback = 'default') {
  if (!efforts || typeof efforts !== 'object' || Array.isArray(efforts)) return isEffort(fallback) ? fallback : '';
  return isEffort(efforts[agentId]) ? efforts[agentId] : (isEffort(fallback) ? fallback : 'default');
}

export function normalizeEfforts(value, agentIds = []) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workError('efforts 必须是对象', 400);
  const wanted = new Set(Array.isArray(agentIds) ? agentIds.filter(id => typeof id === 'string' && id) : []);
  const result = {};
  for (const [key, effort] of Object.entries(value)) {
    if (wanted.size && !wanted.has(key)) continue;
    if (!isEffort(effort)) throw workError(`思考强度无效：${String(key).slice(0, 60)}`, 400);
    result[key] = effort;
  }
  return Object.keys(result).length ? result : null;
}
