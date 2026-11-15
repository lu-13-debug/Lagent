import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createMcpHandler, registerMcpRoutes } from './work/mcp.js';
import { createMcpTokenService, MCP_TOKEN_PREFIX } from './work/mcp-tokens.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-mcp-tokens-'));
  for (const name of ['a', 'b']) mkdirSync(join(dir, name));
  const store = new Store(dir);
  const codex = {
    id: 'codex', name: 'Codex', kind: 'cli', available: true, capabilities: [],
    defaultInput: text => ({ prompt: text }), validateInput: input => input,
    start(ticket, assignment) { return { id: assignment.id, status: 'completed', report: { summary: 'done' } }; },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([codex]), () => {}, {
    workspace: dir,
    policy: { allowedExecutors: ['analysis', 'codex'] },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }
  });
  let time = Date.parse('2026-11-14T08:00:00.000Z');
  const tokens = createMcpTokenService({ store, engine, now: () => time });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine, tokens, advance: ms => { time += ms; } };
}

test('作用域令牌：明文只返回一次，默认只读、可撤销', t => {
  const { engine, store, tokens } = fixture(t);
  const issued = tokens.issue({ name: '外部审阅' });
  assert.match(issued.token, new RegExp(`^${MCP_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`));
  assert.equal(issued.record.readOnly, true);
  assert.equal(issued.record.tools.length, 0);
  assert.equal(issued.record.maxConcurrency, 4);
  assert.doesNotMatch(JSON.stringify(tokens.list()), new RegExp(issued.token));
  assert.doesNotMatch(JSON.stringify(store.list('config')), new RegExp(issued.token));

  const row = tokens.authenticate(issued.token);
  assert.equal(row.id, issued.record.id);
  assert.throws(() => tokens.assertTool(row, 'work_send_command'), { status: 403 });
  assert.doesNotThrow(() => tokens.assertTool(row, 'work_list_tickets'));
  assert.throws(() => tokens.assertTool(row, 'work_send_command', {}), { status: 403 });

  const revoked = tokens.revoke(issued.record.id);
  assert.ok(revoked.revokedAt);
  assert.throws(() => tokens.authenticate(issued.token), { status: 401 });
  assert.equal(tokens.list().length, 1);
  const audit = store.list('work-audit');
  assert.ok(audit.some(row => row.action === 'mcp/token' && row.result === 'revoked'));
});

test('作用域令牌：TTL、调用上限、Token 预算与并发闸门', t => {
  const { store, tokens, advance } = fixture(t);
  const expiring = tokens.issue({ name: '短期', ttlDays: 1, readOnly: false });
  advance(2 * 86400000);
  assert.throws(() => tokens.authenticate(expiring.token), { status: 401 });

  const limited = tokens.issue({ name: '一次', maxCalls: 1, readOnly: false });
  const limitedRow = tokens.authenticate(limited.token);
  tokens.recordCall(limitedRow, {});
  assert.throws(() => tokens.authenticate(limited.token), { status: 403, message: '该 MCP 令牌的调用额度已用完' });

  const budget = tokens.issue({ name: '预算', budgetTokens: 100, readOnly: false });
  store.put('work-usage', { id: 'usage-1', ticketId: 'ticket-budget', calls: 1, totalTokens: 150, recordedAt: new Date().toISOString() });
  const budgetRow = tokens.authenticate(budget.token);
  tokens.recordCall(budgetRow, { ticketId: 'ticket-budget' });
  assert.equal(tokens.usedTokens(budgetRow), 150);
  assert.throws(() => tokens.authenticate(budget.token), { status: 403, message: '该 MCP 令牌的 Token 预算已用完' });

  const concurrent = tokens.issue({ name: '并发 1', maxConcurrency: 1, readOnly: false });
  const row = tokens.authenticate(concurrent.token);
  const release = tokens.enter(row);
  assert.throws(() => tokens.enter(row), { status: 429, message: '该 MCP 令牌的并发请求过多' });
  release();
  release();
  assert.doesNotThrow(() => tokens.enter(tokens.authenticate(concurrent.token)));
});

