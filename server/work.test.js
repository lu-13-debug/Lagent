import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { workEvents } from './work/effects.js';
import { workStore } from './work/store.js';
import { createApp } from './app.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { terminalExecutor, validateTerminalInput } from './work/executors/terminal.js';

const makeDataset = (id, overrides = {}) => ({
  id,
  name: `数据集 ${id}`,
  rowCount: 12,
  source: 'upload',
  records: { users: [{ id: 'private-record' }] },
  privateToken: 'must-not-leak',
  createdAt: '2026-11-05T00:00:00.000Z',
  ...overrides
});

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-'));
  const store = new Store(dir);
  const datasets = options.datasets ?? [makeDataset('dataset-one')];
  for (const dataset of datasets) store.put('dataset', dataset);
  const events = [];
  const starts = [];
  const startInputs = [];
  let engine;
  const executor = {
    start(ticket, assignment, input) {
      starts.push(assignment.id);
      startInputs.push(input);
      if (!input?.datasetId) throw Object.assign(new Error('当前工作区没有可用数据集'), { status: 400 });
      const task = { id: assignment.id, status: 'running', goal: ticket.command };
      store.put('task', task);
      return task;
    },
    get: id => id && store.get('task', id),
    resume() {},
    approve(task) { store.put('task', { ...task, status: 'running' }); },
    stop(task) { store.put('task', { ...task, status: 'cancelled' }); }
  };
  const open = () => { engine = createWorkEngine(store, options.executorFactory ? options.executorFactory(executor) : executor, event => events.push(event), { ...(options.planner ? { planner: options.planner } : {}) }); };
  open();
  // 这些用例验证的是「先批准再执行」的审批链路，需要显式打开该策略；产品默认已改成直接执行。
  engine.updatePolicy({ requireApproval: true });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    engine,
    store,
    executor,
    starts,
    startInputs,
    events,
    restart() { engine.close(); open(); engine.recover(); return engine; }
  };
}

function route(target, path) { return target.router.stack.find(layer => layer.route?.path === path)?.route.stack[0].handle; }
function call(target, path, req = {}) {
  let output;
  const res = { status() { return this; }, json(value) { output = value; }, set() { return this; }, flushHeaders() {}, write() {}, end() {} };
  route(target, path)(req, res);
  return output;
}
function sseResponse() {
  const response = new EventEmitter();
  const chunks = [];
  response.set = () => {};
  response.flushHeaders = () => {};
  response.write = chunk => chunks.push(chunk);
  response.end = () => response.emit('close');
  return { response, chunks };
}

test('Work契约字段、命令幂等、输入校验及严格投影', t => {
  const f = fixture(t);
  f.store.put('dataset', makeDataset('dataset-two'));
  assert.throws(() => f.engine.command({ text: '   ' }), { status: 400 });
  assert.throws(() => f.engine.command({ text: 'x'.repeat(3001) }), { status: 400 });
  assert.throws(() => f.engine.command({ text: '有效指令', clientRequestId: 'x'.repeat(121) }), { status: 400 });
  assert.throws(() => f.engine.command({ text: '无效选择', datasetId: 'missing' }), { status: 400 });
  assert.throws(() => f.engine.command({ text: '无效类型', datasetId: 42 }), { status: 400 });
  const ticket = f.engine.command({ text: '检查留存', clientRequestId: 'once', datasetId: 'dataset-one' });
  assert.equal(ticket.datasetId, 'dataset-one');
  assert.equal(f.engine.command({ text: ' 检查留存 ', clientRequestId: 'once', datasetId: 'dataset-one' }).id, ticket.id);
  assert.throws(() => f.engine.command({ text: '检查留存', clientRequestId: 'once', datasetId: 'dataset-two' }), { status: 409 });
  assert.throws(() => f.engine.command({ text: '不同指令', clientRequestId: 'once', datasetId: 'dataset-one' }), { status: 409 });
  assert.deepEqual(Object.keys(ticket).sort(), ['acceptance', 'attention', 'chainRootId', 'contract', 'createdAt', 'datasetId', 'executor', 'handoff', 'handoffChildId', 'handoffDepth', 'handoffSummary', 'id', 'parentTicketId', 'planId', 'planStep', 'planTotal', 'preview', 'source', 'stage', 'status', 'summary', 'title', 'updatedAt', 'verify']);
  const bootstrap = f.engine.bootstrap();
  assert.deepEqual(Object.keys(bootstrap).sort(), ['activeProfile', 'agents', 'attention', 'capabilities', 'datasets', 'plans', 'policy', 'profiles', 'projects', 'queue', 'tickets', 'tools', 'workspace']);
  assert.deepEqual(bootstrap.projects, []);
  assert.equal(bootstrap.capabilities.work, true);
  assert.equal(bootstrap.policy.acceptMode, 'explicit');
  assert.deepEqual(Object.keys(bootstrap.datasets[0]).sort(), ['id', 'name', 'rowCount', 'source']);
  assert.deepEqual(Object.keys(bootstrap.attention[0]).sort(), ['createdAt', 'options', 'question', 'ticketId', 'title']);
  assert.deepEqual(Object.keys(bootstrap.attention[0].options[0]).sort(), ['action', 'id', 'label']);
  const detail = f.engine.detail(ticket.id);
  assert.deepEqual(Object.keys(detail).sort(), ['assignments', 'reports', 'team', 'ticket']);
  assert.equal(detail.team, null);
  assert.equal(detail.ticket.datasetId, 'dataset-one');
  assert.doesNotMatch(JSON.stringify({ ticket, bootstrap, detail }), /clientRequestId|lastAction|approvalSnapshot|private-record|privateToken|"command"/);
  assert.throws(() => f.engine.detail('missing'), { status: 404 });
  assert.throws(() => f.engine.action(ticket.id, 'explode'), { status: 400 });
  assert.throws(() => f.engine.action(ticket.id, 'resume'), { status: 409 });
});

test('Work bootstrap 数据集元数据最多50条且不含原始记录或私有字段', t => {
  const datasets = Array.from({ length: 55 }, (_, index) => makeDataset(`dataset-${index}`, {
    name: `数据 ${index}`,
    rowCount: index + 1,
    source: index % 2 ? 'upload' : 'demo'
  }));
  const f = fixture(t, { datasets });
  const listed = f.engine.bootstrap().datasets;
  assert.equal(listed.length, 50);
  assert.equal(listed[0].id, 'dataset-54');
  for (const dataset of listed) {
    assert.deepEqual(Object.keys(dataset).sort(), ['id', 'name', 'rowCount', 'source']);
    assert.equal(typeof dataset.id, 'string');
    assert.equal(typeof dataset.name, 'string');
    assert.equal(typeof dataset.rowCount, 'number');
    assert.equal(typeof dataset.source, 'string');
  }
});

test('Work 数据集选择支持单数据集自动、显式选择、多数据集拒绝缺失及无数据集阻塞', t => {
  const single = fixture(t);
  const automaticTicket = single.engine.command({ text: '单数据集自动选择' });
  assert.equal(automaticTicket.datasetId, null);
  const automatic = single.engine.action(automaticTicket.id, 'approve');
  assert.equal(automatic.status, 'working');
  assert.equal(automatic.datasetId, 'dataset-one');
  assert.equal(single.startInputs[0].datasetId, 'dataset-one');

  const multiple = fixture(t, { datasets: [makeDataset('dataset-one'), makeDataset('dataset-two')] });
  const missing = multiple.engine.command({ text: '多数据集必须选择' });
  assert.throws(() => multiple.engine.action(missing.id, 'approve'), { status: 400 });
  assert.equal(multiple.engine.detail(missing.id).ticket.status, 'awaiting_review');
  const explicit = multiple.engine.action(missing.id, 'approve', { datasetId: 'dataset-two' });
  assert.equal(explicit.status, 'working');
  assert.equal(explicit.datasetId, 'dataset-two');
  assert.equal(multiple.startInputs[0].datasetId, 'dataset-two');
  const preselected = multiple.engine.command({ text: '命令时预选', datasetId: 'dataset-one' });
  assert.equal(preselected.datasetId, 'dataset-one');
  assert.equal(multiple.engine.action(preselected.id, 'approve').datasetId, 'dataset-one');

  const empty = fixture(t, { datasets: [] });
  const noDataset = empty.engine.command({ text: '没有数据集' });
  const blocked = empty.engine.action(noDataset.id, 'approve');
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.summary, /没有可用数据集|请先上传/);
  assert.equal(empty.starts.length, 0);
  const emptyDetail = empty.engine.detail(noDataset.id);
  assert.equal(emptyDetail.assignments[0].status, 'blocked');
  assert.equal(emptyDetail.reports[0].kind, 'blocked');
});

