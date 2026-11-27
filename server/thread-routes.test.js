import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { registerWork } from './work/routes.js';
import { createExecutorRegistry } from './work/executors/index.js';

process.env.LAGENT_THREAD_API = '1';
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
  const dir = mkdtempSync(join(tmpdir(), 'lagent-thread-routes-'));
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
    stop(task) { store.put('task', { ...task, status: 'cancelled' }); }
  };
  const close = registerWork(app, store, createExecutorRegistry([executor]), { workspace: dir, ownerId: 'local' });
  t.after(() => {
    close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { app, engine: app.locals.workEngine, store };
}

test('thread 路由：工单 id 深链到会话投影，事件可用 after_seq 分页', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  const ticketId = created.ticket.id;

  const listed = await invoke(f.app, '/api/work/threads');
  assert.ok(listed.threads.some(thread => thread.id === ticketId));

  const thread = await invoke(f.app, '/api/work/threads/:id', { params: { id: ticketId } });
  assert.equal(thread.thread.id, ticketId);
  assert.equal(thread.thread.tickets.length, 1);
  assert.equal(thread.thread.tickets[0].id, ticketId);
  assert.equal(thread.thread.status, 'running');
  assert.ok(thread.thread.cursor.lastSeq >= 1, '游标来自 run-event');

  const events = await invoke(f.app, '/api/work/threads/:id/events', { params: { id: ticketId } });
  assert.equal(events.threadId, ticketId);
  assert.ok(events.events.length >= 1);
  assert.ok(events.events.every(event => typeof event.seq === 'number'));
  const after = await invoke(f.app, '/api/work/threads/:id/events', { params: { id: ticketId }, query: { after_seq: String(events.events[0].seq) } });
  assert.ok(after.events.every(event => event.seq > events.events[0].seq));

  const missing = await invoke(f.app, '/api/work/threads/:id', { params: { id: 'nope' } });
  assert.equal(missing.status, 404);
});

test('thread 投影不写库：读取多次不会新增实体', async t => {
  const f = fixture(t);
  const created = await invoke(f.app, '/api/work/command', { method: 'POST', body: { text: '检查目录', executorId: 'terminal' } });
  const before = f.store.list('conversation').length + f.store.list('work-ticket').length;
  await invoke(f.app, '/api/work/threads/:id', { params: { id: created.ticket.id } });
  await invoke(f.app, '/api/work/threads/:id', { params: { id: created.ticket.id } });
  const after = f.store.list('conversation').length + f.store.list('work-ticket').length;
  assert.equal(after, before);
  assert.equal(f.store.list('thread').length, 0, 'P0 不落 thread 实体');
});
