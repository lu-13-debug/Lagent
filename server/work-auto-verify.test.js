import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, { timeoutMs = 8000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待自动验收超时');
    await wait(intervalMs);
  }
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-auto-verify-'));
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
  return { engine, dir, store };
}

test('工单完成后自动执行验收并通过', async t => {
  const { engine, store } = fixture(t);
  const ticket = engine.command({ text: '自动验收通过', executorId: 'terminal', executorInput: { program: 'pwd', args: [] }, verify: { command: 'npm --version' } });
  assert.equal(ticket.status, 'completed');
  const detail = await until(() => {
    const current = engine.detail(ticket.id);
    return current.ticket.acceptance ? current : null;
  });
  assert.equal(detail.ticket.acceptance.status, 'passed');
  assert.equal(detail.ticket.status, 'completed');
  assert.match(detail.ticket.summary, /验收通过：npm --version/);
  assert.equal(detail.ticket.review.verdict, 'pass');
  assert.equal(detail.ticket.review.evidence.level, 'verified');
  assert.deepEqual(detail.ticket.review.failureModes, []);
  assert.equal(detail.reports[0].artifacts.review.evidence.level, 'verified');
  // 自动验收回写不能把批准前冻结的执行输入冲掉，否则失败后重试会丢参数。
  assert.deepEqual(store.get('work-control', ticket.id).executorInput, { program: 'pwd', args: [] });
});

test('自动验收失败时工单进入 blocked 并保留证据', async t => {
  const { engine, dir } = fixture(t);
  writeFileSync(join(dir, 'fail.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fail', () => assert.equal(1, 2));\n", 'utf8');
  const ticket = engine.command({ text: '自动验收失败', executorId: 'terminal', executorInput: { program: 'pwd', args: [] }, verify: { command: 'node --test fail.test.mjs' } });
  const detail = await until(() => {
    const current = engine.detail(ticket.id);
    return current.ticket.acceptance ? current : null;
  });
  assert.equal(detail.ticket.acceptance.status, 'failed');
  assert.equal(detail.ticket.status, 'blocked');
  assert.match(detail.ticket.summary, /验收未通过/);
  assert.ok(detail.ticket.attention);
  assert.match(detail.reports[0].summary, /验收未通过/);
  assert.equal(detail.ticket.review.verdict, 'reject');
  assert.equal(detail.ticket.review.evidence.level, 'failed');
  assert.ok(detail.ticket.review.issues.some(issue => issue.code === 'CRITIC_VERIFY_FAILED'));
});

test('autoVerify:false 时不会自动跑验收', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-auto-verify-off-'));
  const store = new Store(dir);
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { terminal: { command: 'pwd', exitCode: 0 } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir, autoVerify: false });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const ticket = engine.command({ text: '关闭自动验收', executorId: 'terminal', executorInput: { program: 'pwd', args: [] }, verify: { command: 'npm --version' } });
  await wait(600);
  assert.equal(engine.detail(ticket.id).ticket.acceptance, null);
  assert.equal(engine.detail(ticket.id).ticket.status, 'completed');
});
