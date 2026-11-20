import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { recordTicketUsage, summarizeUsage, checkTokenBudget, ticketsTokensUsed } from './work/usage.js';

test('工单执行后记录用量，可按项目/执行器/天汇总', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-'));
  const store = new Store(dir);
  recordTicketUsage(store, { ticket: { id: 't1' }, assignment: { executor: 'claude-code' }, task: { artifacts: { cli: { usage: { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.01 } } } }, executorId: 'claude-code', projectId: 'p1' });
  recordTicketUsage(store, { ticket: { id: 't2' }, assignment: { executor: 'codex' }, task: { artifacts: { cli: { usage: { input_tokens: 200, output_tokens: 100 } } } }, executorId: 'codex', projectId: 'p1' });
  recordTicketUsage(store, { ticket: { id: 't3' }, assignment: { executor: 'terminal' }, task: { artifacts: { terminal: { command: 'pwd' } } }, executorId: 'terminal', projectId: 'p2' });

  const all = summarizeUsage(store, { days: 'all' });
  assert.equal(all.totals.calls, 3);
  assert.equal(all.totals.totalTokens, 450);
  assert.equal(all.byExecutor.length, 3);
  const byProject = summarizeUsage(store, { projectId: 'p1', days: 'all' });
  assert.equal(byProject.totals.calls, 2);
  assert.equal(byProject.byExecutor.find(r => r.executorId === 'claude-code')?.costEstimate, 0.01);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Token 预算硬闸在执行前拦截', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-budget-'));
  const store = new Store(dir);
  recordTicketUsage(store, { ticket: { id: 't1' }, assignment: { executor: 'model' }, task: { report: { aiUsage: { inputTokens: 900, outputTokens: 100, totalTokens: 1000 } } }, executorId: 'model', projectId: 'p1' });
  const ok = checkTokenBudget(store, 't1', 2000);
  assert.equal(ok.ok, true);
  assert.equal(ok.used, 1000);
  const blocked = checkTokenBudget(store, 't1', 1000);
  assert.equal(blocked.ok, false);
  // 批量统计只查相关工单，不会把其它工单的用量算进来。
  assert.equal(ticketsTokensUsed(store, ['t1', 'missing']), 1000);
  assert.equal(store.listWhere('work-usage', 'ticketId', ['t1']).length, 1);
  assert.throws(() => store.listWhere('work-usage', 'ticketId; DROP TABLE entities', 'x'), /无效的字段名/);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('引擎在执行时检查 token 预算并记录用量', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-engine-usage-'));
  const store = new Store(dir);
  let started = 0;
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      started++;
      if (started === 1) throw new Error('首次启动失败');
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, usage: { input_tokens: 10, output_tokens: 5 }, artifacts: { terminal: { command: 'pwd', exitCode: 0 } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir, policy: { budgets: { maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 1000 } } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const first = engine.command({ text: '第一次', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } });
  assert.equal(first.status, 'failed');

  // 手动把预算耗尽，验证 retry 时被硬闸拦截。
  recordTicketUsage(store, { ticket: { id: first.id }, assignment: { executor: 'terminal' }, task: { usage: { input_tokens: 900, output_tokens: 100 } }, executorId: 'terminal', projectId: '' });
  const retried = engine.action(first.id, 'retry');
  assert.equal(retried.status, 'failed');
  assert.match(retried.summary, /Token 预算/);

  const summary = engine.usageSummary({ days: 'all' });
  assert.equal(summary.totals.calls, 1);
});

test('用量汇总带预算与 80% 告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-alert-'));
  const store = new Store(dir);
  recordTicketUsage(store, { ticket: { id: 't1' }, assignment: { executor: 'model' }, task: { usage: { input_tokens: 850, output_tokens: 50 } }, executorId: 'model', projectId: 'p1' });
  recordTicketUsage(store, { ticket: { id: 't2' }, assignment: { executor: 'model' }, task: { usage: { input_tokens: 100, output_tokens: 20 } }, executorId: 'model', projectId: 'p1' });
  const report = summarizeUsage(store, { days: 'all', budgetTokens: 1000 });
  assert.equal(report.budget.maxTokensPerTicket, 1000);
  assert.equal(report.budget.warningRatio, 0.8);
  assert.deepEqual(report.budget.warnings.map(row => row.ticketId), ['t1']);
  const t1 = report.byTicket.find(row => row.ticketId === 't1');
  assert.equal(t1.warning, true);
  assert.equal(t1.ratio, 0.9);
  const t2 = report.byTicket.find(row => row.ticketId === 't2');
  assert.equal(t2.warning, false);

  const withoutBudget = summarizeUsage(store, { days: 'all' });
  assert.equal(withoutBudget.budget, null);
  assert.equal(withoutBudget.byTicket.find(row => row.ticketId === 't1').warning, undefined);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('用量按执行与协调拆分，协调占比可单独查看', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-role-'));
  const store = new Store(dir);
  recordTicketUsage(store, {
    ticket: { id: 't1' }, assignment: { executor: 'model', role: 'coordination' },
    task: { report: { aiUsage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } } }, executorId: 'model'
  });
  recordTicketUsage(store, {
    ticket: { id: 't2' }, assignment: { executor: 'model' },
    task: { report: { aiUsage: { inputTokens: 240, outputTokens: 60, totalTokens: 300 } } }, executorId: 'model'
  });
  const summary = summarizeUsage(store, { days: 'all' });
  assert.equal(summary.totals.totalTokens, 400);
  assert.equal(summary.coordination.totalTokens, 100);
  assert.equal(summary.execution.totalTokens, 300);
  assert.equal(summary.coordination.share, 0.25);
  assert.equal(summary.byRole.coordination.calls, 1);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
