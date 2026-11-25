import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const module = await import('./app.js').catch(() => ({}));
let nextPort = 23000 + Math.floor(Math.random() * 10000);

async function setup(t, options = {}) {
  assert.equal(typeof module.createApp, 'function', '必须提供 createApp');
  const dir = await mkdtemp(path.join(tmpdir(), 'lagent-test-'));
  let app = module.createApp({ dataDir: dir, ...options });
  let server = app.listen(nextPort++, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); await rm(dir, { recursive: true, force: true }); });
  const api = async (route, method = 'GET', body, headers = {}) => {
    const res = await fetch(base + route, { method, headers: { ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
    const data = await res.json();
    return { status: res.status, ...data };
  };
  const restart = async () => {
    await new Promise(resolve => server.close(resolve)); app.locals.close();
    app = module.createApp({ dataDir: dir, ...options });
    server = app.listen(nextPort++, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  };
  return { api, base, dir, app, restart };
}

test('本地服务只暴露指挥台需要的运行时能力，旧数据分析接口已下线', async t => {
  const { api } = await setup(t);
  const runtime = await api('/api/runtime');
  assert.equal(runtime.status, 200);
  assert.equal(runtime.serviceName, 'Lagent');
  assert.equal(runtime.capabilities.memory, true);
  assert.equal(runtime.capabilities.modelUsage, true);
  assert.equal(runtime.capabilities.superagent, true);
  assert.equal(runtime.capabilities.walletVersion, undefined);
  assert.equal(runtime.capabilities.reportExplore, undefined);
  assert.equal((await api('/api/datasets/demo', 'POST', {})).status, 404);
  assert.equal((await api('/api/tasks')).status, 404);
  const boot = await api('/api/bootstrap');
  assert.equal(boot.tasks, undefined);
  assert.equal(boot.datasets, undefined);
  assert.equal(typeof boot.settings, 'object');
  assert.equal((await api('/api/health')).ok, true);
});

test('Memory本地显式CRUD、非法输入与软删除恢复', async t => {
  const { api } = await setup(t); assert.equal((await api('/api/runtime')).capabilities.memory, true);
  assert.equal((await api('/api/memory', 'POST', { scope: 'bad', type: 'preference', key: '语言', value: '中文' })).status, 400);
  const saved = await api('/api/memory', 'POST', { scope: 'user', type: 'preference', key: '语言', value: '中文', status: 'confirmed' }); assert.equal(saved.status, 201);
  const id = saved.memory.id; assert.equal((await api(`/api/memory/${id}`, 'PATCH', { value: '简体中文' })).memory.version, 2);
  assert.equal((await api(`/api/memory/${id}`, 'DELETE')).memory.enabled, false);
  assert.equal((await api(`/api/memory/${id}`, 'PATCH', { enabled: true })).memory.enabled, true);
  assert.equal((await api('/api/memory?scope=project')).memories.length, 0);
  assert.equal((await api('/api/memory?ownerId=other')).memories.length, 1);
});

test('模型用量接口校验范围且只输出用量数据', async t => {
  const { api, app } = await setup(t);
  app.locals.store.put('task', { id: 'usage-task', status: 'completed' });
  app.locals.store.put('model-call', { id: 'usage-test', taskId: 'usage-task', stageId: 'insights', stageName: '洞察', kind: 'stage', provider: '测试', model: 'mock', protocol: 'chat-completions', recordedAt: new Date().toISOString(), inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal((await api('/api/runtime')).capabilities.modelUsage, true);
  const usage = await api('/api/model-usage?days=30');
  assert.equal(usage.status, 200); assert.equal(usage.totals.totalTokens, 15); assert.equal(usage.byTask[0].taskId, 'usage-task');
  assert.equal((await api('/api/model-usage?days=invalid')).status, 400);
  assert.equal((await api('/api/model-usage?days=7&days=30')).status, 400);
  assert.equal(JSON.stringify(usage).includes('goal'), false);
});

test('settings never expose or persist key and cross-site mutation is denied', async t => {
  const { api, dir } = await setup(t);
  const secret = 'secret-test-never-persist-123';
  let result = await api('/api/settings', 'PUT', { provider: '兼容服务', baseUrl: 'http://127.0.0.1:9876/v1', model: 'local', apiKey: secret });
  assert.equal(result.settings.hasKey, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal((await api('/api/settings', 'PUT', { provider: 'x', baseUrl: 'http://example.com/v1', model: 'x' })).status, 400);
  assert.equal((await api('/api/settings', 'PUT', { provider: '兼容服务', baseUrl: 'http://127.0.0.1:9876/v1', model: 'local' }, { origin: 'https://evil.example' })).status, 403);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    assert.equal((await readFile(path.join(dir, entry.name))).includes(Buffer.from(secret)), false);
  }
  result = await api('/api/settings', 'PUT', { provider: '兼容服务', baseUrl: 'http://127.0.0.1:9876/v1', model: 'local', clearKey: true });
  assert.equal(result.settings.hasKey, false);
});