test('作用域令牌：工具白名单、项目绑定与未知工具校验', t => {
  const { dir, engine, tokens } = fixture(t);
  const handler = createMcpHandler({ engine });
  const known = new Set(handler.tools.map(tool => tool.name));
  const projectA = engine.importProject({ path: join(dir, 'a') }).project;
  const projectB = engine.importProject({ path: join(dir, 'b') }).project;
  const chatA = engine.createProjectChat(projectA.id, { executorId: 'codex', title: 'A' }).chat;
  const chatB = engine.createProjectChat(projectB.id, { executorId: 'codex', title: 'B' }).chat;
  const ticketA = engine.command({ text: 'A 工单', executorId: 'codex', projectChatId: chatA.id, executorInput: { prompt: 'A' } });
  const ticketB = engine.command({ text: 'B 工单', executorId: 'codex', projectChatId: chatB.id, executorInput: { prompt: 'B' } });

  const issued = tokens.issue({ name: 'A 只读', projectId: projectA.id, tools: ['work_list_tickets', 'work_get_ticket'], readOnly: true }, { knownTools: known });
  assert.deepEqual(issued.record.tools, ['work_list_tickets', 'work_get_ticket']);
  assert.equal(issued.record.projectId, projectA.id);
  const row = tokens.authenticate(issued.token);

  assert.doesNotThrow(() => tokens.assertTool(row, 'work_list_tickets', {}));
  assert.throws(() => tokens.assertTool(row, 'work_list_projects', {}), { status: 403 });
  assert.throws(() => tokens.assertTool(row, 'work_get_ticket', { id: ticketB.id }), { status: 403, message: '该 MCP 令牌只能访问绑定的项目' });
  assert.doesNotThrow(() => tokens.assertTool(row, 'work_get_ticket', { id: ticketA.id }));
  assert.throws(() => tokens.assertTool(row, 'work_send_command', { projectId: projectB.id }), { status: 403 });

  assert.throws(() => tokens.issue({ name: 'x', tools: ['work_nope'] }, { knownTools: known }), { status: 400 });
  assert.throws(() => tokens.issue({ name: 'x', projectId: 'missing' }), { status: 404 });
  assert.throws(() => tokens.issue({ name: 'x', ttlDays: 0 }), { status: 400 });
});

test('MCP handler：作用域过滤工具列表与项目数据', async t => {
  const { dir, engine } = fixture(t);
  const handler = createMcpHandler({ engine });
  const projectA = engine.importProject({ path: join(dir, 'a') }).project;
  const projectB = engine.importProject({ path: join(dir, 'b') }).project;
  const chatA = engine.createProjectChat(projectA.id, { executorId: 'codex', title: 'A' }).chat;
  const chatB = engine.createProjectChat(projectB.id, { executorId: 'codex', title: 'B' }).chat;
  const ticketA = engine.command({ text: 'A 工单', executorId: 'codex', projectChatId: chatA.id, executorInput: { prompt: 'A' } });
  engine.command({ text: 'B 工单', executorId: 'codex', projectChatId: chatB.id, executorInput: { prompt: 'B' } });

  const readonly = { readOnly: true, tools: [], projectId: null };
  const writeNames = ['work_send_command', 'work_create_plan', 'work_ticket_action'];
  const listed = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { scope: readonly })).tools.map(tool => tool.name);
  assert.equal(listed.includes('work_list_tickets'), true);
  for (const name of writeNames) assert.equal(listed.includes(name), false);
  await assert.rejects(handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_send_command', arguments: { text: 'x' } } }, { scope: readonly }), { status: 403 });

  const whitelist = { readOnly: false, tools: ['work_list_tickets'], projectId: null };
  const filtered = (await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { scope: whitelist })).tools.map(tool => tool.name);
  assert.deepEqual(filtered, ['work_list_tickets']);

  const scoped = { readOnly: true, tools: [], projectId: projectA.id };
  const result = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'work_list_tickets', arguments: {} } }, { scope: scoped });
  const tickets = JSON.parse(result.content[0].text).tickets;
  assert.deepEqual(tickets.map(ticket => ticket.id), [ticketA.id]);
  const projects = JSON.parse((await handler.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'work_list_projects', arguments: {} } }, { scope: scoped })).content[0].text).projects;
  assert.deepEqual(projects.map(project => project.id), [projectA.id]);
  // 项目令牌调用项目工具时自动注入绑定项目，不能指向另一个项目。
  await assert.rejects(handler.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'work_project_brief', arguments: { projectId: projectB.id } } }, { scope: scoped }), { status: 403 });
});

test('MCP 路由：只读令牌写操作返回 403 并写审计', async t => {
  const { store, engine, tokens } = fixture(t);
  const app = express();
  app.use(express.json());
  registerMcpRoutes(app, { engine, gateway: {}, mcpTokens: tokens });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const issued = tokens.issue({ name: '只读', readOnly: true });
  const call = async (name, args) => {
    const response = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    return { status: response.status, body: await response.json() };
  };

  const denied = await call('work_send_command', { text: 'x' });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /只读令牌/);
  assert.equal(tokens.list()[0].calls, 0);
  const deniedAudit = store.list('work-audit').find(row => row.action === 'mcp/call' && row.result === 'denied');
  assert.ok(deniedAudit);
  assert.match(deniedAudit.reason, /work_send_command/);
  assert.doesNotMatch(JSON.stringify(deniedAudit), new RegExp(issued.token));

  const listed = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  const tools = await listed.json();
  assert.equal(tools.result.tools.some(tool => tool.name === 'work_send_command'), false);

  // 无法鉴权的令牌必须是 401，且不暴露内部细节。
  const bad = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MCP_TOKEN_PREFIX}${'a'.repeat(43)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
  });
  assert.equal(bad.status, 401);
});
