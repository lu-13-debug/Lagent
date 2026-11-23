import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorkbuddyInput, extractAssistantReply, workbuddyExecutor } from './work/executors/workbuddy.js';

function memoryStore() {
  const rows = new Map();
  return {
    put(_kind, row) { rows.set(row.id, row); return row; },
    get(_kind, id) { return rows.get(id) || null; },
    list() { return [...rows.values()]; }
  };
}

function fakeDriver(overrides = {}) {
  const calls = [];
  return {
    calls,
    async open() { calls.push('open'); },
    async send(prompt, options) { calls.push(['send', prompt, options]); return { baseline: 0 }; },
    async wait() { calls.push('wait'); return '7006652'; },
    async close() { calls.push('close'); },
    ...overrides
  };
}

async function waitForStatus(store, id, statuses, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = store.get('task', id);
    if (task && statuses.includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('任务没有进入预期状态');
}

test('WorkBuddy 输入：校验提示词与超时范围', () => {
  assert.deepEqual(normalizeWorkbuddyInput({ prompt: '计算 1+1' }), { prompt: '计算 1+1', timeoutMs: 600000, newConversation: true });
  assert.throws(() => normalizeWorkbuddyInput({ prompt: '   ' }), /不能为空/);
  assert.throws(() => normalizeWorkbuddyInput({ prompt: 'x'.repeat(8001) }), /不能超过/);
  assert.throws(() => normalizeWorkbuddyInput({ prompt: 'hi', timeoutMs: 1000 }), /timeoutMs/);
  assert.throws(() => normalizeWorkbuddyInput({ prompt: 'hi', timeoutMs: 3600001 }), /timeoutMs/);
});

test('WorkBuddy 回复：保留正文并截断超长内容', () => {
  assert.equal(extractAssistantReply(' 7006652 \n'), '7006652');
  assert.equal(extractAssistantReply(''), '');
  assert.equal(extractAssistantReply('x'.repeat(30000)).length, 20000);
});

test('WorkBuddy 执行器：派发任务并把回复写入 artifacts.cli', async () => {
  const store = memoryStore();
  const driver = fakeDriver();
  const executor = workbuddyExecutor({ store, driverFactory: () => driver, launch: false });
  const task = executor.start({ command: '计算 1234 乘以 5678' }, { id: 'A1' }, { executorInput: { prompt: '计算 1234 乘以 5678' } });
  assert.equal(task.status, 'running');
  const done = await waitForStatus(store, 'A1', ['completed', 'failed']);
  assert.equal(done.status, 'completed');
  assert.equal(done.artifacts.cli.summary, '7006652');
  assert.equal(done.artifacts.cli.executorId, 'workbuddy');
  assert.equal(done.error, undefined);
  assert.deepEqual(driver.calls[0], 'open');
  assert.equal(driver.calls[1][0], 'send');
  assert.match(driver.calls[1][1], /^计算 1234 乘以 5678/);
  assert.match(driver.calls[1][1], /请全程使用简体中文思考和输出/);
  assert.deepEqual(driver.calls[1][2], { newConversation: true });
  assert.equal(driver.calls.includes('close'), true);
});

test('WorkBuddy 执行器：窗口未就绪时任务失败并保留原因', async () => {
  const store = memoryStore();
  const driver = fakeDriver({
    async wait() { throw Object.assign(new Error('没找到 WorkBuddy 的任务输入框'), { status: 409 }); }
  });
  const executor = workbuddyExecutor({ store, driverFactory: () => driver, launch: false });
  executor.start({ command: '做个任务' }, { id: 'A2' }, { executorInput: { prompt: '做个任务' } });
  const done = await waitForStatus(store, 'A2', ['completed', 'failed']);
  assert.equal(done.status, 'failed');
  assert.match(done.error, /输入框/);
  assert.equal(done.artifacts.cli.exitCode, 1);
});

test('WorkBuddy 执行器：stop 后任务标记为已取消', async () => {
  const store = memoryStore();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const driver = fakeDriver({
    async wait({ cancelled }) {
      await waiting;
      if (cancelled()) throw Object.assign(new Error('WorkBuddy 任务已停止'), { status: 499 });
      return 'late';
    }
  });
  const executor = workbuddyExecutor({ store, driverFactory: () => driver, launch: false });
  const task = executor.start({ command: '长任务' }, { id: 'A3' }, { executorInput: { prompt: '长任务' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  executor.stop(task);
  release();
  const done = await waitForStatus(store, 'A3', ['completed', 'failed', 'cancelled']);
  assert.equal(done.status, 'cancelled');
  assert.equal(done.error, 'WorkBuddy 任务已停止');
});
