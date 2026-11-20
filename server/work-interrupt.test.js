import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-interrupt-'));
  const store = new Store(dir);
  const tasks = new Map();
  let engine;
  const executor = {
    id: 'terminal', name: 'Mock', kind: 'tool', available: true, requiresDataset: false, capabilities: ['code'],
    start(ticket, assignment) {
      const task = {
        id: assignment.id,
        ticketId: ticket.id,
        status: 'running',
        activity: [{ kind: 'tool', text: '已经跑了一部分' }],
        artifacts: { cli: { summary: '半成品', usage: {} } }
      };
      tasks.set(task.id, task);
      store.put('task', task);
      return task;
    },
    get: id => tasks.get(id) || null,
    stop(task) {
      if (!task) return;
      task.status = 'cancelled';
      store.put('task', task);
    },
    // 模拟停止指令发出后，执行器仍把迟到的完成结果写回存储。
    finishLate(task) {
      task.status = 'completed';
      task.report = { summary: '晚到的完成结果' };
      store.put('task', task);
    }
  };
  engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, {
    workspace: dir,
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    policy: { allowedExecutors: ['terminal'] }
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, tasks };
}

test('用户中断：标为 cancelled 而不是 failed，并保留中断前的过程与产物', async t => {
  const { engine, store } = fixture(t);
  const ticket = engine.command({ text: '跑一个长任务', executorId: 'terminal' });
  assert.equal(ticket.status, 'working');

  const stopped = engine.action(ticket.id, 'stop', { reason: '需求改了，先停一下' });
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.interrupted, true);
  assert.match(stopped.summary, /需求改了/);
  assert.doesNotMatch(stopped.summary, /失败/);

  const detail = engine.detail(ticket.id);
  assert.equal(detail.assignments.at(-1)?.status, 'cancelled');
  const report = store.list('work-report').find(row => row.ticketId === ticket.id);
  assert.equal(report?.kind, 'dropped');
  assert.equal(report?.artifacts?.interrupted, true);
  assert.equal(report?.artifacts?.cli?.summary, '半成品');
  assert.equal(report?.artifacts?.activity?.at(-1)?.text, '已经跑了一部分');
  assert.ok(store.list('work-audit').some(row => row.ticketId === ticket.id && row.action === 'stop' && row.result === 'cancelled'));
});

test('用户中断：迟到的完成回写不能把 cancelled 翻回 completed', async t => {
  const { engine, store, tasks } = fixture(t);
  const ticket = engine.command({ text: '跑一个长任务', executorId: 'terminal' });
  engine.action(ticket.id, 'stop', { reason: '用户中断' });
  const task = [...tasks.values()][0];
  // 执行器在停止后仍写了一次 completed。
  task.status = 'running';
  store.put('task', task);
  const late = { ...task, status: 'completed', report: { summary: '晚到的完成结果' } };
  store.put('task', late);
  await wait(50);
  assert.equal(engine.detail(ticket.id).ticket.status, 'cancelled');
  assert.match(engine.detail(ticket.id).ticket.summary, /停止|中断/);
});

test('用户中断后可以重试：新一次执行不继承上次的中断标记', async t => {
  const { engine } = fixture(t);
  const ticket = engine.command({ text: '再跑一次', executorId: 'terminal' });
  engine.action(ticket.id, 'stop', { reason: '先停' });
  const retried = engine.action(ticket.id, 'retry');
  assert.equal(retried.status, 'working');
  assert.notEqual(retried.interrupted, true);
  engine.action(ticket.id, 'stop');
});

test('中断原因会限制长度', t => {
  const { engine } = fixture(t);
  const ticket = engine.command({ text: '长任务', executorId: 'terminal' });
  const stopped = engine.action(ticket.id, 'stop', { reason: 'x'.repeat(500) });
  assert.ok(stopped.summary.length <= 210);
  assert.equal(stopped.summary.replace(/^已按你的要求停止：/, '').length, 200);
});
