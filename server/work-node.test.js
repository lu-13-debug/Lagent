import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { createExecutorRegistry } from './work/executors/index.js';
import { createNodeHub, loadNodeSecret, signNodeToken, verifyNodeToken } from './work/node-hub.js';
import { registerNodeRoutes } from './work/node-routes.js';
import { normalizePolicy } from './application/policy/model.js';

function memoryStore() {
  const rows = new Map();
  const listeners = new Set();
  return {
    // 和真实 store 一致：只有 task 写入会通知订阅者，引擎就是靠这个回收执行器状态。
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    put: (kind, body) => {
      rows.set(`${kind}:${body.id}`, structuredClone(body));
      if (kind === 'task') for (const listener of listeners) listener(body);
      return body;
    },
    get: (kind, id) => (rows.has(`${kind}:${id}`) ? structuredClone(rows.get(`${kind}:${id}`)) : null),
    list: kind => [...rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, body]) => structuredClone(body))
  };
}

function harness() {
  const store = memoryStore();
  const registry = createExecutorRegistry([{
    id: 'model', name: 'Lagent', kind: 'model', available: true,
    validateInput: value => value, start: () => ({ id: 'x' }), get: () => null
  }]);
  const policy = { allowedExecutors: ['model'] };
  const engine = {
    policy: () => ({ allowedExecutors: [...policy.allowedExecutors] }),
    updatePolicy: input => { policy.allowedExecutors = [...input.allowedExecutors]; }
  };
  const hub = createNodeHub({ store, registry, engine, now: () => 1_700_000_000_000 });
  return { store, registry, hub, policy };
}

test('节点令牌：签名可验证，篡改与过期都会被拒', () => {
  const secret = 'x'.repeat(32);
  const token = signNodeToken(secret, { nodeId: 'n1', userId: 'u1', now: 1000, ttlMs: 5000 });
  assert.deepEqual(verifyNodeToken(secret, token, 2000), { nodeId: 'n1', userId: 'u1' });
  assert.equal(verifyNodeToken(secret, `${token}x`, 2000), null);
  assert.equal(verifyNodeToken('y'.repeat(32), token, 2000), null);
  assert.equal(verifyNodeToken(secret, token, 9000), null, '过期令牌必须失效');
  assert.equal(verifyNodeToken(secret, 'not-a-token', 2000), null);
});

test('密钥落在数据目录里，重启后仍然是同一个', () => {
  const dir = `./.node-secret-test-${process.pid}`;
  const first = loadNodeSecret(dir, {});
  const second = loadNodeSecret(dir, {});
  assert.equal(first, second);
  assert.ok(first.length >= 32);
  assert.equal(loadNodeSecret(dir, { LAGENT_NODE_SECRET: 'z'.repeat(20) }), 'z'.repeat(20));
  import('node:fs').then(({ rmSync }) => rmSync(dir, { recursive: true, force: true }));
});

test('节点注册后执行器出现、进入策略白名单，断开后全部收回', () => {
  const { registry, hub, policy } = harness();
  const { agents } = hub.registerNode({
    nodeId: 'abcdef1234567890',
    userId: 'u1',
    agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'cli' }, { id: 'codex', name: 'Codex', kind: 'cli' }]
  });
  // 服务器上原本没有同名执行器时，直接沿用 claude-code / codex 这两个 id，界面无需改动。
  assert.deepEqual(agents.map(agent => agent.executorId), ['claude-code', 'codex']);
  const listed = registry.list().map(agent => agent.id);
  assert.ok(listed.includes('claude-code'));
  assert.equal(registry.resolve('codex').name, 'Codex（本机）');
  assert.ok(policy.allowedExecutors.includes('claude-code'), '节点执行器要自动进入策略白名单');

  hub.unregisterNode('abcdef1234567890');
  assert.deepEqual(registry.list().map(agent => agent.id), ['model']);
  assert.deepEqual(policy.allowedExecutors, ['model']);
});

test('任务从排队到完成：长轮询领取，过程与结果回传给引擎', async () => {
  const { registry, hub } = harness();
  const { agents } = hub.registerNode({ nodeId: 'nodeaaaa1111', userId: 'u1', agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'cli' }] });
  const executor = registry.resolve(agents[0].executorId);

  const task = executor.start({ id: 'ticket-1' }, { id: 'assign-1' }, { executorInput: { prompt: '看看目录' } });
  assert.equal(task.status, 'queued');
  assert.equal(task.ticketId, 'ticket-1');

  const claimed = await hub.nextJob('nodeaaaa1111', 1000);
  assert.equal(claimed.job.id, task.id);
  assert.deepEqual(claimed.job.input, { prompt: '看看目录' });
  assert.equal(executor.get(task.id).status, 'running');

  hub.updateJob('nodeaaaa1111', task.id, { status: 'running', task: { status: 'running', activity: [{ at: '2026-01-01T00:00:00.000Z', kind: 'note', text: '正在读取目录' }] } });
  const running = executor.get(task.id);
  assert.equal(running.status, 'running');
  assert.match(running.activity[0].text, /正在读取目录/);

  hub.updateJob('nodeaaaa1111', task.id, {
    status: 'completed',
    task: { status: 'completed', activity: [], artifacts: { cli: { summary: '目录里有两个文件', usage: { input_tokens: 10 } } } }
  });
  const done = executor.get(task.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.artifacts.cli.summary, '目录里有两个文件');
  assert.equal(done.id, task.id, '任务 id 必须与工单分配的 sessionId 一致');
});

