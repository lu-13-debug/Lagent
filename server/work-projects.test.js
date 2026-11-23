import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { projectService } from './work/projects.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';
import { codexExecutor } from './work/executors/codex.js';
import { modelExecutor } from './work/executors/model.js';
import { windowExecutor } from './work/executors/window.js';

async function waitFor(predicate, message = '等待条件超时', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}

function fakeCliChild(stdout) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    queueMicrotask(() => child.emit('close', null, signal || 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0, null);
  });
  return child;
}

const jsonl = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

function makeHome(root) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return home;
}

function makeProject(root) {
  const projectDir = join(root, 'demo-project');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/feature-mobile\n');
  writeFileSync(join(projectDir, 'README.md'), '# demo\n');
  return projectDir;
}

function writeClaudeSession(home, projectDir, sessionId, title) {
  const encoded = projectDir.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(home, '.claude', 'projects', encoded);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl([
    { type: 'user', sessionId, cwd: projectDir, message: { content: title } },
    { type: 'assistant', sessionId, cwd: projectDir, message: { content: [{ type: 'text', text: '好的' }] } }
  ]));
}

test('P1 项目文件夹导入校验路径、去重并读取 Git 分支', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const service = projectService(store, { home: makeHome(root) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  assert.throws(() => service.importProject({ path: 'relative/dir' }), { status: 400 });
  assert.throws(() => service.importProject({ path: join(root, 'missing') }), { status: 400 });
  assert.throws(() => service.importProject({ path: 'C:\\' }), { status: 400 });

  const first = service.importProject({ path: projectDir });
  assert.equal(first.created, true);
  assert.equal(first.project.gitBranch, 'feature-mobile');
  assert.equal(first.project.name, 'demo-project');
  assert.equal(resolve(first.project.path), resolve(projectDir));

  const again = service.importProject({ path: `${projectDir}\\` });
  assert.equal(again.created, false);
  assert.equal(again.project.id, first.project.id);
  assert.equal(service.listProjects().length, 1);
  assert.equal(service.getProject(first.project.id).chatCount, 0);

  assert.throws(() => service.getProject('missing'), { status: 404 });
  service.deleteProject(first.project.id);
  assert.equal(service.listProjects().length, 0);
});

test('P1 扫描并导入 Claude Code 项目会话，拒绝其它目录会话', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  writeClaudeSession(home, projectDir, 'sess-demo', '修复首页布局');
  const otherDir = join(root, 'other-project');
  mkdirSync(otherDir, { recursive: true });
  writeClaudeSession(home, otherDir, 'sess-other', '无关会话');
  const codexDir = join(home, '.codex', 'sessions', '2026', '11', '08');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'rollout-2026-11-08-demo.jsonl'), jsonl([
    { type: 'session_meta', payload: { cwd: projectDir, session_id: 'codex-demo' } },
    { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: '补一个项目导入入口' }] } }
  ]));
  const service = projectService(store, { home });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const { project } = service.importProject({ path: projectDir });
  const sessions = service.scanSessions(project.id, 'claude-code');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, 'sess-demo');
  assert.equal(sessions[0].title, '修复首页布局');
  assert.equal(sessions[0].imported, false);
  const codexSessions = service.scanSessions(project.id, 'codex');
  assert.equal(codexSessions.length, 1);
  assert.equal(codexSessions[0].sessionId, 'codex-demo');
  assert.equal(codexSessions[0].title, '补一个项目导入入口');
  assert.equal(codexSessions[0].imported, false);
  assert.equal(service.scanSessions(project.id).length, 2);

  const imported = service.importSession(project.id, { executorId: 'claude-code', sessionId: 'sess-demo' });
  assert.equal(imported.created, true);
  assert.equal(imported.chat.executorId, 'claude-code');
  assert.equal(imported.chat.sessionId, 'sess-demo');
  assert.equal(imported.chat.source, 'imported');
  assert.equal(service.scanSessions(project.id, 'claude-code')[0].imported, true);

  const duplicate = service.importSession(project.id, { executorId: 'claude-code', sessionId: 'sess-demo' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.chat.id, imported.chat.id);
  assert.throws(() => service.importSession(project.id, { executorId: 'claude-code', sessionId: 'sess-other' }), { status: 404 });
  assert.throws(() => service.importSession(project.id, { executorId: 'terminal', sessionId: 'sess-demo' }), { status: 400 });
  assert.throws(() => service.createChat(project.id, { executorId: 'terminal' }), { status: 400 });
  assert.throws(() => service.createChat(project.id, { executorId: 'window' }), { status: 400 });
  const importedCodex = service.importSession(project.id, { executorId: 'codex', sessionId: 'codex-demo' });
  assert.equal(importedCodex.chat.executorId, 'codex');
  assert.equal(service.listChats(project.id).length, 2);
  service.deleteChat(importedCodex.chat.id);
  service.deleteChat(imported.chat.id);
  assert.equal(service.listChats(project.id).length, 0);
});

