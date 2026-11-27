import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { registerWork } from './work/routes.js';
import { createExecutorRegistry } from './work/executors/index.js';

process.env.LAGENT_WORKTREE = '1';

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
  const dir = mkdtempSync(join(tmpdir(), 'lagent-worktree-routes-'));
  const store = new Store(join(dir, 'data'));
  const project = join(dir, 'repo');
  mkdirSync(project, { recursive: true });
  git(project, ['init']);
  git(project, ['config', 'user.email', 'test@example.com']);
  git(project, ['config', 'user.name', 'Test']);
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'init']);
  store.put('work-project', { id: 'p1', name: 'repo', path: project, createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z' });
  store.put('work-project', { id: 'p2', name: 'plain', path: dir, createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z' });
  const executor = {
    id: 'terminal', name: '受控终端', kind: 'terminal', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ command: text }), validateInput: input => input,
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

test('项目隔离模式：git 项目可开，非 git 拒绝，工作树列表为空', async t => {
  const { app } = fixture(t);
  const enabled = await invoke(app, '/api/work/projects/:id/isolation', {
    method: 'POST', params: { id: 'p1' }, body: { mode: 'worktree' }
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.project.isolation, 'worktree');

  const rejected = await invoke(app, '/api/work/projects/:id/isolation', {
    method: 'POST', params: { id: 'p2' }, body: { mode: 'worktree' }
  });
  assert.equal(rejected.status, 400, '非 git 项目不能开启隔离');

  const list = await invoke(app, '/api/work/projects/:id/worktrees', { params: { id: 'p1' }, query: {} });
  assert.equal(list.status, 200);
  assert.deepEqual(list.worktrees, []);

  const off = await invoke(app, '/api/work/projects/:id/isolation', {
    method: 'POST', params: { id: 'p1' }, body: { mode: 'direct' }
  });
  assert.equal(off.status, 200);
  assert.equal(off.project.isolation, undefined);
});
