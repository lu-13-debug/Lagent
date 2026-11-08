import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { windowExecutor } from './work/executors/window.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('窗口执行器发送指令并读回窗口输出', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'window-exec-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  const bridge = {
    listWindows: async () => [{ id: '42', handle: 42, process: 'Codex', title: 'Codex' }],
    sendToWindow: async (handle, text, options) => { calls.push(['send', handle, text, options.submit]); return { ok: true, process: 'Codex', submitted: options.submit }; },
    readWindow: async handle => {
      calls.push(['read', handle]);
      const reads = calls.filter(call => call[0] === 'read').length;
      return { text: reads === 1 ? '旧输出' : '最近输出' };
    }
  };
  const executor = windowExecutor({ store, bridge, waitMs: 5, maxWaitMs: 0 });
  const task = executor.start({ id: 'ticket-1' }, { id: 'assignment-1' }, { executorInput: { handle: 42, text: '继续', submit: true } });
  for (let i = 0; i < 40 && executor.get(task.id)?.status === 'running'; i++) await sleep(25);
  const finished = executor.get(task.id);
  assert.equal(finished.status, 'completed');
  assert.deepEqual(calls, [['read', 42], ['send', 42, '继续', true], ['read', 42]]);
  assert.equal(finished.artifacts.window.text, '最近输出');
  assert.match(finished.report.summary, /读取到窗口输出/);
  assert.equal(JSON.stringify(finished.report).includes('密钥'), false);
  assert.throws(() => executor.start({ id: 'ticket-2' }, { id: 'assignment-2' }, { handle: 0, text: 'x' }), { status: 400 });
});

test('窗口没有新输出时明确提示，而不是当作空结果', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'window-empty-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bridge = {
    listWindows: async () => [{ id: '42', handle: 42, process: 'DeepSeek Harness', title: 'DSH' }],
    sendToWindow: async () => ({ ok: true, process: 'DeepSeek Harness', submitted: true }),
    readWindow: async () => ({ text: '发送前就有的旧对话' })
  };
  const executor = windowExecutor({ store, bridge, waitMs: 5, maxWaitMs: 0 });
  const task = executor.start({ id: 'ticket-empty' }, { id: 'assignment-empty' }, { executorInput: { handle: 42, text: '您好', submit: true } });
  for (let i = 0; i < 40 && executor.get(task.id)?.status === 'running'; i++) await sleep(25);
  const finished = executor.get(task.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.artifacts.window.text, '');
  assert.equal(finished.report.output, '');
  assert.match(finished.report.summary, /未读取到新输出/);
  assert.match(finished.warning, /读取/);
});

test('计划自动执行可把步骤分派给窗口执行器', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'window-plan-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bridge = {
    listWindows: async () => [{ id: '42', handle: 42, process: 'Codex', title: 'Codex' }],
    sendToWindow: async () => ({ ok: true, process: 'Codex', submitted: true }),
    readWindow: async () => ({ text: '窗口输出' })
  };
  const engine = createWorkEngine(store, createExecutorRegistry([windowExecutor({ store, bridge, waitMs: 5, maxWaitMs: 0 })]), () => {}, { policy: { allowedExecutors: ['window'] } });
  t.after(() => engine.close());
  const plan = engine.plan({ goal: '窗口任务', autoRun: true, steps: [
    { executorId: 'window', text: '继续执行', executorInput: { handle: 42, process: 'Codex', text: '继续执行', submit: true } },
    { executorId: 'window', text: '读取结果', executorInput: { handle: 42, process: 'Codex', text: '读取结果', submit: true }, dependsOn: [0] }
  ] });
  for (let i = 0; i < 80 && engine.getPlan(plan.id).status !== 'completed'; i++) await sleep(50);
  assert.equal(engine.getPlan(plan.id).status, 'completed');
  assert.deepEqual(engine.getPlan(plan.id).steps.map(step => step.status), ['completed', 'completed']);
});