test('P1 目录浏览只返回文件夹并拒绝文件路径', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  mkdirSync(join(projectDir, 'src'));
  const service = projectService(store, { home: makeHome(root) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const listing = service.listDirectory({ path: projectDir });
  assert.equal(listing.path, resolve(projectDir).replaceAll('\\', '/'));
  assert.deepEqual(listing.entries.map(item => item.name), ['.git', 'src']);
  assert.ok(listing.entries.every(item => item.isDir));
  assert.ok(listing.parent);
  assert.equal(listing.truncated, false);

  assert.throws(() => service.listDirectory({ path: join(projectDir, 'README.md') }), { status: 400 });
  assert.throws(() => service.listDirectory({ path: join(root, 'missing') }), { status: 400 });
  assert.throws(() => service.listDirectory({ path: 'x'.repeat(401) }), { status: 400 });

  const roots = service.listDirectory({});
  assert.equal(roots.path, '');
  assert.equal(roots.parent, null);
  assert.ok(roots.entries.length >= 1);
  if (process.platform === 'win32') assert.ok(roots.entries.some(item => /^[A-Z]:\/$/.test(item.path)));
});

test('P1 CLI 因回合上限失败后仍保存 sessionId，下一条消息可续接', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  const spawned = [];
  const claude = claudeCodeExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args) => {
      spawned.push(args);
      return fakeCliChild(jsonl([
        { type: 'system', session_id: 'cli-failed-session' },
        { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'cli-failed-session', result: 'Claude Code error_max_turns' }
      ]));
    }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([claude]), () => {}, {
    policy: { allowedExecutors: ['claude-code'], requireApproval: false },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const imported = engine.importProject({ path: projectDir });
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'claude-code' });

  const ticket = engine.projectChatMessage(chat.id, { text: '从零完成一个大型项目' });
  await waitFor(() => spawned.length === 1, '首条消息未启动');
  const turnsIndex = spawned[0].indexOf('--max-turns');
  assert.ok(turnsIndex >= 0, '应带上回合上限参数');
  // Claude Code 自己的默认是 60 回合；引擎不能再用统一的 30 把它压低。
  assert.equal(spawned[0][turnsIndex + 1], '60', '未显式指定时使用该 CLI 的默认回合数，而不是被引擎写死的较低值');
  await waitFor(() => engine.detail(ticket.id).ticket.status === 'failed', '工单应因回合上限失败');
  assert.equal(engine.getProject(imported.project.id).chats[0].sessionId, 'cli-failed-session');

  const second = engine.projectChatMessage(chat.id, { text: '继续，把剩下的做完' });
  await waitFor(() => spawned.length === 2, '续接消息未启动');
  const resumeIndex = spawned[1].indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(spawned[1][resumeIndex + 1], 'cli-failed-session');
  // 第一次失败后应把同执行器的教训前置到第二次任务里。
  assert.match(spawned[1].join('\n'), /失败教训/);
  await waitFor(() => engine.detail(second.id).ticket.status === 'failed', '第二条消息应结束');
  const remembered = engine.projectMemoryDigest(imported.project.id);
  const reflection = remembered.entries.find(entry => entry.kind === 'reflection');
  assert.ok(reflection, '失败后应留下反思条目');
  assert.equal(reflection.executorId, 'claude-code');
  assert.ok(reflection.occurrences >= 2);
  assert.match(reflection.lesson, /拆小|回合/);
});