test('Work command 与 approve 拒绝不存在及跨工作区 datasetId', t => {
  const a = fixture(t, { datasets: [makeDataset('only-a')] });
  const b = fixture(t, { datasets: [makeDataset('only-b')] });
  assert.throws(() => b.engine.command({ text: '跨工作区命令', datasetId: 'only-a' }), { status: 400 });
  const ticket = b.engine.command({ text: '当前工作区批准' });
  assert.throws(() => b.engine.action(ticket.id, 'approve', { datasetId: 'only-a' }), { status: 400 });
  assert.equal(b.engine.detail(ticket.id).ticket.status, 'awaiting_review');
  assert.equal(b.engine.action(ticket.id, 'approve', { datasetId: 'only-b' }).datasetId, 'only-b');
  assert.equal(a.engine.bootstrap().datasets[0].id, 'only-a');
});

test('Work审批、退回、恢复、停止及重派幂等，工作区隔离', t => {
  const a = fixture(t), b = fixture(t);
  const ticket = a.engine.command({ text: '检查收益' });
  assert.throws(() => b.engine.detail(ticket.id), { status: 404 });
  assert.deepEqual(b.engine.bootstrap().tickets, []);
  assert.equal(a.engine.action(ticket.id, 'reject').status, 'waiting');
  assert.equal(a.engine.action(ticket.id, 'reject').status, 'waiting');
  assert.equal(a.engine.action(ticket.id, 'resume').status, 'awaiting_review');
  a.engine.action(ticket.id, 'approve');
  assert.equal(a.engine.action(ticket.id, 'stop').status, 'cancelled');
  assert.equal(a.engine.action(ticket.id, 'stop').status, 'cancelled');
  assert.equal(a.engine.action(ticket.id, 'retry').status, 'working');
  assert.equal(a.engine.action(ticket.id, 'retry').status, 'working');
  assert.equal(a.starts.length, 2);
  assert.equal(a.engine.detail(ticket.id).ticket.datasetId, 'dataset-one');
});

test('Work任务状态同步、报告 artifacts 与工作重启恢复', async t => {
  const f = fixture(t), ticket = f.engine.command({ text: '检查留存', clientRequestId: 'run' });
  f.engine.action(ticket.id, 'approve');
  const assignment = f.engine.detail(ticket.id).assignments[0];
  f.store.put('task', { id: assignment.sessionId, status: 'awaiting_approval' });
  await Promise.resolve();
  assert.equal(f.engine.detail(ticket.id).ticket.status, 'awaiting_review');
  f.store.put('dataset', makeDataset('dataset-two'));
  assert.throws(() => f.engine.action(ticket.id, 'approve', { datasetId: 'dataset-two' }), { status: 400 });
  const engine = f.restart();
  assert.equal(engine.detail(ticket.id).ticket.status, 'awaiting_review');
  engine.action(ticket.id, 'approve');
  f.store.put('task', { id: assignment.sessionId, status: 'completed', report: { summary: '结果' } });
  await Promise.resolve();
  const detail = engine.detail(ticket.id);
  assert.equal(detail.ticket.status, 'completed');
  assert.equal(detail.ticket.datasetId, 'dataset-one');
  assert.equal(detail.assignments[0].status, 'completed');
  assert.equal(detail.reports[0].kind, 'ready');
  assert.equal(detail.reports[0].artifacts.taskId, assignment.sessionId);
  assert.equal(detail.reports[0].artifacts.report.summary, '结果');
  assert.deepEqual(new Set(f.events.map(event => event.type)), new Set(['ticket', 'assignment', 'report']));
});

test('Work服务重启后待确认工单同步为失败并可重试', async t => {
  const f = fixture(t), ticket = f.engine.command({ text: '等待计划确认' });
  f.engine.action(ticket.id, 'approve');
  const assignment = f.engine.detail(ticket.id).assignments[0];
  f.store.put('task', { id: assignment.sessionId, status: 'awaiting_approval' });
  await Promise.resolve();
  assert.equal(f.engine.detail(ticket.id).ticket.status, 'awaiting_review');
  f.engine.close();
  f.store.put('task', { id: assignment.sessionId, status: 'failed', error: '服务已重启，先前任务中断' });
  const engine = f.restart();
  const detail = engine.detail(ticket.id);
  assert.equal(detail.ticket.status, 'failed');
  assert.equal(detail.assignments[0].status, 'failed');
  assert.equal(detail.reports.find(report => report.kind === 'failed')?.kind, 'failed');
  assert.match(detail.ticket.summary, /重启|中断/);
  assert.equal(engine.action(ticket.id, 'retry').status, 'working');
  assert.equal(f.starts.length, 2);
});

test('Work event 在写入事务内裁剪为每 ticket 500 条及全局 5000 条', t => {
  const f = fixture(t, { datasets: [] });
  const store = workStore(f.store, () => {});
  const event = (ticketId, id) => ['assignment', { id, ticketId, status: 'working' }];
  store.write(Array.from({ length: 510 }, (_, index) => event('ticket-a', `a-${index}`)));
  let retained = f.store.list('work-event');
  assert.equal(retained.length, 500);
  assert.equal(retained[0].payload.id, 'a-509');
  assert.equal(retained.at(-1).payload.id, 'a-10');
  assert.equal(retained.filter(item => item.ticketId === 'ticket-a').length, 500);

  const more = [];
  for (let ticketIndex = 0; ticketIndex < 9; ticketIndex++) {
    const ticketId = `ticket-${ticketIndex}`;
    for (let index = 0; index < 500; index++) more.push(event(ticketId, `${ticketId}-${index}`));
  }
  for (let index = 0; index < 5; index++) more.push(event('ticket-tail', `tail-${index}`));
  store.write(more);
  retained = f.store.list('work-event');
  assert.equal(retained.length, 5000);
  assert.equal(retained[0].payload.id, 'tail-4');
  assert.equal(retained.filter(item => item.ticketId === 'ticket-a').length, 495);
  assert.equal(retained.some(item => item.payload.id === 'a-0' || item.payload.id === 'a-14'), false);
  assert.ok(retained.every(item => retained.filter(candidate => candidate.ticketId === item.ticketId).length <= 500));
});

test('Work SSE发送三类事件、空闲心跳并关闭连接', async () => {
  const effects = workEvents({ heartbeatMs: 5 });
  const { response, chunks } = sseResponse();
  effects.connect({}, response);
  await new Promise(resolve => setTimeout(resolve, 15));
  for (const type of ['ticket', 'assignment', 'report']) effects.publish({ type, ticketId: 'id', payload: { type } });
  effects.close();
  assert.ok(chunks.includes(': heartbeat\n\n'));
  const messages = chunks.filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));
  assert.deepEqual(messages.map(message => message.type), ['ticket', 'assignment', 'report']);
  assert.deepEqual(Object.keys(messages[0]).sort(), ['payload', 'ticketId', 'type']);
});

test('Work SSE 支持 Last-Event-ID 断线重放', () => {
  const store = new Store(tmpdir());
  store.put('work-event', { id: 'e1', type: 'ticket', ticketId: 't1', payload: { x: 1 }, createdAt: '2026-11-12T00:00:01.000Z' });
  store.put('work-event', { id: 'e2', type: 'assignment', ticketId: 't1', payload: { x: 2 }, createdAt: '2026-11-12T00:00:02.000Z' });
  const effects = workEvents({ store, heartbeatMs: 5 });
  const { response: replay, chunks: replayChunks } = sseResponse();
  effects.connect({ headers: { 'last-event-id': '2026-11-12T00:00:01.000Z' } }, replay);
  effects.close();
  const replayMessages = replayChunks.filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));
  assert.equal(replayMessages.length, 1);
  assert.equal(replayMessages[0].type, 'assignment');
  store.close();
});

