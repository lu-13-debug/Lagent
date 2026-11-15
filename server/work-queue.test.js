import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

const stamp = '2026-11-15T10:00:00.000Z';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-queue-'));
  const store = new Store(dir);
  const executor = { id: 'codex', name: 'Codex CLI', kind: 'cli', available: true, capabilities: [], start() { throw new Error('not used'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store };
}

test('bootstrap 返回并发占用，界面能解释为什么在排队', t => {
  const { engine, store } = fixture(t);
  store.put('work-assignment', { id: 'a1', ticketId: 't1', executor: 'codex', status: 'working', startedAt: stamp });
  store.put('work-assignment', { id: 'a2', ticketId: 't2', executor: 'codex', status: 'working', startedAt: stamp });
  store.put('work-ticket', { id: 't3', status: 'queued', executor: 'codex', title: '第三个任务', createdAt: stamp, updatedAt: stamp });
  assert.deepEqual(engine.bootstrap().queue, { maxConcurrent: 2, running: 2, queued: 1, full: true });
});

test('没有执行中的工单时不标记满载', t => {
  const { engine } = fixture(t);
  assert.deepEqual(engine.bootstrap().queue, { maxConcurrent: 2, running: 0, queued: 0, full: false });
});
