import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-command-project-'));
  const store = new Store(dir);
  const executor = id => ({
    id,
    name: id === 'model' ? 'Lagent' : id,
    // 生产里的内置 Lagent 也以 cli 形态注册（受管执行器）。
    kind: 'cli',
    available: true,
    capabilities: [],
    defaultInput: text => ({ prompt: text }),
    validateInput: input => input,
    start(ticket, assignment) { return { id: assignment.id, status: 'completed', report: { summary: `${id} 完成` } }; },
    get() { return null; }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([executor('model'), executor('codex')]), () => {}, {
    workspace: dir,
    policy: { allowedExecutors: ['model', 'codex'] },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine };
}

test('只传 projectId 时落到 Lagent 主持的项目会话，不命中 hidden 执行子会话', t => {
  const { engine, store, dir } = fixture(t);
  const { project } = engine.importProject({ path: dir });
  const host = engine.createProjectChat(project.id, { executorId: 'model', title: '主对话' }).chat;
  const child = engine.createProjectChat(project.id, { executorId: 'codex', title: '内部执行', hidden: true }).chat;
  // hidden 子会话更新更晚：旧实现取 listChats()[0] 会错误地落到它上面。
  store.put('project-chat', { ...host, updatedAt: '2026-11-20T10:00:00.000Z' });
  store.put('project-chat', { ...child, updatedAt: '2026-11-20T11:00:00.000Z' });

  const ticket = engine.command({ text: '检查项目状态', projectId: project.id });
  assert.equal(ticket.projectChatId, host.id, '不能落到 hidden 执行子会话');
  assert.equal(ticket.executor, 'model', '没有显式执行器时沿用会话绑定的 Lagent');
});

test('显式 executorId 时选择对应的项目会话', t => {
  const { engine, dir } = fixture(t);
  const { project } = engine.importProject({ path: dir });
  engine.createProjectChat(project.id, { executorId: 'model', title: '主对话' });
  const codexChat = engine.createProjectChat(project.id, { executorId: 'codex', title: 'Codex 对话' }).chat;

  const ticket = engine.command({ text: '跑一遍检查', executorId: 'codex', projectId: project.id });
  assert.equal(ticket.projectChatId, codexChat.id);
  assert.equal(ticket.executor, 'codex');
});
