import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from './store.js';
import { createRunEventLog, normalizeThreadId, wireEvent } from './work/run-events.js';
import { workEvents } from './work/effects.js';
import { workStore } from './work/store.js';
import { MobileGateway, mobileWorkEvent } from './mobile-gateway.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-run-events-'));
  const store = new Store(dir);
  const log = createRunEventLog(store, { ownerId: 'local' });
  t.after(() => { log.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, log };
}

function sseResponse() {
  const response = new EventEmitter();
  const chunks = [];
  response.set = () => {};
  response.flushHeaders = () => {};
  response.write = chunk => { chunks.push(chunk); return true; };
  response.end = () => response.emit('close');
  response.status = code => { response.statusCode = code; return response; };
  response.json = body => { response.body = body; return response; };
  return { response, chunks };
}

const dataFrames = chunks => chunks
  .filter(chunk => chunk.startsWith('data: '))
  .map(chunk => JSON.parse(chunk.slice(6)));

const eventFrames = chunks => chunks
  .filter(chunk => chunk.startsWith('id: '))
  .map(chunk => JSON.parse(chunk.split('\n').find(line => line.startsWith('data: ')).slice(6)));

test('run-event 全局 seq、线程归一与按 id 去重', t => {
  const { log } = fixture(t);
  const first = log.record({ id: 'e1', type: 'ticket', ticketId: 't1', payload: { id: 't1', conversationId: 'c1' }, createdAt: '2026-11-26T00:00:01.000Z' });
  assert.equal(first.seq, 1);
  assert.equal(first.threadId, 'c1');
  assert.equal(first.type, 'ticket.status');
  assert.equal(first.workType, 'ticket');

  const chat = log.record({ id: 'e2', type: 'run-chat', runId: 'r1', payload: { chatId: 'c2' } });
  assert.equal(chat.seq, 2);
  assert.equal(chat.threadId, 'c2');
  assert.equal(chat.type, 'thread.created');

  const run = log.record({ id: 'e3', type: 'run', runId: 'r1', payload: { status: 'running' } });
  assert.equal(run.seq, 3);
  assert.equal(run.threadId, 'c2', 'run 事件沿用 run-chat 学到的 chatId');

  const again = log.record({ id: 'e2', type: 'run-chat', runId: 'r1', payload: { chatId: 'c2' } });
  assert.equal(again.seq, 2, '同一条 work 事件重复记录不分配新 seq');
  assert.deepEqual(log.listAfter(1).map(event => event.seq), [2, 3]);
  assert.equal(log.oldestSeq(), 1);
  assert.equal(log.latestSeq(), 3);
});

test('run-event 在已有事务内追加，不重复开启事务', t => {
  const { store, log } = fixture(t);
  const recorded = store.atomic(() => log.appendMany([
    { type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'queued' } },
    { type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'running' } }
  ]));
  assert.deepEqual(recorded.map(event => event.seq), [1, 2]);
  assert.equal(log.latestSeq(), 2);
});

test('超长 payload 截断并标记 truncated', t => {
  const { log } = fixture(t);
  const event = log.record({ type: 'activity', ticketId: 't1', payload: { text: 'x'.repeat(40000) } });
  assert.equal(event.truncated, true);
  assert.equal(event.payload.truncated, true);
  assert.ok(event.payload.bytes > 32768);
  assert.ok(Buffer.byteLength(JSON.stringify(event.payload)) <= 32768);
});

test('prune 按 thread 保留最近 N 条并按天数清旧事件', t => {
  const { log } = fixture(t);
  for (let index = 0; index < 5; index++) log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1' } });
  for (let index = 0; index < 2; index++) log.record({ type: 'ticket', ticketId: 't2', payload: { id: 't2' } });
  log.record({ type: 'ticket', ticketId: 't3', payload: { id: 't3' }, createdAt: '2026-01-01T00:00:00.000Z' });

  const result = log.prune({ perThread: 2, maxAgeDays: 30, now: Date.parse('2026-11-26T00:00:00.000Z') });
  assert.ok(result.threads >= 3);
  assert.equal(result.aged, 1);
  assert.equal(log.listAfter(0, 100).filter(event => event.threadId === 't1').length, 2);
  assert.equal(log.listAfter(0, 100).filter(event => event.threadId === 't2').length, 2);
  const next = log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1' } });
  assert.equal(next.seq, 9, '裁剪不回收 seq');
});

