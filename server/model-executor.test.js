import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { modelExecutor, normalizeModelInput, safeSearchExpression } from './work/executors/model.js';

function memoryStore() {
  const rows = new Map();
  return {
    put: (kind, body) => { rows.set(`${kind}:${body.id}`, structuredClone(body)); return body; },
    get: (kind, id) => (rows.has(`${kind}:${id}`) ? structuredClone(rows.get(`${kind}:${id}`)) : null),
    list: kind => [...rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, body]) => structuredClone(body)),
    delete: (kind, id) => { rows.delete(`${kind}:${id}`); },
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

// 越界访问会挂起等用户回答：这个辅助函数在测试里扮演「用户点批准/退回」。
async function answerAccess(executor, taskId, decision = 'allow', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let answered = 0;
  while (Date.now() < deadline) {
    const task = executor.get(taskId);
    if (task && task.status === 'awaiting_approval') {
      executor.approve(task, { decision });
      answered += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      continue;
    }
    if (task && ['completed', 'failed', 'cancelled'].includes(task.status)) return { task, answered };
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('等待授权超时');
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

test('长结论保留完整正文，供计划后续步骤使用', async () => {
  const store = memoryStore();
  const long = '分工说明'.repeat(1200); // 4800 字，超过工单摘要的 4000 字上限
  const hub = fakeModelHub([JSON.stringify({ final: { summary: long, files: [] } })]);
  const executor = modelExecutor({ store, cwd: process.cwd(), context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '给出完整分工' }, { id: 'assign-long' }, {
    executorInput: { prompt: '给出完整分工', workspace: process.cwd(), write: false },
  });
  const done = await settle(executor, 'assign-long');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.artifacts.cli.summary.length, 4000, '界面摘要仍限制在 4000 字');
  assert.equal(done.artifacts.cli.detail.length, 4800, '完整正文不能被 4000 字截断');
  assert.ok(done.artifacts.cli.detail.endsWith('分工说明'));
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

test('写入被限制在工作目录内，越界路径要问一次，拒绝后不落盘', async () => {
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
  const { task: done, answered } = await answerAccess(executor, 'assign-3', 'deny');
  assert.equal(answered, 1, '越界写入要先问用户');
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

test('项目计划传入的 maxTurns 会变成模型步数预算，不再退回 12 步', () => {
  // 引擎给项目执行器传 maxTurns，模型的一步就是一次工具调用，必须复用这个预算。
  assert.equal(normalizeModelInput({ prompt: '做点事', maxTurns: 60 }).maxSteps, 60);
  assert.equal(normalizeModelInput({ prompt: '做点事', maxTurns: 120 }).maxSteps, 60, '超过模型上限时夹到 60，而不是让整条计划报 400');
  assert.equal(normalizeModelInput({ prompt: '做点事' }).maxSteps, 20);
  assert.throws(() => normalizeModelInput({ prompt: '做点事', maxTurns: 0 }), /maxTurns/);
  assert.equal(normalizeModelInput({ prompt: '做点事', maxSteps: 3, maxTurns: 60 }).maxSteps, 3, '显式 maxSteps 优先');
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
    executorInput: { prompt: '删掉文件', workspace: dir, write: true, confirmDanger: false },
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
  // 越界的那次会先弹窗：这里选择拒绝。
  const { task: done, answered } = await answerAccess(executor, 'assign-guard', 'deny');
  assert.equal(answered, 1, '只有工作目录外的那次需要询问');
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
  // 工具被拒 + 结论说「没有权限」= 任务没达成，不能报完成。
  assert.equal(done.status, 'failed');
  assert.match(String(done.error || ''), /没有完成/);
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), true);
  assert.ok(done.activity.some(item => item.kind === 'error'));
});

test('工作目录之外的读取会先问一次，批准后读到内容', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-out-read-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'model-out-other-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(other, 'note.txt'), '外部目录里的内容');
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'read_file', args: { path: path.join(other, 'note.txt') } }),
    JSON.stringify({ tool: 'read_file', args: { path: path.join(other, 'note.txt') } }),
    JSON.stringify({ tool: 'write_file', args: { path: 'copied.txt', content: '外部目录里的内容' } }),
    '{"final":{"summary":"先读外部再写回工作目录","files":["copied.txt"]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '读外面的文件' }, { id: 'assign-out-read' }, {
    executorInput: { prompt: '读外面的文件', workspace: dir, write: true },
  });
  const { task: done, answered } = await answerAccess(executor, 'assign-out-read', 'allow');
  assert.equal(answered, 1, '同一个文件读两次也只问一次');
  assert.equal(done.status, 'completed', done.error || '');
  assert.ok(done.activity.some(item => item.kind === 'waiting' && /请求读取/.test(item.text || '')));
  const observed = done.activity.filter(item => item.kind === 'observation').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /note\.txt/);
  assert.equal(fs.readFileSync(path.join(dir, 'copied.txt'), 'utf8'), '外部目录里的内容');
});