test('Work默认关闭，开启后契约路由、SSE 与单数据集自动选择可用', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-app-'));
  const app = createApp({ dataDir: join(dir, 'enabled'), workEnabled: true });
  const old = createApp({ dataDir: join(dir, 'old'), workEnabled: false });
  t.after(() => { app.locals.close(); old.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(route(old, '/api/work/bootstrap'), undefined);
  assert.equal(call(old, '/api/runtime').capabilities.superagent, undefined);
  assert.equal(call(app, '/api/runtime').capabilities.superagent, true);
  assert.equal(typeof route(app, '/api/tasks'), 'function');
  assert.equal(typeof route(app, '/api/work/tickets/:id/team/:nodeId/review'), 'function');
  assert.equal(typeof route(app, '/api/work/tickets/:id/team/:nodeId/proposals/:proposalId'), 'function');
  const boot = call(app, '/api/work/bootstrap');
  assert.equal(boot.datasets.length, 1);
  assert.deepEqual(Object.keys(boot.datasets[0]).sort(), ['id', 'name', 'rowCount', 'source']);
  const selectedDatasetId = boot.datasets[0].id;
  const { response, chunks } = sseResponse();
  route(app, '/api/work/events')({}, response);
  const ticket = call(app, '/api/work/command', { body: { text: '核对演示数据' } }).ticket;
  assert.equal(ticket.datasetId, null);
  const read = () => call(app, '/api/work/tickets/:id', { params: { id: ticket.id } });
  const approve = input => call(app, '/api/work/tickets/:id/actions', { params: { id: ticket.id }, body: { action: 'approve', input } });
  assert.equal(approve().ticket.datasetId, selectedDatasetId);
  for (let attempt = 0; attempt < 500; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const state = read();
    if (state.ticket.status === 'completed') {
      const report = state.reports.find(item => item.kind === 'ready');
      assert.ok(report?.artifacts.report);
      assert.equal(app.locals.store.get('task', report.artifacts.taskId).goal, '核对演示数据');
      break;
    }
    assert.ok(!['failed', 'blocked', 'cancelled'].includes(state.ticket.status), state.ticket.summary);
    if (state.ticket.status === 'awaiting_review') approve();
  }
  assert.equal(read().ticket.status, 'completed');
  assert.equal(read().ticket.datasetId, selectedDatasetId);
  const messages = chunks.filter(chunk => chunk.startsWith('data: ')).map(chunk => JSON.parse(chunk.slice(6)));
  assert.deepEqual(new Set(messages.map(message => message.type)), new Set(['ticket', 'assignment', 'report']));
});

function teamArtifact() {
  return {
    summary: 'PRIVATE_ARTIFACT_SUMMARY',
    team: {
      limits: { maxDepth: 3, maxNodes: 12, maxSubtasks: 12, maxConcurrent: 3, maxCalls: 48, maxTokens: 65536, timeoutMs: 600000 },
      usage: { calls: 3, totalTokens: 900, reservedTokens: 0 },
      cancelled: false,
      nodes: [
        { id: 'root', parentId: null, depth: 1, name: '洞察', status: 'completed', dependsOn: [], retries: 0, proposals: [], PRIVATE: 'PRIVATE_ROOT' },
        { id: 'accept-node', parentId: 'root', depth: 2, name: '核查A', status: 'completed', dependsOn: [], retries: 0, proposals: [{ id: 'chart-proposal', kind: 'chart', status: 'proposed', summary: '新增留存图', privatePrompt: 'PRIVATE_PROMPT', privateRows: [1, 2, 3] }], PRIVATE: 'PRIVATE_ACCEPT' },
        { id: 'reject-node', parentId: 'root', depth: 2, name: '核查B', status: 'failed', dependsOn: [], retries: 0, proposals: [{ id: 'clean-proposal', kind: 'clean', status: 'needsApproval', summary: '清洗空值', privatePrompt: 'PRIVATE_CLEAN' }], PRIVATE: 'PRIVATE_REJECT' }
      ]
    },
    events: [
      { type: 'node.created', nodeId: 'accept-node', status: 'pending', seq: 1, createdAt: '2026-11-05T00:00:00.000Z', privatePrompt: 'PRIVATE_EVENT' },
      { type: 'node.updated', nodeId: 'accept-node', status: 'completed', seq: 2, createdAt: '2026-11-05T00:00:01.000Z', privateRows: [1] }
    ],
    revision: 1,
    updatedAt: '2026-11-05T00:00:02.000Z',
    PRIVATE: 'PRIVATE_TOP'
  };
}

function approvedTeamFixture(t) {
  const f = fixture(t);
  const ticket = f.engine.command({ text: '团队验收', datasetId: 'dataset-one' });
  f.engine.action(ticket.id, 'approve');
  const assignment = f.engine.detail(ticket.id).assignments[0];
  const task = f.store.get('task', assignment.sessionId);
  f.store.put('task', { ...task, artifacts: { ...(task.artifacts || {}), team: teamArtifact() } });
  return { f, ticketId: ticket.id, assignment };
}

test('Work团队投影仅暴露白名单，节点验收和提案决策持久化并发布去重SSE', t => {
  const { f, ticketId, assignment } = approvedTeamFixture(t);
  const detail = f.engine.detail(ticketId);
  assert.deepEqual(Object.keys(detail.team).sort(), ['cancelled', 'events', 'limits', 'nodes', 'revision', 'updatedAt', 'usage']);
  assert.equal(detail.team.revision, 1);
  assert.equal(detail.team.nodes.length, 3);
  assert.deepEqual(Object.keys(detail.team.nodes[1].proposals[0]).sort(), ['id', 'kind', 'status', 'summary']);
  assert.equal(detail.team.events.length, 2);
  assert.deepEqual(Object.keys(detail.team.events[0]).sort(), ['createdAt', 'nodeId', 'seq', 'status', 'type']);
  assert.doesNotMatch(JSON.stringify(detail), /PRIVATE|privatePrompt|privateRows/);

  assert.throws(() => f.engine.reviewTeamNode(ticketId, 'root', 'accept'), { status: 403 });
  assert.throws(() => f.engine.reviewTeamNode(ticketId, 'missing-node', 'accept'), { status: 404 });
  assert.throws(() => f.engine.reviewTeamNode(ticketId, 'accept-node', 'maybe'), { status: 400 });

  const beforeEvents = f.events.length;
  const accepted = f.engine.reviewTeamNode(ticketId, 'accept-node', 'accept');
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.nodes.find(node => node.id === 'accept-node').status, 'accepted');
  const rejected = f.engine.reviewTeamNode(ticketId, 'reject-node', 'reject');
  assert.equal(rejected.revision, 3);
  const rejectedNode = rejected.nodes.find(node => node.id === 'reject-node');
  assert.equal(rejectedNode.status, 'pending');
  assert.equal(rejectedNode.retries, 1);
  assert.throws(() => f.engine.reviewTeamNode(ticketId, 'reject-node', 'reject'), { status: 409 });

  const decided = f.engine.decideTeamProposal(ticketId, 'accept-node', 'chart-proposal', 'accept');
  assert.equal(decided.revision, 4);
  assert.equal(decided.nodes.find(node => node.id === 'accept-node').proposals[0].status, 'accepted');
  assert.throws(() => f.engine.decideTeamProposal(ticketId, 'accept-node', 'chart-proposal', 'reject'), { status: 409 });

  const teamEvents = f.events.slice(beforeEvents).filter(event => event.type === 'team' && event.ticketId === ticketId);
  assert.deepEqual(teamEvents.map(event => event.payload.revision), [2, 3, 4]);
  assert.ok(teamEvents.every(event => event.payload.events.length <= 100));

  const persisted = f.store.get('task', assignment.sessionId).artifacts.team;
  assert.equal(persisted.team.nodes.find(node => node.id === 'reject-node').retries, 1);
  assert.equal(persisted.team.nodes.find(node => node.id === 'accept-node').proposals[0].status, 'accepted');

  const restarted = f.restart();
  const restored = restarted.detail(ticketId).team;
  assert.equal(restored.nodes.find(node => node.id === 'reject-node').status, 'pending');
  assert.equal(restored.nodes.find(node => node.id === 'accept-node').proposals[0].status, 'accepted');

  const other = fixture(t);
  assert.throws(() => other.engine.detail(ticketId), { status: 404 });
  assert.throws(() => other.engine.reviewTeamNode(ticketId, 'accept-node', 'accept'), { status: 404 });
});


