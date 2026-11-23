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
  const root = mkdtempSync(join(tmpdir(), 'lagent-collaborate-'));
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
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
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
  const verifySteps = middle.filter(step => step.role === 'verify');
  assert.equal(verifySteps.length, 2, '两位协作 Agent 互相验收');
  assert.deepEqual(steps.at(-1).dependsOn, verifySteps.map(step => step.index), '收拢步骤要等交叉验收完成');

  const tickets = store.list('work-ticket').filter(ticket => ticket.planId === result.plan.id);
  assert.equal(tickets.length, steps.length, '每一步一张工单');

  const claudeStep = middle.find(step => step.executorId === 'claude-code');
  if (claudeStep) {
    const control = store.get('work-control', claudeStep.ticketId);
    assert.equal(control.executorInput.model, 'claude-sonnet-4-6', '指定的模型要传给该 CLI');
  }
  const modelControl = store.get('work-control', steps[0].ticketId);
  assert.match(modelControl.executorInput.prompt, /不要修改或创建任何文件/);
});

test('团队协作：项目里的只读目标不建交付清单，也不要求协作方落盘', async t => {
  const { engine, store } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo-readonly' }).project;
  const result = await engine.collaborate({
    goal: '只读统计 src 下的 .tsx 文件，不要修改任何文件，不要运行构建',
    projectId: project.id,
    agentIds: ['claude-code', 'codex']
  });
  const steps = result.plan.steps;
  const coordination = store.get('work-control', steps[0].ticketId).executorInput;
  assert.match(coordination.prompt, /原始目标要求只读/);
  assert.doesNotMatch(coordination.prompt, /把清单写到项目根目录/);
  assert.equal(coordination.role, 'coordination');
  const workStep = steps.find(step => step.executorId !== 'model' && step.role !== 'verify');
  const work = store.get('work-control', workStep.ticketId).executorInput;
  assert.match(work.prompt, /原始目标要求只读/);
  assert.doesNotMatch(work.prompt, /清单里的每个文件都要真实落盘/);
  const synthesis = store.get('work-control', steps.at(-1).ticketId).executorInput;
  assert.equal(synthesis.role, 'synthesis');
  assert.match(synthesis.prompt, /不要因为“没有生成脚本\/报告文件”判失败/);
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

test('团队协作：项目里只出现一条 Lagent 对话，各 Agent 作为同一会话里的 run 执行', async t => {
  const { engine, store } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo' }).project;
  const result = await engine.collaborate({
    goal: '给播放器补一个音量记忆功能',
    projectId: project.id,
    agentIds: ['claude-code', 'codex']
  });
  const chats = engine.getProject(project.id).chats;
  assert.equal(chats.length, 1, '项目页只显示一条对话');
  assert.equal(chats[0].executorId, 'model', '这条对话的宿主是 Lagent');
  assert.equal(chats[0].title, '给播放器补一个音量记忆功能', '对话标题用协作目标');
  assert.ok(result.mainChatId === chats[0].id, '返回值告诉前端对话是哪条');
  // 外部 Agent 的执行上下文被标成隐藏，只用于执行与续接，不再各自变成一条对话。
  const hidden = store.list('work-project-chat').filter(chat => chat.projectId === project.id && chat.hidden === true);
  for (const chat of hidden) {
    assert.equal(chat.parentChatId, chats[0].id, '隐藏的执行上下文挂在 Lagent 对话下');
    assert.notEqual(chat.executorId, 'model');
  }
  // 所有步骤工单都归到同一个会话的同一轮里。
  assert.ok(result.conversationId, '协作返回会话 id');
  const conversation = engine.getConversation(result.conversationId).conversation;
  assert.equal(conversation.host, 'lagent');
  assert.equal(conversation.turns.length, 1, '一次协作只产生一轮');
  const conversationTickets = conversation.ticketIds;
  assert.ok(conversationTickets.length >= 2, '协调者与执行者的工单都在会话里');
  for (const step of result.steps) {
    assert.ok(conversationTickets.includes(step.ticketId), '每个步骤工单都归入会话');
  }
});

test('会话派活：一条对话里多个 Agent 各一条 run，追问追加同一轮列表', async t => {
  const { engine } = harness(t);
  const { conversation } = engine.createConversation({ goal: '审查鉴权逻辑', title: '审查鉴权逻辑', agentIds: ['claude-code'] });
  const first = await engine.conversationMessage(conversation.id, {
    text: '检查会话固定与权限判断是否有漏洞',
    mode: 'review',
    agentIds: ['claude-code', 'codex'],
    autoRun: false
  });
  // 强制主控：Lagent 分工 + 两个协作 Agent + Lagent 汇总，共 4 张工单。
  assert.equal(first.tickets.length, 4, 'Lagent 分工、协作执行与汇总都派了活');
  const loaded = engine.getConversation(conversation.id).conversation;
  assert.equal(loaded.host, 'lagent');
  assert.equal(loaded.turns.length, 1);
  assert.equal(loaded.turns[0].mode, 'review');
  assert.equal(loaded.turns[0].runs.length, 4);
  assert.deepEqual([...loaded.participants].sort(), ['claude-code', 'codex', 'model']);
  assert.equal(loaded.turns[0].runs[0].role, 'coordination');
  assert.equal(loaded.turns[0].runs.at(-1).role, 'synthesis');
  for (const ticket of first.tickets) {
    assert.equal(ticket.conversationId, conversation.id);
    assert.equal(ticket.turnId, loaded.turns[0].id);
  }

  // 汇总也由 Lagent 做，旧前端传别的 Agent 会被忽略。
  const synthesis = engine.conversationSynthesize(conversation.id, loaded.turns[0].id, { agentId: 'codex' });
  assert.equal(synthesis.ticket.role, 'synthesis');
  assert.equal(synthesis.ticket.agentId, 'model', '汇总工单的执行者固定为 Lagent，忽略调用方传入的 agentId');
  assert.equal(synthesis.ticket.conversationId, conversation.id);
  const synthesised = engine.getConversation(conversation.id).conversation;
  assert.equal(synthesised.turns[0].synthesisTicketId, synthesis.ticket.id);
  assert.equal(synthesised.turns[0].synthesisAgentId, 'model');
  assert.ok(synthesised.ticketIds.includes(synthesis.ticket.id));

  // 追问还在同一个会话里，不另开对话。
  const second = await engine.conversationMessage(conversation.id, {
    text: '再补一个修复建议',
    mode: 'auto',
    agentIds: ['codex'],
    autoRun: false
  });
  assert.equal(second.tickets.length, 3, '一次协作仍是 Lagent 分工 + 协作 + 汇总');
  const after = engine.getConversation(conversation.id).conversation;
  assert.equal(after.turns.length, 2);
  assert.equal(after.turns[1].runs.length, 3);
  const summaries = engine.bootstrap().conversations;
  assert.ok(summaries.some(item => item.id === conversation.id), '会话出现在指挥台列表里');
  assert.equal(summaries.find(item => item.id === conversation.id).turnCount, 2);
});

test('项目里同一任务的多条 Agent 对话合并成一条 Lagent 会话', async t => {
  const { engine, store } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo' }).project;
  const first = engine.createProjectChat(project.id, { executorId: 'claude-code', title: '做导出按钮' }).chat;
  const second = engine.createProjectChat(project.id, { executorId: 'codex', title: '做导出按钮' }).chat;
  const stamp = first.createdAt;
  store.put('work-project-chat', { ...store.get('work-project-chat', second.id), createdAt: stamp, updatedAt: stamp });
  for (const [chat, executor] of [[first, 'claude-code'], [second, 'codex']]) {
    const ticketId = `t-${executor}`;
    store.put('work-ticket', {
      id: ticketId, title: '做导出按钮', status: 'completed', executor,
      createdAt: stamp, updatedAt: stamp, projectChatId: chat.id
    });
    store.put('work-project-chat', { ...store.get('work-project-chat', chat.id), lastTicketId: ticketId, updatedAt: stamp });
  }
  engine.recover();
  const chats = engine.getProject(project.id).chats;
  assert.equal(chats.length, 1, '项目页只保留一条可见对话');
  assert.ok(chats[0].conversationId, '可见对话指向 Lagent 会话');
  const conversation = engine.getConversation(chats[0].conversationId).conversation;
  assert.equal(conversation.turns.length, 1, '同一任务只保留一轮');
  assert.deepEqual(conversation.ticketIds.sort(), ['t-claude-code', 't-codex']);
  assert.deepEqual(conversation.participants.sort(), ['claude-code', 'codex', 'model']);
  const rows = store.list('work-project-chat').filter(chat => chat.projectId === project.id);
  assert.equal(rows.filter(chat => chat.hidden === true).length, 1, '其余 Agent 对话标成隐藏');
  // 再跑一次保持原样。
  engine.recover();
  assert.equal(engine.getProject(project.id).chats.length, 1);
  assert.equal(engine.getConversation(chats[0].conversationId).conversation.turns.length, 1);
});

test('同一 Agent 多轮工单不会把别的 Agent 挤出会话', async t => {
  const { engine, store } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo' }).project;
  const chat = engine.createProjectChat(project.id, { executorId: 'claude-code', title: '做导出按钮' }).chat;
  const stamp = chat.createdAt;
  // 一个任务跑了 8 轮 claude-code，另有 codex、claude-acp 各跑了一轮。
  const rows = [];
  for (let index = 0; index < 8; index += 1) rows.push(['claude-code', `t-cc-${index}`]);
  rows.push(['codex', 't-codex'], ['claude-acp', 't-acp']);
  for (const [executor, ticketId] of rows) {
    store.put('work-ticket', {
      id: ticketId, title: '做导出按钮', status: 'completed', executor,
      createdAt: stamp, updatedAt: stamp, projectChatId: chat.id
    });
  }
  engine.recover();
  const conversation = engine.getConversation(engine.getProject(project.id).chats[0].conversationId).conversation;
  const agents = conversation.turns[0].runs.map(run => run.agentId).sort();
  assert.deepEqual(agents, ['claude-acp', 'claude-code', 'codex'], '每个 Agent 各保留一张最新工单');
  assert.equal(conversation.turns[0].runs.length, 3);
});

test('已迁移会话里的残缺轮次会被修复成每个 Agent 一条', async t => {
  const { engine, store } = harness(t);
  const stamp = '2026-11-15T04:14:26.000Z';
  const conversationId = 'conv-project-broken';
  const turnId = 'turn-project-broken';
  const runs = [];
  for (let index = 0; index < 8; index += 1) {
    const ticketId = `t-broken-cc-${index}`;
    runs.push({ ticketId, agentId: 'claude-code', role: 'answer' });
    store.put('work-ticket', {
      id: ticketId, title: '数据可视化', status: 'completed', executor: 'claude-code',
      createdAt: stamp, updatedAt: stamp, conversationId, turnId, agentId: 'claude-code', role: 'answer'
    });
  }
  for (const [executor, ticketId] of [['codex', 't-broken-codex'], ['claude-acp', 't-broken-acp']]) {
    store.put('work-ticket', {
      id: ticketId, title: '数据可视化', status: 'completed', executor,
      createdAt: stamp, updatedAt: stamp, conversationId, turnId, agentId: executor, role: 'answer'
    });
  }
  store.put('work-conversation', {
    id: conversationId, title: '数据可视化', goal: '数据可视化', host: 'lagent',
    participants: ['claude-code'],
    turns: [{ id: turnId, index: 0, prompt: '数据可视化', mode: 'review', agentIds: ['claude-code'], runs, createdAt: stamp }],
    createdAt: stamp, updatedAt: stamp
  });
  engine.recover();
  const conversation = engine.getConversation(conversationId).conversation;
  const agents = conversation.turns[0].runs.map(run => run.agentId).sort();
  assert.deepEqual(agents, ['claude-acp', 'claude-code', 'codex'], '被挤掉的 Agent 补回同一轮');
  assert.equal(conversation.turns[0].runs.length, 3, '每个 Agent 只留一条');
  assert.deepEqual(conversation.participants.sort(), ['claude-acp', 'claude-code', 'codex']);
});

test('同一任务先后两轮派活，已建好的两条会话会并成一条并保留两轮', async t => {
  const { engine, store } = harness(t);
  const project = engine.importProject({ path: process.cwd(), name: 'demo' }).project;
  const first = engine.createProjectChat(project.id, { executorId: 'claude-code', title: '项目实现 · v2' }).chat;
  const second = engine.createProjectChat(project.id, { executorId: 'codex', title: '项目实现 · v2' }).chat;
  const base = Date.parse('2026-11-16T13:30:03.000Z');
  const later = new Date(base + 150000).toISOString();
  store.put('work-project-chat', { ...store.get('work-project-chat', first.id), createdAt: new Date(base).toISOString(), updatedAt: new Date(base).toISOString() });
  store.put('work-project-chat', { ...store.get('work-project-chat', second.id), createdAt: later, updatedAt: later });
  const seed = (chat, stamp, tag) => {
    const conversationId = `conv-project-${chat.id}`;
    const turnId = `turn-project-${chat.id}`;
    const runs = [];
    for (const executor of ['claude-code', 'codex', 'claude-acp']) {
      const ticketId = `t-${tag}-${executor}`;
      runs.push({ ticketId, agentId: executor, role: 'answer' });
      store.put('work-ticket', {
        id: ticketId, title: '项目实现 · v2', status: 'completed', executor,
        createdAt: stamp, updatedAt: stamp, projectChatId: chat.id,
        conversationId, turnId, agentId: executor, role: 'answer'
      });
    }
    store.put('work-conversation', {
      id: conversationId, title: '项目实现 · v2', goal: '项目实现 · v2', host: 'lagent', projectId: project.id,
      participants: ['claude-code', 'codex', 'claude-acp'],
      turns: [{ id: turnId, index: 0, prompt: '项目实现 · v2', mode: 'review', agentIds: ['claude-code', 'codex', 'claude-acp'], runs, createdAt: stamp }],
      createdAt: stamp, updatedAt: stamp
    });
    store.put('work-project-chat', { ...store.get('work-project-chat', chat.id), conversationId, updatedAt: stamp });
  };
  seed(first, new Date(base).toISOString(), 'round1');
  seed(second, later, 'round2');
  engine.recover();
  const chats = engine.getProject(project.id).chats;
  assert.equal(chats.length, 1, '同一任务只留一条可见对话');
  const conversation = engine.getConversation(chats[0].conversationId).conversation;
  assert.equal(conversation.turns.length, 2, '两轮都保留，不是只留最新一轮');
  const turnTickets = conversation.turns.map(turn => turn.runs.map(run => run.ticketId).sort());
  assert.deepEqual(turnTickets[0], ['t-round1-claude-acp', 't-round1-claude-code', 't-round1-codex']);
  assert.deepEqual(turnTickets[1], ['t-round2-claude-acp', 't-round2-claude-code', 't-round2-codex']);
  const rows = store.list('work-conversation').filter(row => row.id.includes(first.id) || row.id.includes(second.id));
  assert.equal(rows.length, 1, '被合并的旧会话已删除');
});

test('历史迁移把同一任务的多个单工单会话并回一条', async t => {
  const { engine, store } = harness(t);
  const base = Date.parse('2026-11-15T04:14:26.000Z');
  const rows = [['t-a', 'claude-acp'], ['t-b', 'claude-code'], ['t-c', 'dsh']];
  rows.forEach(([id, executor], index) => {
    const stamp = new Date(base + index * 40).toISOString();
    store.put('work-ticket', {
      id, title: '只回复 OK', status: 'completed', executor, createdAt: stamp, updatedAt: stamp,
      conversationId: `conv-ticket-${id}`, turnId: `turn-ticket-${id}`, agentId: executor, role: 'answer'
    });
    store.put('work-conversation', {
      id: `conv-ticket-${id}`, title: '只回复 OK', goal: '只回复 OK', host: 'lagent', participants: [executor],
      turns: [{ id: `turn-ticket-${id}`, index: 0, prompt: '只回复 OK', mode: 'auto', agentIds: [executor], runs: [{ ticketId: id, agentId: executor, role: 'answer' }], createdAt: stamp }],
      createdAt: stamp, updatedAt: stamp
    });
  });
  engine.recover();
  const list = store.list('work-conversation');
  const grouped = list.find(row => row.id.startsWith('conv-group-'));
  assert.ok(grouped, '同题多 Agent 的占位会话被合成一条');
  assert.deepEqual(grouped.turns[0].runs.map(run => run.ticketId).sort(), ['t-a', 't-b', 't-c']);
  assert.equal(list.filter(row => row.id.startsWith('conv-ticket-')).length, 0, '占位会话已清理');
  for (const id of ['t-a', 't-b', 't-c']) assert.equal(store.get('work-ticket', id).conversationId, grouped.id);
  // 再跑一次不会重复合并。
  engine.recover();
  assert.equal(store.list('work-conversation').filter(row => row.id.startsWith('conv-group-')).length, 1);
});

test('对话消息可指定模型与思考强度，并落进执行器输入', async t => {
  const { engine, store } = harness(t);
  const projectDir = join(tmpdir(), `lagent-chat-model-${Date.now()}`);
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
  const projectDir = join(tmpdir(), `lagent-chat-perm-${Date.now()}`);
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
  const projectDir = join(tmpdir(), `lagent-chat-delete-${Date.now()}`);
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
  const projectDir = join(tmpdir(), `lagent-cascade-${Date.now()}`);
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
  const root = mkdtempSync(join(tmpdir(), 'lagent-memory-iso-'));
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
  const projectDir = mkdtempSync(join(tmpdir(), 'lagent-memory-share-'));
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
