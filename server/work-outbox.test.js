import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { EFFECT_KINDS, enqueue, claimDue, listEffects, retryEffect, complete } from './work/outbox.js';

test('通用 effect 队列支持多种 kind、stepId 与查询', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-effects-'));
  const store = new Store(dir);
  const launch = enqueue(store, { kind: EFFECT_KINDS.launch, key: 'a', ticketId: 't1', payload: { assignmentId: 'x' } });
  const verify = enqueue(store, { kind: EFFECT_KINDS.verify, key: 'b', ticketId: 't1', stepId: 's1', payload: { command: 'npm test' } });
  const notify = enqueue(store, { kind: EFFECT_KINDS.notify, key: 'c', ticketId: 't2', payload: { message: 'hi' } });
  assert.equal(launch.kind, EFFECT_KINDS.launch);
  assert.equal(verify.stepId, 's1');
  assert.equal(notify.ticketId, 't2');

  const launches = claimDue(store, { limit: 10, kind: EFFECT_KINDS.launch });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].status, 'running');

  const byTicket = listEffects(store, { ticketId: 't1' });
  assert.equal(byTicket.length, 2);
  const byKind = listEffects(store, { kind: EFFECT_KINDS.verify });
  assert.equal(byKind.length, 1);

  complete(store, verify.id);
  const pending = listEffects(store, { status: 'pending' });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, EFFECT_KINDS.notify);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('failed effect 可手动重试，重试后回到 pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-effects-retry-'));
  const store = new Store(dir);
  const effect = enqueue(store, { kind: EFFECT_KINDS.launch, key: 'r', ticketId: 't', payload: {} });
  const claimed = claimDue(store, { limit: 1 });
  assert.equal(claimed[0].status, 'running');
  const failed = store.get('work-effect', effect.id);
  failed.status = 'failed';
  store.put('work-effect', failed);

  const reset = retryEffect(store, effect.id);
  assert.equal(reset.status, 'pending');
  assert.equal(reset.attempts, 0);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('引擎暴露 listEffects 与 retryEffect，outbox 启用后执行先入队', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-engine-outbox-'));
  const store = new Store(dir);
  let started = 0;
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      started++;
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { terminal: { command: 'pwd', exitCode: 0 } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir, outboxEnabled: true, outboxPollMs: 50 });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const ticket = engine.command({ text: ' queued via outbox ', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } });
  assert.equal(ticket.status, 'queued');
  const effects = engine.listEffects({ ticketId: ticket.id });
  assert.equal(effects.length, 1);
  assert.equal(effects[0].kind, EFFECT_KINDS.launch);

  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(started, 1);
  const detail = engine.detail(ticket.id);
  assert.equal(detail.ticket.status, 'completed');

  // 直接制造一个 failed 的 verify effect 来测试 retryEffect。
  const verify = enqueue(store, { kind: EFFECT_KINDS.verify, key: `v-${ticket.id}`, ticketId: ticket.id, stepId: 's1', payload: { command: 'npm test' } });
  const raw = store.get('work-effect', verify.id);
  raw.status = 'failed';
  store.put('work-effect', raw);
  engine.retryEffect(verify.id);
  const afterRetry = engine.listEffects({ ticketId: ticket.id, kind: EFFECT_KINDS.verify });
  assert.equal(afterRetry[0].status, 'pending');
});

test('队列按优先级领取：用户交互先于系统回报和 routine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-effects-priority-'));
  const store = new Store(dir);
  enqueue(store, { kind: EFFECT_KINDS.launch, key: 'routine', ticketId: 't-routine', priority: 2, payload: {} });
  enqueue(store, { kind: EFFECT_KINDS.launch, key: 'system', ticketId: 't-system', priority: 1, payload: {} });
  enqueue(store, { kind: EFFECT_KINDS.launch, key: 'user', ticketId: 't-user', priority: 0, payload: {} });

  const claimed = claimDue(store, { limit: 10, kind: EFFECT_KINDS.launch });
  assert.deepEqual(claimed.map(effect => effect.ticketId), ['t-user', 't-system', 't-routine']);
  assert.deepEqual(claimed.map(effect => effect.priority), [0, 1, 2]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('同一工单默认同时只领取一个 effect，完成后再领下一个', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-effects-fair-'));
  const store = new Store(dir);
  const first = enqueue(store, { kind: EFFECT_KINDS.launch, key: 'a1', ticketId: 't1', payload: {} });
  enqueue(store, { kind: EFFECT_KINDS.launch, key: 'a2', ticketId: 't1', payload: {} });
  enqueue(store, { kind: EFFECT_KINDS.launch, key: 'b1', ticketId: 't2', payload: {} });

  const claimed = claimDue(store, { limit: 10, kind: EFFECT_KINDS.launch });
  assert.equal(claimed.length, 2);
  assert.deepEqual(claimed.map(effect => effect.ticketId).sort(), ['t1', 't2']);
  const t1Claimed = claimed.find(effect => effect.ticketId === 't1');
  assert.equal(t1Claimed.key, 'a1');

  complete(store, first.id);
  const next = claimDue(store, { limit: 10, kind: EFFECT_KINDS.launch });
  assert.equal(next.length, 1);
  assert.equal(next[0].ticketId, 't1');
  assert.equal(next[0].key, 'a2');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
