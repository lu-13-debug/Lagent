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

async function waitFor(predicate, message = '等待条件超时', timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

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
  const events = [];
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex, model]), event => events.push(event), {
    policy: { allowedExecutors: ['claude-code', 'codex', 'model'] },
    env: { ...process.env, DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { engine, store, events };
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

test('团队协作：只给你选中的 Agent 派活，没选的不会凭空出现在分工里', async t => {
  const { engine } = harness(t);
  const result = await engine.collaborate({
    goal: '给播放器加一个音量记忆功能，写 index.html、player.js 和 unit.test.js',
    agentIds: ['claude-code']
  });
  const middle = result.plan.steps.slice(1, -1);
  assert.ok(middle.length >= 1);
  for (const step of middle) {
    assert.equal(step.executorId, 'claude-code', '只在被选中的 Agent 里分工');
  }
});

test('团队协作：没有可用的外部 Agent 时拒绝执行', async t => {  const { engine } = harness(t);
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

test('单条对话可以有自己的权限档位，优先于全局设置', async t => {
  const { engine, store } = harness(t);
  const projectDir = join(tmpdir(), `dataagent-chat-perm-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });
  t.after(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = engine.importProject({ path: projectDir }).project;
  const { chat } = engine.createProjectChat(project.id, { executorId: 'model' });

  // 全局设成「仅查看」，这条对话自己设成「完全权限」：以对话为准。
  engine.updatePolicy({ permission: 'read' });
  engine.setProjectChatPermission(chat.id, { permission: 'full' });
  const raised = engine.projectChatMessage(chat.id, { text: '看一下目录结构' });
  const raisedInput = store.get('work-control', raised.id).executorInput;
  assert.equal(raisedInput.permission, 'full');
  assert.equal(raisedInput.write, true, '完全权限下可以写');

  // 反过来：全局「完全权限」，这条对话只要「仅查看」。
  engine.updatePolicy({ permission: 'full' });
  engine.setProjectChatPermission(chat.id, { permission: 'read' });
  const lowered = engine.projectChatMessage(chat.id, { text: '再来一次' });
  const loweredInput = store.get('work-control', lowered.id).executorInput;
  assert.equal(loweredInput.permission, 'read');
  assert.equal(loweredInput.write, false, '仅查看时写被关掉');

  // 清空档位后回到跟随全局设置。
  engine.setProjectChatPermission(chat.id, { permission: '' });
  const inherited = engine.projectChatMessage(chat.id, { text: '第三次' });
  assert.equal(store.get('work-control', inherited.id).executorInput.permission, 'full');

  assert.throws(() => engine.setProjectChatPermission(chat.id, { permission: 'root' }), /permission/);
});

test('删除对话里的一条消息会连同执行记录一起清掉', async t => {
  const { engine, store, events } = harness(t);
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
  // 其它窗口（含手机端）靠这条事件立刻丢掉卡片，否则右侧「执行详情」要等下次轮询才消失。
  assert.ok(events.some(event => event.type === 'delete' && event.ticketId === ticket.id), '删除后要推一条 delete 事件');
  assert.deepEqual(events.find(event => event.type === 'delete').payload.ids, [ticket.id]);
});

test('不属于任何对话的工单不能从对话页删除', async t => {
  const { engine } = harness(t);
  const ticket = engine.command({ text: '只回复两个字母：OK', executorId: 'model' });
  assert.throws(() => engine.deleteTicket(ticket.id), /只有项目对话里的消息可以删除/);
});

test('删除工作文件夹或对话时，名下的工单一起清掉，不留幽灵待确认', async t => {
  const { engine, store } = harness(t);
  const projectDir = join(tmpdir(), `dataagent-cascade-${Date.now()}`);
  mkdirSync(projectDir, { recursive: true });
  t.after(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = engine.importProject({ path: projectDir }).project;
  const { chat } = engine.createProjectChat(project.id, { executorId: 'model' });
  const keepChat = engine.createProjectChat(project.id, { executorId: 'model' }).chat;
  const ticket = engine.projectChatMessage(chat.id, { text: '看一下目录结构' });
  const kept = engine.projectChatMessage(keepChat.id, { text: '再来一次' });

  // 先删单个对话：只该清掉它自己的工单。
  const byChat = engine.deleteProjectChat(chat.id);
  assert.equal(byChat.removed, 1);
  assert.equal(store.get('work-ticket', ticket.id) ?? null, null);
  assert.ok(store.get('work-ticket', kept.id), '别的对话的工单不受影响');

  // 再删整个工作文件夹：剩下的工单也要跟着走。
  const byProject = engine.deleteProject(project.id);
  assert.equal(byProject.removed, 1);
  assert.equal(store.get('work-ticket', kept.id) ?? null, null);
  assert.equal(store.list('work-ticket').filter(row => row.id === kept.id).length, 0);
});

test('派单前的任务书：没有模型时用本地模板给三版', async t => {
  const { engine } = harness(t);
  const result = await engine.suggestPrompts({ goal: '给播放器加一个音量记忆功能', agentIds: ['claude-code'] });
  assert.equal(result.source, 'local', '测试环境没有可用模型，应回退本地模板');
  assert.equal(result.prompts.length, 3);
  assert.deepEqual(result.prompts.map(item => item.id), ['constraints', 'steps', 'acceptance']);
  for (const item of result.prompts) {
    assert.match(item.prompt, /给播放器加一个音量记忆功能/);
    assert.match(item.prompt, /claude-code/);
  }
  await assert.rejects(() => engine.suggestPrompts({ goal: '   ' }), /1–4000/);
});

test('项目记忆按项目隔离，摘要里说明只记关键改动', async t => {
  const { engine, store } = harness(t);
  const root = mkdtempSync(join(tmpdir(), 'dataagent-memory-iso-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(root, 'one'), { recursive: true });
  mkdirSync(join(root, 'two'), { recursive: true });
  const one = engine.importProject({ path: join(root, 'one'), name: 'one' }).project;
  const two = engine.importProject({ path: join(root, 'two'), name: 'two' }).project;

  const entry = (id, projectId, title, kind, files) => store.put('work-project-memory', {
    id,
    projectId,
    title,
    kind,
    summary: '',
    files,
    improvements: [],
    openQuestions: [],
    executorId: 'model',
    source: 'local',
    createdAt: '2026-11-11T01:00:00.000Z',
    updatedAt: '2026-11-11T01:00:00.000Z',
  });
  entry('mem-one-1', one.id, '新建 player.js 与 styles.css', 'change', ['player.js', 'styles.css']);
  entry('mem-two-1', two.id, '另一个项目的改动', 'change', ['other.js']);

  const digestOne = engine.projectMemoryDigest(one.id).digest;
  assert.match(digestOne, /新建 player\.js 与 styles\.css/, '本项目能看到自己的改动');
  assert.match(digestOne, /改动：/, '条目要标出「改动」还是「结论」');
  assert.match(digestOne, /同一项目下的所有对话共享/, '摘要里说明共享范围与收录标准');
  assert.doesNotMatch(digestOne, /另一个项目的改动/, '不同项目不互相污染');

  const digestTwo = engine.projectMemoryDigest(two.id).digest;
  assert.match(digestTwo, /另一个项目的改动/);
  assert.doesNotMatch(digestTwo, /player\.js/, '另一个项目看不到本项目文件');
});

test('协作时把项目关键改动同步给外部 Agent', async t => {
  const { engine, store } = harness(t);
  const projectDir = mkdtempSync(join(tmpdir(), 'dataagent-memory-share-'));
  t.after(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = engine.importProject({ path: projectDir }).project;
  store.put('work-project-memory', {
    id: 'mem-share-1',
    projectId: project.id,
    title: '约定用 localStorage 存音量',
    kind: 'note',
    summary: '播放器的音量不走后端，只存本地。',
    files: [],
    improvements: [],
    openQuestions: [],
    executorId: 'model',
    source: 'local',
    createdAt: '2026-11-11T01:00:00.000Z',
    updatedAt: '2026-11-11T01:00:00.000Z',
  });

  const result = await engine.collaborate({
    goal: '给播放器加音量记忆',
    projectId: project.id,
    agentIds: ['claude-code'],
  });
  const claudeStep = result.plan.steps.find(step => step.executorId === 'claude-code');
  const prompt = store.get('work-control', claudeStep.ticketId).executorInput.prompt;
  assert.match(prompt, /整个任务：给播放器加音量记忆/, '外部 Agent 拿到完整任务书');
  assert.match(prompt, /项目关键改动/, '项目记忆要同步给协作 Agent');
  assert.match(prompt, /localStorage/, '记忆里的结论要真的带过去');
  assert.match(prompt, /你改了哪些文件/, '要求给出交付证据');
});