test('拒绝越界访问后不再执行，并留下可读的原因', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-out-deny-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'model-out-deny2-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const target = path.join(other, 'secret.txt');
  fs.writeFileSync(target, '不该被读走');
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'read_file', args: { path: target } }),
    '{"final":{"summary":"被拒绝了，停止","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '试着读外面' }, { id: 'assign-out-deny' }, {
    executorInput: { prompt: '试着读外面', workspace: dir, write: false },
  });
  const { task: done, answered } = await answerAccess(executor, 'assign-out-deny', 'deny');
  assert.equal(answered, 1);
  assert.equal(done.status, 'completed', done.error || '');
  const errors = done.activity.filter(item => item.kind === 'error').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(errors, /用户拒绝了读取权限/);
  assert.equal(done.accessRequest, undefined, '回答之后不应再有挂起的请求');
});

test('长期授权的额外目录不再询问', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-roots-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'model-roots-extra-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(other, 'lib.txt'), '共享目录');
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'read_file', args: { path: path.join(other, 'lib.txt') } }),
    '{"final":{"summary":"读完了","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '读共享目录' }, { id: 'assign-roots' }, {
    executorInput: { prompt: '读共享目录', workspace: dir, write: false, roots: [other] },
  });
  const done = await settle(executor, 'assign-roots');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '授权目录不应再弹窗');
  const observed = done.activity.filter(item => item.kind === 'observation').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /lib\.txt/);
});

test('完全权限模式下写工作目录外的文件不再询问', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-full-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'model-full-extra-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const outside = path.join(other, 'outside.txt');
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'write_file', args: { path: outside, content: '完全权限' } }),
    '{"final":{"summary":"写完了","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '写到外面的目录' }, { id: 'assign-full' }, {
    executorInput: { prompt: '写到外面的目录', workspace: dir, permission: 'full', write: true },
  });
  const done = await settle(executor, 'assign-full');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '完全权限不该再弹窗');
  assert.equal(fs.readFileSync(outside, 'utf8'), '完全权限');
});

test('仅查看模式下写文件直接被拒绝，不等用户点允许', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'blocked.txt');
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'write_file', args: { path: target, content: '不该落盘' } }),
    '{"final":{"summary":"写不了","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '尝试写文件' }, { id: 'assign-read' }, {
    executorInput: { prompt: '尝试写文件', workspace: dir, permission: 'read' },
  });
  const done = await settle(executor, 'assign-read');
  assert.equal(fs.existsSync(target), false);
  const observed = done.activity.map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /仅查看/);
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '仅查看模式不该弹窗，应直接拒绝');
});

test('白名单外的命令要确认，拒绝就不执行', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cmd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = 'node -e "require(\'fs\').writeFileSync(\'made.txt\',\'x\')"';
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'run_command', args: { command } }),
    '{"final":{"summary":"命令被拒绝","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '跑个命令' }, { id: 'assign-cmd-deny' }, {
    executorInput: { prompt: '跑个命令', workspace: dir, write: true },
  });
  const { task: done, answered } = await answerAccess(executor, 'assign-cmd-deny', 'deny');
  assert.equal(answered, 1, '白名单外的命令必须询问');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.existsSync(path.join(dir, 'made.txt')), false, '被拒绝的命令不能产生副作用');
  assert.ok(done.activity.some(item => item.kind === 'waiting' && /请求执行命令/.test(item.text || '')));
});

