import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';
import { modelExecutor } from './work/executors/model.js';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'lagent-migrate-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, 'store.sqlite'));
  const claude = claudeCodeExecutor({ store, cwd: root, binary: process.execPath, spawnImpl: () => { throw new Error('迁移测试不应该启动 CLI'); } });
  const model = modelExecutor({
    store,
    cwd: root,
    context: () => ({ settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, key: 'test-key', maxTokens: 800, timeoutMs: 5000 }),
    fetchImpl: async () => { throw new Error('迁移测试不应该调用模型'); }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, model]), () => {}, {
    policy: { allowedExecutors: ['claude-code'] },
    managedProjectChats: true,
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    brain: { availability: () => ({ ok: true, model: 'deepseek-chat' }) },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { engine, store, root };
}

function seedLegacyChat(store, projectId, { status = 'completed', extra = {} } = {}) {
  const stamp = new Date().toISOString();
  const chat = {
    id: 'legacy-chat-1',
    projectId,
    executorId: 'claude-code',
    title: '旧项目对话',
    autoTitle: false,
    sessionId: 'session-legacy',
    writable: true,
    source: 'manual',
    createdAt: stamp,
    updatedAt: stamp,
    ...extra
  };
  store.put('work-project-chat', chat);
  store.put('work-ticket', {
    id: 'legacy-ticket-1',
    projectChatId: chat.id,
    executor: 'claude-code',
    title: '旧任务',
    status,
    summary: '旧结论',
    createdAt: stamp,
    updatedAt: stamp
  });
  return chat;
}

test('启动迁移把有结论的旧项目对话收成 Lagent 宿主', async t => {
  const { engine, store, root } = harness(t);
  const project = engine.importProject({ path: root, name: '旧项目' }).project;
  seedLegacyChat(store, project.id);
  engine.recover();
  const host = store.get('work-project-chat', 'legacy-chat-1');
  assert.equal(host.executorId, 'model');
  assert.equal(host.role, 'host');
  assert.ok(host.conversationId, '宿主归属一条会话');
  const hidden = store.list('work-project-chat').find(chat => chat.conversationId === host.conversationId && chat.hidden === true);
  assert.equal(hidden.executorId, 'claude-code');
  assert.equal(hidden.sessionId, 'session-legacy', 'CLI 会话跟着旧执行器迁移，续接不断');
  assert.ok(!host.sessionId, '宿主不再持有执行器 session');
  const conversation = engine.getConversation(host.conversationId).conversation;
  assert.deepEqual(conversation.participants, ['model', 'claude-code']);
});

test('运行中的旧对话不会被迁移打断', async t => {
  const { engine, store, root } = harness(t);
  const project = engine.importProject({ path: root, name: '在跑项目' }).project;
  seedLegacyChat(store, project.id, { status: 'working' });
  engine.recover();
  const chat = store.get('work-project-chat', 'legacy-chat-1');
  assert.equal(chat.executorId, 'claude-code', '等任务结束后再物化');
  assert.equal(store.list('work-project-chat').filter(item => item.hidden === true).length, 0, '不提前迁移 session');
});

test('重复启动迁移是幂等的，不会重复建隐藏执行对话', async t => {
  const { engine, store, root } = harness(t);
  const project = engine.importProject({ path: root, name: '幂等项目' }).project;
  seedLegacyChat(store, project.id);
  engine.recover();
  const first = store.get('work-project-chat', 'legacy-chat-1');
  engine.recover();
  const second = store.get('work-project-chat', 'legacy-chat-1');
  assert.equal(second.conversationId, first.conversationId);
  const hidden = store.list('work-project-chat').filter(chat => chat.hidden === true && chat.conversationId === first.conversationId);
  assert.equal(hidden.length, 1);
  assert.equal(store.list('work-conversation').length, 1);
});
