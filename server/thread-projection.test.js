import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createRunEventLog } from './work/run-events.js';
import { createApprovalService } from './work/approvals.js';
import { createThreadProjection, threadStatusOf } from './work/thread-projection.js';

function fixture(t, { withRunEvents = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-thread-projection-'));
  const store = new Store(dir);
  const log = withRunEvents ? createRunEventLog(store, { ownerId: 'local' }) : null;
  let current = Date.parse('2026-11-26T00:00:00.000Z');
  const approvals = createApprovalService(store, {
    publish: () => {},
    now: () => current,
    clock: () => new Date(current).toISOString()
  });
  store.put('conversation', {
    id: 'conv-1', title: '发布检查', goal: '检查发布说明', projectId: 'p1',
    agentIds: ['model'], turns: [], status: 'awaiting_review',
    createdAt: '2026-11-26T00:00:00.000Z', updatedAt: '2026-11-26T00:00:00.000Z'
  });
  store.put('work-ticket', {
    id: 't1', title: '检查发布说明', status: 'awaiting_review', executor: 'model',
    summary: '等待确认', conversationId: 'conv-1', turnId: 'turn-1', approvalId: 'a1',
    createdAt: '2026-11-26T00:00:01.000Z', updatedAt: '2026-11-26T00:00:05.000Z'
  });
  store.put('work-ticket', {
    id: 't2', title: '整理变更', status: 'completed', executor: 'model',
    summary: '完成', conversationId: 'conv-1',
    createdAt: '2026-11-26T00:00:01.000Z', updatedAt: '2026-11-26T00:00:04.000Z'
  });
  store.put('work-run', {
    id: 'r1', goal: '发布检查', chatId: 'conv-1', status: 'running', currentStep: 1,
    steps: [{ index: 0, status: 'done' }, { index: 1, status: 'running' }],
    createdAt: '2026-11-26T00:00:01.000Z', updatedAt: '2026-11-26T00:00:06.000Z'
  });
  store.put('work-report', {
    id: 'rep-1', ticketId: 't1', kind: 'waiting', summary: '等待审批',
    createdAt: '2026-11-26T00:00:05.000Z'
  });
  store.put('work-usage', { id: 'u1', ticketId: 't1', calls: 2, totalTokens: 300, costEstimate: 0.02, recordedAt: '2026-11-26T00:00:05.000Z' });
  store.put('work-usage', { id: 'u2', ticketId: 't2', calls: 1, totalTokens: 200, costEstimate: 0.01, recordedAt: '2026-11-26T00:00:05.000Z' });
  const approval = approvals.request({ threadId: 'conv-1', ticketId: 't1', kind: 'ticket', title: '确认执行', summary: '请确认', input: { command: 'secret' } });
  store.put('approval', { ...store.get('approval', approval.id), id: 'a1' });
  store.delete('approval', approval.id);

  const events = [];
  if (log) {
    log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1', conversationId: 'conv-1', title: '检查发布说明', status: 'awaiting_review', summary: '等待确认', attention: { question: '确认？' } }, createdAt: '2026-11-26T00:00:02.000Z' });
    log.record({ type: 'activity', ticketId: 't1', payload: { conversationId: 'conv-1', activity: [
      { kind: 'thought', text: '先看发布说明' },
      { kind: 'tool', text: '读取 CHANGELOG', detail: '读取成功' },
      { kind: 'permission', text: '请求写入 README', requestId: 'perm-1' }
    ] }, createdAt: '2026-11-26T00:00:03.000Z' });
    log.record({ type: 'approval', eventType: 'approval.requested', threadId: 'conv-1', ticketId: 't1', payload: { approvalId: 'a1', kind: 'ticket', title: '确认执行', summary: '请确认', status: 'pending' }, createdAt: '2026-11-26T00:00:04.000Z' });
  } else {
    store.put('work-event', { id: 'we1', type: 'ticket', ticketId: 't1', payload: { id: 't1', title: '检查发布说明', status: 'awaiting_review', summary: '等待确认', attention: { question: '确认？' } }, createdAt: '2026-11-26T00:00:02.000Z' });
    store.put('work-event', { id: 'we2', type: 'activity', ticketId: 't1', payload: { activity: [{ kind: 'tool', text: '读取 CHANGELOG' }] }, createdAt: '2026-11-26T00:00:03.000Z' });
  }

  const projection = createThreadProjection({
    store,
    runEvents: log,
    budgetTokens: 10000,
    now: () => current
  });
  t.after(() => { approvals.close(); log?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, log, approvals, projection, advance: ms => { current += ms; }, events };
}

test('thread 投影：聚合会话、工单、运行、审批、时间线与 Inspector', t => {
  const { projection } = fixture(t);
  const thread = projection.get('conv-1');
  assert.equal(thread.id, 'conv-1');
  assert.equal(thread.title, '发布检查');
  assert.equal(thread.status, 'waiting_approval');
  assert.equal(thread.runs.length, 1);
  assert.equal(thread.runs[0].doneSteps, 1);
  assert.equal(thread.runs[0].totalSteps, 2);
  assert.deepEqual(thread.tickets.map(ticket => ticket.id).sort(), ['t1', 't2']);
  assert.equal(thread.approvals.length, 1);
  assert.equal(thread.approvals[0].input, undefined, '投影不泄露审批原始输入');
  assert.equal(thread.inspector.pendingApprovals.length, 1);
  assert.equal(thread.inspector.running[0].id, 'r1');
  assert.equal(thread.inspector.artifacts[0].id, 'rep-1');
  assert.equal(thread.inspector.usage.tokens, 500);
  assert.equal(thread.inspector.usage.calls, 3);
  assert.ok(Math.abs(thread.inspector.usage.cost - 0.03) < 1e-9);
  assert.equal(thread.inspector.usage.budget, 10000);
  assert.equal(thread.cursor.lastSeq, 3, '游标是 thread 内最新 run-event 的 seq');
  assert.equal(thread.cursor.updatedAt, '2026-11-26T00:00:06.000Z');

  const kinds = thread.timeline.map(row => row.kind);
  assert.ok(kinds.includes('approval'));
  assert.ok(kinds.includes('thinking'));
  assert.ok(kinds.includes('tool'));
  assert.equal(thread.timeline.find(row => row.kind === 'approval' && row.approvalId === 'a1')?.status, 'pending');
});

test('thread 别名：ticketId / runId / approvalId 都解析到同一会话', t => {
  const { projection } = fixture(t);
  for (const alias of ['t1', 'r1', 'a1']) {
    assert.equal(projection.resolve(alias).threadId, 'conv-1');
    assert.equal(projection.get(alias).id, 'conv-1');
  }
  assert.throws(() => projection.get('missing'), error => error.status === 404);
  assert.throws(() => projection.resolve(''), error => error.status === 400);
});

test('thread 列表：同一会话只出现一次，按更新时间排序并带待审批数', t => {
  const { projection, store } = fixture(t);
  store.put('conversation', { id: 'conv-2', title: '旧会话', status: 'completed', createdAt: '2026-11-25T00:00:00.000Z', updatedAt: '2026-11-25T00:00:00.000Z' });
  const list = projection.list();
  assert.equal(list.filter(item => item.id === 'conv-1').length, 1);
  assert.equal(list[0].id, 'conv-1', '最近更新的会话排前面');
  assert.equal(list[0].pendingApprovals, 1);
  assert.equal(list[0].ticketCount, 2);
  assert.equal(list.find(item => item.id === 'conv-2')?.status, 'settled');
});

test('thread 事件分页：after_seq 只返回增量，latestSeq 推进', t => {
  const { projection } = fixture(t);
  const first = projection.listEvents('conv-1', { afterSeq: 0, limit: 2 });
  assert.equal(first.threadId, 'conv-1');
  assert.deepEqual(first.events.map(event => event.seq), [1, 2]);
  assert.equal(first.latestSeq, 3);
  const rest = projection.listEvents('t1', { afterSeq: 2 });
  assert.deepEqual(rest.events.map(event => event.seq), [3]);
  assert.equal(rest.events[0].eventType, 'approval.requested');
});

test('thread 缓存：1 秒内复用，超过 1 秒或 seq 变化后重建', t => {
  const { projection, advance, log } = fixture(t);
  const first = projection.get('conv-1');
  assert.equal(projection.get('conv-1'), first, '同一毫秒返回同一份投影');
  advance(1500);
  const second = projection.get('conv-1');
  assert.notEqual(second, first);
  log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1', conversationId: 'conv-1', status: 'working' } });
  const third = projection.get('conv-1');
  assert.equal(third.cursor.lastSeq, 4, '新事件立即让缓存失效');
});

test('没有 run-event 时退回 work-event，时间线形状保持不变', t => {
  const { projection } = fixture(t, { withRunEvents: false });
  const thread = projection.get('conv-1');
  assert.equal(thread.timeline.length, 2);
  assert.equal(thread.timeline[0].kind, 'approval', '带 attention 的工单事件显示为审批行');
  assert.equal(thread.timeline[1].kind, 'tool');
  assert.equal(thread.cursor.lastSeq, 0);
});

test('thread 状态聚合：待审批优先于运行，失败优先于已结算', () => {
  assert.equal(threadStatusOf([], [], []), 'idle');
  assert.equal(threadStatusOf([{ status: 'working' }], [], []), 'running');
  assert.equal(threadStatusOf([{ status: 'working' }], [{ status: 'pending' }], []), 'waiting_approval');
  assert.equal(threadStatusOf([{ status: 'completed' }, { status: 'failed' }], [], []), 'failed');
  assert.equal(threadStatusOf([{ status: 'completed' }], [], []), 'settled');
  assert.equal(threadStatusOf([], [], [{ status: 'paused' }]), 'paused');
});
