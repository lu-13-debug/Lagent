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

test('对话消息可指定模型与思考强度，并落进执行器输入', async t => {
  const { engine, store } = harness(t);
  const projectDir = join(tmpdir(), `dataagent-chat-model-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });
  t.after(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = engine.importProject({ path: projectDir }).project;
  const { chat } = engine.createProjectChat(project.id, { executorId: 'model' });

  const ticket = engine.projectChatMessage(chat.id, { text: '看一下目录结构', profileId: 'profile-abc', effort: 'high' });
  const control = store.get('work-control', ticket.id);
  assert.equal(control.executorInput.profileId, 'profile-abc');
  assert.equal(control.executorInput.effort, 'high');
  assert.equal(control.executorInput.workspace, projectDir, '工作目录仍锁定在项目内');

  const plain = engine.projectChatMessage(chat.id, { text: '再来一次' });
  const plainControl = store.get('work-control', plain.id);
  assert.equal(plainControl.executorInput.profileId, undefined, '不传时沿用默认模型');
  assert.equal(plainControl.executorInput.effort, undefined);
});

test('删除对话里的一条消息会连同执行记录一起清掉', async t => {
  const { engine, store } = harness(t);
  const projectDir = join(tmpdir(), `dataagent-chat-delete-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });
  t.after(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = engine.importProject({ path: projectDir }).project;
  const { chat } = engine.createProjectChat(project.id, { executorId: 'model' });
  const ticket = engine.projectChatMessage(chat.id, { text: '看一下目录结构' });

  // 待确认的工单不能删：还在执行的方案删掉会让执行器无处回报。
  assert.throws(() => engine.deleteTicket(ticket.id), /先停止再删除/);

  engine.action(ticket.id, 'stop');
  const result = engine.deleteTicket(ticket.id);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.ids, [ticket.id]);
  assert.equal(result.planRemoved, false);
  assert.equal(store.get('work-ticket', ticket.id) ?? null, null, '工单本身被删除');
  assert.equal(store.get('work-control', ticket.id) ?? null, null, '控制记录被删除');
  assert.equal(store.list('work-ticket').filter(row => row.id === ticket.id).length, 0);
  assert.equal(engine.getProject(project.id).chats.find(item => item.id === chat.id).lastTicketId ?? null, null, '对话的最后一条消息指针被清掉');
});

test('不属于任何对话的工单不能从对话页删除', async t => {
  const { engine } = harness(t);
  const ticket = engine.command({ text: '只回复两个字母：OK', executorId: 'model' });
  assert.throws(() => engine.deleteTicket(ticket.id), /只有项目对话里的消息可以删除/);
});
