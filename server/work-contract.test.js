import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { contractBrief, normalizeContract } from './work/contract.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-contract-'));
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
  return { engine };
}

test('任务契约规范化：合法字段、去重与空契约拒绝', () => {
  const contract = normalizeContract({
    objective: '  修复登录页  ',
    inputs: [' a.js ', 'a.js', 'b.js'],
    constraints: ['不得改 API'],
    acceptance: ['npm test 通过'],
    tools: ['read', 'write'],
    budget: { tokens: 1000, calls: 3 }
  });
  assert.equal(contract.objective, '修复登录页');
  assert.deepEqual(contract.inputs, ['a.js', 'b.js']);
  assert.deepEqual(contract.budget, { tokens: 1000, calls: 3 });

  assert.throws(() => normalizeContract({ objective: 'x', unknown: 1 }), /未知字段/);
  assert.throws(() => normalizeContract({}), /不能为空/);
  assert.throws(() => normalizeContract({ deadlineMs: 10 }), /deadlineMs/);
  assert.throws(() => normalizeContract({ inputs: 'a' }), /字符串数组/);
  assert.throws(() => normalizeContract({ budget: { tokens: -1 } }), /非负整数/);
  assert.throws(() => normalizeContract({ report: { status: 'x' } }), /report 包含未知字段/);
  assert.equal(normalizeContract(null), null);
  assert.equal(normalizeContract(undefined), null);
});

test('契约压缩成执行器可读的简报', () => {
  const brief = contractBrief(normalizeContract({
    objective: '修复登录',
    inputs: ['src/login.tsx'],
    constraints: ['不得改 API'],
    acceptance: ['npm test 通过'],
    tools: ['read', 'write'],
    budget: { tokens: 1000 },
    deadlineMs: 600000,
    report: { summary: '给出 diff', evidence: ['npm test 输出'] }
  }));
  assert.match(brief, /【任务契约】/);
  assert.match(brief, /目标：修复登录/);
  assert.match(brief, /验收：npm test 通过/);
  assert.match(brief, /预算：tokens=1000/);
  assert.match(brief, /截止：600000ms/);
  assert.match(brief, /证据：npm test 输出/);
  assert.equal(contractBrief(null), '');
});

test('工单与计划步骤可携带契约并在投影中返回', t => {
  const { engine } = fixture(t);
  const contract = { objective: '跑一次检查', acceptance: ['pwd'], constraints: ['只读'] };
  const ticket = engine.command({
    text: '带契约的工单', executorId: 'terminal',
    executorInput: { program: 'pwd', args: [] },
    contract
  });
  assert.deepEqual(ticket.contract, { objective: '跑一次检查', inputs: [], constraints: ['只读'], acceptance: ['pwd'], tools: [] });
  assert.deepEqual(engine.detail(ticket.id).ticket.contract.objective, '跑一次检查');

  const plan = engine.plan({
    goal: '带契约的计划', autoRun: false,
    steps: [
      { executorId: 'terminal', text: '第一步', executorInput: { program: 'pwd', args: [] }, contract: { objective: '第一步目标', acceptance: ['pwd'] } },
      { executorId: 'terminal', text: '第二步', executorInput: { program: 'pwd', args: [] }, dependsOn: [0] }
    ]
  });
  assert.equal(plan.steps[0].contract.objective, '第一步目标');
  assert.equal(plan.steps[1].contract, undefined);
  const detail = engine.getPlan(plan.id);
  assert.equal(detail.steps[0].contract.objective, '第一步目标');
  assert.throws(() => engine.command({ text: '坏契约', executorId: 'terminal', executorInput: { program: 'pwd', args: [] }, contract: { bogus: 1 } }), /未知字段|不能为空/);
});