async function waitFor(predicate, message = '等待条件超时', timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}

async function completeWork(f, id) {
  const before = f.engine.detail(id);
  if (before.ticket.status === 'awaiting_review') f.engine.action(id, 'approve');
  await waitFor(() => f.engine.detail(id).ticket.status === 'working', '工单未进入执行中');
  const assignment = f.engine.detail(id).assignments[0];
  assert.ok(assignment?.sessionId, '执行任务缺少 sessionId');
  const task = f.store.get('task', assignment.sessionId);
  assert.ok(task, '执行任务不存在');
  f.store.put('task', { ...task, status: 'completed', report: { id: `report-${id}`, summary: '完成' } });
  await waitFor(() => f.engine.detail(id).ticket.status === 'completed', '工单未进入已完成');
  return f.engine.detail(id).ticket;
}

function fakeTerminalChild({ stdout = '', stderr = '', code = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    child.killSignal = signal;
    queueMicrotask(() => child.emit('close', null, signal || 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (!hang) child.emit('close', code, null);
  });
  return child;
}

test('E1 执行器注册表校验 ID、可用性与真实 bootstrap 投影', t => {
  const records = [];
  const analysis = {
    id: 'analysis', name: '数据分析', kind: 'analysis', available: true, capabilities: ['analysis', 'report'],
    start() { return null; }, get() { return null; }, resume() {}
  };
  const offline = {
    id: 'offline', name: '离线执行器', kind: 'tool', available: false, capabilities: ['tool'],
    start() { records.push('offline'); }, get() { return null; }
  };
  const registry = createExecutorRegistry([analysis, offline]);
  assert.deepEqual(registry.list(), [
    { id: 'analysis', name: '数据分析', kind: 'analysis', available: true, capabilities: ['analysis', 'report'] },
    { id: 'offline', name: '离线执行器', kind: 'tool', available: false, capabilities: ['tool'] }
  ]);
  assert.throws(() => registry.requireAvailable('missing'), { status: 400 });
  assert.throws(() => registry.requireAvailable('offline'), /不可用/);
  assert.throws(() => createExecutorRegistry([analysis, { ...analysis }]), /重复/);

  const dir = mkdtempSync(join(tmpdir(), 'lagent-executor-registry-'));
  const store = new Store(dir);
  const engine = createWorkEngine(store, registry);
  engine.updatePolicy({ requireApproval: true });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => engine.command({ text: '未知执行器', executorId: 'missing' }), { status: 400 });
  assert.throws(() => engine.command({ text: '不可用执行器', executorId: 'offline' }), { status: 400 });
  const ticket = engine.command({ text: '默认执行器' });
  assert.equal(ticket.executor, 'analysis');
  const agents = engine.bootstrap().agents;
  assert.deepEqual(agents.map(agent => ({ id: agent.id, status: agent.status })), [
    { id: 'analysis', status: 'available' },
    { id: 'offline', status: 'unavailable' }
  ]);
  assert.deepEqual(Object.keys(agents[0]).sort(), ['capabilities', 'id', 'kind', 'name', 'status']);
  assert.equal(records.length, 0);
});

test('E1 terminal command 批准前冻结输入，批准后才启动并生成 terminal report', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-terminal-engine-'));
  const store = new Store(dir);
  const spawned = [];
  const terminal = terminalExecutor({
    store,
    cwd: dir,
    resolveProgram: () => 'C:\\trusted\\git.exe',
    spawnImpl: (executable, args, options) => {
      spawned.push({ executable, args, options });
      return fakeTerminalChild({ stdout: 'clean' });
    }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]));
  engine.updatePolicy({ requireApproval: true });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const ticket = engine.command({
    text: '检查工作区状态',
    clientRequestId: 'terminal-once',
    executorId: 'terminal',
    executorInput: { program: 'git', args: ['status', '--short'] }
  });
  assert.equal(ticket.executor, 'terminal');
  assert.equal(ticket.datasetId, null);
  assert.equal(ticket.stage, 'approval');
  assert.doesNotMatch(JSON.stringify(ticket), /executorInput/);
  assert.equal(spawned.length, 0);
  assert.equal(engine.detail(ticket.id).assignments.length, 0);
  assert.equal(engine.detail(ticket.id).team, null);
  assert.equal(engine.command({
    text: ' 检查工作区状态 ',
    clientRequestId: 'terminal-once',
    executorId: 'terminal',
    executorInput: { program: 'git', args: ['status', '--short'] }
  }).id, ticket.id);
  assert.throws(() => engine.command({
    text: '检查工作区状态',
    clientRequestId: 'terminal-once',
    executorId: 'terminal',
    executorInput: { program: 'git', args: ['diff'] }
  }), { status: 409 });
  assert.equal(store.get('work-control', ticket.id).executorInput.program, 'git');

  engine.action(ticket.id, 'approve', {
    executorInput: { program: 'git', args: ['--version'] }
  });
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['status', '--short']);
  await waitFor(() => engine.detail(ticket.id).ticket.status === 'completed', 'terminal 未完成');
  const detail = engine.detail(ticket.id);
  assert.equal(detail.assignments[0].executor, 'terminal');
  assert.equal(detail.reports[0].kind, 'ready');
  assert.equal(detail.reports[0].artifacts.terminal.exitCode, 0);
  assert.equal(detail.reports[0].artifacts.terminal.stdout, 'clean');
  assert.doesNotMatch(JSON.stringify(detail), /executorInput|terminalInput|_terminalOutput/);
});

test('E1 terminal 白名单、输出截断、环境过滤、超时、非零退出与 Abort', async t => {
  assert.deepEqual(validateTerminalInput({ program: 'git', args: ['status', '--short'] }), { program: 'git', args: ['status', '--short'] });
  assert.throws(() => validateTerminalInput({ program: 'powershell', args: [] }), { status: 400 });
  assert.throws(() => validateTerminalInput({ program: 'git', args: ['status', ';', 'rm'] }), { status: 400 });
  assert.throws(() => validateTerminalInput({ program: 'git', args: ['status', '>', 'out.txt'] }), { status: 400 });
  assert.throws(() => validateTerminalInput({ program: 'git', args: ['status', '$(whoami)'] }), { status: 400 });
  assert.throws(() => validateTerminalInput({ program: 'git', args: ['status', '%PATH%'] }), { status: 400 });
  assert.throws(() => validateTerminalInput({ program: 'ls', args: ['../secret'] }), { status: 400 });
  assert.throws(() => validateTerminalInput({ program: 'pwd', args: ['-a'] }), { status: 400 });

  const dir = mkdtempSync(join(tmpdir(), 'lagent-terminal-unit-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = async (name, child, options = {}) => {
    let captured;
    const executor = terminalExecutor({
      store,
      cwd: dir,
      timeoutMs: 1000,
      resolveProgram: () => 'C:\\trusted\\git.exe',
      spawnImpl: (_executable, _args, spawnOptions) => {
        captured = spawnOptions;
        return child;
      },
      ...options
    });
    const assignmentId = `assignment-${name}`;
    executor.start(
      { id: `ticket-${name}`, command: name },
      { id: assignmentId, ticketId: `ticket-${name}`, executor: 'terminal' },
      { executorInput: { program: 'git', args: ['status'] } }
    );
    await waitFor(() => store.get('task', assignmentId)?.status !== 'running', `${name} 未结束`);
    const task = store.get('task', assignmentId);
    executor.close();
    return { task, captured };
  };

  const filtered = await run('filtered', fakeTerminalChild({ stdout: 'abcdefghijk' }), {
    maxOutputBytes: 8,
    environment: {
      PATH: process.env.PATH,
      Path: process.env.Path,
      OPENAI_API_KEY: 'must-not-leak',
      LAGENT_CREDENTIAL_MASTER_KEY: 'must-not-leak'
    }
  });
  assert.equal(filtered.task.status, 'completed');
  assert.equal(filtered.task.artifacts.terminal.stdout, 'abcdefgh');
  assert.equal(filtered.task.artifacts.terminal.truncated, true);
  assert.equal(filtered.captured.cwd, resolve(dir));
  assert.equal(filtered.captured.shell, false);
  assert.equal(filtered.captured.env.OPENAI_API_KEY, undefined);
  assert.equal(filtered.captured.env.LAGENT_CREDENTIAL_MASTER_KEY, undefined);

  const nonzero = await run('nonzero', fakeTerminalChild({ stderr: 'bad state', code: 7 }));
  assert.equal(nonzero.task.status, 'failed');
  assert.equal(nonzero.task.artifacts.terminal.exitCode, 7);
  assert.equal(nonzero.task.artifacts.terminal.stderr, 'bad state');

  const timedOut = await run('timeout', fakeTerminalChild({ hang: true }), { timeoutMs: 10 });
  assert.equal(timedOut.task.status, 'failed');
  assert.equal(timedOut.task.artifacts.terminal.timedOut, true);

  const abortChild = fakeTerminalChild({ hang: true });
  const abortExecutor = terminalExecutor({
    store,
    cwd: dir,
    resolveProgram: () => 'C:\\trusted\\git.exe',
    spawnImpl: () => abortChild
  });
  const abortTask = abortExecutor.start(
    { id: 'ticket-abort', command: 'abort' },
    { id: 'assignment-abort', ticketId: 'ticket-abort', executor: 'terminal' },
    { executorInput: { program: 'git', args: ['status'] } }
  );
  abortExecutor.stop(abortTask);
  await waitFor(() => store.get('task', 'assignment-abort')?.status === 'cancelled');
  assert.ok(abortChild.killSignal);
  assert.equal(store.get('task', 'assignment-abort').artifacts.terminal.cancelled, true);
  abortExecutor.close();
});

test('E1 terminal 非零退出通过 Work failed report 暴露退出码', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-terminal-report-'));
  const store = new Store(dir);
  const terminal = terminalExecutor({
    store,
    cwd: dir,
    resolveProgram: () => 'C:\\trusted\\git.exe',
    spawnImpl: () => fakeTerminalChild({ stderr: 'denied', code: 9 })
  });
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]));
  engine.updatePolicy({ requireApproval: true });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const ticket = engine.command({
    text: '失败命令',
    executorId: 'terminal',
    executorInput: { program: 'git', args: ['status'] }
  });
  engine.action(ticket.id, 'approve');
  await waitFor(() => engine.detail(ticket.id).ticket.status === 'failed', 'terminal 失败未同步');
  const detail = engine.detail(ticket.id);
  const report = detail.reports.find(item => item.kind === 'failed');
  assert.equal(report.artifacts.terminal.exitCode, 9);
  assert.equal(report.artifacts.terminal.stderr, 'denied');
});

