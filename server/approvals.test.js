import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createApprovalService, approvalFingerprint, GRANT_NOT_ENABLED, publicApproval } from './work/approvals.js';
import { createRunEventLog, toRunEvent, wireEvent } from './work/run-events.js';
import { sanitizeMobileApproval } from './mobile-gateway.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-approvals-'));
  const store = new Store(dir);
  const published = [];
  let current = Date.parse('2026-11-26T00:00:00.000Z');
  const approvals = createApprovalService(store, {
    ownerId: 'local',
    publish: event => published.push(event),
    now: () => current,
    clock: () => new Date(current).toISOString()
  });
  t.after(() => { approvals.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, approvals, published, advance: ms => { current += ms; } };
}

test('审批请求：落库、发事件、同指纹去重', t => {
  const { approvals, published } = fixture(t);
  const first = approvals.request({
    threadId: 'c1', ticketId: 't1', kind: 'ticket', title: '确认执行', summary: '请确认终端命令',
    options: ['allow_once', 'deny'], risk: 'high', input: { command: 'npm test' }
  });
  assert.equal(first.status, 'pending');
  assert.equal(first.threadId, 'c1');
  assert.equal(first.ticketId, 't1');
  assert.equal(first.options.includes('deny'), true);
  assert.equal(published.length, 1);
  assert.equal(published[0].type, 'approval');
  assert.equal(published[0].eventType, 'approval.requested');
  assert.equal(published[0].payload.approvalId, first.id);
  assert.equal(published[0].payload.status, 'pending');

  const again = approvals.request({
    threadId: 'c1', ticketId: 't1', kind: 'ticket', title: '确认执行', summary: '请确认终端命令',
    options: ['allow_once', 'deny'], risk: 'high', input: { command: 'npm test' }
  });
  assert.equal(again.id, first.id, '同一 thread + 指纹只保留一条 pending');
  assert.equal(published.length, 1);
  assert.equal(approvals.stats().pending, 1);
});

