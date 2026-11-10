import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { modelExecutor } from './work/executors/model.js';

function memoryStore() {
  const rows = new Map();
  return {
    put: (kind, body) => { rows.set(`${kind}:${body.id}`, structuredClone(body)); return body; },
    get: (kind, id) => (rows.has(`${kind}:${id}`) ? structuredClone(rows.get(`${kind}:${id}`)) : null),
    list: kind => [...rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, body]) => structuredClone(body)),
  };
}

function fakeModelHub(replies) {
  const queue = [...replies];
  return {
    context() {
      return {
        settings: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
        key: 'test-key',
        maxTokens: 800,
        timeoutMs: 5000,
      };
    },
    reply: () => queue.shift() ?? '{"final":{"summary":"结束","files":[]}}',
    size: () => queue.length,
  };
}

function fakeFetch(hub) {
  return async () => {
    const content = hub.reply();
    const body = { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
}

async function settle(executor, taskId, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = executor.get(taskId);
    if (task && task.status !== 'running') return task;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('模型 Agent 超时未结束');
}

test('模型 Agent 走工具循环并把过程写进 activity', async () => {
  const store = memoryStore();
  const hub = fakeModelHub([
    '{"tool":"list_files","args":{"path":"."}}',
    '{"final":{"summary":"仓库里有两个文件","files":["a.txt"]}}',
  ]);
  const executor = modelExecutor({ store, cwd: process.cwd(), context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  const task = executor.start({ command: '看看仓库里有什么' }, { id: 'assign-1' }, {
    executorInput: { prompt: '看看仓库里有什么', workspace: process.cwd(), write: false },
  });
  assert.equal(task.status, 'running');
  const done = await settle(executor, 'assign-1');
  assert.equal(done.status, 'completed', done.error || '');
  const kinds = done.activity.map(item => item.kind);
  assert.ok(kinds.includes('tool'), '应记录工具调用');
  assert.ok(kinds.includes('observation'), '应记录工具结果');
  assert.equal(kinds.filter(kind => kind === 'result').length, 1);
  assert.match(done.artifacts.cli.summary, /仓库里有两个文件/);
  assert.equal(done.artifacts.cli.executorId, 'model');
  assert.deepEqual(done.artifacts.cli.artifacts, ['a.txt']);
  assert.equal(done.artifacts.cli.stats.steps, 2);
});

test('没有写权限时拒绝写入，并记录失败原因', async () => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-agent-'));
  const hub = fakeModelHub([
    '{"tool":"write_file","args":{"path":"note.txt","content":"hello"}}',
    '{"final":{"summary":"写不了，已说明原因","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '写一个文件' }, { id: 'assign-2' }, {
    executorInput: { prompt: '写一个文件', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-2');
  assert.equal(done.status, 'completed', done.error || '');
  assert.ok(done.activity.some(item => item.kind === 'error'));
  assert.equal(fs.existsSync(path.join(dir, 'note.txt')), false);
});

test('写入被限制在工作目录内，越界路径被拒绝', async () => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-agent-'));
  const outside = path.join(os.tmpdir(), `escape-${Date.now()}.txt`);
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'write_file', args: { path: '../' + path.basename(outside), content: 'x' } }),
    '{"final":{"summary":"越界被拒","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '试着写到外面' }, { id: 'assign-3' }, {
    executorInput: { prompt: '试着写到外面', workspace: dir, write: true },
  });
  const done = await settle(executor, 'assign-3');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.existsSync(outside), false);
  assert.ok(done.activity.some(item => item.kind === 'error'));
});

test('写权限打开后可以在工作目录里生成文件', async () => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-agent-'));
  const hub = fakeModelHub([
    '{"tool":"write_file","args":{"path":"out/note.txt","content":"hello"}}',
    '{"final":{"summary":"写好了","files":["out/note.txt"]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '写一个文件' }, { id: 'assign-5' }, {
    executorInput: { prompt: '写一个文件', workspace: dir, write: true },
  });
  const done = await settle(executor, 'assign-5');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.readFileSync(path.join(dir, 'out', 'note.txt'), 'utf8'), 'hello');
});

