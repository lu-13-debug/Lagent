import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { mergeRuns, planToRun, taggedRun } from './work/run-projection.js';
import { createApp } from './app.js';

const route = (app, path) => app.router.stack.find(layer => layer.route?.path === path)?.route.stack[0].handle;

async function callAsync(app, path, req = {}) {
  let output;
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { output = value; return this; },
    set() { return this; },
    flushHeaders() {},
    write() {},
    end() {}
  };
  await route(app, path)(req, res);
  return { output, statusCode };
}

function engineFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-run-projection-'));
  const store = new Store(dir);
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { terminal: { command: 'pwd', exitCode: 0 } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, dir };
}

test('计划投影成统一 Run：状态、步骤与依赖映射', () => {
  const plan = {
    id: 'p1',
    goal: '修复登录',
    status: 'active',
    currentStep: 1,
    totalSteps: 2,
    projectId: 'proj',
    projectChatId: 'chat',
    steps: [
      { index: 0, title: '调研', executorId: 'claude-code', ticketId: 't1', status: 'completed', dependsOn: [] },
      { index: 1, title: '实现', executorId: 'codex', ticketId: 't2', status: 'awaiting_review', dependsOn: [0], scope: ['src'] }
    ],
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T01:00:00.000Z'
  };
  const run = planToRun(plan);
  assert.equal(run.kind, 'plan');
  assert.equal(run.status, 'running');
  assert.equal(run.templateLabel, '多步计划');
  assert.equal(run.endedAt, null);
  assert.deepEqual(run.steps.map(step => step.status), ['done', 'running']);
  assert.equal(run.steps[1].role, '实现');
  assert.deepEqual(run.steps[1].dependsOn, [0]);
  assert.deepEqual(run.steps[1].scope, ['src']);

  const done = planToRun({ ...plan, status: 'completed' });
  assert.equal(done.status, 'completed');
  assert.equal(done.endedAt, plan.updatedAt);
  const cancelled = planToRun({ ...plan, status: 'cancelled' });
  assert.equal(cancelled.status, 'cancelled');
});

test('融合列表按更新时间倒序，编排 run 自动补 kind', () => {
  const runs = mergeRuns(
    [{ id: 'r1', goal: '编排', status: 'running', updatedAt: '2026-11-12T02:00:00.000Z' }],
    [{ id: 'p1', goal: '计划', status: 'active', updatedAt: '2026-11-12T03:00:00.000Z', steps: [] }],
    10
  );
  assert.deepEqual(runs.map(run => run.id), ['p1', 'r1']);
  assert.equal(runs.find(run => run.id === 'r1').kind, 'orchestrator');
  assert.equal(runs.find(run => run.id === 'p1').kind, 'plan');
  assert.equal(taggedRun({ id: 'r2', kind: 'orchestrator' }).kind, 'orchestrator');
});

test('引擎暴露 listPlans/findPlan，计划可作为运行读取', t => {
  const { engine } = engineFixture(t);
  const plan = engine.plan({
    goal: '投影计划',
    autoRun: false,
    steps: [
      { executorId: 'terminal', text: '第一步', executorInput: { program: 'pwd', args: [] } },
      { executorId: 'terminal', text: '第二步', executorInput: { program: 'pwd', args: [] }, dependsOn: [0] }
    ]
  });
  const found = engine.findPlan(plan.id);
  assert.equal(found.id, plan.id);
  assert.equal(found.totalSteps, 2);
  assert.equal(engine.findPlan('missing'), null);
  const list = engine.listPlans(10);
  assert.equal(list[0].id, plan.id);
  assert.equal(list.length, 1);
});

test('GET /api/work/runs?include=plans 在编排器关闭时仍返回计划运行', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-run-route-'));
  const previous = process.env.LAGENT_ORCHESTRATOR;
  process.env.LAGENT_ORCHESTRATOR = 'legacy';
  const app = createApp({ dataDir: dir, cloud: true, workEnabled: true, serveStatic: false });
  t.after(() => {
    app.locals.close();
    if (previous === undefined) delete process.env.LAGENT_ORCHESTRATOR; else process.env.LAGENT_ORCHESTRATOR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  const created = (await callAsync(app, '/api/work/plans', {
    body: {
      goal: '路由投影计划', autoRun: false, clientRequestId: 'run-projection',
      steps: [
        { executorId: 'terminal', text: '第一步', executorInput: { program: 'pwd', args: [] } },
        { executorId: 'terminal', text: '第二步', executorInput: { program: 'pwd', args: [] }, dependsOn: [0] }
      ]
    }
  })).output.plan;
  assert.equal(created.totalSteps, 2);

  const listed = (await callAsync(app, '/api/work/runs', { query: { include: 'plans', limit: '10' } })).output;
  assert.equal(listed.runs.length, 1);
  assert.equal(listed.runs[0].id, created.id);
  assert.equal(listed.runs[0].kind, 'plan');
  assert.equal(listed.runs[0].status, 'running');

  const detail = (await callAsync(app, '/api/work/runs/:id', { params: { id: created.id } })).output;
  assert.equal(detail.run.id, created.id);
  assert.equal(detail.run.steps.length, 2);

  const disabled = await callAsync(app, '/api/work/runs', { query: { limit: '10' } });
  assert.equal(disabled.statusCode, 503);
  assert.match(disabled.output.error, /编排器未启用/);
});
