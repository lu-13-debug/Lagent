import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createMcpHandler } from './work/mcp.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时');
    await sleep(30);
  }
}
async function callTool(handler, name, args) {
  const result = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(result.content[0].text);
}

test('MCP v2：契约、验收、产物读取', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-mcp-v2-'));
  const store = new Store(dir);
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { terminal: { command: 'pwd', exitCode: 0, stdout: '/tmp' } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const ticket = engine.command({
    text: '带契约与验收',
    executorId: 'terminal',
    executorInput: { program: 'pwd', args: [] },
    contract: { objective: '确认目录', acceptance: ['pwd 成功'] },
    verify: { command: 'npm --version' }
  });
  await until(() => engine.detail(ticket.id).ticket.acceptance);
  const handler = createMcpHandler({ engine });

  const contract = await callTool(handler, 'work_task_contract_read', { id: ticket.id });
  assert.equal(contract.contract.objective, '确认目录');
  assert.equal(contract.verify.command, 'npm --version');

  const acceptance = await callTool(handler, 'work_acceptance_read', { id: ticket.id });
  assert.equal(acceptance.acceptance.status, 'passed');
  assert.equal(acceptance.status, 'completed');

  const artifacts = await callTool(handler, 'work_artifact_read', { id: ticket.id });
  assert.ok(artifacts.artifacts.terminal);
  const single = await callTool(handler, 'work_artifact_read', { id: ticket.id, name: 'terminal' });
  assert.equal(single.found, true);
  assert.equal(single.value.command, 'pwd');
  const missing = await callTool(handler, 'work_artifact_read', { id: ticket.id, name: 'nope' });
  assert.equal(missing.found, false);
});

test('MCP v2：项目记忆检索', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-mcp-memory-'));
  const store = new Store(dir);
  const cli = {
    id: 'codex', name: 'Codex Mock', kind: 'cli', available: true, requiresDataset: false, capabilities: ['code'],
    defaultInput: text => ({ prompt: text }),
    validateInput: value => value,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: '改了登录页' }, artifacts: { cli: { summary: '改了登录页', files: ['src/auth/login.tsx'] } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([cli]), () => {}, { workspace: dir, env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }, policy: { allowedExecutors: ['codex'] } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const { project } = engine.importProject({ path: dir });
  const chat = engine.createProjectChat(project.id, { executorId: 'codex', title: '测试' }).chat;
  engine.command({ text: '修登录页', executorId: 'codex', projectChatId: chat.id, executorInput: { prompt: '修登录页' } });

  const handler = createMcpHandler({ engine });
  const found = await callTool(handler, 'work_memory_search', { projectId: project.id, query: '登录' });
  assert.equal(found.entries.length, 1);
  assert.equal(found.entries[0].scope, 'src/auth');
  assert.ok(found.entries[0].tags.includes('codex'));

  const byScope = await callTool(handler, 'work_memory_search', { projectId: project.id, scope: 'src/order' });
  assert.equal(byScope.entries.length, 0);
});
