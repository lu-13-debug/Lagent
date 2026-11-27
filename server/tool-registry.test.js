import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createToolRegistry } from './work/tool-registry.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-tools-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const registry = createToolRegistry({
    store,
    listExecutors: () => [
      { id: 'model', name: 'Lagent', kind: 'model', available: true, capabilities: ['prompt'] },
      { id: 'terminal', name: '受控终端', kind: 'terminal', available: true, capabilities: [] }
    ],
    listSkills: () => [{ id: 's1', name: '发布说明', description: '生成变更记录', enabled: true }],
    listMcpServers: () => [{ id: 'fs', name: 'files', enabled: true, tools: ['read_file', { name: 'write_file' }] }]
  });
  return { store, registry };
}

test('工具注册表：合并内置、执行器、MCP 与技能，并给出统计', t => {
  const { registry } = fixture(t);
  const tools = registry.list();
  assert.equal(tools.filter(tool => tool.source === 'builtin').length, 4);
  assert.equal(tools.filter(tool => tool.source === 'executor').length, 2);
  assert.equal(tools.filter(tool => tool.source === 'mcp').length, 2);
  assert.equal(tools.filter(tool => tool.source === 'skill').length, 1);
  assert.ok(tools.every(tool => tool.enabled));

  const summary = registry.summary();
  assert.equal(summary.total, 9);
  assert.equal(summary.enabled, 9);
  assert.equal(summary.bySource.mcp, 2);
  assert.ok(summary.byRisk.high >= 2, '终端与窗口属于高风险');
  assert.equal(new Set(tools.map(tool => tool.id)).size, tools.length, 'id 不重复');
});

test('工具注册表：启停与风险级别落库，可恢复默认', t => {
  const { store, registry } = fixture(t);
  const terminal = registry.find('builtin:terminal');
  assert.equal(terminal.risk, 'high');

  const disabled = registry.setState('builtin:terminal', { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(registry.list({ enabled: true }).some(tool => tool.id === 'builtin:terminal'), false);
  assert.equal(registry.list({ enabled: false }).length, 1);

  const relaxed = registry.setState('builtin:terminal', { risk: 'medium' });
  assert.equal(relaxed.risk, 'medium');
  assert.equal(store.list('tool-state').length, 1);

  const restored = registry.removeState('builtin:terminal');
  assert.equal(restored.enabled, true);
  assert.equal(restored.risk, 'high');
  assert.equal(store.list('tool-state').length, 0);

  assert.throws(() => registry.find('missing:tool'), error => error.status === 404);
  assert.throws(() => registry.setState('missing:tool', { enabled: false }), error => error.status === 404);
});

test('工具注册表：停用的 MCP 服务器与技能仍列出，但标记不可用', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-tools-off-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const registry = createToolRegistry({
    store,
    listExecutors: () => [],
    listSkills: () => [{ id: 's1', name: '离线技能', enabled: false }],
    listMcpServers: () => [{ id: 'fs', name: 'files', enabled: false, tools: ['read_file'] }]
  });
  const tools = registry.list();
  assert.equal(tools.find(tool => tool.id === 'mcp:files:read_file').available, false);
  assert.equal(tools.find(tool => tool.id === 'skill:s1').available, false);
  assert.equal(registry.list({ source: 'mcp' }).length, 1);
});
