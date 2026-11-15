import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createAcpExecutor } from './work/executors/acp.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createWorkEngine } from './work/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = '2026-11-15T10:00:00.000Z';
const agentFile = fileURLToPath(new URL('./fixtures/fake-acp-permission-agent.mjs', import.meta.url));

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-permission-'));
  const workspace = mkdtempSync(join(tmpdir(), 'acp-permission-project-'));
  const store = new Store(dir);
  const executor = createAcpExecutor({
    id: 'test-acp', name: 'Test ACP', store, cwd: dir,
    command: process.execPath, args: [agentFile], timeoutMs: 10000,
    ...options
  });
  t.after(() => { executor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  return { dir, workspace, store, executor };
}

async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`等待超时：${label}`);
}

test('ACP 文件权限请求等界面决定，允许后才继续', async t => {
  const { workspace, executor } = fixture(t, { permissionTimeoutMs: 5000 });
  const task = executor.start({ id: 't1' }, { id: 'a1' }, { prompt: '改一个文件', workspace, write: true });
  const request = await waitFor(() => (executor.get(task.id)?.activity || []).find(step => step.kind === 'permission'), '权限请求');
  assert.match(request.text, /permission\.txt/);
  assert.ok(request.requestId);
  assert.equal(executor.get(task.id).status, 'running');
  assert.equal(executor.resolvePermission(executor.get(task.id), request.requestId, 'allow'), true);
  const finished = await waitFor(() => { const value = executor.get(task.id); return value?.status === 'completed' ? value : null; }, '任务完成');
  assert.match(finished.artifacts.acp.text, /permission=allow-once/);
});

test('ACP 权限请求超时后自动拒绝，任务不会挂死', async t => {
  const { workspace, executor } = fixture(t, { permissionTimeoutMs: 80 });
  const task = executor.start({ id: 't2' }, { id: 'a2' }, { prompt: '改一个文件', workspace, write: true });
  const finished = await waitFor(() => { const value = executor.get(task.id); return value?.status === 'completed' ? value : null; }, '超时后完成');
  assert.match(finished.artifacts.acp.text, /permission=cancelled/);
  const request = (finished.activity || []).find(step => step.kind === 'permission');
  assert.equal(request?.decided, 'deny');
});

test('engine.permissionDecision 把界面决定转给当前执行器', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-permission-engine-'));
  const store = new Store(dir);
  const calls = [];
  const executor = {
    id: 'claude-acp', name: 'Claude ACP', kind: 'cli', available: true, capabilities: [],
    start() { throw new Error('not used'); },
    get(id) { return { id, status: 'running' }; },
    resolvePermission(task, requestId, decision) { calls.push({ taskId: task.id, requestId, decision }); return true; },
    close() {}
  };
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.put('work-ticket', { id: 't1', status: 'working', executor: 'claude-acp', title: '改文件', createdAt: stamp, updatedAt: stamp });
  store.put('work-assignment', { id: 'a1', ticketId: 't1', executor: 'claude-acp', status: 'working', sessionId: 'task-1', startedAt: stamp });
  const detail = engine.permissionDecision('t1', 'request-1', 'allow');
  assert.equal(detail.ticket.id, 't1');
  assert.deepEqual(calls, [{ taskId: 'task-1', requestId: 'request-1', decision: 'allow' }]);
  assert.throws(() => engine.permissionDecision('t1', 'request-1', 'maybe'), /allow|deny|决定/);
});
