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
  assert.equal(done.status, 'completed', done.error || '');
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
