import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import {
  cancelTicketEffects,
  claimDue,
  complete,
  enqueue,
  fail,
  OUTBOX_BASE_DELAY_MS,
  recoverRunningEffects,
  sanitizeOutboxError
} from './work/outbox.js';

function tempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-outbox-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function dataset(id = 'dataset-one') {
  return { id, name: `数据集 ${id}`, rowCount: 10, source: 'upload', records: [], privateToken: 'must-not-leak' };
}

function fixture(t, { outboxEnabled = true, startError } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-outbox-engine-'));
  const store = new Store(dir);
  store.put('dataset', dataset());
  let engine;
  const starts = [];
  const executor = {
    id: 'analysis',
    name: '测试分析',
    kind: 'analysis',
    available: true,
    requiresDataset: true,
    capabilities: ['analysis'],
    start(ticket, assignment, input) {
      starts.push({ ticketId: ticket.id, assignmentId: assignment.id, input });
      if (startError) throw startError(starts.length);
      const task = { id: assignment.id, workAssignmentId: assignment.id, status: 'running', goal: ticket.command };
      store.put('task', task);
      return task;
    },
    get: id => id && store.get('task', id),
    resume() {},
    stop(task) { if (task) store.put('task', { ...task, status: 'cancelled' }); }
  };
  const open = () => createWorkEngine(store, createExecutorRegistry([executor]), () => {}, {
    outboxEnabled,
    outboxPollMs: 60_000
  });
  engine = open();
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    store,
    starts,
    get engine() { return engine; },
    restart() { engine.close(); engine = open(); return engine; }
  };
}

test('E5 outbox enqueue 去重覆盖 payload，claimDue 按到期时间稳定排序并计数', t => {
  const store = tempStore(t);
  const first = enqueue(store, { key: 'same', ticketId: 'ticket-a', payload: { value: 1, secret: 'old' } }, { now: 200 });
  const updated = enqueue(store, { key: 'same', ticketId: 'ticket-a', payload: { value: 2 } }, { now: 200 });
  assert.equal(updated.id, first.id);
  assert.deepEqual(updated.payload, { value: 2 });
  assert.equal(updated.status, 'pending');
  assert.equal(updated.nextAt, 200);

  const later = enqueue(store, { key: 'later', ticketId: 'ticket-b', payload: { value: 3 } }, { now: 250 });
  const due = claimDue(store, { limit: 1, now: 250 });
  assert.equal(due.length, 1);
  assert.equal(due[0].id, updated.id);
  assert.equal(due[0].status, 'running');
  assert.equal(due[0].attempts, 1);
  assert.deepEqual(claimDue(store, { limit: 10, now: 249 }), []);
  const second = claimDue(store, { limit: 10, now: 250 });
  assert.equal(second[0].id, later.id);
  assert.equal(complete(store, due[0].id, { now: 300 }).status, 'done');
});

test('E5 outbox 失败使用 2s/4s/8s 退避并在重试耗尽后 failed', t => {
  const store = tempStore(t);
  const effect = enqueue(store, { key: 'retry', ticketId: 'ticket', payload: {} }, { now: 0 });
  let current = claimDue(store, { limit: 1, now: 0 })[0];
  assert.equal(current.attempts, 1);

  current = fail(store, current.id, { code: 'E_LAUNCH', status: 503 }, { now: 100 });
  assert.equal(current.status, 'pending');
  assert.equal(current.nextAt, 100 + OUTBOX_BASE_DELAY_MS);
  assert.equal(claimDue(store, { limit: 1, now: current.nextAt - 1 }).length, 0);

  current = claimDue(store, { limit: 1, now: current.nextAt })[0];
  current = fail(store, current.id, { code: 'E_LAUNCH', status: 503 }, { now: 200 });
  assert.equal(current.attempts, 2);
  assert.equal(current.nextAt, 200 + OUTBOX_BASE_DELAY_MS * 2);

  current = claimDue(store, { limit: 1, now: current.nextAt })[0];
  current = fail(store, current.id, { code: 'E_LAUNCH', status: 503 }, { now: 300 });
  assert.equal(current.attempts, 3);
  assert.equal(current.nextAt, 300 + OUTBOX_BASE_DELAY_MS * 4);

  current = claimDue(store, { limit: 1, now: current.nextAt })[0];
  current = fail(store, current.id, { code: 'E_LAUNCH', status: 503 }, { now: 400 });
  assert.equal(current.attempts, 4);
  assert.equal(current.status, 'failed');
  assert.doesNotMatch(current.lastError, /prompt|token|output/i);
});

