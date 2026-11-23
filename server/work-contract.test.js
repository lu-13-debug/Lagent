import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { contractBrief, missingDeliverables, normalizeContract } from './work/contract.js';

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
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, {
    workspace: dir,
    // 这个文件只验证契约本身，关掉自动续跑，避免缺交付文件时又排一轮队列。
    env: { ...process.env, LAGENT_AUTO_CONTINUE: '0' }
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, dir };
}

test('任务契约规范化：合法字段、去重与空契约拒绝', () => {
  const contract = normalizeContract({
    objective: '  修复登录页  ',
    inputs: [' a.js ', 'a.js', 'b.js'],
    constraints: ['不得改 API'],
    acceptance: ['npm test 通过'],
    deliverables: ['app/pages/login.php', 'app/pages/login.php', 'docs/测试用例.md'],
    tools: ['read', 'write'],
    budget: { tokens: 1000, calls: 3 }
  });
  assert.equal(contract.objective, '修复登录页');
  assert.deepEqual(contract.inputs, ['a.js', 'b.js']);
  assert.deepEqual(contract.deliverables, ['app/pages/login.php', 'docs/测试用例.md']);
  assert.deepEqual(contract.budget, { tokens: 1000, calls: 3 });

  assert.throws(() => normalizeContract({ objective: 'x', unknown: 1 }), /未知字段/);
  assert.throws(() => normalizeContract({}), /不能为空/);
  assert.throws(() => normalizeContract({ deadlineMs: 10 }), /deadlineMs/);
  assert.throws(() => normalizeContract({ inputs: 'a' }), /字符串数组/);
  assert.throws(() => normalizeContract({ budget: { tokens: -1 } }), /非负整数/);
  assert.throws(() => normalizeContract({ report: { status: 'x' } }), /report 包含未知字段/);
  assert.throws(() => normalizeContract({ deliverables: ['D:/outside/a.php'] }), /项目内的相对路径/);
  assert.throws(() => normalizeContract({ deliverables: ['../outside/a.php'] }), /不能包含 \.\./);
  assert.equal(normalizeContract(null), null);
  assert.equal(normalizeContract(undefined), null);
});

test('契约压缩成执行器可读的简报', () => {
  const brief = contractBrief(normalizeContract({
    objective: '修复登录',
    inputs: ['src/login.tsx'],
    constraints: ['不得改 API'],
    acceptance: ['npm test 通过'],
    deliverables: ['src/login.tsx', 'docs/测试用例.md'],
    tools: ['read', 'write'],
    budget: { tokens: 1000 },
    deadlineMs: 600000,
    report: { summary: '给出 diff', evidence: ['npm test 输出'] }
  }));
  assert.match(brief, /【任务契约】/);
  assert.match(brief, /目标：修复登录/);
  assert.match(brief, /验收：npm test 通过/);
  assert.match(brief, /必须落盘：src\/login\.tsx、docs\/测试用例\.md/);
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
  assert.deepEqual(ticket.contract, { objective: '跑一次检查', inputs: [], constraints: ['只读'], acceptance: ['pwd'], deliverables: [], tools: [] });
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

test('计划步骤把契约写进执行输入，执行器能直接看到交付清单', t => {
  const { engine, store } = fixture(t);
  const plan = engine.plan({
    goal: '带交付清单的计划', autoRun: false,
    steps: [
      { executorId: 'terminal', text: '第一步', executorInput: { program: 'pwd', args: [] }, contract: { objective: '落盘需求文档', deliverables: ['docs/需求分析.md'], acceptance: ['文件存在'] } },
      { executorId: 'terminal', text: '第二步', executorInput: { program: 'pwd', args: [] }, dependsOn: [0] }
    ]
  });
  const control = store.get('work-control', plan.steps[0].ticketId);
  assert.match(control.command, /【任务契约】/);
  assert.match(control.command, /必须落盘：docs\/需求分析\.md/);
  assert.match(control.command, /验收：文件存在/);
});

test('声明了交付清单但文件没落盘时，工单不能报完成', async t => {
  const { engine } = fixture(t);
  const plan = engine.plan({
    goal: '缺交付文件', autoRun: false,
    steps: [
      { executorId: 'terminal', text: '写需求文档', executorInput: { program: 'pwd', args: [] }, contract: { deliverables: ['docs/需求分析.md'] } },
      { executorId: 'terminal', text: '第二步', executorInput: { program: 'pwd', args: [] }, dependsOn: [0] }
    ]
  });
  engine.action(plan.steps[0].ticketId, 'approve');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && engine.detail(plan.steps[0].ticketId).ticket.status !== 'failed') {
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
  }
  const ticket = engine.detail(plan.steps[0].ticketId).ticket;
  assert.equal(ticket.status, 'failed', JSON.stringify({ summary: ticket.summary, stage: ticket.stage, contract: ticket.contract }));
  assert.match(ticket.summary, /缺少交付文件：docs\/需求分析\.md/);
});

test('交付清单缺文件时能逐项报出来', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-deliverables-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', '需求分析.md'), '# 需求');
  const contract = normalizeContract({ deliverables: ['docs/需求分析.md', 'docs/实验报告.md', 'sql/schema.sql'] });
  assert.deepEqual(missingDeliverables(contract, dir), ['docs/实验报告.md', 'sql/schema.sql']);
  assert.deepEqual(missingDeliverables(contract, dir), ['docs/实验报告.md', 'sql/schema.sql'], '重复调用结果稳定');
  assert.deepEqual(missingDeliverables(null, dir), []);
  assert.deepEqual(missingDeliverables(contract, ''), []);
});
