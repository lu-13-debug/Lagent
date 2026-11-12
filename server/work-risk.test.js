import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview, previewQuestion } from './work/risk.js';
import { normalizeVerify, runVerify } from './work/verify.js';

test('审批预览按执行器生成动作、风险与层级，并脱敏凭据', () => {
  const terminal = buildPreview({ executor: { id: 'terminal', kind: 'tool' }, executorInput: { program: 'git', args: ['status'] } });
  assert.equal(terminal.kind, 'command');
  assert.equal(terminal.risk, 'low');
  assert.equal(terminal.tier, 'investigate');
  assert.match(terminal.action, /git status/);

  const window = buildPreview({ executor: { id: 'window', kind: 'tool' }, executorInput: { text: '继续处理', handle: 42 } });
  assert.equal(window.kind, 'window-input');
  assert.equal(window.risk, 'high');
  assert.equal(window.tier, 'autopilot');
  assert.equal(window.reversible, false);

  const projectPath = process.cwd();
  const write = buildPreview({ executor: { id: 'claude-code', kind: 'cli' }, executorInput: { prompt: '修复 token=secret-value', write: true }, project: { path: projectPath } });
  assert.equal(write.kind, 'file-write');
  assert.equal(write.risk, 'medium');
  assert.equal(write.tier, 'draft');
  assert.doesNotMatch(write.action, /secret-value/);
  assert.equal(write.paths[0], projectPath);
  assert.match(previewQuestion('Claude Code', write), /修改项目文件/);
});

test('验收命令只允许白名单、拒绝 shell 与越界 cwd', () => {
  const npm = normalizeVerify({ command: 'npm test', expect: 'exit=0' });
  assert.equal(npm.program, 'npm');
  assert.deepEqual(npm.args, ['test']);
  assert.throws(() => normalizeVerify({ command: 'npm test && rm -rf /' }), /shell/);
  assert.throws(() => normalizeVerify({ command: 'curl https://example.com' }), /白名单/);
  assert.throws(() => normalizeVerify({ command: 'npm test', cwd: '../outside' }), /cwd/);
  assert.throws(() => normalizeVerify({ command: 'npm test', expect: 'always' }), /expect/);
  assert.throws(() => normalizeVerify({ command: 'pytest ../../secret' }), /项目外/);
  assert.throws(() => normalizeVerify({ command: 'pytest C:/secret' }), /项目外/);
});

test('验收在 Lagent 侧执行并返回通过/失败证据', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pass = await runVerify({ verify: { command: 'npm --version', expect: 'exit=0' }, projectPath: dir });
  assert.equal(pass.status, 'passed');
  assert.equal(pass.exitCode, 0);
  assert.ok(pass.output.length > 0);

  writeFileSync(join(dir, 'fail.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fail', () => assert.equal(1, 2));\n", 'utf8');
  const fail = await runVerify({ verify: { command: 'node --test fail.test.mjs', expect: 'exit=0' }, projectPath: dir });
  assert.equal(fail.status, 'failed');
  assert.notEqual(fail.exitCode, 0);
  assert.match(fail.output, /fail|AssertionError|not ok/i);
});

test('引擎在工单完成后可执行验收，失败会进入阻塞并留证据', async t => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('./store.js');
  const { createWorkEngine } = await import('./work/engine.js');
  const { createExecutorRegistry } = await import('./work/executors/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'lagent-engine-verify-'));
  const store = new Store(dir);
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) { return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { terminal: { command: 'pwd', exitCode: 0 } } }; },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const pass = engine.command({ text: '验收通过', executorId: 'terminal', executorInput: { program: 'pwd', args: [] }, verify: { command: 'npm --version' } });
  assert.equal(pass.status, 'completed');
  const passed = await engine.verifyTicket(pass.id);
  assert.equal(passed.acceptance.status, 'passed');
  assert.equal(engine.detail(pass.id).ticket.acceptance.status, 'passed');

  writeFileSync(join(dir, 'fail.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fail', () => assert.equal(1, 2));\n", 'utf8');
  const fail = engine.command({ text: '验收失败', executorId: 'terminal', executorInput: { program: 'pwd', args: [] }, verify: { command: 'node --test fail.test.mjs' } });
  const failed = await engine.verifyTicket(fail.id);
  assert.equal(failed.acceptance.status, 'failed');
  assert.equal(failed.ticket.status, 'blocked');
  assert.match(failed.ticket.summary, /验收未通过/);
});

test('高风险动作即使默认不要求批准也会先进入待确认', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('./store.js');
  const { createWorkEngine } = await import('./work/engine.js');
  const { createExecutorRegistry } = await import('./work/executors/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'lagent-risk-gate-'));
  const store = new Store(dir);
  const window = {
    id: 'window', name: '窗口 Agent', kind: 'tool', available: true, requiresDataset: false, capabilities: ['window'],
    validateInput: input => input,
    start() { throw new Error('不应该直接启动'); },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([window]), () => {}, { workspace: dir, policy: { allowedExecutors: ['window'], requireApproval: false } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const ticket = engine.command({ text: '向窗口发指令', executorId: 'window', executorInput: { handle: 42, text: '继续处理' } });
  assert.equal(ticket.status, 'awaiting_review');
  assert.equal(ticket.preview.risk, 'high');
  assert.match(ticket.attention.question, /窗口|发送/);
});

test('项目简报支持未解问题/下一步/接手命令，并记录外部来源', async t => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('./store.js');
  const { createWorkEngine } = await import('./work/engine.js');
  const { createExecutorRegistry } = await import('./work/executors/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'lagent-brief-'));
  writeFileSync(join(dir, 'README.md'), '# demo\n', 'utf8');
  const store = new Store(dir);
  const terminal = { id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: [], start() { throw new Error('unused'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const { project } = engine.importProject({ path: dir });
  const brief = engine.saveProjectBrief(project.id, {
    goal: '交接测试',
    openQuestions: ['登录态怎么续？'],
    nextSteps: ['先跑 npm test'],
    verifyCommands: ['npm test']
  }, { source: 'mcp' });
  assert.deepEqual(brief.openQuestions, ['登录态怎么续？']);
  assert.deepEqual(brief.nextSteps, ['先跑 npm test']);
  assert.equal(brief.sources.openQuestions, 'mcp');
  const markdown = engine.projectBriefMarkdown(project.id).markdown;
  assert.match(markdown, /## 未解问题/);
  assert.match(markdown, /## 下一步/);
  assert.match(markdown, /## 接手先跑/);
  assert.match(markdown, /外部 Agent（MCP）/);
});