test('E1 Work app 注册 terminal，cloud 账号使用各自 dataDir 作为 cwd', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-terminal-app-'));
  const apps = [];
  t.after(() => {
    for (const app of apps) app.locals.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = async account => {
    const app = createApp({ dataDir: join(dir, account), cloud: true, workEnabled: true });
    apps.push(app);
    const agents = call(app, '/api/work/bootstrap').agents;
    assert.equal(agents.find(agent => agent.id === 'terminal').status, 'available');
    const ticket = call(app, '/api/work/command', {
      body: { text: `pwd ${account}`, executorId: 'terminal', executorInput: { program: 'pwd', args: [] } }
    }).ticket;
    assert.equal(ticket.executor, 'terminal');
    // 默认策略是直接执行：工单创建后立即进入工作，不需要再点一次批准。
    assert.notEqual(ticket.status, 'awaiting_review');
    await waitFor(() => call(app, '/api/work/tickets/:id', { params: { id: ticket.id } }).ticket.status === 'completed', `${account} terminal 未完成`);
    const detail = call(app, '/api/work/tickets/:id', { params: { id: ticket.id } });
    const report = detail.reports.find(item => item.kind === 'ready');
    return resolve(report.artifacts.terminal.stdout.trim());
  };
  const accountA = await run('account-a');
  const accountB = await run('account-b');
  assert.equal(accountA, resolve(join(dir, 'account-a')));
  assert.equal(accountB, resolve(join(dir, 'account-b')));
  assert.notEqual(accountA, accountB);
});

test('E8 已完成工单交接继承数据集、冻结输入、幂等并发且深度不超过 3', async t => {
  const f = fixture(t, { datasets: [makeDataset('dataset-one'), makeDataset('dataset-two')] });
  const root = f.engine.command({ text: '根任务', datasetId: 'dataset-one' });
  const source = await completeWork(f, root.id);
  assert.throws(
    () => f.engine.handoff(root.id, { executorId: 'analysis', datasetId: 'dataset-two' }),
    { status: 409 }
  );

  f.events.length = 0;
  const other = createWorkEngine(f.store, f.executor);
  t.after(() => other.close());
  const results = [
    f.engine.handoff(root.id, { executorId: 'analysis', text: '交接子任务' }),
    other.handoff(root.id, { executorId: 'analysis', text: '交接子任务' })
  ];
  assert.deepEqual(results.map(result => result.created), [true, false]);
  assert.equal(results[0].ticket.id, results[1].ticket.id);

  const child = results[0].ticket;
  const parentDetail = f.engine.detail(root.id);
  const childDetail = f.engine.detail(child.id);
  assert.equal(parentDetail.ticket.handoffChildId, child.id);
  assert.equal(childDetail.ticket.parentTicketId, root.id);
  assert.equal(childDetail.ticket.chainRootId, root.id);
  assert.equal(childDetail.ticket.handoffDepth, 1);
  assert.equal(childDetail.ticket.handoffSummary, source.summary);
  assert.equal(childDetail.ticket.datasetId, 'dataset-one');
  assert.equal(childDetail.ticket.source, 'handoff');
  assert.equal(childDetail.ticket.status, 'awaiting_review');
  assert.doesNotMatch(JSON.stringify(childDetail), /executorInput|"command"/);

  const ticketEvents = f.events.filter(event => event.type === 'ticket');
  assert.equal(ticketEvents.length, 1);
  assert.equal(ticketEvents[0].ticketId, child.id);
  assert.equal(ticketEvents[0].payload.id, child.id);

  const control = f.store.get('work-control', child.id);
  assert.equal(control.command, '交接子任务');
  assert.equal(control.executorInput, null);
  assert.equal(f.store.get('work-control', root.id).command, '根任务');

  const audit = f.store.list('work-audit').find(row => row.ticketId === child.id && row.action === 'handoff');
  assert.ok(audit);
  assert.deepEqual(Object.keys(audit).sort(), ['action', 'at', 'executor', 'id', 'reason', 'result', 'ticketId']);
  assert.equal(audit.executor, 'analysis');
  assert.equal(audit.result, 'created');
  assert.doesNotMatch(JSON.stringify(audit), /executorInput|prompt|command/);

  let current = child;
  for (let depth = 1; depth < 3; depth++) {
    await completeWork(f, current.id);
    const next = f.engine.handoff(current.id, { executorId: 'analysis' });
    assert.equal(next.created, true);
    assert.equal(next.ticket.handoffDepth, depth + 1);
    assert.equal(next.ticket.chainRootId, root.id);
    current = next.ticket;
  }
  await completeWork(f, current.id);
  assert.throws(() => f.engine.handoff(current.id, { executorId: 'analysis' }), { status: 409 });
});

test('E8 交接校验 completed、executor、policy、可用性与只读输入并保持审计脱敏', async t => {
  const secret = 'E8_SECRET_PROMPT_AND_EXECUTOR_INPUT';
  const f = fixture(t, {
    executorFactory: analysis => createExecutorRegistry([
      { ...analysis, id: 'analysis', name: '数据分析', kind: 'analysis', available: true, requiresDataset: true },
      {
        id: 'terminal', name: '受控终端', kind: 'terminal', available: true, requiresDataset: false,
        validateInput: validateTerminalInput,
        start() { return null; }, get() { return null; }
      },
      {
        id: 'codex', name: '只读 Codex', kind: 'cli', available: true, requiresDataset: false,
        validateInput: input => input,
        start() { return null; }, get() { return null; }
      },
      {
        id: 'browser', name: '受控浏览器', kind: 'tool', available: false, requiresDataset: false,
        validateInput: input => input,
        start() { return null; }, get() { return null; }
      }
    ])
  });
  const source = f.engine.command({ text: '待交接源', datasetId: 'dataset-one' });
  assert.throws(() => f.engine.handoff(source.id, { executorId: 'analysis' }), { status: 409 });
  await completeWork(f, source.id);

  assert.throws(() => f.engine.handoff(source.id, { executorId: 'missing' }), { status: 400 });
  assert.throws(
    () => f.engine.handoff(source.id, { executorId: 'codex', executorInput: { prompt: secret } }),
    { status: 403 }
  );
  assert.throws(
    () => f.engine.handoff(source.id, { executorId: 'terminal', executorInput: { program: 'git', args: ['status;whoami'] } }),
    { status: 400 }
  );
  assert.throws(() => f.engine.handoff(source.id, { executorId: 'browser' }), { status: 400 });
  assert.equal(f.engine.detail(source.id).ticket.handoffChildId, null);

  const title = '交接标题'.repeat(30);
  const created = f.engine.handoff(source.id, {
    executorId: 'terminal',
    text: title,
    executorInput: { program: 'git', args: ['status'] }
  });
  assert.equal(created.created, true);
  assert.equal(created.ticket.title.length, 100);
  assert.equal(created.ticket.stage, 'approval');
  assert.equal(created.ticket.handoffDepth, 1);
  assert.equal(created.ticket.handoffSummary, f.engine.detail(source.id).ticket.summary);
  assert.doesNotMatch(JSON.stringify(created.ticket), /executorInput|"command":/);
  assert.deepEqual(f.store.get('work-control', created.ticket.id).executorInput, { program: 'git', args: ['status'] });

  const audits = f.store.list('work-audit').filter(row => row.action === 'handoff');
  const denied = audits.find(row => row.executor === 'codex' && row.result === 'denied');
  assert.ok(denied);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(secret));
});

