import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpBridge, createMcpClient, loadMcpServers } from './work/mcp-client.js';
import { modelExecutor } from './work/executors/model.js';
import { Store } from './store.js';

const SERVER = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
rl.on('line', line => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'calc', version: '1.0.0' } } });
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'add', description: '相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] } });
  if (message.method === 'tools/call') {
    const value = message.params?.arguments || {};
    return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(Number(value.a) + Number(value.b)) }] } });
  }
  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } });
});
`;

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-mcp-client-'));
  const script = join(dir, 'server.cjs');
  writeFileSync(script, SERVER);
  return { dir, script };
}

function cleanup(t, dir, close) {
  // 先关子进程再删临时目录；Windows 上未退出的子进程会锁住 cwd。
  t.after(async () => {
    try { await close?.(); } catch { /* 用例已失败时仍要清理。 */ }
    await new Promise(resolve => setTimeout(resolve, 100));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
}

test('MCP 客户端完成 initialize / tools/list / tools/call', async t => {
  const f = fixture(t);
  const client = createMcpClient({ id: 'calc', name: '计算器', command: process.execPath, args: [f.script], cwd: f.dir, env: { ...process.env } });
  cleanup(t, f.dir, () => client.close());
  const init = await client.initialize();
  assert.equal(init.serverInfo.name, 'calc');
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'add');
  assert.equal(tools[0].inputSchema.properties.a.type, 'number');
  const result = await client.callTool('add', { a: 2, b: 40 });
  assert.equal(result.content, '42');
});

test('MCP 工具桥映射工具名并转发调用', async t => {
  const f = fixture(t);
  const bridge = createMcpBridge({ servers: [{ id: 'calc', name: 'calc', command: process.execPath, args: [f.script], cwd: f.dir, env: { ...process.env }, enabled: true }] });
  cleanup(t, f.dir, () => bridge.close());
  const connected = await bridge.connect();
  assert.equal(connected.tools, 1);
  assert.equal(bridge.health()[0].ok, true);
  const schemas = bridge.schemas();
  assert.equal(schemas[0].function.name, 'mcp__calc__add');
  assert.equal(schemas[0].function.parameters.required[0], 'a');
  assert.equal(bridge.owns('mcp__calc__add'), true);
  const result = await bridge.call('mcp__calc__add', { a: 5, b: 7 });
  assert.equal(result.content, '12');
  await assert.rejects(bridge.call('mcp__calc__missing', {}), { status: 404 });
});

test('MCP 白名单只暴露指定工具', async t => {
  const f = fixture(t);
  const bridge = createMcpBridge({ servers: [{ id: 'calc', command: process.execPath, args: [f.script], cwd: f.dir, env: { ...process.env }, enabled: true, tools: ['subtract'] }] });
  cleanup(t, f.dir, () => bridge.close());
  await bridge.connect();
  assert.equal(bridge.schemas().length, 0);
  assert.equal(bridge.health()[0].tools, 1);
});

test('MCP 配置读取：托管配置可用，项目 .mcp.json 需显式开启', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-mcp-config-'));
  const store = new Store(join(dir, 'data'));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { calc: { command: process.execPath, args: ['server.cjs'] } } }));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.config('mcp-servers-v1:alice', [{ id: 'managed', name: 'managed', command: 'npx', args: ['-y', 'some-server'], env: { PATH: process.env.PATH, SECRET_TOKEN: 'x'.repeat(20) }, enabled: true }]);
  const managed = loadMcpServers({ store, ownerId: 'alice', workspace: dir, env: {} });
  assert.equal(managed.length, 1);
  assert.equal(managed[0].id, 'managed');
  assert.equal(managed[0].env.SECRET_TOKEN, 'x'.repeat(20));
  assert.equal(managed[0].env.PATH, process.env.PATH);
  const project = loadMcpServers({ store, ownerId: 'alice', workspace: dir, env: { LAGENT_MCP_PROJECT_CONFIG: '1' } });
  assert.equal(project.length, 2);
  assert.ok(project.some(row => row.id === 'calc'));
  // 未列入允许命令的服务器被静默丢弃，不会执行任意程序。
  store.config('mcp-servers-v1:alice', [{ id: 'bad', command: 'powershell', args: ['-Command', 'rm -rf /'] }]);
  assert.equal(loadMcpServers({ store, ownerId: 'alice', workspace: dir, env: {} }).length, 0);
});

test('内置模型 Agent 可以调用 MCP 工具并记录过程', async t => {
  const f = fixture(t);
  const rows = new Map();
  const store = {
    put: (kind, body) => { rows.set(`${kind}:${body.id}`, structuredClone(body)); return body; },
    get: (kind, id) => rows.has(`${kind}:${id}`) ? structuredClone(rows.get(`${kind}:${id}`)) : null,
    list: kind => [...rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, body]) => structuredClone(body))
  };
  const replies = ['{"tool":"mcp__calc__add","args":{"a":2,"b":40}}', '{"final":{"summary":"两数相加等于 42","files":[]}}'];
  const executor = modelExecutor({
    store,
    cwd: f.dir,
    context: () => ({ settings: { provider: 'demo', baseUrl: 'https://api.example.com/v1', model: 'demo' }, key: 'x'.repeat(20), maxTokens: 800, timeoutMs: 5000 }),
    fetchImpl: async () => {
      const content = replies.shift() || '{"final":{"summary":"结束","files":[]}}';
      const body = { choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      return { ok: true, status: 200, headers: { get: () => null }, async json() { return body; }, async text() { return JSON.stringify(body); } };
    },
    mcpServers: async () => [{ id: 'calc', name: 'calc', command: process.execPath, args: [f.script], cwd: f.dir, env: { ...process.env }, enabled: true }]
  });
  cleanup(t, f.dir, () => executor.close());
  executor.start({ command: '算一下 2+40' }, { id: 'mcp-task' }, { executorInput: { prompt: '算一下 2+40', workspace: f.dir, write: false } });
  const deadline = Date.now() + 8000;
  let task;
  while (Date.now() < deadline) {
    task = executor.get('mcp-task');
    if (task && task.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(task.status, 'completed', task.error || '');
  const texts = task.activity.map(item => `${item.text} ${item.detail || ''}`).join('\n');
  assert.match(texts, /mcp__calc__add/);
  assert.match(texts, /42|完成/);
  assert.deepEqual(task.mcpHealth.map(row => row.ok), [true]);
});

test('MCP 客户端超时与关闭', async t => {
  const f = fixture(t);
  const silent = join(f.dir, 'silent.cjs');
  writeFileSync(silent, 'process.stdin.resume(); setInterval(() => {}, 1000);');
  const client = createMcpClient({ id: 'silent', command: process.execPath, args: [silent], cwd: f.dir, env: { ...process.env }, timeoutMs: 200 });
  cleanup(t, f.dir, () => client.close());
  await assert.rejects(client.initialize(), { code: 'MCP_TIMEOUT' });
  await client.close();
  await assert.rejects(client.initialize(), { status: 409 });
});