test('P1 项目对话消息经审批后在工作目录续接会话并回写 sessionId', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  const spawned = [];
  const outputs = [
    jsonl([
      { type: 'system', session_id: 'cli-session-1' },
      { type: 'assistant', session_id: 'cli-session-1', message: { content: [{ type: 'text', text: '已读取项目' }] } },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'cli-session-1', result: '第一步完成' }
    ]),
    jsonl([
      { type: 'system', session_id: 'cli-session-1' },
      { type: 'result', subtype: 'success', is_error: false, session_id: 'cli-session-1', result: '第二步完成' }
    ])
  ];
  let call = 0;
  const claude = claudeCodeExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      spawned.push({ args, options });
      const output = outputs[Math.min(call, outputs.length - 1)];
      call += 1;
      return fakeCliChild(output);
    }
  });
  let plannerInput = null;
  const engine = createWorkEngine(store, createExecutorRegistry([claude]), () => {}, {
    policy: { allowedExecutors: ['claude-code'], requireApproval: true },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home,
    planner: async input => {
      plannerInput = input;
      return { steps: [{ executorId: 'claude-code', text: '检查主题实现' }, { executorId: 'claude-code', text: '实现夜间开关' }] };
    }
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  assert.equal(imported.created, true);
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'claude-code' });
  assert.equal(chat.writable, true);
  assert.equal(engine.getProject(imported.project.id).chats.length, 1);

  const ticket = engine.projectChatMessage(chat.id, { text: '给首页加一个夜间开关' });
  assert.equal(ticket.projectChatId, chat.id);
  assert.equal(ticket.executor, 'claude-code');
  assert.equal(ticket.status, 'awaiting_review');
  assert.equal(spawned.length, 0);
  assert.equal(engine.getProject(imported.project.id).chats[0].lastTicketId, ticket.id);

  assert.throws(() => engine.projectChatMessage(chat.id, { text: '   ' }), { status: 400 });

  engine.action(ticket.id, 'approve');
  await waitFor(() => engine.detail(ticket.id).ticket.status === 'completed', '项目消息未完成');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.cwd, resolve(projectDir));
  assert.match(spawned[0].args.join('\n'), /项目修改模式/);
  assert.match(spawned[0].args.join('\n'), /项目上下文/);
  assert.ok(spawned[0].args.includes('acceptEdits'));
  assert.ok(!spawned[0].args.includes('--resume'));
  assert.equal(engine.getProject(imported.project.id).chats[0].sessionId, 'cli-session-1');
  assert.equal(engine.getProject(imported.project.id).chats[0].lastSummary, '第一步完成');
  const report = engine.detail(ticket.id).reports.find(item => item.kind === 'ready');
  assert.equal(report.artifacts.cli.summary, '第一步完成');
  assert.equal(report.artifacts.cli.sessionId, 'cli-session-1');

  const second = engine.projectChatMessage(chat.id, { text: '再补一条说明' });
  assert.equal(second.projectChatId, chat.id);
  engine.action(second.id, 'approve');
  await waitFor(() => engine.detail(second.id).ticket.status === 'completed', '第二个项目消息未完成');
  assert.equal(spawned.length, 2);
  const resumeIndex = spawned[1].args.indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(spawned[1].args[resumeIndex + 1], 'cli-session-1');
  assert.deepEqual(engine.projectChatTickets(chat.id).map(item => item.id), [ticket.id, second.id]);
  assert.throws(() => engine.projectChatTickets('missing-chat'), { status: 404 });

  const suggestion = await engine.suggestPlan({ goal: '给首页加夜间开关', projectChatId: chat.id });
  assert.deepEqual(suggestion.steps.map(step => step.executorId), ['claude-code', 'claude-code']);
  assert.equal(plannerInput.project.path, imported.project.path);
  assert.deepEqual(plannerInput.executors, ['claude-code']);
  assert.equal(plannerInput.executors.includes('analysis'), false);

  const memoryAfterRun = engine.projectMemoryDigest(imported.project.id);
  assert.equal(memoryAfterRun.entries.length, 2);
  assert.match(memoryAfterRun.digest, /项目记忆（最近 2 条 \/ 共 2 条）/);
  assert.equal(memoryAfterRun.entries[0].executorId, 'claude-code');
  const changes = engine.projectChanges(imported.project.id);
  assert.equal(changes.length, 2);
  const recorded = changes.find(change => change.ticketId === ticket.id);
  assert.equal(recorded.summary, '第一步完成');
  assert.equal(recorded.sessionId, 'cli-session-1');
  assert.equal(recorded.status, 'completed');
  assert.equal(recorded.projectChatId, chat.id);
  const brief = engine.saveProjectBrief(imported.project.id, { goal: '给首页加夜间开关', keyPoints: ['保持主题一致'] });
  assert.equal(brief.goal, '给首页加夜间开关');
  const briefDoc = engine.projectBriefMarkdown(imported.project.id);
  assert.match(briefDoc.markdown, /# 项目简报：demo-project/);
  assert.match(briefDoc.markdown, /保持主题一致/);
  assert.match(briefDoc.markdown, /第一步完成/);

  const plan = engine.plan({
    goal: '给首页加夜间开关',
    projectChatId: chat.id,
    steps: [
      { executorId: 'claude-code', text: '检查现有主题实现' },
      { executorId: 'claude-code', text: '实现开关并更新样式', dependsOn: [0] }
    ]
  });
  assert.equal(plan.projectChatId, chat.id);
  assert.deepEqual(plan.steps.map(step => step.executorId), ['claude-code', 'claude-code']);
  const planStepTicket = engine.detail(plan.steps[0].ticketId).ticket;
  assert.equal(planStepTicket.projectChatId, chat.id);
  assert.equal(engine.getPlan(plan.id).projectChatId, chat.id);

  assert.throws(() => engine.plan({
    goal: '错误绑定',
    projectChatId: chat.id,
    steps: [
      { executorId: 'window', text: '第一步' },
      { executorId: 'window', text: '第二步' }
    ]
  }), { status: 400 });

  const dispatched = engine.projectDispatch(imported.project.id, { text: '同时检查依赖与样式', executorIds: ['claude-code'] });
  assert.equal(dispatched.tickets.length, 1);
  // 分派变成一条 Lagent 会话，Agent 的执行上下文是隐藏对话，不再复用/新增可见对话。
  assert.ok(dispatched.conversationId, '分派返回会话 id');
  assert.equal(dispatched.tickets[0].conversationId, dispatched.conversationId);
  assert.notEqual(dispatched.tickets[0].projectChatId, chat.id, '不复用已有可见对话');
  assert.equal(dispatched.project.chats.length, 1, '项目页仍然只有一条可见对话');
  assert.throws(() => engine.projectDispatch(imported.project.id, { text: '空目标', executorIds: [] }), { status: 400 });
  assert.throws(() => engine.projectDispatch(imported.project.id, { text: '窗口分派', executorIds: ['window'] }), { status: 400, message: /请先选择要接管的窗口/ });

  assert.throws(() => engine.command({
    text: '普通任务试图指定目录',
    executorId: 'claude-code',
    executorInput: { prompt: 'x', maxTurns: 1, workspace: projectDir }
  }), { status: 400 });

  const freshChat = engine.createProjectChat(imported.project.id, { executorId: 'claude-code' }).chat;
  const freshTicket = engine.projectChatMessage(freshChat.id, { text: '新开会话继续做导出' });
  engine.action(freshTicket.id, 'approve');
  await waitFor(() => engine.detail(freshTicket.id).ticket.status === 'completed', '新项目会话未完成');
  assert.match(spawned[2].args.join('\n'), /项目记忆/);
  assert.match(spawned[2].args.join('\n'), /只回复两个字母|第一步完成/);

  engine.deleteProjectChat(freshChat.id);
  engine.deleteProjectChat(chat.id);
  assert.equal(engine.getProject(imported.project.id).chats.length, 0);
  engine.deleteProject(imported.project.id);
  assert.equal(engine.listProjects().length, 0);
});

