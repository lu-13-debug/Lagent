import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkflowService } from './work/workflows.js';
import { createEvalService } from './work/evals.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-p4-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { store };
}

test('工作流：保存、校验步骤、运行并记录计划 id', t => {
  const { store } = fixture(t);
  const calls = [];
  const service = createWorkflowService(store, {
    startPlan: input => { calls.push(input); return { id: 'plan-1', steps: input.steps }; },
    listExecutors: () => ['model', 'claude-code']
  });
  const workflow = service.save({
    name: '发布检查',
    goal: '检查并发布',
    steps: [
      { executorId: 'model', text: '检查变更' },
      { executorId: 'claude-code', text: '跑测试', dependsOn: [0] }
    ]
  });
  assert.ok(workflow.id);
  assert.equal(service.list().length, 1);

  const { plan } = service.run(workflow.id, { autoRun: true });
  assert.equal(plan.id, 'plan-1');
  assert.equal(calls[0].goal, '检查并发布');
  assert.equal(calls[0].autoRun, true);
  assert.equal(calls[0].steps.length, 2);
  assert.equal(service.get(workflow.id).runs[0].planId, 'plan-1');

  assert.throws(() => service.save({ name: 'x', goal: 'y', steps: [{ executorId: 'model', text: 'only one' }] }), /2–5 个步骤/);
  assert.throws(() => service.save({ name: 'x', goal: 'y', steps: [
    { executorId: 'model', text: 'a' }, { executorId: 'model', text: 'b', dependsOn: [1] }
  ] }), /引用更早步骤/);
  assert.throws(() => service.save({ name: 'x', goal: 'y', steps: [
    { executorId: 'unknown-agent', text: 'a' }, { executorId: 'model', text: 'b' }
  ] }), /执行器不可用/);

  service.remove(workflow.id);
  assert.equal(service.list().length, 0);
});

test('评测：汇总真实工单的状态、耗时、Token 与验证结果', t => {
  const { store } = fixture(t);
  store.put('work-ticket', { id: 't1', title: '完成的', executor: 'model', status: 'completed', createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:01:00.000Z' });
  store.put('work-ticket', { id: 't2', title: '失败的', executor: 'codex', status: 'failed', createdAt: '2026-11-27T00:02:00.000Z', updatedAt: '2026-11-27T00:03:00.000Z' });
  store.put('work-assignment', { id: 'a1', ticketId: 't1', executor: 'model', status: 'completed', startedAt: '2026-11-27T00:00:00.000Z', endedAt: '2026-11-27T00:00:30.000Z' });
  store.put('work-assignment', { id: 'a2', ticketId: 't2', executor: 'codex', status: 'failed', startedAt: '2026-11-27T00:02:00.000Z', endedAt: '2026-11-27T00:02:10.000Z' });
  store.put('work-usage', { id: 'u1', ticketId: 't1', calls: 3, totalTokens: 1200, costEstimate: 0.05 });
  store.put('work-usage', { id: 'u2', ticketId: 't2', calls: 1, totalTokens: 300, costEstimate: 0.01 });
  store.put('work-audit', { id: 'v1', ticketId: 't1', action: 'verify:auto', result: 'passed', at: '2026-11-27T00:01:00.000Z' });
  store.put('work-project-change', { id: 'c1', ticketId: 't1', files: ['a.js', 'b.js'], createdAt: '2026-11-27T00:01:00.000Z' });

  const service = createEvalService(store, { now: () => '2026-11-27T01:00:00.000Z' });
  const record = service.evaluate({ name: '回归', ticketIds: ['t1', 't2'] });
  assert.equal(record.summary.total, 2);
  assert.equal(record.summary.passed, 1);
  assert.equal(record.summary.failed, 1);
  assert.equal(record.summary.passRate, 0.5);
  assert.equal(record.summary.verified, 1);
  assert.equal(record.summary.totalTokens, 1500);
  assert.equal(record.summary.totalCost, 0.06);
  const t1 = record.tickets.find(row => row.ticketId === 't1');
  assert.equal(t1.outcome, 'passed');
  assert.equal(t1.verify, 'passed');
  assert.equal(t1.durationMs, 30000);
  assert.equal(t1.files, 2);
  assert.equal(record.tickets.find(row => row.ticketId === 't2').outcome, 'failed');

  assert.equal(service.list().length, 1);
  assert.equal(service.get(record.id).name, '回归');
  assert.throws(() => service.evaluate({ ticketIds: ['missing'] }), /工单不存在/);
});
