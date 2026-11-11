import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { createAcpExecutor } from './work/executors/acp.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createWorkEngine } from './work/engine.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('ACP 执行器完成 initialize、session/new 与 session/prompt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-exec-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const agentFile = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  const executor = createAcpExecutor({ id: 'test-acp', name: 'Test ACP', store, cwd: dir, command: process.execPath, args: [agentFile], timeoutMs: 10000 });
  assert.equal(executor.available, true);
  const task = executor.start({ id: 't1' }, { id: 'a1' }, { prompt: '测试 ACP' });
  for (let i = 0; i < 100 && executor.get(task.id)?.status === 'running'; i++) await sleep(50);
  const finished = executor.get(task.id);
  assert.equal(finished.status, 'completed', finished.error);
  assert.equal(finished.artifacts.acp.stopReason, 'end_turn');
  assert.match(finished.artifacts.acp.text, /ACP OK/);
  executor.close();
});

test('ACP 项目工单用 ticket 的 workspace 作为 session 工作目录', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-workspace-'));
  const workspace = mkdtempSync(join(tmpdir(), 'acp-project-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  const agentFile = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));
  const executor = createAcpExecutor({ id: 'test-acp', name: 'Test ACP', store, cwd: dir, command: process.execPath, args: [agentFile], timeoutMs: 10000 });
  assert.deepEqual(executor.validateInput({ prompt: '检查项目', workspace }), { prompt: '检查项目', workspace, write: false });
  assert.deepEqual(executor.validateInput({ prompt: '检查项目', workspace, write: true }), { prompt: '检查项目', workspace, write: true });
  assert.throws(() => executor.validateInput({ prompt: '检查项目', workspace: join(dir, 'missing-dir') }), { status: 400 });
  const task = executor.start({ id: 't2' }, { id: 'a2' }, { prompt: '检查项目', workspace });
  for (let i = 0; i < 100 && executor.get(task.id)?.status === 'running'; i++) await sleep(50);
  const finished = executor.get(task.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.artifacts.acp.cwd, workspace);
  assert.match(finished.artifacts.acp.text, /ACP OK/);
  executor.close();
});

test('ACP 项目工单在 workspace 内开放文件读写，越界路径被拒绝', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-fs-'));
  const workspace = mkdtempSync(join(tmpdir(), 'acp-fs-project-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  writeFileSync(join(workspace, '.agent-input.txt'), '项目说明书内容');
  const agentFile = fileURLToPath(new URL('./fixtures/fake-acp-fs-agent.mjs', import.meta.url));
  const executor = createAcpExecutor({ id: 'test-acp', name: 'Test ACP', store, cwd: dir, command: process.execPath, args: [agentFile], timeoutMs: 10000 });
  const task = executor.start({ id: 't3' }, { id: 'a3' }, { prompt: '读一下项目说明', workspace, write: true });
  for (let i = 0; i < 100 && executor.get(task.id)?.status === 'running'; i++) await sleep(50);
  const finished = executor.get(task.id);
  assert.equal(finished.status, 'completed');
  assert.match(finished.artifacts.acp.text, /read=项目说明书内容/);
  assert.match(finished.artifacts.acp.text, /write=ok/);
  assert.match(finished.artifacts.acp.text, /escape=blocked/);
  assert.equal(readFileSync(join(workspace, 'out', '.agent-output.txt'), 'utf8'), 'written by acp');
  assert.equal(existsSync(join(workspace, '..', 'escaped.txt')), false);
  executor.close();
});

test('ACP 无 workspace 的工单仍然只读', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-ro-'));
  const workspace = mkdtempSync(join(tmpdir(), 'acp-ro-project-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  writeFileSync(join(workspace, '.agent-input.txt'), '不该被读到');
  const agentFile = fileURLToPath(new URL('./fixtures/fake-acp-fs-agent.mjs', import.meta.url));
  const executor = createAcpExecutor({ id: 'test-acp', name: 'Test ACP', store, cwd: workspace, command: process.execPath, args: [agentFile], timeoutMs: 10000 });
  const task = executor.start({ id: 't4' }, { id: 'a4' }, { prompt: '读一下' });
  for (let i = 0; i < 100 && executor.get(task.id)?.status === 'running'; i++) await sleep(50);
  const finished = executor.get(task.id);
  assert.equal(finished.status, 'completed');
  assert.match(finished.artifacts.acp.text, /readError=/);
  assert.match(finished.artifacts.acp.text, /writeError=/);
  assert.equal(existsSync(join(workspace, 'out', '.agent-output.txt')), false);
  executor.close();
});

test('ACP 工单未显式提供 executorInput 时用指令文本作为 prompt', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-default-'));
  const store = new Store(dir);
  const started = [];
  const acp = {
    id: 'claude-acp',
    name: 'Claude ACP',
    kind: 'cli',
    available: true,
    requiresDataset: false,
    capabilities: ['acp', 'agent', 'chat'],
    validateInput(input) {
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) throw Object.assign(new Error('ACP prompt 必须是非空字符串'), { status: 400 });
      return { prompt };
    },
    defaultInput(text) { return this.validateInput({ prompt: text }); },
    start(ticket, assignment, input) {
      started.push(input);
      const task = { id: assignment.id, status: 'completed' };
      store.put('task', task);
      return task;
    },
    get: id => id && store.get('task', id),
    stop() {}
  };
  const engine = createWorkEngine(store, createExecutorRegistry([acp]), () => {}, { env: { LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  engine.updatePolicy({ allowedExecutors: ['claude-acp'] });
  const ticket = engine.command({ text: '只回复 OK', executorId: 'claude-acp' });
  const control = store.get('work-control', ticket.id);
  assert.deepEqual(control.executorInput, { prompt: '只回复 OK' });
  assert.equal(ticket.executor, 'claude-acp');
});

test('策略切到「仅查看」后项目分派给 ACP 只读', t => {
  const dir = mkdtempSync(join(tmpdir(), 'acp-policy-'));
  const projectDir = mkdtempSync(join(tmpdir(), 'acp-policy-project-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const store = new Store(dir);
  const started = [];
  const acp = {
    id: 'claude-acp',
    name: 'Claude ACP',
    kind: 'cli',
    available: true,
    requiresDataset: false,
    capabilities: ['acp', 'agent', 'chat'],
    validateInput(input) {
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt) throw Object.assign(new Error('ACP prompt 必须是非空字符串'), { status: 400 });
      return { prompt, ...(typeof input.workspace === 'string' && input.workspace ? { workspace: input.workspace, write: input.write === true } : {}) };
    },
    defaultInput(text) { return this.validateInput({ prompt: text }); },
    start(ticket, assignment, input) {
      started.push(input);
      store.put('task', { id: assignment.id, status: 'completed' });
      return { id: assignment.id, status: 'completed' };
    },
    get: id => id && store.get('task', id),
    stop() {}
  };
  const engine = createWorkEngine(store, createExecutorRegistry([acp]), () => {}, { env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); rmSync(projectDir, { recursive: true, force: true }); });
  engine.updatePolicy({ allowedExecutors: ['claude-acp'], permission: 'read' });
  const { project } = engine.importProject({ path: projectDir });
  const result = engine.projectDispatch(project.id, { text: '梳理项目结构', executorIds: ['claude-acp'] });
  assert.equal(result.tickets.length, 1);
  const control = store.get('work-control', result.tickets[0].id);
  assert.equal(control.executorInput.workspace, project.path);
  assert.equal(control.executorInput.write, false);
  engine.updatePolicy({ allowedExecutors: ['claude-acp'], permission: 'workspace' });
  const second = engine.projectDispatch(project.id, { text: '再梳理一次', executorIds: ['claude-acp'] });
  assert.equal(store.get('work-control', second.tickets[0].id).executorInput.write, true);
});
