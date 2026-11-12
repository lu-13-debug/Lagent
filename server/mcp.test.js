import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerMcpRoutes } from './work/mcp.js';

async function fixture(t) {
  const calls = [];
  const engine = {
    bootstrap: () => ({ tickets: [{ id: 't1', title: '任务' }], attention: [], agents: [{ id: 'claude-acp', status: 'available' }], plans: [{ id: 'p0', goal: '旧计划', status: 'completed' }] }),
    detail: id => ({ ticket: { id, title: '任务', status: 'completed' }, reports: [{ id: 'r1', summary: '完成', artifacts: { report: { id: 'acp-1', summary: 'OK' }, acp: { text: 'OK' } } }] }),
    command: input => { calls.push(['command', input]); return { id: 't2', title: input.text }; },
    action: (id, action) => { calls.push(['action', id, action]); return { id, status: 'working' }; },
    plan: input => { calls.push(['plan', input]); return { id: 'p1', goal: input.goal, steps: input.steps }; },
    auditExternal: (...args) => calls.push(['audit', ...args])
  };
  const owner = { token: 'A'.repeat(43), id: 'device-mcp' };
  const gateway = {
    createPair: () => ({ code: '123456', expiresAt: new Date(Date.now() + 300000).toISOString() }),
    claim: (code, name) => { assert.equal(code, '123456'); return { deviceToken: owner.token, deviceId: owner.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }; },
    authenticateRequest(req, { ownerId }) { if (req.headers.authorization !== `Bearer ${owner.token}` || ownerId !== 'local') { const e = new Error('设备认证失败'); e.status = 401; throw e; } return owner; }
  };
  const app = express(); app.use(express.json()); registerMcpRoutes(app, { engine, gateway, ownerId: 'local' });
  app.use((error, _req, res, _next) => res.status(error.status || 400).json({ error: error.message }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { method = 'GET', token, body } = {}) => fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { request, gateway, calls, token: owner.token };
}

test('MCP 初始化、工具列表与调用受 Bearer 令牌保护', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'initialize' } })).status, 401);
  const init = await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } } });
  assert.equal(init.status, 200);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, 'Lagent');
  const list = await (await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } })).json();
  assert.ok(list.result.tools.some(item => item.name === 'work_send_command'));
  const call = await (await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'work_send_command', arguments: { text: '检查 CI' } } } })).json();
  assert.equal(JSON.parse(call.result.content[0].text).ticket.id, 't2');
  assert.deepEqual(f.calls[0], ['command', { text: '检查 CI', origin: 'mcp' }]);
  const blocked = await (await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'work_ticket_action', arguments: { id: 't2', action: 'approve' } } } })).json();
  assert.equal(blocked.error.code, 403);
  assert.match(blocked.error.message, /不能批准/);
  const unknown = await (await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'missing' } } })).json();
  assert.equal(unknown.error.code, 404);
  const notification = await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(notification.status, 202);
});

test('MCP 暴露执行器、计划、计划创建与报告摘要', async t => {
  const f = await fixture(t);
  const call = async (id, name, args) => {
    const response = await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } });
    const body = await response.json();
    return JSON.parse(body.result.content[0].text);
  };
  const agents = await call(10, 'work_list_agents', {});
  assert.equal(agents.agents[0].id, 'claude-acp');
  const plans = await call(11, 'work_list_plans', {});
  assert.equal(plans.plans[0].id, 'p0');
  const report = await call(12, 'work_get_report', { id: 't1' });
  assert.equal(report.summary, '完成');
  assert.equal(report.report.summary, 'OK');
  assert.deepEqual(report.artifactKeys.sort(), ['acp', 'report']);
  const created = await call(13, 'work_create_plan', { goal: '协同审查', steps: [{ executorId: 'claude-acp', text: '审查报告' }], autoRun: true });
  assert.equal(created.plan.id, 'p1');
  assert.equal(f.calls.at(-1)[0], 'plan');
  const bad = await f.request('/api/mcp', { method: 'POST', token: f.token, body: { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'work_create_plan', arguments: { goal: '缺少步骤' } } } });
  assert.equal((await bad.json()).error.code, 400);
});

test('MCP 令牌生成接口返回一次性 token', async t => {  const f = await fixture(t);
  const response = await f.request('/api/mcp/token', { method: 'POST', body: { name: 'MCP 测试' } });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.token, f.token);
  assert.equal(body.endpoint, '/api/mcp');
});
