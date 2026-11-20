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
import { collaboratorsOf, isExecutorAllowed, lagentReadiness, managedTurnShape, normalizeManagedAgents } from './application/conversation/model.js';

function harness(t, { modelConfigured = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lagent-enforce-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, 'store.sqlite'));
  const claude = claudeCodeExecutor({ store, cwd: root, binary: process.execPath, spawnImpl: () => { throw new Error('测试不应该真的启动 CLI'); } });
  const model = modelExecutor({
    store,
    cwd: root,
    context: () => ({ settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, key: 'test-key', maxTokens: 800, timeoutMs: 5000 }),
    fetchImpl: async () => { throw new Error('测试不应该真的调用模型'); }
  });
  const brain = {
    availability: () => modelConfigured ? { ok: true, model: 'deepseek-chat' } : { ok: false, configured: false, reason: '未配置' }
  };
  const fake = id => ({ id, name: id, kind: 'cli', available: true, validateInput: () => null, execute: async () => ({ ok: true }) });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, model, fake('codex'), fake('claude-acp'), fake('gemini'), fake('qwen')]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex', 'claude-acp', 'gemini', 'qwen'] },
    managedProjectChats: true,
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    brain,
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { engine, store, root };
}

test('纯规则：Lagent 永远在参与者首位，外部协作最多 3 个', () => {
  assert.deepEqual(normalizeManagedAgents(['claude-code', 'codex', 'model', 'claude-code']), ['model', 'claude-code', 'codex']);
  assert.deepEqual(normalizeManagedAgents(['a', 'b', 'c', 'd']), ['model', 'a', 'b', 'c']);
  assert.deepEqual(collaboratorsOf(['model', 'codex']), ['codex']);
  assert.equal(managedTurnShape({ mode: 'auto', collaborators: [] }).kind, 'direct');
  assert.equal(managedTurnShape({ mode: 'review', collaborators: ['codex'] }).kind, 'coordinated');
  assert.equal(managedTurnShape({ mode: 'plan', collaborators: ['codex'] }).kind, 'plan');
  assert.equal(isExecutorAllowed({ allowedExecutors: [] }, 'model'), true, '策略不能关掉主控');
  assert.equal(isExecutorAllowed({ allowedExecutors: [] }, 'codex'), false);
  assert.equal(lagentReadiness({ configured: false }).code, 'LAGENT_MODEL_NOT_CONFIGURED');
  assert.equal(lagentReadiness({ configured: true, available: true }).ready, true);
});

test('只选外部 Agent 时仍由 Lagent 分工与汇总', async t => {
  const { engine } = harness(t);
  const { conversation } = engine.createConversation({ goal: '审查鉴权', agentIds: ['claude-code'] });
  const result = await engine.conversationMessage(conversation.id, {
    text: '检查鉴权逻辑是否有漏洞',
    mode: 'review',
    agentIds: ['claude-code'],
    autoRun: false
  });
  assert.equal(result.tickets.length, 3, 'Lagent 分工 + 外部执行 + Lagent 汇总');
  assert.deepEqual(result.tickets.map(ticket => ticket.role), ['coordination', 'answer', 'synthesis']);
  assert.deepEqual(result.tickets.map(ticket => ticket.executor), ['model', 'claude-code', 'model']);
  const loaded = engine.getConversation(conversation.id).conversation;
  assert.deepEqual(loaded.participants, ['model', 'claude-code']);
  assert.equal(loaded.turns[0].synthesisAgentId, 'model');
  for (const ticket of result.tickets) {
    assert.equal(ticket.conversationId, conversation.id);
    assert.equal(ticket.turnId, loaded.turns[0].id);
  }
});

test('只选 Lagent 时直接一张工单，不额外造协调与汇总', async t => {
  const { engine } = harness(t);
  const { conversation } = engine.createConversation({ goal: '解释一下', agentIds: [] });
  const result = await engine.conversationMessage(conversation.id, { text: '解释一下这个报错', autoRun: false });
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].executor, 'model');
  assert.equal(result.tickets[0].role, 'answer');
});

test('模型未配置时直接阻断，外部 Agent 不能绕过 Lagent', async t => {
  const { engine, store } = harness(t, { modelConfigured: false });
  const { conversation } = engine.createConversation({ goal: '审查', agentIds: ['claude-code'] });
  await assert.rejects(
    () => engine.conversationMessage(conversation.id, { text: '审查一下', agentIds: ['claude-code'], autoRun: false }),
    error => error.status === 409 && error.code === 'LAGENT_MODEL_NOT_CONFIGURED'
  );
  assert.equal(store.list('work-ticket').length, 0, '阻断时不能先派一张外部工单');
});

test('协作 Agent 超过 3 个时自动截断，不会让主控被挤掉', async t => {
  const { engine } = harness(t);
  const { conversation } = engine.createConversation({ goal: '多人对比', agentIds: [] });
  const result = await engine.conversationMessage(conversation.id, {
    text: '对比几种实现',
    mode: 'review',
    agentIds: ['claude-code', 'codex', 'claude-acp', 'gemini', 'qwen'],
    autoRun: false
  });
  const executors = result.tickets.map(ticket => ticket.executor);
  assert.equal(executors[0], 'model');
  assert.equal(executors.at(-1), 'model');
  assert.ok(executors.filter(id => id !== 'model').length <= 3);
});

test('外部 CLI 不能绕过会话直接派单', async t => {
  const { engine } = harness(t);
  assert.throws(
    () => engine.command({ text: '直接跑一下', executorId: 'claude-code' }),
    error => error.status === 409 && error.code === 'LAGENT_REQUIRED'
  );
});

test('项目对话惰性转成 Lagent 会话，原执行器退到隐藏执行对话', async t => {
  const { engine, store } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo' }).project;
  const { chat } = engine.createProjectChat(project.id, { executorId: 'claude-code' });
  const tickets = engine.projectChatMessages(chat.id, { text: '看一下目录结构', autoRun: false });
  assert.ok(tickets.length >= 3);
  const conversationId = tickets[0].conversationId;
  assert.ok(conversationId, '项目对话派单后返回会话 id');
  const chats = store.list('work-project-chat');
  const host = chats.find(item => item.id === chat.id);
  assert.equal(host.executorId, 'model', '用户看到的对话宿主是 Lagent');
  assert.equal(host.role, 'host');
  const hidden = chats.find(item => item.conversationId === conversationId && item.hidden === true);
  assert.equal(hidden.executorId, 'claude-code', '原执行器保留在隐藏执行对话里');
  assert.deepEqual(engine.getConversation(conversationId).conversation.participants, ['model', 'claude-code']);
});
