import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { registerWork } from './work/routes.js';
import { createExecutorRegistry } from './work/executors/index.js';

// 审批中心按开关启用；本文件单独跑，开关只影响这个进程。
process.env.LAGENT_APPROVALS = '1';
process.env.LAGENT_RUN_EVENTS = '1';

const route = (app, path, method = 'GET') => app.router.stack
  .find(layer => layer.route?.path === path && layer.route.methods?.[method.toLowerCase()])?.route.stack[0].handle;
const invoke = async (app, path, req = {}) => {
  let output;
  const res = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { output = value; return this; },
    send(value) { output = { __sent: value }; return this; },
    type() { return this; },
    set() { return this; },
    flushHeaders() {}, write() {}, end() {}
  };
  await route(app, path, req.method || 'GET')(req, res);
  return { status: res.statusCode, ...output };
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-approvals-routes-'));
  const store = new Store(join(dir, 'data'));
  const app = express();
  app.use(express.json());
  const executor = {
    id: 'terminal', name: '受控终端', kind: 'terminal', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ command: text }),
    validateInput: input => input,
    start(ticket, assignment) {
      const task = { id: assignment.id, status: 'running', goal: ticket.command };
      store.put('task', task);
      return task;
    },
    get: id => id && store.get('task', id),
    approve(task) { store.put('task', { ...task, status: 'running' }); },
    resolvePermission(task, requestId, decision) {
      this.permissions = [...(this.permissions || []), { requestId, decision }];
      return true;
    },
    stop(task) { store.put('task', { ...task, status: 'cancelled' }); }
  };
  const gateway = {
    publish() {},
    authenticateRequest: () => ({ id: 'd1', ownerId: 'local' }),
    unreadNotificationCount: () => 0
  };
  // 编排器默认会把工作流状态写到 data/orchestrator.db；测试用内存库，避免污染仓库和 Windows 文件锁。
  process.env.LAGENT_RUN_DB = ':memory:';
  const close = registerWork(app, store, createExecutorRegistry([executor]), { workspace: dir, mobileGateway: gateway, mobileOwnerId: 'local', ownerId: 'local' });
  const engine = app.locals.workEngine;
  engine.updatePolicy({ requireApproval: true, allowedExecutors: ['terminal'] });
  t.after(() => {
    close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { app, engine, store, executor };
}

test('审批路由：建单即入收件箱，桌面决议后工单继续，重复决议 409', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  assert.equal(created.ticket.status, 'awaiting_review');
  assert.ok(created.ticket.approvalId, '工单带上 approvalId，旧客户端也能深链');

  const bootstrap = await invoke(f.app, '/api/work/bootstrap');
  assert.equal(bootstrap.approvals.length, 1);
  assert.equal(bootstrap.approvals[0].ticketId, created.ticket.id);
  assert.equal(bootstrap.approvals[0].status, 'pending');
  assert.equal(bootstrap.approvals[0].input, undefined, 'bootstrap 不带原始输入');

  const listed = await invoke(f.app, '/api/work/approvals');
  assert.equal(listed.approvals.length, 1);
  const detail = await invoke(f.app, '/api/work/approvals/:id', { params: { id: listed.approvals[0].id } });
  assert.equal(detail.approval.input.command, '检查目录');

  const decided = await invoke(f.app, '/api/work/approvals/:id/decision', { method: 'POST', params: { id: listed.approvals[0].id }, body: { decision: 'allow_once' } });
  assert.equal(decided.approval.status, 'resolved');
  assert.equal(decided.approval.decision, 'allow_once');
  assert.equal(decided.approval.decidedBy, 'desktop');
  const current = await invoke(f.app, '/api/work/tickets/:id', { params: { id: created.ticket.id } });
  assert.notEqual(current.ticket.status, 'awaiting_review', '批准后工单继续执行');

  const again = await invoke(f.app, '/api/work/approvals/:id/decision', { method: 'POST', params: { id: listed.approvals[0].id }, body: { decision: 'allow_once' } });
  assert.equal(again.status, 409);
  assert.equal(again.code, 'APPROVAL_ALREADY_SETTLED');
});