test('只读白名单内的命令直接执行，不弹窗', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cmd-ok-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
  const hub = fakeModelHub([
    '{"tool":"run_command","args":{"command":"node --check a.js"}}',
    '{"final":{"summary":"语法没问题","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '查语法' }, { id: 'assign-cmd-ok' }, {
    executorInput: { prompt: '查语法', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-cmd-ok');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false);
  const observed = done.activity.filter(item => item.kind === 'observation').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /退出码 0/);
});

// 用户抱怨过"点不完"：只是看看目录里有什么，不该每次都弹确认框。
test('查看目录的命令不用逐次确认，直接执行', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cmd-list-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'readme.md'), 'hello\n');
  const hub = fakeModelHub([
    '{"tool":"run_command","args":{"command":"Get-ChildItem","shell":"powershell"}}',
    '{"final":{"summary":"目录里只有一个 readme.md","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '看看目录' }, { id: 'assign-cmd-list' }, {
    executorInput: { prompt: '看看目录', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-cmd-list');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '查看类命令不该弹确认');
  const observed = done.activity.filter(item => item.kind === 'observation').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /运行命令/);
  assert.match(observed, /退出码 0|目录/);
});

// 真实踩过的坑：模型常把「看文件前几行」写成 `Get-Content x | Select -First 5`，
// 管道让它掉出只读白名单，于是一个纯查看动作也要用户点一次允许。
test('管道只是整理输出时也不用逐次确认', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cmd-pipe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  const hub = fakeModelHub([
    '{"tool":"run_command","args":{"command":"Get-Content notes.txt | Select-Object -First 2"}}',
    '{"final":{"summary":"前两行是 alpha 和 beta","files":[]}}'
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '看文件前两行' }, { id: 'assign-cmd-pipe' }, {
    executorInput: { prompt: '看文件前两行', workspace: dir, write: false }
  });
  const done = await settle(executor, 'assign-cmd-pipe');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '只读的管道命令不该弹确认');
  const observed = done.activity.filter(item => item.kind === 'observation').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /alpha/);
});

// 真实踩过的坑：模型一次看「改了什么」会连着写 `git status; git log`，
// 分号让它掉出只读白名单，于是整条计划停在第一次确认上。
test('分号连起来的只读命令也不用逐次确认', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cmd-semi-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  const hub = fakeModelHub([
    '{"tool":"run_command","args":{"command":"Get-ChildItem; Get-Content a.txt"}}',
    '{"final":{"summary":"目录里只有 a.txt","files":[]}}'
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '看看目录和文件' }, { id: 'assign-cmd-semi' }, {
    executorInput: { prompt: '看看目录和文件', workspace: dir, write: false }
  });
  const done = await settle(executor, 'assign-cmd-semi');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '只读命令连起来跑也不该弹确认');
});

// 反过来：分号里只要有一段会写文件，仍然要问。
test('分号里有写操作时仍然要确认', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-cmd-semi-write-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = fakeModelHub([
    '{"tool":"run_command","args":{"command":"Get-ChildItem; Set-Content -Path evil.txt -Value hi"}}',
    '{"final":{"summary":"没写成","files":[]}}'
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '试着写个文件' }, { id: 'assign-cmd-semi-write' }, {
    executorInput: { prompt: '试着写个文件', workspace: dir, write: true, permission: 'workspace' }
  });
  const done = await settle(executor, 'assign-cmd-semi-write');
  assert.ok(done.activity.some(item => item.kind === 'waiting'), '写操作必须让用户确认');
});

// 真实踩过的坑：`cmd.exe /d /s /c "powershell -Command "..."` 会把内层引号吃掉，
// PowerShell 只回显脚本、退出码还是 0 —— 命令看着成功，其实什么都没做。
test('shell=powershell 的脚本带引号也能真正执行，不会被 cmd 吃掉', async t => {
  if (process.platform !== 'win32') { t.skip('只在 Windows 上有 cmd 引号问题'); return; }
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pwsh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'y');
  const command = `Get-ChildItem -Path '${dir}' -Filter 'gone.txt' | Remove-Item -Force; Get-ChildItem -Path '${dir}' | Select-Object -ExpandProperty Name`;
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'run_command', args: { command, shell: 'powershell' } }),
    '{"final":{"summary":"删掉了 gone.txt","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '删掉 gone.txt' }, { id: 'assign-pwsh' }, {
    executorInput: { prompt: '删掉 gone.txt', workspace: dir, write: true, permission: 'workspace' },
  });
  const { task: done } = await answerAccess(executor, 'assign-pwsh');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false, '脚本必须真的执行，而不是只被回显');
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  const observed = done.activity.filter(item => item.kind === 'observation').map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(observed, /退出码 0/);
  assert.match(observed, /keep\.txt/);
});

