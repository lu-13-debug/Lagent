import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

const stamp = '2026-11-15T10:00:00.000Z';

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-queue-'));
  const store = new Store(dir);
  const executor = { id: 'codex', name: 'Codex CLI', kind: 'cli', available: true, capabilities: [], start() { throw new Error('not used'); }, get() { return null; }, ...overrides };
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, {
    workspace: dir,
    outboxEnabled: true,
    policy: { allowedExecutors: ['analysis', 'terminal', 'codex'] },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }
  });
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

test('排队工单的 outbox 记录丢失后会被重新入队并启动', t => {
  const tasks = new Map();
  const { engine, store } = fixture(t, {
    start(ticket) {
      const task = { id: `task-${ticket.id}`, ticketId: ticket.id, status: 'running' };
      tasks.set(task.id, task);
      return task;
    },
    get(id) { return tasks.get(id) || null; }
  });
  store.put('work-ticket', { id: 't-orphan', status: 'queued', stage: 'launch', executor: 'codex', title: '孤立排队任务', createdAt: stamp, updatedAt: stamp });
  store.put('work-assignment', { id: 'a-orphan', ticketId: 't-orphan', executor: 'codex', status: 'queued', queuedAt: stamp });
  engine.recover();
  assert.equal(store.get('work-ticket', 't-orphan').status, 'working');
  assert.equal(store.list('work-effect').filter(effect => effect.ticketId === 't-orphan' && effect.status === 'done').length, 1);
});

test('排队工单的启动记录已失败时收尾，而不是无限重试', t => {
  const { engine, store } = fixture(t);
  store.put('work-ticket', { id: 't-failed-launch', status: 'queued', stage: 'launch', executor: 'codex', title: '启动失败任务', createdAt: stamp, updatedAt: stamp });
  store.put('work-assignment', { id: 'a-failed-launch', ticketId: 't-failed-launch', executor: 'codex', status: 'queued', queuedAt: stamp });
  store.put('work-effect', {
    id: 'e-failed-launch', kind: 'launch', key: 'launch:t-failed-launch:a-failed-launch',
    ticketId: 't-failed-launch', payload: { assignmentId: 'a-failed-launch' },
    status: 'failed', attempts: 4, nextAt: Date.now(), createdAt: stamp, updatedAt: stamp
  });
  engine.recover();
  assert.equal(store.get('work-ticket', 't-failed-launch').status, 'failed');
});
