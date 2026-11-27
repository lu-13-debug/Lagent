import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { registerWork } from './work/routes.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createCheckpointService } from './work/checkpoints.js';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const route = (app, path, method = 'GET') => app.router.stack
  .find(layer => layer.route?.path === path && layer.route.methods?.[method.toLowerCase()])?.route.stack[0].handle;
const invoke = async (app, path, req = {}) => {
  let output;
  const res = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { output = value; return this; },
    send(value) { output = { __sent: value }; return this; },
    type() { return this; }, set() { return this; },
    flushHeaders() {}, write() {}, end() {}
  };
  await route(app, path, req.method || 'GET')(req, res);
  return { status: res.statusCode, ...output };
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-routes-'));
  const store = new Store(join(dir, 'data'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  const executor = {
    id: 'terminal', name: '受控终端', kind: 'terminal', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ command: text }),
    validateInput: input => input,
    start(ticket, assignment) { const task = { id: assignment.id, status: 'running', goal: ticket.command }; store.put('task', task); return task; },
    get: id => id && store.get('task', id),
    stop(task) { store.put('task', { ...task, status: 'cancelled' }); }
  };
  const app = express();
  app.use(express.json());
  const close = registerWork(app, store, createExecutorRegistry([executor]), { workspace: dir, ownerId: 'local' });
  t.after(() => { close(); store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { dir, store, app };
}

test('检查点路由：列表 → 预览拿令牌 → 带令牌二次确认回滚', async t => {
  const { dir, store, app } = fixture(t);
  const service = createCheckpointService(store, { dataDir: join(dir, 'data') });
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  const checkpoint = service.capture({ projectPath: dir, threadId: 'th-1', ticketId: 't-1' });
  writeFileSync(join(dir, 'a.txt'), 'three\n');

  const list = await invoke(app, '/api/work/checkpoints', { query: { threadId: 'th-1' } });
  assert.equal(list.status, 200);
  assert.equal(list.checkpoints.length, 1);
  assert.equal(list.checkpoints[0].id, checkpoint.id);

  const preview = await invoke(app, '/api/work/checkpoints/preview', { query: { threadId: 'th-1', scope: 'session', paths: 'a.txt' } });
  assert.equal(preview.status, 200);
  assert.equal(preview.preview.scope, 'session');
  assert.equal(preview.preview.files[0].before, 'saved');

  const denied = await invoke(app, '/api/work/checkpoints/restore', {
    method: 'POST', body: { threadId: 'th-1', scope: 'session', paths: ['a.txt'], confirm: true }
  });
  assert.equal(denied.status, 409, '缺少令牌不允许回滚');

  const restored = await invoke(app, '/api/work/checkpoints/restore', {
    method: 'POST', body: { threadId: 'th-1', scope: 'session', paths: ['a.txt'], token: preview.preview.token, confirm: true }
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.restore.counts.restored, 1);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'two\n');
});
