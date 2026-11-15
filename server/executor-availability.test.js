import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acpExecutors } from './work/executors/acp.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-executor-availability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, store: {} };
}

test('探测不到 ACP 命令时仍然注册为不可用，而不是静默消失', t => {
  const { dir, store } = fixture(t);
  const list = acpExecutors({ store, cwd: dir, environment: { PATH: '' } });
  assert.deepEqual(list.map(executor => executor.id).sort(), ['claude-acp', 'codex-acp', 'dsh-acp']);
  assert.ok(list.every(executor => executor.available === false));
});

test('不可用的 ACP 执行器保留在注册表里，派发时给出明确拒绝', t => {
  const { dir, store } = fixture(t);
  const registry = createExecutorRegistry(acpExecutors({ store, cwd: dir, environment: { PATH: '' } }));
  const codex = registry.list().find(executor => executor.id === 'codex-acp');
  assert.equal(codex.available, false);
  assert.throws(() => registry.requireAvailable('codex-acp'), /当前不可用/);
});