test('E8 父子工单按工作区隔离，其他工作区不可查看或交接', async t => {
  const owner = fixture(t);
  const other = fixture(t);
  const source = owner.engine.command({ text: '隔离源工单', datasetId: 'dataset-one' });
  await completeWork(owner, source.id);
  const child = owner.engine.handoff(source.id, { executorId: 'analysis' }).ticket;

  assert.throws(() => other.engine.detail(source.id), { status: 404 });
  assert.throws(() => other.engine.detail(child.id), { status: 404 });
  assert.throws(() => other.engine.handoff(source.id, { executorId: 'analysis' }), { status: 404 });
  assert.deepEqual(other.engine.bootstrap().tickets, []);
});

test('E8 handoff action 首次返回 201，重复交接返回 200 和同一子工单', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-handoff-route-'));
  const app = createApp({ dataDir: dir, cloud: true, workEnabled: true });
  t.after(() => { app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  const source = call(app, '/api/work/command', {
    body: { text: 'HTTP 交接源', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } }
  }).ticket;
  // 默认策略直接执行，创建后不需要再点一次批准。
  await waitFor(() => call(app, '/api/work/tickets/:id', { params: { id: source.id } }).ticket.status === 'completed', 'HTTP 源工单未完成');

  const invoke = input => {
    let body;
    let status = 200;
    const response = {
      status(code) { status = code; return this; },
      json(value) { body = value; return this; },
      set() { return this; }, flushHeaders() {}, write() {}, end() {}
    };
    route(app, '/api/work/tickets/:id/actions')({ params: { id: source.id }, body: { action: 'handoff', input } }, response);
    return { status, body };
  };
  const first = invoke({ executorId: 'analysis', text: 'HTTP 子工单' });
  const duplicate = invoke({ executorId: 'analysis', text: '不同标题也不重复创建' });
  assert.equal(first.status, 201);
  assert.equal(first.body.ticket.parentTicketId, source.id);
  assert.equal(first.body.ticket.handoffDepth, 1);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.ticket.id, first.body.ticket.id);
});

test('E9 多步计划一次创建、自动推进且不自动执行', async t => {
  const f = fixture(t);
  const plan = f.engine.plan({
    goal: '检查并修复',
    clientRequestId: 'plan-once',
    steps: [
      { executorId: 'analysis', text: '第一步检查', datasetId: 'dataset-one' },
      { executorId: 'analysis', text: '第二步修复', datasetId: 'dataset-one', dependsOn: [0] }
    ]
  });
  assert.equal(plan.totalSteps, 2);
  assert.equal(plan.currentStep, 0);
  assert.deepEqual(plan.steps.map(step => step.status), ['awaiting_review', 'waiting']);
  assert.equal(f.engine.plan({ goal: '检查并修复', clientRequestId: 'plan-once', steps: [{ executorId: 'analysis', text: 'A', datasetId: 'dataset-one' }, { executorId: 'analysis', text: 'B', datasetId: 'dataset-one' }] }).id, plan.id);
  assert.equal(f.engine.bootstrap().plans[0].id, plan.id);
  const [first, second] = plan.steps;
  assert.equal(f.engine.detail(first.ticketId).ticket.planStep, 0);
  assert.equal(f.engine.detail(second.ticketId).ticket.status, 'waiting');
  assert.throws(() => f.engine.action(second.ticketId, 'approve'), { status: 409 });
  assert.throws(() => f.engine.action(second.ticketId, 'stop'), { status: 409 });

  await completeWork(f, first.ticketId);
  const advanced = f.engine.getPlan(plan.id);
  assert.equal(advanced.status, 'active');
  assert.equal(advanced.currentStep, 1);
  assert.equal(advanced.steps[1].status, 'awaiting_review');
  assert.equal(f.engine.detail(second.ticketId).assignments.length, 0);

  await completeWork(f, second.ticketId);
  const done = f.engine.getPlan(plan.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.steps.map(step => step.status), ['completed', 'completed']);
});

test('E9 计划校验、取消与跨工作区隔离', async t => {
  const f = fixture(t);
  assert.throws(() => f.engine.plan({ goal: '一步', steps: [{ executorId: 'analysis', text: 'A', datasetId: 'dataset-one' }] }), { status: 400 });
  assert.throws(() => f.engine.plan({ goal: '六步', steps: Array.from({ length: 6 }, (_, index) => ({ executorId: 'analysis', text: `步骤${index}`, datasetId: 'dataset-one' })) }), { status: 400 });
  assert.throws(() => f.engine.plan({ goal: '未知执行器', steps: [{ executorId: 'codex', text: 'A' }, { executorId: 'analysis', text: 'B', datasetId: 'dataset-one' }] }), { status: 400 });
  assert.throws(() => f.engine.plan({ goal: '非法输入', steps: [{ executorId: 'analysis', text: 'A', executorInput: { prompt: '不允许' } }, { executorId: 'analysis', text: 'B', datasetId: 'dataset-one' }] }), { status: 400 });
  const plan = f.engine.plan({ goal: '取消计划', steps: [{ executorId: 'analysis', text: '第一步', datasetId: 'dataset-one' }, { executorId: 'analysis', text: '第二步', datasetId: 'dataset-one' }] });
  const cancelled = f.engine.cancelPlan(plan.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.steps.map(step => step.status), ['cancelled', 'cancelled']);
  assert.equal(f.engine.getPlan(plan.id).status, 'cancelled');
  const other = fixture(t);
  assert.throws(() => other.engine.getPlan(plan.id), { status: 404 });
  assert.deepEqual(other.engine.bootstrap().plans, []);
});

test('E9 计划推进在重启后保持幂等', async t => {
  const f = fixture(t);
  const plan = f.engine.plan({ goal: '重启计划', steps: [{ executorId: 'analysis', text: '第一步', datasetId: 'dataset-one' }, { executorId: 'analysis', text: '第二步', datasetId: 'dataset-one', dependsOn: [0] }, { executorId: 'analysis', text: '第三步', datasetId: 'dataset-one', dependsOn: [1] }] });
  await completeWork(f, plan.steps[0].ticketId);
  assert.equal(f.engine.getPlan(plan.id).currentStep, 1);
  const eventsBefore = f.events.length;
  f.restart();
  assert.equal(f.engine.getPlan(plan.id).currentStep, 1);
  assert.equal(f.engine.detail(plan.steps[1].ticketId).ticket.status, 'awaiting_review');
  assert.equal(f.events.filter(event => event.type === 'ticket' && event.payload?.id === plan.steps[1].ticketId).length, 1);
  assert.ok(f.events.length >= eventsBefore);
});

