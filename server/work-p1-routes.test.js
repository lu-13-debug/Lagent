import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { registerWork } from './work/routes.js';
import { createExecutorRegistry } from './work/executors/index.js';

const route = (app, path, method = 'GET') => app.router.stack.find(layer => layer.route?.path === path && layer.route.methods?.[method.toLowerCase()])?.route.stack[0].handle;
const invoke = async (app, path, req = {}) => {
  let output;
  const res = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { output = value; return this; },
    send(value) { output = value; return this; },
    type() { return this; },
    set() { return this; },
    flushHeaders() {}, write() {}, end() {}
  };
  await route(app, path, req.method || 'GET')(req, res);
  return output;
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-p1-routes-'));
  const projectDir = join(dir, 'project');
  mkdirSync(projectDir, { recursive: true });
  const store = new Store(join(dir, 'data'));
  const bridge = {
    captureWindow: async () => ({ image: 'data:image/jpeg;base64,AAAA', width: 800, height: 600, title: 'Codex 会话', process: 'codex' })
  };
  const app = express();
  const executor = {
    id: 'codex', name: 'Codex', kind: 'cli', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ prompt: text }), validateInput: input => input,
    start: () => ({ status: 'completed', report: { summary: 'done' }, artifacts: {} }), get: () => null
  };
  const close = registerWork(app, store, createExecutorRegistry([executor]), { workspace: dir, windowBridge: bridge });
  t.after(() => {
    close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, projectDir, app };
}

test('P1 路由：IM 渠道、团队房间与实时观察', async t => {
  const f = fixture(t);
  assert.deepEqual((await invoke(f.app, '/api/work/im/config')).channels, []);
  const saved = await invoke(f.app, '/api/work/im/channels', { method: 'POST', body: { name: '研发群', kind: 'slack', webhookUrl: 'https://hooks.example/abc', events: ['ticket'] } });
  assert.equal(saved.channel.kind, 'slack');
  assert.equal(saved.channel.webhookHost, 'hooks.example');
  const listed = await invoke(f.app, '/api/work/im/config');
  assert.equal(listed.channels.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), /hooks\.example\/abc/);
  assert.deepEqual(await invoke(f.app, '/api/work/im/channels/:id', { params: { id: saved.channel.id }, method: 'DELETE' }), { ok: true, id: saved.channel.id });

  const project = (await invoke(f.app, '/api/work/projects', { method: 'POST', body: { path: f.projectDir, name: 'P1 项目' } })).project;
  assert.ok(project.id);
  const room = (await invoke(f.app, '/api/work/projects/:id/rooms', { method: 'POST', params: { id: project.id }, body: { title: '发布联调' } })).room;
  assert.equal(room.title, '发布联调');
  assert.equal(room.projectId, project.id);
  const posted = await invoke(f.app, '/api/work/rooms/:id/messages', { method: 'POST', params: { id: room.id }, body: { text: '准备开始', agent: '我' } });
  assert.equal(posted.message.text, '准备开始');
  assert.equal((await invoke(f.app, '/api/work/rooms/:id', { params: { id: room.id } })).room.messages.at(-1).text, '准备开始');

  const live = await invoke(f.app, '/api/work/live', { method: 'POST', body: { handle: 4242, process: 'codex', title: 'Codex 会话' } });
  assert.equal(live.session.status, 'live');
  const frame = await invoke(f.app, '/api/work/live/:id/frame', { params: { id: live.session.id } });
  assert.match(frame.frame.image, /^data:image\/jpeg;base64,/);
  const taken = await invoke(f.app, '/api/work/live/:id/takeover', { method: 'POST', params: { id: live.session.id } });
  assert.equal(taken.session.status, 'takeover');
  assert.deepEqual(await invoke(f.app, '/api/work/live/:id/stop', { method: 'POST', params: { id: live.session.id } }), { ok: true, id: live.session.id });
});

test('P1 路由：Library 预览、应用与回滚', async t => {
  const f = fixture(t);
  const project = (await invoke(f.app, '/api/work/projects', { method: 'POST', body: { path: f.projectDir, name: 'Library 项目' } })).project;
  const preview = await invoke(f.app, '/api/work/projects/:id/library/preview', { params: { id: project.id }, query: {} });
  assert.equal(preview.targets.length, 3);
  assert.ok(preview.targets.every(row => row.changed));
  assert.match(preview.targets.find(row => row.id === 'claude').after, /lagent:begin/);
  const applied = await invoke(f.app, '/api/work/projects/:id/library/apply', { method: 'POST', params: { id: project.id }, body: {} });
  assert.equal(applied.sync.changed, 3);
  assert.equal(applied.sync.changedFiles.length, 3);
  const syncs = await invoke(f.app, '/api/work/projects/:id/library/syncs', { params: { id: project.id } });
  assert.equal(syncs.syncs.length, 1);
  // 第二次写入内容没有变化，不产生新文件修改。
  const again = await invoke(f.app, '/api/work/projects/:id/library/apply', { method: 'POST', params: { id: project.id }, body: {} });
  assert.equal(again.sync.changed, 0);
  const rolled = await invoke(f.app, '/api/work/projects/:id/library/rollback', { method: 'POST', params: { id: project.id }, body: { syncId: applied.sync.id } });
  assert.equal(rolled.restored.length, 3);
  const after = await invoke(f.app, '/api/work/projects/:id/library/preview', { params: { id: project.id }, query: {} });
  assert.ok(after.targets.every(row => row.changed));
});

test('P1 路由：例行任务列表与参数校验', async t => {
  const f = fixture(t);
  const list = await invoke(f.app, '/api/work/routines');
  assert.deepEqual(list.routines, []);
  assert.ok(list.kinds.includes('daily-brief'));
  await assert.rejects(() => invoke(f.app, '/api/work/hooks/:token', { method: 'POST', params: { token: 'wrong' }, body: {} }), { status: 401 });
});