test('P1 项目简报与变更档案可存储、导出 Markdown 并随项目删除', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const service = projectService(store, { home: makeHome(root) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const { project } = service.importProject({ path: projectDir });
  const empty = service.getBrief(project.id);
  assert.equal(empty.goal, '');
  assert.deepEqual(empty.keyPoints, []);
  const brief = service.saveBrief(project.id, { goal: '做夜间模式', summary: '主题变量已就绪', keyPoints: ['保持浅色主题'], decisions: ['只隐藏入口'], constraints: ['不覆盖草稿'] });
  assert.ok(brief.updatedAt);
  assert.deepEqual(service.getBrief(project.id).keyPoints, ['保持浅色主题']);
  assert.throws(() => service.getBrief('missing'), { status: 404 });

  assert.throws(() => service.recordChange(project.id, {}), { status: 400 });
  const manual = service.recordChange(project.id, { title: '实现开关', summary: '新增主题开关', files: ['src/theme.ts'], executorId: 'codex' });
  assert.equal(manual.source, 'manual');
  assert.deepEqual(manual.files, ['src/theme.ts']);
  const auto = service.recordChange(project.id, { ticketId: 'ticket-1', title: '自动记录', summary: '自动摘要', status: 'completed' }, { source: 'auto' });
  assert.equal(auto.id, 'ticket-1');
  const repeat = service.recordChange(project.id, { ticketId: 'ticket-1', summary: '更新摘要' }, { source: 'auto' });
  assert.equal(repeat.id, 'ticket-1');
  assert.equal(repeat.createdAt, auto.createdAt);
  assert.equal(service.listChanges(project.id).length, 2);

  const doc = service.briefMarkdown(project.id);
  assert.match(doc.markdown, /# 项目简报：demo-project/);
  assert.match(doc.markdown, /做夜间模式/);
  assert.match(doc.markdown, /实现开关/);
  assert.match(doc.markdown, /更新摘要/);
  assert.equal(doc.changes.length, 2);

  service.deleteChange(project.id, manual.id);
  assert.equal(service.listChanges(project.id).length, 1);
  assert.throws(() => service.deleteChange('missing', auto.id), { status: 404 });
  assert.throws(() => service.deleteChange(project.id, 'missing'), { status: 404 });

  service.deleteProject(project.id);
  assert.equal(store.list('project-change').filter(row => row.projectId === project.id).length, 0);
  assert.equal(store.get('project-brief', project.id), null);
});

test('P1 项目计划把步骤分派给不同 Agent 并各自建立项目对话', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  const claudeCalls = [];
  const codexCalls = [];
  const claude = claudeCodeExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      claudeCalls.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'system', session_id: 'claude-session' },
        { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session', result: '检查完成' }
      ]));
    }
  });
  const codex = codexExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      codexCalls.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'thread.started', thread_id: 'codex-thread' },
        { type: 'item.completed', item: { type: 'agent_message', text: '实现完成' } },
        { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }
      ]));
    }
  });
  let plannerInput = null;
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex'], requireApproval: true },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home,
    planner: async input => {
      plannerInput = input;
      return { steps: [{ executorId: 'claude-code', text: '检查现有实现' }, { executorId: 'codex', text: '实现夜间开关' }] };
    }
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'claude-code' });
  const plan = engine.plan({
    goal: '跨 Agent 完成夜间模式',
    projectChatId: chat.id,
    steps: [
      { executorId: 'claude-code', text: '检查现有实现', executorInput: { maxTurns: 50, timeoutMs: 3_600_000 } },
      { executorId: 'codex', text: '实现夜间开关' }
    ]
  });
  assert.equal(plan.projectId, imported.project.id);
  assert.equal(plan.steps[0].projectChatId, chat.id);
  assert.ok(plan.steps[1].projectChatId);
  assert.notEqual(plan.steps[1].projectChatId, chat.id);
  const codexChat = engine.getProject(imported.project.id).chats.find(item => item.executorId === 'codex');
  assert.ok(codexChat);
  assert.equal(plan.steps[1].projectChatId, codexChat.id);

  engine.action(plan.steps[0].ticketId, 'approve');
  engine.action(plan.steps[1].ticketId, 'approve');
  await waitFor(() => engine.detail(plan.steps[0].ticketId).ticket.status === 'completed' && engine.detail(plan.steps[1].ticketId).ticket.status === 'completed', '跨 Agent 计划未完成');
  assert.equal(claudeCalls.length, 1);
  assert.equal(codexCalls.length, 1);
  assert.equal(claudeCalls[0].options.cwd, resolve(projectDir));
  assert.equal(codexCalls[0].options.cwd, resolve(projectDir));
  const claudeTask = store.get('task', engine.detail(plan.steps[0].ticketId).assignments[0].id);
  assert.equal(claudeTask.cliInput.maxTurns, 50);
  assert.equal(claudeTask.cliInput.timeoutMs, 3_600_000);
  assert.equal(engine.getProject(imported.project.id).chats.find(item => item.executorId === 'codex').sessionId, 'codex-thread');

  const changes = engine.projectChanges(imported.project.id);
  assert.equal(changes.length, 2);
  assert.deepEqual(new Set(changes.map(change => change.executorId)), new Set(['claude-code', 'codex']));
  assert.ok(changes.every(change => change.source === 'auto'));
  const codexChange = changes.find(change => change.executorId === 'codex');
  assert.equal(codexChange.summary, '实现完成');
  assert.equal(codexChange.sessionId, 'codex-thread');

  const suggestion = await engine.suggestPlan({ goal: '跨 Agent 完成夜间模式', projectChatId: chat.id, executors: ['claude-code', 'codex'] });
  assert.deepEqual(new Set(suggestion.steps.map(step => step.executorId)), new Set(['claude-code', 'codex']));
  assert.deepEqual(new Set(plannerInput.executors), new Set(['claude-code', 'codex']));
  assert.deepEqual(plannerInput.project.chats.map(item => item.executorId).sort(), ['claude-code', 'codex']);
});