test('节点任务的进度写成 task 记录并触发通知，工单才能从执行中收尾', async () => {
  const { store, registry, hub } = harness();
  const { agents } = hub.registerNode({ nodeId: 'nodebbbb2222', userId: 'u1', agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'cli' }] });
  const executor = registry.resolve(agents[0].executorId);
  const notified = [];
  store.subscribe(body => notified.push(body.status));

  const task = executor.start({ id: 'ticket-2' }, { id: 'assign-2' }, { executorInput: { prompt: '列目录' } });
  assert.equal(store.get('task', task.id).status, 'queued', '领任务前也要有 task 记录');
  await hub.nextJob('nodebbbb2222', 1000);
  hub.updateJob('nodebbbb2222', task.id, { status: 'completed', task: { status: 'completed', activity: [] } });

  assert.equal(store.get('task', task.id).status, 'completed');
  assert.deepEqual(notified, ['queued', 'completed'], '每次状态变化都要通知引擎');
});

test('节点断开时，排队中的任务直接失败，不会永远卡住', async () => {
  const { registry, hub } = harness();
  const { agents } = hub.registerNode({ nodeId: 'nodebbbb2222', userId: 'u1', agents: [{ id: 'codex', name: 'Codex', kind: 'cli' }] });
  const executor = registry.resolve(agents[0].executorId);
  const task = executor.start({ id: 'ticket-2' }, { id: 'assign-2' }, { executorInput: { prompt: '跑一下' } });
  hub.unregisterNode('nodebbbb2222');
  const job = hub.getJob(task.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /断开/);
});

test('服务器上未安装的同名执行器被本机顶替，断开后原样放回；第二台电脑自动加前缀', () => {
  const store = memoryStore();
  const registry = createExecutorRegistry([
    { id: 'model', name: 'Lagent', kind: 'model', available: true, validateInput: value => value, start: () => ({}) },
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', available: false, validateInput: value => value, start: () => ({}) }
  ]);
  const policy = { allowedExecutors: ['model', 'claude-code'] };
  const engine = {
    policy: () => ({ allowedExecutors: [...policy.allowedExecutors] }),
    updatePolicy: input => { policy.allowedExecutors = [...input.allowedExecutors]; }
  };
  const hub = createNodeHub({ store, registry, engine, now: () => 1 });

  const first = hub.registerNode({ nodeId: 'pc1111111111', userId: 'u1', agents: [{ id: 'claude-code', name: 'Claude Code' }] });
  assert.equal(first.agents[0].executorId, 'claude-code', '顶替掉服务器上那个不可用的同名执行器');
  assert.equal(registry.resolve('claude-code').available, true);
  assert.match(registry.resolve('claude-code').name, /本机/);

  const second = hub.registerNode({ nodeId: 'pc2222222222', userId: 'u1', agents: [{ id: 'claude-code', name: 'Claude Code' }] });
  assert.equal(second.agents[0].executorId, 'node-pc222222-claude-code', '第二台电脑不能顶掉第一台');

  hub.unregisterNode('pc2222222222');
  assert.match(registry.resolve('claude-code').name, /本机/, '第一台仍然在线');

  hub.unregisterNode('pc1111111111');
  assert.equal(registry.resolve('claude-code').available, false, '断开后恢复成「未安装」的内置执行器');
  assert.equal(registry.resolve('claude-code').name, 'Claude Code');
});

test('策略白名单接受本机节点执行器，仍然拒绝真正未知的 id', () => {
  const policy = normalizePolicy({ allowedExecutors: ['analysis', 'node-1a2b3c4d-claude-code'] });
  assert.deepEqual(policy.allowedExecutors, ['analysis', 'node-1a2b3c4d-claude-code']);
  assert.throws(() => normalizePolicy({ allowedExecutors: ['analysis', 'evil-executor'] }), /未知执行器/);
});

test('没有上报任何 Agent 的节点会被拒绝', () => {
  const { hub } = harness();
  assert.throws(() => hub.registerNode({ nodeId: 'n1', userId: 'u1', agents: [] }), /没有上报/);
  assert.throws(() => hub.registerNode({ nodeId: 'n1', userId: 'u1', agents: [{ id: 'BAD ID' }] }), /没有上报/);
});

async function withServer(handler) {
  const app = express();
  const nodeRouter = express.Router();
  app.use('/api/node', nodeRouter);
  app.use(express.json({ limit: '128kb' }));
  handler(nodeRouter, app);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

test('节点接口：注册发令牌，令牌可用，未注册的节点被要求重注册', async () => {
  const { hub } = harness();
  const secret = 's'.repeat(32);
  const { base, close } = await withServer(nodeRouter => {
    registerNodeRoutes(nodeRouter, { resolveHub: () => hub, authenticate: () => 'u1', secret });
  });
  try {
    const registered = await fetch(`${base}/api/node/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'cli' }] })
    });
    assert.equal(registered.status, 201);
    const body = await registered.json();
    assert.ok(body.token);
    assert.deepEqual(verifyNodeToken(secret, body.token, Date.now()), { nodeId: body.nodeId, userId: 'u1' });

    const empty = await fetch(`${base}/api/node/next?wait=0`, { headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(empty.status, 204);

    const anonymous = await fetch(`${base}/api/node/next?wait=0`);
    assert.equal(anonymous.status, 401);

    const forged = await fetch(`${base}/api/node/next?wait=0`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(forged.status, 401);

    hub.unregisterNode(body.nodeId);
    const stale = await fetch(`${base}/api/node/next?wait=0`, { headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(stale.status, 409, '节点被清理后要求重新注册');
  } finally { await close(); }
});
