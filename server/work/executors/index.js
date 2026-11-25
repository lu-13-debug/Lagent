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
    // 本机执行节点动态注册的执行器：探测清单里没有它们，但用户电脑上确实装了。
    nodeBacked: executor.__nodeBacked === true,
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
    // 本机执行节点连上来时才出现，断开后立刻消失；内置执行器在构造时就固定了。
    register(executor) {
      const publicMetadata = metadata(executor);
      if (entries.has(executor.id)) throw new TypeError(`执行器 id 重复：${executor.id}`);
      entries.set(executor.id, { executor, publicMetadata });
      return publicMetadata;
    },
    unregister(id) {
      const entry = entries.get(id);
      if (!entry) return false;
      try { entry.executor.close?.(); } catch { /* 清理失败不阻止移除。 */ }
      entries.delete(id);
      return true;
    },
    requireAvailable(id) {
      const entry = entries.get(id);
      if (!entry) throw workError('执行器不存在', 400);
      if (!entry.publicMetadata.available) throw workError(`执行器「${entry.publicMetadata.name}」当前不可用`, 400);
      return entry.executor;
    },
    // 把策略里的并发数下发给支持动态并发的执行器；不支持的执行器保持自身限制。
    setConcurrency(value) {
      for (const { executor } of entries.values()) {
        if (typeof executor.setConcurrency !== 'function') continue;
        try { executor.setConcurrency(value); } catch { /* 单个执行器拒绝不影响其它执行器。 */ }
      }
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
  // 兼容直接传单个执行器的调用方：注册成什么由它自己的 id 决定，不再默认当成数据分析。
  return createExecutorRegistry([{
    ...executor,
    id: executor?.id || 'executor',
    name: executor?.name || '执行器',
    kind: executor?.kind || 'cli',
    available: executor?.available !== false
  }]);
}