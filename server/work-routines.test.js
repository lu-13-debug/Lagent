import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createRoutineService } from './work/routines.js';

function fixture(t, { requireApproval = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-routines-'));
  const store = new Store(join(dir, 'data'));
  const started = [];
  const cli = {
    id: 'codex', name: 'Codex', kind: 'cli', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ prompt: text }), validateInput: input => input,
    start(ticket, assignment) {
      started.push(ticket.id);
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: {} };
    },
    get: () => null
  };
  const engine = createWorkEngine(store, createExecutorRegistry([cli]), () => {}, {
    workspace: dir,
    policy: { allowedExecutors: ['codex'], requireApproval, budgets: { maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 100000 } },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }
  });
  const project = engine.importProject({ path: dir, name: 'Routine 项目' }).project;
  let time = Date.parse('2026-11-14T08:00:00.000Z');
  const routines = createRoutineService({ store, engine, now: () => time });
  t.after(() => { routines.stop(); engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine, project, routines, started, advance: ms => { time += ms; }, now: () => time };
}

test('Routine 默认创建待批准的建议工单，不自动执行', t => {
  const f = fixture(t);
  const saved = f.routines.save({ name: '每日检查', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: '检查 {{project}} 的 {{date}} 状态', enabled: true, schedule: { kind: 'interval', intervalMs: 3600000 } });
  assert.equal(saved.routine.enabled, true);
  assert.ok(saved.routine.nextAt > f.now());
  const result = f.routines.runNow(saved.routine.id);
  assert.equal(result.text, '已创建建议工单');
  const ticket = result.tickets[0];
  assert.equal(ticket.status, 'awaiting_review');
  assert.equal(ticket.source, 'routine');
  assert.equal(ticket.routineId, saved.routine.id);
  const command = f.store.get('work-control', ticket.id).command;
  assert.match(command, /Routine 项目/);
  assert.match(command, /2026-11-14/);
  assert.equal(f.started.length, 0);
  assert.equal(f.routines.get(saved.routine.id).lastTicketId, ticket.id);
});

test('Routine auto 模式在策略允许时批准执行', t => {
  const f = fixture(t);
  const saved = f.routines.save({ name: '自动日报', projectId: f.project.id, executorId: 'codex', kind: 'daily-brief', mode: 'auto', enabled: true, schedule: { kind: 'manual' } });
  const result = f.routines.runNow(saved.routine.id);
  assert.equal(result.autoApproved, true);
  assert.equal(f.started.length, 1);
  assert.equal(f.engine.detail(result.tickets[0].id).ticket.status, 'completed');
});

test('Routine 每日计划只创建一次 nextAt，禁用后不调度', t => {
  const f = fixture(t);
  const saved = f.routines.save({ name: '每日九点', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: '日报', enabled: true, schedule: { kind: 'daily', at: '09:00' } });
  assert.ok(saved.routine.nextAt > f.now());
  assert.ok(saved.routine.nextAt <= f.now() + 24 * 60 * 60 * 1000);
  const row = f.store.get('work-routine', saved.routine.id);
  f.store.put('work-routine', { ...row, nextAt: f.now() - 1 });
  const ticked = f.routines.tick();
  assert.equal(ticked.ran, 1);
  assert.ok(f.store.get('work-routine', saved.routine.id).nextAt > f.now());
  const disabled = f.routines.save({ id: saved.routine.id, enabled: false });
  assert.equal(disabled.routine.nextAt, null);
  assert.equal(f.routines.tick().ran, 0);
});

test('Routine Webhook 令牌只显示一次，错误令牌拒绝', t => {
  const f = fixture(t);
  const saved = f.routines.save({ name: 'Webhook 触发', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: '处理触发', enabled: true, schedule: { kind: 'webhook' } });
  assert.ok(saved.webhookToken);
  assert.doesNotMatch(JSON.stringify(f.routines.list()), new RegExp(saved.webhookToken));
  assert.throws(() => f.routines.triggerWebhook('wrong-token', {}), { status: 401 });
  const triggered = f.routines.triggerWebhook(saved.webhookToken, { text: '来自 CI 的提醒' });
  assert.equal(triggered.tickets.length, 1);
  assert.match(f.store.get('work-control', triggered.tickets[0].id).command, /来自 CI 的提醒/);
  // 轮换后旧令牌失效。
  const rotated = f.routines.save({ id: saved.routine.id, rotateWebhook: true });
  assert.notEqual(rotated.webhookToken, saved.webhookToken);
  assert.throws(() => f.routines.triggerWebhook(saved.webhookToken, {}), { status: 401 });
});

test('停滞跟进只为超时工单创建建议', t => {
  const f = fixture(t);
  const chat = f.engine.createProjectChat(f.project.id, { executorId: 'codex' }).chat;
  const old = new Date(f.now() - 60 * 60 * 1000).toISOString();
  f.store.put('work-ticket', { id: 'stale-ticket', title: '卡住的恢复任务', status: 'working', executor: 'codex', projectChatId: chat.id, createdAt: old, updatedAt: old });
  f.store.put('work-control', { id: 'stale-ticket', command: '恢复', executor: 'codex', executorInput: {}, projectChatId: chat.id });
  const saved = f.routines.save({ name: '停滞跟进', projectId: f.project.id, executorId: 'codex', kind: 'stall-followup', stallMs: 30 * 60 * 1000, enabled: true, schedule: { kind: 'manual' } });
  const result = f.routines.runNow(saved.routine.id);
  assert.equal(result.tickets.length, 1);
  assert.match(result.tickets[0].title, /停滞跟进/);
  assert.match(result.tickets[0].attention.question, /疑似停滞/);
});

test('Routine 校验间隔与必填字段', t => {
  const f = fixture(t);
  assert.throws(() => f.routines.save({ name: 'x', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: 'x', schedule: { kind: 'interval', intervalMs: 1000 } }), { status: 400 });
  assert.throws(() => f.routines.save({ name: 'x', projectId: f.project.id, executorId: 'codex', kind: 'task', schedule: { kind: 'manual' } }), { status: 400 });
});

test('文件与 Git 触发只在变化时创建一次建议', t => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'notes.md'), 'v1');
  const fileRoutine = f.routines.save({ name: '文件变化', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: '处理文件变化', enabled: true, schedule: { kind: 'file', path: 'notes.md' } });
  assert.equal(fileRoutine.routine.nextAt, null);
  assert.equal(f.routines.tick().ran, 0);
  writeFileSync(join(f.dir, 'notes.md'), 'v2-changed');
  assert.equal(f.routines.tick().ran, 1);
  assert.equal(f.routines.tick().ran, 0);
  const tickets = f.store.list('work-ticket').filter(ticket => ticket.routineId === fileRoutine.routine.id);
  assert.equal(tickets.length, 1);
  assert.match(f.store.get('work-control', tickets[0].id).command, /处理文件变化/);
  // 敏感路径不能被监视；Git 触发在非仓库项目里保持静默。
  assert.throws(() => f.routines.save({ name: '禁', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: 'x', schedule: { kind: 'file', path: '../outside' } }), { status: 400 });
  assert.throws(() => f.routines.save({ name: '禁', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: 'x', schedule: { kind: 'file', path: '.env.local' } }), { status: 403 });
  const gitRoutine = f.routines.save({ name: 'Git 变化', projectId: f.project.id, executorId: 'codex', kind: 'task', promptTemplate: '处理提交', enabled: true, schedule: { kind: 'git' } });
  assert.equal(gitRoutine.routine.nextAt, null);
  assert.equal(f.routines.tick().ran, 0);
});