test('E5 outbox 重启恢复 running 一次，二次崩溃直接 failed，并支持取消', t => {
  const store = tempStore(t);
  const effect = enqueue(store, { key: 'recover', ticketId: 'ticket', payload: {} }, { now: 0 });
  claimDue(store, { limit: 1, now: 0 });
  const recovered = recoverRunningEffects(store, { now: 10 });
  assert.equal(recovered[0].status, 'pending');
  assert.equal(recovered[0].attempts, 1);
  const second = claimDue(store, { limit: 1, now: 10 })[0];
  assert.equal(second.attempts, 2);
  const failed = recoverRunningEffects(store, { now: 20 })[0];
  assert.equal(failed.status, 'failed');

  const cancellable = enqueue(store, { key: 'cancel', ticketId: 'ticket', payload: {} }, { now: 20 });
  const cancelled = cancelTicketEffects(store, 'ticket', { now: 30 });
  assert.ok(cancelled.some(item => item.id === cancellable.id && item.status === 'done'));
  assert.equal(cancelTicketEffects(store, 'ticket', { now: 31 }).length, 0);
  assert.equal(effect.kind, 'launch');
});

test('E5 outbox 错误脱敏不保留 prompt、token 或原始输出', () => {
  const error = Object.assign(new Error('prompt=private token=secret raw output PRIVATE'), { status: 503, code: 'UPSTREAM_FAILED' });
  const safe = sanitizeOutboxError(error);
  assert.equal(safe, '执行器启动失败（UPSTREAM_FAILED/503）');
  assert.doesNotMatch(safe, /private|secret|output/i);
});

test('E5 Engine 默认关闭保持同步启动，开启后 approve 仅入队并由 drainOutbox 执行一次', t => {
  const direct = fixture(t, { outboxEnabled: false });
  const directTicket = direct.engine.command({ text: '默认同步路径' });
  assert.equal(direct.engine.action(directTicket.id, 'approve').status, 'working');
  assert.equal(direct.starts.length, 1);
  assert.equal(direct.store.list('work-effect').length, 0);

  const queued = fixture(t);
  const ticket = queued.engine.command({ text: '持久启动', executorInput: undefined });
  const approved = queued.engine.action(ticket.id, 'approve');
  assert.equal(approved.status, 'queued');
  assert.equal(queued.starts.length, 0);
  const effect = queued.store.list('work-effect')[0];
  assert.equal(effect.status, 'pending');
  assert.deepEqual(Object.keys(effect.payload).sort(), ['assignmentId', 'datasetId', 'useAI']);
  assert.doesNotMatch(JSON.stringify(effect), /持久启动|prompt|token|private/i);

  assert.equal(queued.engine.drainOutbox({ now: Date.now() + 1000 }).length, 1);
  assert.equal(queued.starts.length, 1);
  assert.equal(queued.store.get('work-effect', effect.id).status, 'done');
  assert.deepEqual(queued.engine.drainOutbox({ now: Date.now() + 2000 }), []);
  assert.equal(queued.starts.length, 1);
  assert.equal(queued.engine.detail(ticket.id).ticket.status, 'working');
});

test('E5 Engine 退避重试四次后收口 failed，审计不含敏感原文', t => {
  const secret = 'prompt=PRIVATE token=SECRET raw-output';
  const f = fixture(t, {
    startError: () => Object.assign(new Error(secret), { status: 503, code: 'UPSTREAM_FAILED' })
  });
  const ticket = f.engine.command({ text: '会失败的任务' });
  assert.equal(f.engine.action(ticket.id, 'approve').status, 'queued');
  let at = Date.now() + 1000;
  f.engine.drainOutbox({ now: at });
  assert.equal(f.engine.detail(ticket.id).ticket.status, 'queued');
  at += OUTBOX_BASE_DELAY_MS;
  f.engine.drainOutbox({ now: at });
  at += OUTBOX_BASE_DELAY_MS * 2;
  f.engine.drainOutbox({ now: at });
  at += OUTBOX_BASE_DELAY_MS * 4;
  f.engine.drainOutbox({ now: at });
  assert.equal(f.starts.length, 4);
  const detail = f.engine.detail(ticket.id);
  assert.equal(detail.ticket.status, 'failed');
  assert.equal(detail.assignments[0].status, 'failed');
  assert.equal(detail.reports.at(-1).kind, 'failed');
  assert.equal(f.store.list('work-effect')[0].status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.store.list('work-audit')), /PRIVATE|SECRET|raw-output/);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|SECRET|raw-output/);
});