test('P1 窗口 Agent 可与项目内 Agent 并行分派，窗口会话绑定所选句柄', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  const bridge = {
    listWindows: async () => [{ id: '42', handle: 42, pid: 7, process: 'Codex', title: 'Codex 窗口' }],
    readWindow: async () => ({ text: '' }),
    sendToWindow: async (handle, text, options) => ({ ok: true, process: 'Codex', submitted: options.submit })
  };
  const claude = claudeCodeExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: () => fakeCliChild(jsonl([{ type: 'result', subtype: 'success', is_error: false, session_id: 'cli-window', result: '完成' }]))
  });
  const window = windowExecutor({ store, bridge, waitMs: 1, pollMs: 1, maxWaitMs: 1 });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, window]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'window'], requireApproval: true },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home,
    windowBridge: bridge
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const result = engine.projectDispatch(imported.project.id, {
    text: '一起做两件事',
    executorIds: ['claude-code', 'window'],
    window: { handle: 42, process: 'Codex', title: 'Codex 窗口' }
  });
  assert.equal(result.tickets.length, 2);
  assert.deepEqual(new Set(result.tickets.map(ticket => ticket.executor)), new Set(['claude-code', 'window']));
  // 分派只产生一条会话；各 Agent 的执行上下文是隐藏对话，不进项目页。
  assert.equal(engine.getProject(imported.project.id).chats.length, 0, '分派不再各自创建可见对话');
  assert.ok(result.conversationId, '分派返回会话 id');
  const hidden = store.list('work-project-chat').filter(chat => chat.projectId === imported.project.id);
  const windowChat = hidden.find(chat => chat.executorId === 'window');
  assert.equal(windowChat.hidden, true);
  assert.equal(windowChat.conversationId, result.conversationId);
  assert.equal(windowChat.window.handle, 42);
  assert.equal(windowChat.window.process, 'Codex');
  assert.equal(windowChat.window.title, 'Codex 窗口');
  assert.equal(result.tickets.find(ticket => ticket.executor === 'window').projectChatId, windowChat.id);

  // 同一句柄再次分派会进新的会话，仍不会冒出新的可见对话。
  const again = engine.projectDispatch(imported.project.id, { text: '再发一次', executorIds: ['window'], window: { handle: 42 } });
  assert.ok(again.conversationId && again.conversationId !== result.conversationId);
  assert.equal(again.tickets[0].conversationId, again.conversationId);
  assert.equal(engine.getProject(imported.project.id).chats.length, 0, '可见对话数量保持为 0');
  assert.throws(() => engine.projectDispatch(imported.project.id, { text: '缺句柄', executorIds: ['claude-code', 'window'] }), { status: 400, message: /请先选择要接管的窗口/ });
});