test('审批决议：allow_once 成功，重复决议 409，事件成对出现', t => {
  const { approvals, published } = fixture(t);
  const created = approvals.request({ threadId: 'c1', ticketId: 't1', kind: 'ticket', title: '确认' });
  const resolved = approvals.resolve(created.id, 'allow_once', { by: 'd1' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.decision, 'allow_once');
  assert.equal(resolved.decidedBy, 'd1');
  assert.equal(published.at(-1).eventType, 'approval.resolved');
  assert.equal(published.at(-1).payload.decision, 'allow_once');

  assert.throws(() => approvals.resolve(created.id, 'allow_once'), error => error.status === 409 && error.code === 'APPROVAL_ALREADY_SETTLED');
  assert.throws(() => approvals.resolve('missing', 'deny'), error => error.status === 404);
});

test('会话级/始终允许在 P0 返回 409 GRANT_NOT_ENABLED，不落库', t => {
  const { approvals } = fixture(t);
  const created = approvals.request({ threadId: 'c1', ticker: 'x', ticketId: 't1', kind: 'ticket', title: '确认', options: ['allow_once', 'allow_session', 'allow_always', 'deny'] });
  for (const decision of ['allow_session', 'allow_always']) {
    assert.throws(() => approvals.resolve(created.id, decision), error => error.status === 409 && error.code === GRANT_NOT_ENABLED);
  }
  assert.equal(approvals.detail(created.id).status, 'pending', '被拒绝的授权范围不改变审批状态');
});

test('过期：按时间决议返回 409，并为 pending 项补发 expired 事件', t => {
  const { approvals, published, advance } = fixture(t);
  const created = approvals.request({ threadId: 'c1', ticketId: 't1', kind: 'tool', requestId: 'r1', title: '授权', ttlMs: 1000 });
  // now 固定为 2026-11-26T00:00:00Z，expiresAt 在同日 00:00:01。
  assert.equal(created.expiresAt, Date.parse('2026-11-26T00:00:00.000Z') + 1000);
  advance(2000);
  assert.throws(() => approvals.resolve(created.id, 'deny'), error => error.code === 'APPROVAL_EXPIRED');
  assert.equal(approvals.detail(created.id).status, 'expired');
  assert.equal(published.at(-1).eventType, 'approval.resolved');
  assert.equal(published.at(-1).payload.status, 'expired');

  const alive = approvals.request({ threadId: 'c2', ticketId: 't2', kind: 'ticket', title: '确认' });
  assert.deepEqual(approvals.expireStale(), []);
  assert.equal(approvals.detail(alive.id).status, 'pending');
});

test('按 requestId 回写旧授权接口，allow/deny 映射到 allow_once/deny', t => {
  const { approvals } = fixture(t);
  const created = approvals.request({ threadId: 'c1', ticketId: 't1', kind: 'tool', requestId: 'req-1', title: '文件授权' });
  const resolved = approvals.resolveByRequest({ ticketId: 't1', requestId: 'req-1', decision: 'allow', by: 'desktop' });
  assert.equal(resolved.decision, 'allow_once');
  assert.equal(approvals.findByRequest({ ticketId: 't1', requestId: 'req-1' }), null);
  assert.equal(approvals.resolveByRequest({ ticketId: 't1', requestId: 'req-1', decision: 'allow' }), null);
});

test('旧工单按钮：批准/退回结束 pending，停止/删除取消', t => {
  const { approvals } = fixture(t);
  const first = approvals.request({ threadId: 'c1', ticketId: 't1', kind: 'ticket', title: '确认' });
  assert.equal(approvals.resolveForTicket('t1', 'allow_once', 'desktop'), 1);
  assert.equal(approvals.detail(first.id).decision, 'allow_once');

  const second = approvals.request({ threadId: 'c2', ticketId: 't2', kind: 'ticket', title: '确认' });
  assert.equal(approvals.resolveForTicket('t2', 'deny', 'desktop'), 1);
  assert.equal(approvals.detail(second.id).status, 'resolved');
  assert.equal(approvals.detail(second.id).decision, 'deny');

  const third = approvals.request({ threadId: 'c3', ticketId: 't3', kind: 'access', requestId: 'a1', title: '访问' });
  assert.equal(approvals.cancelForTicket('t3', '已停止'), 1);
  assert.equal(approvals.detail(third.id).status, 'cancelled');
});

test('list 过滤、detail 带 input、公开投影默认脱敏', t => {
  const { approvals } = fixture(t);
  const a = approvals.request({ threadId: 'c1', ticketId: 't1', runId: 'r1', kind: 'ticket', title: '确认', input: { command: 'secret' } });
  approvals.request({ threadId: 'c2', ticketId: 't2', kind: 'ticket', title: '确认' });
  assert.equal(approvals.list({ threadId: 'c1' }).length, 1);
  assert.equal(approvals.list({ runId: 'r1' })[0].id, a.id);
  assert.equal(approvals.list({ status: 'resolved' }).length, 0);
  assert.equal(approvals.detail(a.id).input.command, 'secret');
  assert.equal(publicApproval(approvals.get(a.id)).input, undefined);
});

test('审批事件进入 run-event：requested/resolved 类型与 threadId', t => {
  const { store, approvals } = fixture(t);
  const log = createRunEventLog(store, { ownerId: 'local' });
  t.after(() => log.close());
  const captured = [];
  approvals.request({ threadId: 'c1', ticketId: 't1', kind: 'ticket', title: '确认' });
  // 直接归一审批事件，验证显式 eventType 覆盖默认 mapped 类型。
  const requested = toRunEvent({ type: 'approval', eventType: 'approval.requested', threadId: 'c1', ticketId: 't1', payload: { approvalId: 'a1' } });
  assert.equal(requested.type, 'approval.requested');
  assert.equal(requested.threadId, 'c1');
  assert.equal(requested.workType, 'approval');
  const resolved = toRunEvent({ type: 'approval', eventType: 'approval.resolved', threadId: 'c1', ticketId: 't1', payload: { approvalId: 'a1' } });
  assert.equal(resolved.type, 'approval.resolved');
  const stored = log.record(requested);
  const wire = wireEvent(stored);
  assert.equal(wire.type, 'approval', '线上 data.type 保持 work 类型');
  assert.equal(wire.eventType, 'approval.requested');
  assert.equal(wire.threadId, 'c1');
  captured.push(stored);

  const fingerprintA = approvalFingerprint({ kind: 'ticket', input: { b: 2, a: 1 } });
  const fingerprintB = approvalFingerprint({ input: { a: 1, b: 2 }, kind: 'ticket' });
  assert.equal(fingerprintA, fingerprintB, '指纹对键顺序不敏感');
});

test('手机投影：不含 input/scope，仅保留决定所需字段', t => {
  const { approvals } = fixture(t);
  const created = approvals.request({
    threadId: 'c1', ticketId: 't1', kind: 'access', requestId: 'a1', title: '读取文件',
    summary: 'Lagent 请求读取：/secret/path', input: { path: '/secret/path' }, scope: { path: '/secret/path' }
  });
  const mobile = sanitizeMobileApproval(approvals.detail(created.id));
  assert.equal(mobile.id, created.id);
  assert.equal(mobile.kind, 'access');
  assert.equal(mobile.title, '读取文件');
  assert.equal(mobile.status, 'pending');
  assert.equal(mobile.input, undefined);
  assert.equal(mobile.scope, undefined);
  assert.equal(mobile.requestId, undefined);
  assert.equal(mobile.summary, 'Lagent 请求读取：/secret/path', '摘要保留给用户判断，但结构化输入不下发');
});