test('审批路由：P0 不开放会话级授权，返回 409 GRANT_NOT_ENABLED 且保持 pending', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  const pending = (await invoke(f.app, '/api/work/approvals')).approvals[0];
  const result = await invoke(f.app, '/api/work/approvals/:id/decision', { method: 'POST', params: { id: pending.id }, body: { decision: 'allow_session' } });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'GRANT_NOT_ENABLED');
  const detail = await invoke(f.app, '/api/work/approvals/:id', { params: { id: pending.id } });
  assert.equal(detail.approval.status, 'pending');
  assert.equal((await invoke(f.app, '/api/work/tickets/:id', { params: { id: created.ticket.id } })).ticket.status, 'awaiting_review');
});

test('旧工单按钮与审批是同一事实：actions approve 会结束 pending', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  assert.equal((await invoke(f.app, '/api/work/approvals')).approvals.length, 1);
  await invoke(f.app, '/api/work/tickets/:id/actions', { method: 'POST', params: { id: created.ticket.id }, body: { action: 'approve' } });
  const after = await invoke(f.app, '/api/work/approvals');
  assert.equal(after.approvals.length, 0, '批准后收件箱不再有 pending');
  const resolved = await invoke(f.app, '/api/work/approvals', { query: { status: 'resolved' } });
  assert.equal(resolved.approvals.length, 1);
  assert.equal(resolved.approvals[0].decision, 'allow_once');
});

test('手机审批：bootstrap 带脱敏审批，手机决议走同一服务', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  const bootstrap = await invoke(f.app, '/api/mobile/bootstrap', { mobileAuthenticated: true, mobileDevice: { id: 'd1', ownerId: 'local' } });
  assert.equal(bootstrap.approvals.length, 1);
  assert.equal(bootstrap.approvals[0].input, undefined);
  assert.equal(bootstrap.approvals[0].ticketId, created.ticket.id);

  const listed = await invoke(f.app, '/api/mobile/approvals', { mobileAuthenticated: true, mobileDevice: { id: 'd1', ownerId: 'local' } });
  assert.equal(listed.approvals.length, 1);
  const decided = await invoke(f.app, '/api/mobile/approvals/:id/decision', {
    method: 'POST',
    params: { id: listed.approvals[0].id },
    body: { decision: 'deny' },
    mobileAuthenticated: true,
    mobileDevice: { id: 'd1', ownerId: 'local' }
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.approval.status, 'resolved');
  assert.equal(decided.approval.decision, 'deny');
  assert.equal(decided.approval.decidedBy, 'd1');
  assert.equal((await invoke(f.app, '/api/work/tickets/:id', { params: { id: created.ticket.id } })).ticket.status, 'waiting');
});

test('执行器交互授权：越权访问与 ACP 权限进入收件箱，旧权限接口能结束审批', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  await invoke(f.app, '/api/work/tickets/:id/actions', { method: 'POST', params: { id: created.ticket.id }, body: { action: 'approve' } });
  const detail = await invoke(f.app, '/api/work/tickets/:id', { params: { id: created.ticket.id } });
  const assignment = detail.assignments[0];
  assert.ok(assignment?.sessionId);

  // 越权访问：任务挂起，sync 应生成 access 审批。
  f.store.put('task', {
    id: assignment.sessionId,
    status: 'awaiting_approval',
    accessRequest: { id: 'acc-1', path: '/etc/hosts', mode: 'read', at: new Date().toISOString() },
    activity: [{ kind: 'waiting', text: '请求读取：/etc/hosts' }]
  });
  f.engine.recover();
  const pending = (await invoke(f.app, '/api/work/approvals')).approvals;
  const access = pending.find(item => item.kind === 'access');
  assert.ok(access, '越权访问生成审批');
  assert.equal(access.requestId, 'acc-1');
  assert.equal(access.ticketId, created.ticket.id);

  const decided = await invoke(f.app, '/api/work/tickets/:id/permissions/:requestId', {
    method: 'POST', params: { id: created.ticket.id, requestId: 'acc-1' }, body: { decision: 'allow' }
  });
  assert.equal(decided.approval.status, 'resolved');
  assert.equal(decided.approval.decision, 'allow_once');
  assert.ok(!(await invoke(f.app, '/api/work/approvals')).approvals.some(item => item.kind === 'access'));

  // ACP 权限：running 中的 pending 权限行也要进收件箱，且按指纹去重。
  f.store.put('task', {
    id: assignment.sessionId,
    status: 'running',
    activity: [{ kind: 'permission', requestId: 'perm-1', text: '请求访问项目文件', detail: '允许一次', at: new Date().toISOString() }]
  });
  f.engine.recover();
  f.engine.recover();
  const tools = (await invoke(f.app, '/api/work/approvals')).approvals.filter(item => item.kind === 'tool');
  assert.equal(tools.length, 1, '重复 sync 不产生重复审批');
  assert.equal(tools[0].requestId, 'perm-1');
});