test('prune 先归档再删除，归档失败时保留数据', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-run-events-archive-'));
  const store = new Store(dir);
  const archived = [];
  const log = createRunEventLog(store, { ownerId: 'local', archive: rows => archived.push(...rows) });
  t.after(() => { log.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  for (let index = 0; index < 4; index++) log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1' } });
  log.record({ type: 'ticket', ticketId: 't9', payload: { id: 't9' }, createdAt: '2026-01-01T00:00:00.000Z' });

  const result = log.prune({ perThread: 2, maxAgeDays: 30, now: Date.parse('2026-11-26T00:00:00.000Z') });
  assert.equal(result.aged, 1);
  assert.ok(archived.length >= 3, '被裁剪的事件都先进了归档');
  assert.ok(archived.some(row => row.threadId === 't9'), '按天过期的事件也进归档');
  assert.equal(log.listAfter(0, 100).filter(event => event.threadId === 't1').length, 2);

  const dir2 = mkdtempSync(join(tmpdir(), 'lagent-run-events-archive-fail-'));
  const store2 = new Store(dir2);
  const log2 = createRunEventLog(store2, { ownerId: 'local', archive: () => { throw new Error('disk full'); } });
  t.after(() => { log2.close(); store2.close(); rmSync(dir2, { recursive: true, force: true }); });
  for (let index = 0; index < 3; index++) log2.record({ type: 'ticket', ticketId: 'c1', payload: { id: 'c1' } });
  const failed = log2.prune({ perThread: 1, maxAgeDays: 0 });
  assert.equal(failed.threads, 0, '归档失败时不删除');
  assert.equal(log2.listAfter(0, 100).filter(event => event.threadId === 'c1').length, 3);
});

test('SSE v2：after_seq 补发、id 帧与旧字段兼容', t => {
  const { log } = fixture(t);
  log.record({ id: 'e1', type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'queued' } });
  log.record({ id: 'e2', type: 'activity', ticketId: 't1', payload: { activity: [{ label: '读取数据' }], status: 'running' } });
  log.record({ id: 'e3', type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'completed' } });
  const events = workEvents({ log });
  const { response, chunks } = sseResponse();
  events.connect({ query: { after_seq: '1' } }, response);
  events.close();

  assert.equal(chunks[0], 'retry: 3000\n\n');
  const frames = chunks.filter(chunk => chunk.startsWith('id: '));
  assert.equal(frames.length, 2);
  assert.ok(frames[0].startsWith('id: 2\ndata: '));
  assert.ok(!frames[0].includes('\nevent: '), '保持 onmessage 可用的默认事件');
  const messages = eventFrames(chunks);
  assert.deepEqual(messages.map(message => message.seq), [2, 3]);
  assert.equal(messages[0].type, 'activity');
  assert.equal(messages[0].eventType, 'activity');
  assert.equal(messages[0].threadId, 't1');
  assert.equal(messages[1].type, 'ticket');
  assert.equal(messages[1].eventType, 'ticket.status');
  assert.equal(messages[1].payload.status, 'completed');
});

test('SSE v2：Last-Event-ID 作为游标回退', t => {
  const { log } = fixture(t);
  for (let index = 0; index < 3; index++) log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1', status: String(index) } });
  const events = workEvents({ log });
  const { response, chunks } = sseResponse();
  events.connect({ headers: { 'last-event-id': '2' } }, response);
  events.close();
  assert.deepEqual(eventFrames(chunks).map(message => message.seq), [3]);
});

test('SSE v2：缺口过大或游标早于保留窗口时发 reset', t => {
  const { log } = fixture(t);
  for (let index = 0; index < 5; index++) log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1' } });

  const gap = workEvents({ log, replayLimit: 2 });
  const gapRes = sseResponse();
  gap.connect({ query: { after_seq: '0' } }, gapRes.response);
  gap.close();
  const gapReset = gapRes.chunks.find(chunk => chunk.startsWith('event: reset'));
  assert.ok(gapReset);
  assert.equal(JSON.parse(gapReset.split('\n').find(line => line.startsWith('data: ')).slice(6)).reason, 'gap');
  assert.ok(gapReset.includes('id: 5\n'), 'reset 也推进浏览器 Last-Event-ID');
  assert.equal(gapRes.chunks.filter(chunk => chunk.startsWith('id: ')).length, 0);

  log.prune({ perThread: 2, maxAgeDays: 0 });
  const retention = workEvents({ log });
  const retentionRes = sseResponse();
  retention.connect({ query: { after_seq: '1' } }, retentionRes.response);
  retention.close();
  const retentionReset = retentionRes.chunks.find(chunk => chunk.startsWith('event: reset'));
  assert.ok(retentionReset);
  assert.equal(JSON.parse(retentionReset.split('\n').find(line => line.startsWith('data: ')).slice(6)).reason, 'retention');
});

