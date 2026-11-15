import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createApp } from './app.js';

const stamp = '2026-11-15T10:00:00.000Z';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-sheet-'));
  const store = new Store(dir);
  const executors = createExecutorRegistry([
    { id: 'codex', name: 'Codex CLI', kind: 'cli', available: true, capabilities: [], start() { throw new Error('not used'); }, get() { return null; } },
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', available: true, capabilities: [], start() { throw new Error('not used'); }, get() { return null; } }
  ]);
  const engine = createWorkEngine(store, executors, () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, dir };
}

function seed(store, dir) {
  store.put('work-project', { id: 'project-1', name: 'Lagent', path: dir, gitBranch: 'main', createdAt: stamp, updatedAt: stamp });
  store.put('work-project-brief', {
    id: 'project-1', projectId: 'project-1', goal: '修复登录', summary: '已完成第一轮',
    keyPoints: [], decisions: [], constraints: [],
    openQuestions: ['旧 token 是否还要兼容'], nextSteps: ['补齐回归测试'], verifyCommands: ['npm test'], sources: {}, updatedAt: stamp
  });
  store.put('work-plan', {
    id: 'plan-1', goal: '修复登录', status: 'completed', autoRun: true, currentStep: 2,
    projectId: 'project-1', createdAt: stamp, updatedAt: stamp,
    steps: [
      { index: 0, ticketId: 'ticket-1', executorId: 'codex', title: '定位登录失败' },
      { index: 1, ticketId: 'ticket-2', executorId: 'claude-code', title: '补回归测试' }
    ]
  });
  store.put('work-ticket', {
    id: 'ticket-1', status: 'completed', executor: 'codex', title: '定位登录失败',
    summary: '已修复 token 过期', verify: { command: 'npm test', cwd: '.' },
    acceptance: { status: 'passed', command: 'npm test', exitCode: 0, output: 'ok', at: stamp },
    planId: 'plan-1', planStep: 0, createdAt: stamp, updatedAt: stamp
  });
  store.put('work-ticket', {
    id: 'ticket-2', status: 'completed', executor: 'claude-code', title: '补回归测试',
    summary: '新增 3 条用例', planId: 'plan-1', planStep: 1, createdAt: stamp, updatedAt: stamp
  });
  store.put('work-report', { id: 'report-1', ticketId: 'ticket-1', kind: 'ready', summary: '已修复 token 过期', createdAt: stamp });
  store.put('work-report', { id: 'report-2', ticketId: 'ticket-2', kind: 'ready', summary: '新增 3 条用例', createdAt: stamp });
  store.put('work-usage', { id: 'usage-1', ticketId: 'ticket-1', executorId: 'codex', calls: 3, totalTokens: 1200, costEstimate: 0.02, recordedAt: stamp });
  store.put('work-project-change', { id: 'ticket-1', projectId: 'project-1', ticketId: 'ticket-1', executorId: 'codex', files: ['src/auth.js'], status: 'completed', createdAt: stamp, updatedAt: stamp });
}

test('计划交接单汇总执行者、结论、验收、改动与下一步', t => {
  const { engine, store, dir } = fixture(t);
  seed(store, dir);
  const sheet = engine.planSheet('plan-1');
  assert.equal(sheet.plan.id, 'plan-1');
  assert.equal(sheet.rows.length, 2);
  const markdown = sheet.markdown;
  assert.match(markdown, /# 交接单：修复登录/);
  assert.match(markdown, /Codex CLI/);
  assert.match(markdown, /Claude Code/);
  assert.match(markdown, /已修复 token 过期/);
  assert.match(markdown, /npm test/);
  assert.match(markdown, /验收通过/);
  assert.match(markdown, /退出码 0/);
  assert.match(markdown, /1,200/);
  assert.match(markdown, /src\/auth\.js/);
  assert.match(markdown, /## 下一步/);
  assert.match(markdown, /补齐回归测试/);
  assert.match(markdown, /## 未解问题/);
  assert.match(markdown, /旧 token 是否还要兼容/);
});

test('计划不存在时交接单返回 404', t => {
  const { engine } = fixture(t);
  assert.throws(() => engine.planSheet('missing'), /计划不存在/);
});

test('交接单路由返回可下载的 Markdown', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-sheet-route-'));
  const app = createApp({ dataDir: dir, workEnabled: true, serveStatic: false });
  seed(app.locals.store, dir);
  t.after(() => { app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  const handler = app.router.stack.find(layer => layer.route?.path === '/api/work/plans/:id/sheet')?.route.stack[0].handle;
  assert.equal(typeof handler, 'function');
  let output;
  handler({ params: { id: 'plan-1' } }, { status() { return this; }, json(value) { output = value; } });
  assert.match(output.markdown, /# 交接单：修复登录/);
});
