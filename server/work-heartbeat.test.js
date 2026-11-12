import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t, { heartbeatStaleMs = 60 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-heartbeat-'));
  const store = new Store(dir);
  const tasks = new Map();
  const executor = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      const task = { id: assignment.id, status: 'running', goal: ticket.command, artifacts: {} };
      tasks.set(assignment.id, task);
      return task;
    },
    get(id) { return id ? tasks.get(id) || null : null; },
    stop(task) { task.status = 'cancelled'; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, { workspace: dir, heartbeatStaleMs });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, tasks };
}

test('执行开始时写入心跳，未超阈值不标 stalled', t => {
  const { engine } = fixture(t, { heartbeatStaleMs: 10000 });
  const ticket = engine.command({ text: '长任务', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } });
  assert.equal(ticket.status, 'working');
  const detail = engine.detail(ticket.id);
  assert.equal(detail.ticket.status, 'working');
  assert.ok(detail.assignments[0].heartbeatAt);
  assert.equal(detail.assignments[0].stalled, undefined);
  assert.equal(detail.ticket.stalled, undefined);
});

test('超过阈值没有心跳时标记 stalled，activity 刷新后恢复', async t => {
  const { engine, store, tasks } = fixture(t, { heartbeatStaleMs: 80 });
  const ticket = engine.command({ text: '可能卡死', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } });
  const firstBeat = engine.detail(ticket.id).assignments[0].heartbeatAt;
  assert.ok(firstBeat);

  await wait(140);
  const stale = engine.detail(ticket.id);
  assert.equal(stale.ticket.stalled, true);
  assert.equal(stale.assignments[0].stalled, true);

  // 执行器还在写 activity：触发一次 store 变更，reconcile 会刷新心跳。
  const task = tasks.get(engine.detail(ticket.id).assignments[0].sessionId);
  task.activity = [{ kind: 'tool', text: 'still working', at: new Date().toISOString() }];
  store.put('task', task);
  await wait(60);
  const fresh = engine.detail(ticket.id);
  assert.ok(fresh.assignments[0].heartbeatAt > firstBeat);
  assert.equal(fresh.ticket.stalled, undefined);
  assert.equal(fresh.assignments[0].stalled, undefined);
});