test('E9 计划路由创建、查询与取消', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-plan-route-'));
  const app = createApp({ dataDir: dir, cloud: true, workEnabled: true, serveStatic: false });
  t.after(() => { app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  const created = call(app, '/api/work/plans', {
    body: { goal: '路由计划', clientRequestId: 'plan-route', autoRun: false, steps: [
      { executorId: 'terminal', text: '第一步', executorInput: { program: 'pwd', args: [] } },
      { executorId: 'terminal', text: '第二步', executorInput: { program: 'pwd', args: [] }, dependsOn: [0] }
    ] }
  }).plan;
  assert.equal(created.totalSteps, 2);
  assert.equal(created.steps[0].status, 'awaiting_review');
  assert.equal(created.steps[1].status, 'waiting');
  assert.equal(call(app, '/api/work/plans/:id', { params: { id: created.id } }).plan.id, created.id);
  const cancelled = call(app, '/api/work/plans/:id/cancel', { method: 'POST', params: { id: created.id }, body: {} }).plan;
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.steps.map(step => step.status), ['cancelled', 'cancelled']);
});

test('E9 计划步骤失败后停止推进', async t => {
  const f = fixture(t);
  const plan = f.engine.plan({ goal: '失败计划', steps: [{ executorId: 'analysis', text: '第一步', datasetId: 'dataset-one' }, { executorId: 'analysis', text: '第二步', datasetId: 'dataset-one', dependsOn: [0] }] });
  const first = f.engine.detail(plan.steps[0].ticketId).ticket;
  f.engine.action(first.id, 'approve');
  await waitFor(() => f.engine.detail(first.id).ticket.status === 'working', '计划第一步未开始');
  const assignment = f.engine.detail(first.id).assignments[0];
  const task = f.store.get('task', assignment.sessionId);
  f.store.put('task', { ...task, status: 'failed', error: '模拟失败' });
  await waitFor(() => f.engine.detail(first.id).ticket.status === 'failed', '计划第一步未失败');
  const stopped = f.engine.getPlan(plan.id);
  assert.equal(stopped.status, 'failed');
  assert.equal(f.engine.detail(plan.steps[1].ticketId).ticket.status, 'blocked');
  assert.throws(() => f.engine.action(plan.steps[1].ticketId, 'approve'), { status: 409 });
});

test('E10 规划建议经引擎校验且不创建工单', async t => {
  const calls = [];
  const f = fixture(t, { planner: async input => { calls.push(input); return { steps: [
    { executorId: 'analysis', text: '第一步检查', datasetId: 'dataset-one', reason: '先核验' },
    { executorId: 'analysis', text: '第二步处理', datasetId: 'dataset-one' }
  ] }; } });
  const suggestion = await f.engine.suggestPlan({ goal: '检查并处理', executors: ['analysis'] });
  assert.deepEqual(suggestion.steps.map(step => step.text), ['第一步检查', '第二步处理']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].goal, '检查并处理');
  assert.deepEqual(calls[0].executors, ['analysis']);
  assert.equal(f.engine.bootstrap().tickets.length, 0);
  assert.deepEqual(f.engine.bootstrap().plans, []);
  await assert.rejects(() => f.engine.suggestPlan({ goal: '', executors: ['analysis'] }), { status: 400 });
  await assert.rejects(() => f.engine.suggestPlan({ goal: '目标', executors: ['codex'] }), { status: 400 });
});

test('E10 规划输出非法或规划器缺失时拒绝', async t => {
  const bad = fixture(t, { planner: async () => ({ steps: [{ executorId: 'codex', text: '不允许' }, { executorId: 'analysis', text: '第二步' }] }) });
  await assert.rejects(() => bad.engine.suggestPlan({ goal: '目标', executors: ['analysis'] }), { status: 502 });
  const missing = fixture(t);
  await assert.rejects(() => missing.engine.suggestPlan({ goal: '目标', executors: ['analysis'] }), { status: 503 });
});