test('步数用完还没做完的工单标成失败，不再报「已完成」', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-steps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // 每一步都在读同一个文件，永远不给 final
  const hub = fakeModelHub(Array.from({ length: 8 }, () => '{"tool":"list_files","args":{"path":"."}}'));
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '一直读' }, { id: 'assign-steps' }, {
    executorInput: { prompt: '一直读', workspace: dir, write: false, maxSteps: 3 },
  });
  const done = await settle(executor, 'assign-steps', 6000);
  assert.equal(done.status, 'failed');
  assert.match(String(done.error || ''), /步数上限/);
  assert.equal(done.artifacts.cli.exitCode, 1);
});

test('协调/验收/汇总步骤的「没做完」是报告结论，不把报告本身判失败', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-report-role-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = fakeModelHub([
    '{"final":{"done":false,"summary":"只做了分工：两位协作 Agent 分别独立统计，再交叉验收。","files":[]}}'
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '分工' }, { id: 'assign-report-role' }, {
    executorInput: { prompt: '分工', workspace: dir, write: false, role: 'coordination' }
  });
  const done = await settle(executor, 'assign-report-role');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.artifacts.cli.exitCode, 0);
  assert.match(done.artifacts.cli.summary, /只做了分工/);

  // 同样的措辞出现在执行型步骤里，仍然要按「没做完」判失败。
  const workerHub = fakeModelHub([
    '{"final":{"done":false,"summary":"只做了分工：两位协作 Agent 分别独立统计。","files":[]}}'
  ]);
  const worker = modelExecutor({ store, cwd: dir, context: () => workerHub.context(), fetchImpl: fakeFetch(workerHub) });
  worker.start({ command: '执行' }, { id: 'assign-worker-role' }, {
    executorInput: { prompt: '执行', workspace: dir, write: false }
  });
  const failed = await settle(worker, 'assign-worker-role');
  assert.equal(failed.status, 'failed');
  assert.match(String(failed.error || ''), /任务没有完成/);
});

