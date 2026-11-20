import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { handoffBrief, normalizeHandoff } from './work/handoff.js';
import { createMcpHandler } from './work/mcp.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-handoff-'));
  const store = new Store(dir);
  const cli = {
    id: 'codex', name: 'Codex Mock', kind: 'cli', available: true, requiresDataset: false, capabilities: ['code'],
    defaultInput: text => ({ prompt: text }),
    validateInput: value => value,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { cli: { summary: 'done' } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([cli]), () => {}, { workspace: dir, env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' }, policy: { allowedExecutors: ['codex'] } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, store, dir };
}

test('交接简报规范化与格式化', () => {
  const handoff = normalizeHandoff({
    summary: '  已完成登录页  ',
    artifacts: ['src/login.tsx', 'src/login.tsx'],
    evidence: ['npm test 通过'],
    decisions: ['沿用现有表单库'],
    openQuestions: ['要不要支持 SSO？'],
    nextSteps: ['补 e2e'],
    budgetUsed: { tokens: 1200, calls: 3 }
  });
  assert.equal(handoff.summary, '已完成登录页');
  assert.deepEqual(handoff.artifacts, ['src/login.tsx']);
  assert.deepEqual(handoff.budgetUsed, { tokens: 1200, calls: 3 });
  const brief = handoffBrief(handoff, { sourceTitle: '登录页' });
  assert.match(brief, /【交接简报】/);
  assert.match(brief, /来源：登录页/);
  assert.match(brief, /已完成：已完成登录页/);
  assert.match(brief, /产物：\n- src\/login.tsx/);
  assert.match(brief, /未解问题：\n- 要不要支持 SSO？/);
  assert.match(brief, /下一步：\n- 补 e2e/);
  assert.match(brief, /已用资源：tokens=1200，calls=3/);

  assert.throws(() => normalizeHandoff({}), /不能为空/);
  assert.throws(() => normalizeHandoff({ bogus: 1 }), /未知字段/);
  assert.throws(() => normalizeHandoff({ artifacts: 'x' }), /字符串数组/);
  assert.throws(() => normalizeHandoff({ budgetUsed: { tokens: -1 } }), /非负整数/);
  assert.equal(normalizeHandoff(null), null);
});

test('结构化交接写入子工单并把简报注入执行器输入', t => {
  const { engine, store } = fixture(t);
  const source = engine.command({ text: '先做登录页', executorId: 'codex', executorInput: { prompt: '先做登录页' } });
  assert.equal(source.status, 'completed');

  const result = engine.handoff(source.id, {
    executorId: 'codex',
    handoff: {
      summary: '登录页已完成',
      artifacts: ['src/login.tsx'],
      evidence: ['npm test 通过'],
      decisions: ['沿用现有表单库'],
      openQuestions: ['要不要支持 SSO？'],
      nextSteps: ['补 e2e'],
      budgetUsed: { tokens: 1200 }
    }
  });
  assert.equal(result.created, true);
  const child = result.ticket;
  assert.equal(child.parentTicketId, source.id);
  assert.equal(child.handoff.summary, '登录页已完成');
  assert.deepEqual(child.handoff.nextSteps, ['补 e2e']);

  const control = store.get('work-control', child.id);
  assert.match(control.executorInput.prompt, /【交接简报】/);
  assert.match(control.executorInput.prompt, /未解问题：/);
  assert.match(control.executorInput.prompt, /下一步：/);
  assert.equal(engine.detail(child.id).ticket.handoff.summary, '登录页已完成');

  // 重复交接返回同一个子工单，不重复建。
  const again = engine.handoff(source.id, { executorId: 'codex', handoff: { summary: 'x' } });
  assert.equal(again.created, false);
  assert.equal(again.ticket.id, child.id);
});

test('交接子工单留在原项目对话里，删除对话时一并清理', t => {
  const { engine, store, dir } = fixture(t);
  const project = engine.importProject({ path: dir, name: '交接项目' }).project;
  const chat = engine.createProjectChat(project.id, { executorId: 'codex' }).chat;
  const stamp = new Date().toISOString();
  store.put('work-ticket', { id: 'source-chat', title: '来源任务', status: 'completed', executor: 'codex', summary: '已完成', projectChatId: chat.id, createdAt: stamp, updatedAt: stamp });
  store.put('work-control', { id: 'source-chat', command: '来源任务', executor: 'codex', executorInput: { prompt: '来源任务' }, projectChatId: chat.id });

  const { ticket } = engine.handoff('source-chat', { executorId: 'codex', handoff: { summary: '继续做' } });
  assert.equal(ticket.projectChatId, chat.id, '子工单要继承项目对话');
  assert.equal(store.get('work-control', ticket.id).projectChatId, chat.id, '控制记录也要带上对话，删消息/删对话才找得到它');

  engine.deleteProjectChat(chat.id);
  assert.equal(store.get('work-ticket', ticket.id), null, '删对话时不能留下孤儿子工单');
});

test('MCP 暴露 work_ticket_handoff，且仍不能批准工单', async t => {
  const { engine } = fixture(t);
  const source = engine.command({ text: '先做登录页', executorId: 'codex', executorInput: { prompt: '先做登录页' } });
  const handler = createMcpHandler({ engine });
  const tools = handler.tools;
  assert.ok(tools.some(tool => tool.name === 'work_ticket_handoff'));

  const result = await handler.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'work_ticket_handoff', arguments: { id: source.id, executorId: 'codex', handoff: { summary: '交接给下一棒' } } }
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.created, true);
  assert.equal(payload.ticket.handoff.summary, '交接给下一棒');

  await assert.rejects(() => handler.handle({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'work_ticket_action', arguments: { id: source.id, action: 'approve' } }
  }), /MCP 不能批准/);
});