test('E10 规划建议路由只返回步骤且不创建工单', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-plan-suggest-'));
  const app = createApp({ dataDir: dir, cloud: true, workEnabled: true, serveStatic: false, workPlanner: async () => ({ steps: [{ executorId: 'terminal', text: '查看目录' }, { executorId: 'terminal', text: '确认版本' }] }) });
  t.after(() => { app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  let output;
  const res = { status() { return this; }, json(value) { output = value; return this; }, set() { return this; }, flushHeaders() {}, write() {}, end() {} };
  await route(app, '/api/work/plans/suggest')({ body: { goal: '查看项目', executors: ['terminal'] } }, res);
  assert.deepEqual(output.steps.map(step => step.text), ['查看目录', '确认版本']);
  assert.deepEqual(call(app, '/api/work/bootstrap').tickets, []);
  assert.deepEqual(call(app, '/api/work/bootstrap').plans, []);
});

test('P1 多 Agent DAG 支持并行分支与独立分支继续', async t => {
  const f = fixture(t);
  const parallel = f.engine.plan({ goal: '并行检查', steps: [
    { executorId: 'analysis', text: '检查 A', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '检查 B', datasetId: 'dataset-one' }
  ] });
  assert.deepEqual(parallel.steps.map(step => step.status), ['awaiting_review', 'awaiting_review']);
  await completeWork(f, parallel.steps[0].ticketId);
  assert.equal(f.engine.getPlan(parallel.id).status, 'active');
  assert.equal(f.engine.detail(parallel.steps[1].ticketId).ticket.status, 'awaiting_review');
  await completeWork(f, parallel.steps[1].ticketId);
  assert.equal(f.engine.getPlan(parallel.id).status, 'completed');

  const branch = f.engine.plan({ goal: '分支失败', steps: [
    { executorId: 'analysis', text: '依赖根', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '依赖子项', datasetId: 'dataset-one', dependsOn: [0] },
    { executorId: 'analysis', text: '独立分支', datasetId: 'dataset-one' }
  ] });
  const first = branch.steps[0].ticketId;
  f.engine.action(first, 'approve');
  await waitFor(() => f.engine.detail(first).ticket.status === 'working', 'DAG 根步骤未开始');
  const assignment = f.engine.detail(first).assignments[0];
  const task = f.store.get('task', assignment.sessionId);
  f.store.put('task', { ...task, status: 'failed', error: '模拟失败' });
  await waitFor(() => f.engine.detail(first).ticket.status === 'failed', 'DAG 根步骤未失败');
  const afterFailure = f.engine.getPlan(branch.id);
  assert.equal(afterFailure.status, 'active');
  assert.equal(afterFailure.steps[1].status, 'blocked');
  assert.equal(afterFailure.steps[2].status, 'awaiting_review');
  await completeWork(f, branch.steps[2].ticketId);
  const ended = f.engine.getPlan(branch.id);
  assert.equal(ended.status, 'failed');
  assert.equal(ended.steps[1].status, 'blocked');
});

test('P1 DAG 依赖校验拒绝前向、自依赖、重复与超过 3 项', async t => {
  const f = fixture(t);
  const step = (extra = {}) => ({ executorId: 'analysis', text: '步骤', datasetId: 'dataset-one', ...extra });
  assert.throws(() => f.engine.plan({ goal: '前向依赖', steps: [step({ dependsOn: [1] }), step()] }), { status: 400 });
  assert.throws(() => f.engine.plan({ goal: '自依赖', steps: [step({ dependsOn: [0] }), step()] }), { status: 400 });
  assert.throws(() => f.engine.plan({ goal: '重复依赖', steps: [step(), step({ dependsOn: [0, 0] })] }), { status: 400 });
  assert.throws(() => f.engine.plan({ goal: '依赖过多', steps: [step(), step(), step(), step(), step({ dependsOn: [0, 1, 2, 3] })] }), { status: 400 });
});

test('P1 计划步骤 reject 后可 resume，失败计划可 retry 复活', async t => {
  const f = fixture(t);
  const rejected = f.engine.plan({ goal: '退回恢复', steps: [
    { executorId: 'analysis', text: '第一步', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '第二步', datasetId: 'dataset-one', dependsOn: [0] }
  ] });
  const first = rejected.steps[0].ticketId;
  f.engine.action(first, 'reject');
  assert.equal(f.engine.detail(first).ticket.status, 'waiting');
  f.engine.action(first, 'resume');
  assert.equal(f.engine.detail(first).ticket.status, 'awaiting_review');

  const failed = f.engine.plan({ goal: '失败重试', steps: [
    { executorId: 'analysis', text: '根步骤', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '下游步骤', datasetId: 'dataset-one', dependsOn: [0] }
  ] });
  const root = failed.steps[0].ticketId;
  f.engine.action(root, 'approve');
  await waitFor(() => f.engine.detail(root).ticket.status === 'working', '重试根步骤未开始');
  const assignment = f.engine.detail(root).assignments[0];
  const task = f.store.get('task', assignment.sessionId);
  f.store.put('task', { ...task, status: 'failed', error: '模拟失败' });
  await waitFor(() => f.engine.detail(root).ticket.status === 'failed', '重试根步骤未失败');
  assert.equal(f.engine.getPlan(failed.id).status, 'failed');
  f.engine.action(root, 'retry');
  await waitFor(() => f.engine.detail(root).ticket.status === 'working', '重试未重新开始');
  const retryAssignment = f.engine.detail(root).assignments[0];
  const retryTask = f.store.get('task', retryAssignment.sessionId);
  f.store.put('task', { ...retryTask, status: 'completed', report: { id: `retry-${root}`, summary: '重试完成' } });
  await waitFor(() => f.engine.detail(root).ticket.status === 'completed', '重试未完成');
  assert.equal(f.engine.getPlan(failed.id).status, 'active');
  assert.equal(f.engine.detail(failed.steps[1].ticketId).ticket.status, 'awaiting_review');
  await completeWork(f, failed.steps[1].ticketId);
  assert.equal(f.engine.getPlan(failed.id).status, 'completed');
});

test('P1 重启恢复活跃计划，补齐崩溃前未推进的下一步', async t => {
  const f = fixture(t);
  const plan = f.engine.plan({ goal: '崩溃恢复', steps: [
    { executorId: 'analysis', text: '已完成步骤', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '待推进步骤', datasetId: 'dataset-one', dependsOn: [0] }
  ] });
  const doneId = plan.steps[0].ticketId;
  const raw = f.store.get('work-ticket', doneId);
  f.store.put('work-ticket', { ...raw, status: 'completed', summary: '已提交但未推进' });
  assert.equal(f.engine.detail(plan.steps[1].ticketId).ticket.status, 'waiting');
  f.restart();
  assert.equal(f.engine.detail(doneId).ticket.status, 'completed');
  assert.equal(f.engine.detail(plan.steps[1].ticketId).ticket.status, 'awaiting_review');
  assert.equal(f.engine.getPlan(plan.id).currentStep, 1);
});

test('P1 重启后读取已持久化策略不因实体 id 字段崩溃', async t => {
  const f = fixture(t);
  f.engine.updatePolicy({ allowedExecutors: ['analysis'], budgets: { maxConcurrent: 1, maxCallsPerTicket: 3, maxRuntimeMs: 1000, maxTokensPerTicket: 1000 }, limits: { browserHosts: [], githubRepos: [] } });
  const restarted = f.restart();
  assert.deepEqual(restarted.policy().allowedExecutors, ['analysis']);
  assert.equal(restarted.policy().budgets.maxConcurrent, 1);
});

test('P2 窗口桥 API 列出、读取、发送并写脱敏审计', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-window-api-'));
  const calls = [];
  const bridge = {
    listWindows: async () => [{ id: '42', handle: 42, pid: 7, process: 'Codex', title: 'Codex 窗口' }],
    readWindow: async handle => { calls.push(['read', handle]); return { text: '终端输出' }; },
    sendToWindow: async (handle, text, options) => { calls.push(['send', handle, text, options.submit]); return { ok: true, process: 'Codex', submitted: options.submit }; }
  };
  const app = createApp({ dataDir: dir, workEnabled: true, serveStatic: false, windowBridge: bridge });
  t.after(() => { app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  const invoke = async (path, req = {}) => {
    let output;
    const res = { status() { return this; }, json(value) { output = value; return this; }, set() { return this; }, flushHeaders() {}, write() {}, end() {} };
    await route(app, path)(req, res);
    return output;
  };
  assert.deepEqual((await invoke('/api/work/windows')).windows[0].process, 'Codex');
  assert.deepEqual(await invoke('/api/work/windows/:id/text', { params: { id: '42' } }), { text: '终端输出' });
  assert.deepEqual(await invoke('/api/work/windows/:id/send', { params: { id: '42' }, body: { text: '继续处理', submit: true } }), { ok: true, process: 'Codex', submitted: true });
  assert.deepEqual(calls, [['read', 42], ['send', 42, '继续处理', true]]);
  const audit = app.locals.store.list('work-audit').find(row => row.action === 'window/send');
  assert.ok(audit);
  assert.equal(JSON.stringify(audit).includes('继续处理'), false);
});

test('P4 自动计划创建后直接启动，并在完成后自动启动下一步', async t => {
  const f = fixture(t);
  const plan = f.engine.plan({ goal: '自动计划', autoRun: true, steps: [
    { executorId: 'analysis', text: '自动第一步', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '自动第二步', datasetId: 'dataset-one', dependsOn: [0] }
  ] });
  assert.equal(plan.autoRun, true);
  assert.equal(f.engine.detail(plan.steps[0].ticketId).ticket.status, 'working');
  assert.equal(f.engine.detail(plan.steps[0].ticketId).assignments.length, 1);
  assert.equal(f.engine.detail(plan.steps[1].ticketId).ticket.status, 'waiting');

  const first = f.engine.detail(plan.steps[0].ticketId);
  const task = f.store.get('task', first.assignments[0].sessionId);
  f.store.put('task', { ...task, status: 'completed', report: { id: `auto-${first.ticket.id}`, summary: '自动完成' } });
  await waitFor(() => f.engine.detail(plan.steps[1].ticketId).ticket.status === 'working', '自动第二步未启动');
  const second = f.engine.detail(plan.steps[1].ticketId);
  const secondTask = f.store.get('task', second.assignments[0].sessionId);
  f.store.put('task', { ...secondTask, status: 'completed', report: { id: `auto-${second.ticket.id}`, summary: '自动完成' } });
  await waitFor(() => f.engine.getPlan(plan.id).status === 'completed', '自动计划未完成');
});

test('计划里某一步失败后可以跳过，后面的步骤接着跑', async t => {
  const f = fixture(t);
  const plan = f.engine.plan({ goal: '跳过失败步骤', autoRun: true, steps: [
    { executorId: 'analysis', text: '会失败的第一步', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '后面的第二步', datasetId: 'dataset-one', dependsOn: [0] }
  ] });
  const first = f.engine.detail(plan.steps[0].ticketId);
  const task = f.store.get('task', first.assignments[0].sessionId);
  f.store.put('task', { ...task, status: 'failed', error: '外部 CLI 起不来' });
  await waitFor(() => f.engine.detail(plan.steps[0].ticketId).ticket.status === 'failed', '第一步没有失败');

  const skipped = f.engine.action(plan.steps[0].ticketId, 'skip', { reason: '外部 CLI 环境缺变量，先跳过' });
  assert.equal(skipped.status, 'completed');
  assert.match(skipped.summary, /跳过/);
  await waitFor(() => f.engine.detail(plan.steps[1].ticketId).ticket.status === 'working', '跳过之后第二步没启动');
  assert.equal(f.engine.getPlan(plan.id).status, 'active');
});

test('默认策略下计划一路执行，不需要逐步点批准', t => {
  const f = fixture(t);
  f.engine.updatePolicy({ requireApproval: false });
  assert.equal(f.engine.policy().requireApproval, false);
  const plan = f.engine.plan({ goal: '直接执行', steps: [
    { executorId: 'analysis', text: '第一步', datasetId: 'dataset-one' },
    { executorId: 'analysis', text: '第二步', datasetId: 'dataset-one', dependsOn: [0] }
  ] });
  assert.equal(plan.autoRun, true);
  assert.equal(f.engine.detail(plan.steps[0].ticketId).ticket.status, 'working');
  assert.deepEqual(f.engine.bootstrap().attention, []);
});