test('变更档案在没有 git 的目录里也会记下执行器报告的产出文件', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-changes-'));
  const store = new Store(root);
  // 故意不建 .git：真实用户经常把普通文件夹导进来，git 差集拿不到东西。
  const projectDir = join(root, 'plain-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# plain\n');
  const home = makeHome(root);
  const replies = [
    { choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'note.txt', content: 'hello-memory' }) } }] } }] },
    { choices: [{ message: { content: '{"final":{"summary":"已写入 note.txt","files":["note.txt"],"done":true}}' } }] }
  ];
  let index = 0;
  const model = modelExecutor({
    store,
    cwd: root,
    context: () => ({ settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, key: 'test-key', maxTokens: 800, timeoutMs: 5000 }),
    fetchImpl: async () => {
      const body = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return { ok: true, status: 200, headers: { get: () => null }, async json() { return body; }, async text() { return JSON.stringify(body); } };
    }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([model]), () => {}, {
    policy: { allowedExecutors: ['model'], requireApproval: false, permission: 'workspace' },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'model' });
  const ticket = engine.projectChatMessage(chat.id, { text: '新建 note.txt，内容写 hello-memory。' });
  await waitFor(() => ['completed', 'failed'].includes(engine.detail(ticket.id).ticket.status), '模型工单没有结束', 8000);
  assert.equal(engine.detail(ticket.id).ticket.status, 'completed');

  const changes = engine.projectChanges(imported.project.id);
  const recorded = changes.find(change => change.ticketId === ticket.id);
  assert.ok(recorded, '完成一次执行要留下变更档案');
  assert.deepEqual(recorded.files, ['note.txt'], '没有 git 时也要记下动了哪个文件');
  const lastChange = changes.at(-1);
  assert.deepEqual(lastChange.files, ['note.txt']);
});

test('建会话时可以一次挑好协作 Agent，之后改名单也存得住', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-collab-chat-'));
  const store = new Store(root);
  const projectDir = join(root, 'collab-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# collab\n');
  const home = makeHome(root);
  const engine = createWorkEngine(store, createExecutorRegistry([modelExecutor({
    store,
    cwd: root,
    context: () => ({ settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, key: 'test-key', maxTokens: 800, timeoutMs: 5000 }),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { return { choices: [{ message: { content: '{"final":{"summary":"ok","done":true}}' } }] }; }, async text() { return '{}'; } })
  })]), () => {}, {
    policy: { allowedExecutors: ['model', 'claude-code', 'codex'], requireApproval: false, permission: 'workspace' },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const withTeam = engine.createProjectChat(imported.project.id, {
    executorId: 'model',
    collaborators: ['claude-code', 'codex', 'claude-code', 'model', 'window']
  });
  // 去重、去掉内置 Agent 与窗口 Agent、最多 3 个。
  assert.deepEqual(withTeam.chat.collaborators, ['claude-code', 'codex']);

  const changed = engine.setProjectChatCollaborators(withTeam.chat.id, { collaborators: ['codex'] });
  assert.deepEqual(changed.collaborators, ['codex']);

  const cleared = engine.setProjectChatCollaborators(withTeam.chat.id, { collaborators: [] });
  assert.equal(cleared.collaborators, undefined, '清空后不再有名单，回到单 Agent');

  const plain = engine.createProjectChat(imported.project.id, { executorId: 'model' });
  assert.equal(plain.chat.collaborators, undefined, '不传就不写这个字段');
});