test('审批事件写入 run-event：requested/resolved 带 threadId', async t => {
  const f = fixture(t);
  f.store.put('work-run', { id: 'run-1', goal: '整理发布说明', chatId: 'conv-1', steps: [], status: 'awaiting_approval' });
  const log = f.app.locals.runEvents;
  if (!log) return t.skip('LAGENT_RUN_EVENTS 未开启');
  await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  const pending = (await invoke(f.app, '/api/work/approvals')).approvals[0];
  await invoke(f.app, '/api/work/approvals/:id/decision', { method: 'POST', params: { id: pending.id }, body: { decision: 'deny' } });
  const events = log.listAfter(0, 50).filter(event => event.workType === 'approval');
  assert.ok(events.some(event => event.type === 'approval.requested'));
  assert.ok(events.some(event => event.type === 'approval.resolved'));
  assert.ok(events.every(event => typeof event.threadId === 'string' && event.threadId));
});

test('运行级审批：计划待批准生成 run 审批，取消后自动收口', async t => {
  const f = fixture(t);
  const started = await invoke(f.app, '/api/work/runs', { method: 'POST', body: { goal: '整理发布说明并检查文档是否完整' } });
  assert.ok(started.run?.id, '编排器返回运行记录');
  // 工作流在后台推进，等它停在 approve 步骤。
  let run = started.run;
  for (let index = 0; index < 60 && !['awaiting_approval', 'failed', 'cancelled'].includes(run.status); index++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    run = f.store.get('work-run', started.run.id) || run;
  }
  assert.equal(run.status, 'awaiting_approval');
  let pending = [];
  for (let index = 0; index < 20 && !pending.some(item => item.kind === 'run'); index++) {
    pending = (await invoke(f.app, '/api/work/approvals')).approvals;
    if (!pending.some(item => item.kind === 'run')) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const runApproval = pending.find(item => item.kind === 'run' && item.runId === started.run.id);
  assert.ok(runApproval, '计划待批准进入审批收件箱');
  assert.equal(runApproval.threadId, run.chatId || started.run.id);

  await invoke(f.app, '/api/work/runs/:id/cancel', { method: 'POST', params: { id: started.run.id } });
  const after = (await invoke(f.app, '/api/work/approvals')).approvals;
  assert.ok(!after.some(item => item.runId === started.run.id), '取消运行后 pending 审批同步取消');
  const cancelled = (await invoke(f.app, '/api/work/approvals', { query: { status: 'cancelled' } })).approvals;
  assert.ok(cancelled.some(item => item.id === runApproval.id));
});

test('旧运行审批入口：先落决议，再交给编排器（运行不存在时仍返回 404）', async t => {
  const f = fixture(t);
  const approvals = f.app.locals.approvals;
  assert.ok(approvals, '审批服务已注入');
  const pending = approvals.request({ threadId: 'conv-run', runId: 'missing-run', kind: 'run', title: '计划待批准', summary: '历史运行' });
  const result = await invoke(f.app, '/api/work/runs/:id/approve', { method: 'POST', params: { id: 'missing-run' }, body: { decision: 'approve' } });
  assert.equal(result.status, 404);
  assert.equal(approvals.detail(pending.id).status, 'resolved');
  assert.equal(approvals.detail(pending.id).decision, 'allow_once');
  assert.equal(approvals.detail(pending.id).decidedBy, 'desktop');
});
