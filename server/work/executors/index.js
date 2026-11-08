import { workError } from '../domain.js';

const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);

function metadata(executor) {
  if (!executor || !identifier(executor.id)) throw new TypeError('执行器必须具有合法 id');
  if (typeof executor.name !== 'string' || !executor.name.trim()) throw new TypeError(`执行器 ${executor.id} 缺少名称`);
  const capabilities = Array.isArray(executor.capabilities)
    ? executor.capabilities.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];
  return Object.freeze({
    id: executor.id,
    name: executor.name.trim(),
    kind: typeof executor.kind === 'string' && executor.kind ? executor.kind : executor.id,
    available: executor.available !== false,
    capabilities: Object.freeze([...new Set(capabilities)])
  });
}

export function createExecutorRegistry(executors) {
  if (!Array.isArray(executors) || !executors.length) throw new TypeError('执行器注册表不能为空');
  const entries = new Map();
  for (const executor of executors) {
    const publicMetadata = metadata(executor);
    if (entries.has(executor.id)) throw new TypeError(`执行器 id 重复：${executor.id}`);
    entries.set(executor.id, { executor, publicMetadata });
  }
  const resolve = id => entries.get(id)?.executor || null;
  return Object.freeze({
    list: () => [...entries.values()].map(entry => ({ ...entry.publicMetadata, capabilities: [...entry.publicMetadata.capabilities] })),
    resolve,
    requireAvailable(id) {
      const entry = entries.get(id);
      if (!entry) throw workError('执行器不存在', 400);
      if (!entry.publicMetadata.available) throw workError(`执行器「${entry.publicMetadata.name}」当前不可用`, 400);
      return entry.executor;
    },
    close() {
      for (const { executor } of entries.values()) {
        try { executor.close?.(); } catch { /* Best-effort shutdown must not block others. */ }
      }
    }
  });
}

export function executorRegistry(executor) {
  if (executor && typeof executor.list === 'function' && typeof executor.resolve === 'function' && typeof executor.requireAvailable === 'function') return executor;
  return createExecutorRegistry([{
    ...executor,
    id: 'analysis',
    name: '数据分析',
    kind: 'analysis',
    available: true,
    capabilities: ['analysis', 'report'],
    requiresDataset: true
  }]);
}