test('删掉文件夹或对话时，挂在它上面的编排记录一起清掉', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-run-purge-'));
  const store = new Store(root);
  const projectDir = join(root, 'purge-project');
  mkdirSync(projectDir, { recursive: true });
  const home = makeHome(root);
  const engine = createWorkEngine(store, createExecutorRegistry([modelExecutor({
    store,
    cwd: root,
    context: () => ({ settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }, key: 'k', maxTokens: 200, timeoutMs: 2000 }),
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, async json() { return { choices: [{ message: { content: '{"final":{"summary":"ok","done":true}}' } }] }; }, async text() { return '{}'; } })
  })]), () => {}, {
    policy: { allowedExecutors: ['model'], requireApproval: false, permission: 'workspace' },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'model' });
  const stamp = new Date().toISOString();
  // 编排记录由编排器写入，这里直接落两条，模拟「项目被删掉但运行还挂着」。
  store.put('work-run', { id: 'run-keep', projectId: imported.project.id, chatId: 'other-chat', status: 'cancelled', createdAt: stamp, updatedAt: stamp, goal: '保留', steps: [], board: [] });
  store.put('work-run', { id: 'run-gone', projectId: imported.project.id, chatId: chat.id, status: 'awaiting_approval', createdAt: stamp, updatedAt: stamp, goal: '要清掉', steps: [], board: [] });
  // 计划和它的检查点/补偿、团队房间也要跟着对话走，否则会留下打不开的僵尸计划。
  store.put('work-plan', { id: 'plan-gone', goal: '清理计划', status: 'active', projectId: imported.project.id, projectChatId: chat.id, steps: [], createdAt: stamp, updatedAt: stamp });
  store.put('work-checkpoint', { id: 'plan-gone-0', planId: 'plan-gone', step: 0, completed: [], files: [], at: stamp });
  store.put('work-compensation', { id: 'plan-gone-0', planId: 'plan-gone', step: 0, command: 'git checkout .', status: 'pending' });
  store.put('work-team-room', { id: 'room-gone', title: '清理房间', projectId: imported.project.id, planId: 'plan-gone', messages: [], createdAt: stamp, updatedAt: stamp });

  const removedChat = engine.deleteProjectChat(chat.id);
  assert.equal(removedChat.runs, 1, '删对话要带走挂在这条对话上的运行');
  assert.equal(removedChat.plans, 1, '删对话要带走挂在这条对话上的计划');
  assert.equal(store.get('work-run', 'run-gone') ?? null, null);
  assert.ok(store.get('work-run', 'run-keep'), '别的对话的运行不能误删');
  assert.equal(store.get('work-plan', 'plan-gone') ?? null, null);
  assert.equal(store.get('work-checkpoint', 'plan-gone-0') ?? null, null);
  assert.equal(store.get('work-compensation', 'plan-gone-0') ?? null, null);
  assert.equal(store.get('work-team-room', 'room-gone') ?? null, null);

  store.put('work-run', { id: 'run-gone-2', projectId: imported.project.id, chatId: 'whatever', status: 'drafting', createdAt: stamp, updatedAt: stamp, goal: '也要清掉', steps: [], board: [] });
  store.put('work-project-memory', { id: 'memory-gone', projectId: imported.project.id, title: '旧记忆', createdAt: stamp });
  const removedProject = engine.deleteProject(imported.project.id);
  assert.equal(removedProject.runs, 2, '删文件夹要把这个项目的运行一起带走');
  assert.equal(store.get('work-run', 'run-gone-2') ?? null, null);
  assert.equal(store.get('work-run', 'run-keep') ?? null, null);
  assert.equal(store.get('work-project-memory', 'memory-gone') ?? null, null, '项目记忆不能让重新导入的项目继承旧 id');
});