test('E5 Engine 并发上限由 drainOutbox 执行阶段约束', async t => {
  const f = fixture(t);
  f.engine.updatePolicy({ budgets: { maxConcurrent: 1 } });
  const first = f.engine.command({ text: '并发一' });
  const second = f.engine.command({ text: '并发二' });
  f.engine.action(first.id, 'approve');
  f.engine.action(second.id, 'approve');
  f.engine.drainOutbox({ now: Date.now() + 1000 });
  assert.equal(f.starts.length, 1);
  assert.equal(f.engine.detail(first.id).ticket.status, 'working');
  assert.equal(f.engine.detail(second.id).ticket.status, 'queued');
  f.engine.drainOutbox({ now: Date.now() + 2000 });
  assert.equal(f.starts.length, 1);

  const firstAssignment = f.engine.detail(first.id).assignments[0];
  f.store.put('task', { id: firstAssignment.sessionId, workAssignmentId: firstAssignment.id, status: 'completed', report: { summary: '完成' } });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.engine.detail(first.id).ticket.status, 'completed');
  f.engine.drainOutbox({ now: Date.now() + 3000 });
  assert.equal(f.starts.length, 2);
  assert.equal(f.engine.detail(second.id).ticket.status, 'working');
});

test('E5 Engine stop 取消 queued effect，重启续跑 pending 且 running 只恢复一次', t => {
  const stopped = fixture(t);
  const ticket = stopped.engine.command({ text: '停止排队任务' });
  stopped.engine.action(ticket.id, 'approve');
  const effect = stopped.store.list('work-effect')[0];
  assert.equal(stopped.engine.action(ticket.id, 'stop').status, 'cancelled');
  assert.equal(stopped.store.get('work-effect', effect.id).status, 'done');
  stopped.engine.drainOutbox({ now: Date.now() + 1000 });
  assert.equal(stopped.starts.length, 0);

  const pending = fixture(t);
  const pendingTicket = pending.engine.command({ text: '重启续跑' });
  pending.engine.action(pendingTicket.id, 'approve');
  const restarted = pending.restart();
  restarted.recover();
  assert.equal(pending.starts.length, 1);
  assert.equal(restarted.detail(pendingTicket.id).ticket.status, 'working');

  const once = fixture(t);
  const onceTicket = once.engine.command({ text: '一次恢复' });
  once.engine.action(onceTicket.id, 'approve');
  const onceEffect = once.store.list('work-effect')[0];
  const onceAssignment = once.engine.detail(onceTicket.id).assignments[0];
  once.engine.close();
  once.store.put('work-effect', { ...onceEffect, status: 'running', attempts: 1 });
  once.store.put('work-assignment', { ...onceAssignment, status: 'working' });
  once.store.put('work-ticket', { ...once.store.get('work-ticket', onceTicket.id), status: 'working' });
  const recoveredEngine = once.restart();
  recoveredEngine.recover();
  assert.equal(once.starts.length, 1);
  assert.equal(once.store.get('work-effect', onceEffect.id).status, 'done');

  const twice = fixture(t);
  const twiceTicket = twice.engine.command({ text: '二次恢复失败' });
  twice.engine.action(twiceTicket.id, 'approve');
  const twiceEffect = twice.store.list('work-effect')[0];
  const twiceAssignment = twice.engine.detail(twiceTicket.id).assignments[0];
  twice.engine.close();
  twice.store.put('work-effect', { ...twiceEffect, status: 'running', attempts: 2 });
  twice.store.put('work-assignment', { ...twiceAssignment, status: 'working' });
  twice.store.put('work-ticket', { ...twice.store.get('work-ticket', twiceTicket.id), status: 'working' });
  const failedEngine = twice.restart();
  failedEngine.recover();
  assert.equal(twice.starts.length, 0);
  assert.equal(twice.store.get('work-effect', twiceEffect.id).status, 'failed');
  assert.equal(failedEngine.detail(twiceTicket.id).ticket.status, 'failed');
});