test('read_office 直接读出 pptx 文字，不需要 PowerShell 解压', async t => {
  const JSZip = (await import('jszip')).default;
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-office-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>科学饮食系统</a:t><a:t>需求：记录每日摄入</a:t></p:sld>');
  fs.writeFileSync(path.join(dir, '课程要求.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const hub = fakeModelHub([
    '{"tool":"read_office","args":{"path":"课程要求.pptx"}}',
    '{"final":{"summary":"读完了","files":[]}}',
  ]);
  const seen = [];
  const fetchImpl = async (_url, options) => {
    seen.push(JSON.parse(options.body));
    const content = hub.reply();
    const body = { choices: [{ message: { content } }], usage: {} };
    return {
      ok: true, status: 200, headers: { get: () => null },
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl });
  executor.start({ command: '读课程要求' }, { id: 'assign-office' }, {
    executorInput: { prompt: '读课程要求', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-office');
  assert.equal(done.status, 'completed', done.error || '');
  const conversation = JSON.stringify(seen);
  assert.match(conversation, /科学饮食系统/);
  assert.match(conversation, /需求：记录每日摄入/);
});

test('模型自己说「没有权限、没执行」时标成失败，而不是已完成', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-refuse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = fakeModelHub([
    JSON.stringify({ final: { summary: '未执行删除：本 Agent 没有写权限，D:\\test 下没有删除任何文件。', files: [] } }),
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '删掉所有文件' }, { id: 'assign-refuse' }, {
    executorInput: { prompt: '删掉所有文件', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-refuse');
  assert.equal(done.status, 'failed');
  assert.match(String(done.error || ''), /没有完成/);
  assert.match(String(done.artifacts.cli.summary || ''), /没有写权限/);
});

test('确实改了文件又给出结论的，仍然是完成', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-done-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = fakeModelHub([
    JSON.stringify({ tool: 'write_file', args: { path: 'note.txt', content: 'hi' } }),
    JSON.stringify({ final: { summary: '写好了 note.txt', files: ['note.txt'] } }),
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '写个文件' }, { id: 'assign-done' }, {
    executorInput: { prompt: '写个文件', workspace: dir, write: true },
  });
  const done = await settle(executor, 'assign-done');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8'), 'hi');
});



test('replace_in_file 精确替换，多处时要显式 all', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-replace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'foo bar foo');
  const hub = fakeModelHub([
    '{"tool":"replace_in_file","args":{"path":"a.txt","find":"foo","replace":"baz"}}',
    '{"tool":"replace_in_file","args":{"path":"a.txt","find":"foo","replace":"baz","all":true}}',
    '{"tool":"replace_in_file","args":{"path":"a.txt","find":"nope","replace":"x"}}',
    '{"final":{"summary":"替换完成","files":["a.txt"]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '改文本' }, { id: 'assign-replace' }, {
    executorInput: { prompt: '改文本', workspace: dir, write: true },
  });
  const done = await settle(executor, 'assign-replace');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'baz bar baz');
  const text = done.activity.map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(text, /找到 2 处/);
  assert.match(text, /没找到|没有在/);
});

test('受保护路径永远拒绝，连询问都不给', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '.env'), 'TOKEN=1');
  const hub = fakeModelHub([
    '{"tool":"read_file","args":{"path":".env"}}',
    '{"final":{"summary":"读不到","files":[]}}',
  ]);
  const executor = modelExecutor({ store, cwd: dir, context: () => hub.context(), fetchImpl: fakeFetch(hub) });
  executor.start({ command: '读密钥' }, { id: 'assign-secret' }, {
    executorInput: { prompt: '读密钥', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-secret');
  assert.equal(done.status, 'completed', done.error || '');
  assert.equal(done.activity.some(item => item.kind === 'waiting'), false, '受保护路径不弹窗');
  const text = done.activity.map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(text, /受保护/);
});

test('project_changes 工具把项目改动清单交给模型，不必整篇重读文件', async t => {
  const store = memoryStore();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-changes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'game.js'), '// 已经改过');
  const brief = ['【项目现状 · 由 Lagent 维护】', '最近的改动（新的在前）：', '- 08:40 · claude-code · 加了输入处理', '  动了：game.js、input.js'].join('\n');
  const hub = fakeModelHub([
    '{"tool":"project_changes","args":{}}',
    '{"final":{"summary":"看过了","files":[]}}',
  ]);
  const seen = [];
  const executor = modelExecutor({
    store,
    cwd: dir,
    context: () => hub.context(),
    fetchImpl: fakeFetch(hub),
    projectState: workspace => { seen.push(workspace); return brief; },
  });
  executor.start({ command: '接手改动' }, { id: 'assign-changes' }, {
    executorInput: { prompt: '接手改动', workspace: dir, write: false },
  });
  const done = await settle(executor, 'assign-changes');
  assert.equal(done.status, 'completed', done.error || '');
  assert.deepEqual(seen, [dir], '按工作目录去问项目现状');
  const text = done.activity.map(item => `${item.text || ''} ${item.detail || ''}`).join('\n');
  assert.match(text, /看改动|项目现状/);
  assert.match(text, /input\.js/, '清单里要能看出别人动了哪些文件');
});

test('服务重启后失效的确认请求返回 false，而不是把工单写成执行中', () => {
  const store = memoryStore();
  const executor = modelExecutor({ store, cwd: process.cwd(), context: () => null });
  // 进程内没有挂起的确认（服务重启/任务已结束）：引擎必须知道这次审批没法继续。
  assert.equal(executor.approve({ id: 'gone', status: 'awaiting_approval' }, { decision: 'allow' }), false);
  assert.equal(executor.reject({ id: 'gone', status: 'awaiting_approval' }), false);
});

test('重启后遗留的 running 任务由 resume 让路，交给引擎重新开跑', () => {
  const store = memoryStore();
  const executor = modelExecutor({ store, cwd: process.cwd(), context: () => null });
  store.put('task', { id: 'stale', status: 'running', activity: [] });
  assert.equal(executor.resume(store.get('task', 'stale')), false);
  assert.equal(store.get('task', 'stale'), null, '旧循环记录要清掉，start 才能重新创建');
});

test('搜索正则拒绝灾难性回溯写法，普通关键字照常可用', () => {
  assert.ok(safeSearchExpression('useEffect') instanceof RegExp);
  assert.ok(safeSearchExpression('foo.*bar') instanceof RegExp);
  for (const pattern of ['(a+)+', '(x*)*', '(a)\\1']) {
    assert.throws(() => safeSearchExpression(pattern), { status: 400 }, pattern);
  }
  assert.throws(() => safeSearchExpression('a'.repeat(201)), { status: 400 });
});