test('新建会话的占位标题使用真实 Agent 名称', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const service = projectService(store, { home: makeHome(root) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

  const project = service.importProject({ path: projectDir }).project;
  const modelChat = service.createChat(project.id, { executorId: 'model' });
  assert.equal(modelChat.title, `${project.name} · Lagent`, '内置 Agent 的会话不能写成 Claude Code');
  assert.equal(modelChat.autoTitle, true);
  const codexChat = service.createChat(project.id, { executorId: 'codex' });
  assert.equal(codexChat.title, `${project.name} · Codex`);
  const explicit = service.createChat(project.id, { executorId: 'model', title: '夜间开关' });
  assert.equal(explicit.title, '夜间开关');
  assert.equal(explicit.autoTitle, false);

  // 旧版本已经写坏的自动标题，读取时也会被纠正；手动改过的名字保持原样。
  store.put('project-chat', { ...modelChat, title: `${project.name} · Claude Code` });
  assert.equal(service.getChat(modelChat.id).title, `${project.name} · Lagent`);
  store.put('project-chat', { ...explicit, title: `${project.name} · Claude Code` });
  assert.equal(service.getChat(explicit.id).title, `${project.name} · Claude Code`);
});

test('同一项目对话里的每条消息可以换执行器，续接 id 按执行器分开保存', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  const claudeCalls = [];
  const codexCalls = [];
  const claude = claudeCodeExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      claudeCalls.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'system', session_id: 'claude-session' },
        { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session', result: '检查完成' }
      ]));
    }
  });
  const codex = codexExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      codexCalls.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'thread.started', thread_id: 'codex-thread' },
        { type: 'item.completed', item: { type: 'agent_message', text: '实现完成' } },
        { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }
      ]));
    }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex'], requireApproval: true },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'claude-code' });

  const first = engine.projectChatMessage(chat.id, { text: '检查现有实现' });
  assert.equal(first.executor, 'claude-code', '不传执行器时沿用会话默认 Agent');
  engine.action(first.id, 'approve');
  await waitFor(() => engine.detail(first.id).ticket.status === 'completed', '第一条消息未完成');

  const second = engine.projectChatMessage(chat.id, { text: '实现夜间开关', executorId: 'codex' });
  assert.equal(second.projectChatId, chat.id, '换人后仍然属于同一条对话');
  assert.equal(second.executor, 'codex');
  engine.action(second.id, 'approve');
  await waitFor(() => engine.detail(second.id).ticket.status === 'completed', '第二条消息未完成');
  assert.equal(codexCalls.length, 1);
  assert.equal(codexCalls[0].options.cwd, resolve(projectDir));
  assert.equal(engine.getProject(imported.project.id).chats[0].executorId, 'claude-code', '换人不能改写会话的默认 Agent');

  const stored = engine.getProject(imported.project.id).chats[0];
  assert.equal(stored.sessionId, 'claude-session');
  assert.equal(stored.sessions.codex, 'codex-thread');

  const third = engine.projectChatMessage(chat.id, { text: '继续检查', executorId: 'claude-code' });
  engine.action(third.id, 'approve');
  await waitFor(() => engine.detail(third.id).ticket.status === 'completed', '第三条消息未完成');
  const resumeIndex = claudeCalls[1].args.indexOf('--resume');
  assert.ok(resumeIndex >= 0);
  assert.equal(claudeCalls[1].args[resumeIndex + 1], 'claude-session', '切回原 Agent 时续接它自己的会话');

  assert.throws(() => engine.projectChatMessage(chat.id, { text: '越权', executorId: 'analysis' }), { status: 400 });
  assert.throws(() => engine.projectChatMessage(chat.id, { text: '越权', executorId: 'window' }), { status: 400 });
});

test('同一条项目消息可以并行交给多个 Agent，各开一张工单', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-projects-'));
  const store = new Store(root);
  const projectDir = makeProject(root);
  const home = makeHome(root);
  const claudeCalls = [];
  const codexCalls = [];
  const claude = claudeCodeExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      claudeCalls.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'system', session_id: 'claude-session' },
        { type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session', result: '检查完成' }
      ]));
    }
  });
  const codex = codexExecutor({
    store,
    cwd: root,
    binary: process.execPath,
    spawnImpl: (_executable, args, options) => {
      codexCalls.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'thread.started', thread_id: 'codex-thread' },
        { type: 'item.completed', item: { type: 'agent_message', text: '实现完成' } },
        { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 5 } }
      ]));
    }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex'], requireApproval: true },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' },
    home
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const imported = engine.importProject({ path: projectDir });
  const { chat } = engine.createProjectChat(imported.project.id, { executorId: 'claude-code' });

  const tickets = engine.projectChatMessages(chat.id, { text: '并行检查并各给结论', executorIds: ['claude-code', 'codex'] });
  assert.equal(tickets.length, 2);
  assert.deepEqual(new Set(tickets.map(ticket => ticket.executor)), new Set(['claude-code', 'codex']));
  assert.ok(tickets.every(ticket => ticket.projectChatId === chat.id), '多张工单仍属于同一条对话');

  for (const ticket of tickets) engine.action(ticket.id, 'approve');
  await waitFor(() => tickets.every(ticket => engine.detail(ticket.id).ticket.status === 'completed'), '并行工单未全部完成');
  assert.equal(claudeCalls.length, 1);
  assert.equal(codexCalls.length, 1);
  assert.equal(engine.getProject(imported.project.id).chats[0].executorId, 'claude-code', '批量执行不能改写会话默认 Agent');

  assert.throws(() => engine.projectChatMessages(chat.id, { text: '太多人', executorIds: ['claude-code', 'codex', 'claude-acp', 'codex-acp', 'opencode'] }), { status: 400 });
  assert.throws(() => engine.projectChatMessages(chat.id, { text: '越权', executorIds: ['claude-code', 'analysis'] }), { status: 400 });
});

test('P1 非 Git 项目按 mtime 找本次改动并跳过依赖目录', t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-scan-'));
  const store = new Store(root);
  const service = projectService(store, { home: makeHome(root) });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const dir = join(root, 'plain-project');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'src', 'old.js'), 'old');
  const since = Date.now() - 50;
  utimesSync(join(dir, 'src', 'old.js'), new Date(since - 60_000), new Date(since - 60_000));
  writeFileSync(join(dir, 'src', 'a.js'), 'a');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');

  assert.equal(service.isGitRepo(dir), false);
  assert.deepEqual(service.filesModifiedSince(dir, since), ['src/a.js']);
});
