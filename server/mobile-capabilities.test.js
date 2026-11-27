import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { MobileGateway, registerMobileWorkRoutes } from './mobile-gateway.js';

const tempDir = prefix => mkdtempSync(join(tmpdir(), prefix));

async function serve(app) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function request(base, path, { method = 'GET', body, token } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

function fixture(t) {
  const dir = tempDir('mobile-capabilities-');
  const tools = [
    { id: 'builtin:terminal', name: '受控终端', source: 'builtin', risk: 'high', description: '执行命令', enabled: true, available: true },
    { id: 'mcp:files:read_file', name: 'files · read_file', source: 'mcp', risk: 'medium', description: '读取文件', enabled: false, available: true }
  ];
  const toolRegistry = {
    list: () => tools,
    summary: () => ({ total: tools.length, enabled: tools.filter(tool => tool.enabled).length, bySource: {}, byRisk: {} }),
    setState: (id, { enabled }) => {
      const tool = tools.find(item => item.id === id);
      if (!tool) throw Object.assign(new Error('工具不存在'), { status: 404 });
      tool.enabled = enabled;
      return { ...tool };
    }
  };
  const installed = [];
  const engine = {
    agentMarketCatalog: async () => ({
      listings: [
        { id: 'builtin:code-review', name: '代码审查', description: '按风险排序', executorId: 'claude-code', permission: 'read', instructions: ['先看 diff'], skills: [], builtin: true, installed: false },
        { id: 'remote:team:audit', name: '团队审计', description: '只读审计', executorId: 'model', permission: 'read', instructions: [], skills: ['s1'], builtin: false, remote: true, installed: false }
      ],
      remote: { configured: true, url: 'https://example.com/market.json', listings: [] }
    }),
    installAgentBundle: async id => {
      installed.push(id);
      if (id === 'remote:missing') throw Object.assign(new Error('远程配置不存在'), { status: 404 });
      return { profile: { id: 'p1', name: '代码审查' } };
    }
  };
  const gateway = new MobileGateway({ dataDir: join(dir, 'gateway') });
  const app = express();
  app.use(express.json());
  registerMobileWorkRoutes(app, gateway, { engine, ownerId: 'owner-a', toolRegistry });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  t.after(() => {
    gateway.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const pair = gateway.createPair('owner-a');
  const token = gateway.claim(pair.code, '测试手机', 'actor-mobile').deviceToken;
  return { app, token, installed };
}

test('手机端能力：工具清单只下发展示字段，可在手机上启停', async t => {
  const { app, token } = fixture(t);
  const { server, base } = await serve(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  assert.equal((await request(base, '/api/mobile/capabilities')).status, 401);

  const catalog = await (await request(base, '/api/mobile/capabilities', { token })).json();
  assert.equal(catalog.tools.length, 2);
  assert.deepEqual(Object.keys(catalog.tools[0]).sort(), ['available', 'description', 'enabled', 'id', 'name', 'risk', 'source']);
  assert.equal(catalog.summary.enabled, 1);

  const toggled = await request(base, '/api/mobile/tools/builtin%3Aterminal/state', { method: 'POST', token, body: { enabled: false } });
  assert.equal(toggled.status, 200);
  assert.equal((await toggled.json()).tool.enabled, false);

  const invalid = await request(base, '/api/mobile/tools/builtin%3Aterminal/state', { method: 'POST', token, body: { enabled: 'no' } });
  assert.equal(invalid.status, 400);

  const missing = await request(base, '/api/mobile/tools/missing/state', { method: 'POST', token, body: { enabled: true } });
  assert.equal(missing.status, 404);
});

test('手机端能力：市场清单可列出远程配置并安装，不下发指令正文', async t => {
  const { app, token, installed } = fixture(t);
  const { server, base } = await serve(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  const catalog = await (await request(base, '/api/mobile/capabilities', { token })).json();
  assert.equal(catalog.market.listings.length, 2);
  const remote = catalog.market.listings.find(row => row.remote);
  assert.equal(remote.name, '团队审计');
  assert.equal(remote.skills, 1);
  assert.equal('instructionsText' in remote, false);
  assert.equal(catalog.market.remote.configured, true);

  const install = await request(base, '/api/mobile/market/remote%3Ateam%3Aaudit/install', { method: 'POST', token, body: {} });
  assert.equal(install.status, 201);
  assert.equal((await install.json()).profile.name, '代码审查');
  assert.deepEqual(installed, ['remote:team:audit']);

  const missing = await request(base, '/api/mobile/market/remote%3Amissing/install', { method: 'POST', token, body: {} });
  assert.equal(missing.status, 404);
});