test('未配置模型时启动直接报 503，而不是假装在跑', () => {
  const store = memoryStore();
  const executor = modelExecutor({ store, cwd: process.cwd(), context: () => null, fetchImpl: async () => { throw new Error('不该调用'); } });
  assert.throws(
    () => executor.start({ command: '随便做点什么' }, { id: 'assign-4' }, { executorInput: { prompt: '随便做点什么' } }),
    error => error.status === 503 && /还没有可用的模型/.test(error.message),
  );
});

test('输入校验：空目标、非法步数、相对工作目录都会被拒绝', () => {
  const store = memoryStore();
  const executor = modelExecutor({ store, cwd: process.cwd(), context: () => null });
  assert.throws(() => executor.validateInput({ prompt: '' }), /非空字符串/);
  assert.throws(() => executor.validateInput({ prompt: '做点事', maxSteps: 99 }), /maxSteps/);
  assert.throws(() => executor.validateInput({ prompt: '做点事', workspace: 'relative/dir' }), /绝对路径/);
  assert.throws(() => executor.validateInput({ prompt: '做点事', effort: 'high; rm -rf' }), /effort/);
});

test('会话级模型与思考强度会一起传给模型中心', async () => {
  const store = memoryStore();
  const seen = [];
  const hub = fakeModelHub(['{"final":{"summary":"好","files":[]}}']);
  const executor = modelExecutor({
    store,
    cwd: process.cwd(),
    context: () => hub.context(),
    contextFor: (profileId, effort) => { seen.push([profileId, effort]); return hub.context(); },
    fetchImpl: fakeFetch(hub),
  });
  executor.start({ command: '打个招呼' }, { id: 'assign-5' }, {
    executorInput: { prompt: '打个招呼', profileId: 'profile-abc', effort: 'high' },
  });
  const done = await settle(executor, 'assign-5');
  assert.equal(done.status, 'completed', done.error || '');
  assert.deepEqual(seen, [['profile-abc', 'high']]);
  assert.equal(done.artifacts.cli.modelLabel, 'deepseek-chat');
});

test('写权限打开后可以删文件，试运行只报数量不动手', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-delete-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b');
  const hub = fakeModelHub([
    '{"tool":"delete_path","args":{"path":".","recursive":true,"dryRun":true}}',
    '{"tool":"delete_path","args":{"path":"a.txt"}}',
    '{"tool":"delete_path","args":{"path":"sub","recursive":true}}',
    '{"final":{"summary":"删掉了 a.txt 和 sub 目录","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '删掉文件' }, { id: 'assign-del' }, {
    executorInput: { prompt: '删掉文件', workspace: dir, write: true },
  });
  const done = await settle(executor, 'assign-del');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false, 'a.txt 应被删除');
  assert.equal(fs.existsSync(path.join(dir, 'sub')), false, 'sub 目录应被删除');
  const observations = done.activity
    .filter(item => item.kind === 'observation')
    .map(item => `${item.text || ''} ${item.detail || ''}`);
  assert.ok(observations.some(text => /试运行/.test(text)), '试运行时要说清没真删');
  assert.ok(done.artifacts.cli.artifacts.some(name => /已删除/.test(name)), '删除要落进改动清单');
});

test('删除不能越界，也不能删工作目录本身', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-delete-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const outside = path.join(os.tmpdir(), `keep-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'keep');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'delete_path', args: { path: '../' + path.basename(outside) } }),
    '{"tool":"delete_path","args":{"path":"."}}',
    '{"final":{"summary":"两次都被拒了","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '试着乱删' }, { id: 'assign-guard' }, {
    executorInput: { prompt: '试着乱删', workspace: dir, write: true },
  });
  const done = await settle(executor, 'assign-guard');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.existsSync(outside), true, '工作目录外的文件不能被删');
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true, '工作目录本身不能被删');
  assert.equal(done.activity.filter(item => item.kind === 'error').length, 2);
});

test('没有写权限时 delete_path 被拒绝', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-delete-denied-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const hub = fakeModelHub([
    '{"tool":"delete_path","args":{"path":"a.txt"}}',
    '{"final":{"summary":"没有权限，没删","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '删掉文件' }, { id: 'assign-denied' }, {
    executorInput: { prompt: '删掉文件', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-denied');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
  assert.ok(done.activity.some(item => item.kind === 'error'));
});
