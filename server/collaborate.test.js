import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';
import { codexExecutor } from './work/executors/codex.js';
import { modelExecutor } from './work/executors/model.js';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'dataagent-collaborate-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, 'store.sqlite'));
  const claude = claudeCodeExecutor({ store, cwd: root, binary: process.execPath });
  const codex = codexExecutor({ store, cwd: root, binary: process.execPath });
  const model = modelExecutor({
    store,
    cwd: root,
    context: () => ({ settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, key: 'test-key', maxTokens: 800, timeoutMs: 5000 }),
    fetchImpl: async () => { throw new Error('测试不应该真的调用模型'); }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex, model]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex', 'model'] },
    env: { ...process.env, DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { engine, store };
}

test('团队协作：内置模型先拆解，再分派外部 Agent，最后由内置模型收拢', async t => {
  const { engine, store } = harness(t);
  const result = await engine.collaborate({
    goal: '为播放器补一个音量记忆功能，并补上单测',
    agentIds: ['claude-code', 'codex'],
    models: { 'claude-code': 'claude-sonnet-4-6' }
  });

  assert.equal(result.plan.status, 'active');
  const steps = result.plan.steps;
  assert.equal(steps[0].executorId, 'model', '第一步应由内置模型 Agent 理解与拆解');
  assert.equal(steps.at(-1).executorId, 'model', '最后由内置模型 Agent 收拢');

  const middle = steps.slice(1, -1);
  assert.ok(middle.length >= 1, '中间至少有一个外部 Agent 步骤');
  for (const step of middle) {
    assert.ok(step.dependsOn.includes(0), '外部步骤要等第 0 步拆解完成');
  }
  assert.deepEqual(steps.at(-1).dependsOn, middle.map(step => step.index), '收拢步骤要等所有外部步骤');

  const tickets = store.list('work-ticket').filter(ticket => ticket.planId === result.plan.id);
  assert.equal(tickets.length, steps.length, '每一步一张工单');

  const claudeStep = middle.find(step => step.executorId === 'claude-code');
  if (claudeStep) {
    const control = store.get('work-control', claudeStep.ticketId);
    assert.equal(control.executorInput.model, 'claude-sonnet-4-6', '指定的模型要传给该 CLI');
  }
  const modelControl = store.get('work-control', steps[0].ticketId);
  assert.match(modelControl.executorInput.prompt, /不要修改任何文件/);
});

test('团队协作：没有可用的外部 Agent 时拒绝执行', async t => {
  const { engine } = harness(t);
  await assert.rejects(
    () => engine.collaborate({ goal: '补一个导出按钮', agentIds: [] }),
    /至少选择一个 Agent/
  );
});

test('团队协作：只在项目里开一条主对话，其他 Agent 挂成从属会话', async t => {
  const { engine } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo' }).project;
  const result = await engine.collaborate({
    goal: '给播放器补一个音量记忆功能',
    projectId: project.id,
    agentIds: ['claude-code', 'codex']
  });
  const chats = engine.getProject(project.id).chats;
  const roots = chats.filter(chat => !chat.parentChatId);
  const children = chats.filter(chat => chat.parentChatId);
  assert.equal(roots.length, 1, '一次协作只开一条主对话');
  assert.equal(roots[0].executorId, 'model', '主对话是内置模型 Agent');
  assert.equal(roots[0].title, '给播放器补一个音量记忆功能', '主对话标题用协作目标');
  assert.ok(result.mainChatId === roots[0].id, '返回值告诉前端主对话是哪条');
  assert.ok(children.length >= 1, '外部 Agent 各自挂一条从属会话');
  for (const child of children) {
    assert.equal(child.parentChatId, roots[0].id, '从属会话指向主对话');
    assert.notEqual(child.executorId, 'model');
  }
});