test('SSE v2：实时事件按 seq 去重，无 seq 帧仍然直播', t => {
  const { log } = fixture(t);
  const first = log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'queued' } });
  const second = log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'running' } });
  const events = workEvents({ log });
  const { response, chunks } = sseResponse();
  events.connect({ query: { after_seq: String(first.seq) } }, response);
  assert.deepEqual(eventFrames(chunks).map(message => message.seq), [second.seq]);

  events.publish(second);
  assert.equal(chunks.filter(chunk => chunk.startsWith('id: ')).length, 1, '重复推送不再发一帧');
  const third = log.record({ type: 'ticket', ticketId: 't1', payload: { id: 't1', status: 'completed' } });
  events.publish(third);
  assert.equal(chunks.filter(chunk => chunk.startsWith('id: ')).length, 2);

  events.publish({ type: 'live-frame', payload: { image: 'base64' } });
  const live = chunks.find(chunk => chunk.startsWith('data: ') && JSON.parse(chunk.slice(6)).type === 'live-frame');
  assert.ok(live);
  assert.ok(!live.startsWith('id: '));
  events.close();
});

test('SSE v2：登录失效时返回 401', t => {
  const { log } = fixture(t);
  const events = workEvents({ log });
  const { response } = sseResponse();
  events.connect({}, response, () => false);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.body, { error: '登录已失效，请重新登录' });
  events.close();
});

test('workStore 在工单事务内写 run-event，且与 publish 不重复', t => {
  const { store, log } = fixture(t);
  const published = [];
  const db = workStore(store, event => published.push(event), { runEvents: log });
  db.write([['ticket', { id: 't1', status: 'awaiting_review', title: '检查留存' }]]);

  const stored = log.listAfter(0, 10);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, published[0].id);
  assert.equal(stored[0].threadId, 't1');
  assert.equal(stored[0].workType, 'ticket');
  assert.equal(published[0].id, stored[0].id);

  // 路由层的 publish 会再记一次；按 work 事件 id 去重，不产生第二条。
  log.record(published[0]);
  assert.equal(log.listAfter(0, 10).length, 1);
});

test('手机 SSE：补发带 seq、实时去重，reset 清空游标', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-mobile-events-'));
  const gateway = new MobileGateway({ dataDir: join(dir, 'mobile') });
  t.after(() => { gateway.close(); rmSync(dir, { recursive: true, force: true }); });
  const device = { id: 'd1', ownerId: 'local', tokenHash: 'hash' };
  const { response, chunks } = sseResponse();
  const replay = after => ({
    reset: after === 9 ? { reason: 'gap', oldestSeq: 1, latestSeq: 4 } : null,
    frames: after === 9 ? [] : [{ seq: 3, data: mobileWorkEvent({ type: 'ticket', ticketId: 't1', payload: { status: 'running' } }, { seq: 3, eventType: 'ticket.status' }) }]
  });
  gateway.connect({ query: { after_seq: '2' } }, response, { ownerId: 'local', device, replay });
  assert.ok(chunks.includes('id: 3\ndata: ' + JSON.stringify(mobileWorkEvent({ type: 'ticket', ticketId: 't1', payload: { status: 'running' } }, { seq: 3, eventType: 'ticket.status' })) + '\n\n'));

  gateway.publish('local', { type: 'ticket', ticketId: 't1', payload: { status: 'running' } }, { seq: 3 });
  assert.equal(chunks.filter(chunk => chunk === 'id: 3\ndata: ' + JSON.stringify(mobileWorkEvent({ type: 'ticket', ticketId: 't1', payload: { status: 'running' } }, { seq: 3, eventType: 'ticket.status' })) + '\n\n').length, 1);

  gateway.publish('local', { type: 'ticket', ticketId: 't1', payload: { status: 'completed' } }, { seq: 4 });
  assert.equal(dataFrames(chunks).filter(message => message.seq === 4).length, 1);

  const resetRes = sseResponse();
  gateway.connect({ query: { after_seq: '9' } }, resetRes.response, { ownerId: 'local', device, replay });
  assert.ok(resetRes.chunks.some(chunk => chunk.startsWith('event: reset')));
  gateway.publish('local', { type: 'ticket', ticketId: 't1', payload: { status: 'queued' } }, { seq: 5 });
  assert.equal(dataFrames(resetRes.chunks).filter(message => message.seq === 5).length, 1, 'reset 把游标推到最新后仍接收后续事件');
});

test('线程归一优先级与 wireEvent 形状', () => {
  assert.equal(normalizeThreadId({ conversationId: 'c', chatId: 'h', ticketId: 't', runId: 'r' }), 'c');
  assert.equal(normalizeThreadId({ chatId: 'h', ticketId: 't', runId: 'r' }), 'h');
  assert.equal(normalizeThreadId({ ticketId: 't', runId: 'r' }), 't');
  assert.equal(normalizeThreadId({}), null);
  assert.equal(wireEvent({ seq: 7, type: 'ticket.status', workType: 'ticket', ticketId: 't1', payload: { status: 'ok' }, threadId: 'c1', createdAt: 'now', schemaVersion: 1 }).type, 'ticket');
  assert.equal(wireEvent({ type: 'live-frame' }).type, 'live-frame');
});
