import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.js';
import { stageReply } from './stage-reply-fixture.js';

test('模型中心可经应用配置并启动真实阶段任务，PDF重试不重复收费', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'lagent-multi-api-'));
  let calls = 0, pdfCalls = 0;
  const app = createApp({ dataDir: dir, credentialMasterKey: Buffer.alloc(32, 7).toString('base64'), fetchImpl: async (_url, init) => { calls++; return Response.json({ choices: [{ message: { content: JSON.stringify(stageReply(JSON.parse(init.body))) } }] }); }, analysisTool: async () => ({}), pdfBuilder: async () => { pdfCalls++; return Buffer.from('%PDF-1.7\ntest'); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (route, method = 'GET', body) => { const response = await fetch(base + '/api' + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, ...await response.json() }; };
  const hub = await api('/model-hub'); assert.equal(hub.status, 200, hub.error);
  const saved = await api('/model-credentials', 'POST', { name: '测试凭据', provider: 'test', baseUrl: 'https://test.example/v1', protocol: 'chat-completions', apiKey: 'fake-api-private-key' }); assert.equal(saved.status, 200, saved.error);
  const profile = await api('/model-profiles', 'POST', { name: '阶段模型', credentialId: saved.credential.id, model: 'mock-model' }); assert.equal(profile.status, 200, profile.error);
  const config = await api('/workflow-config', 'PUT', { ...hub.workflow, defaultProfileId: profile.profile.id }); assert.equal(config.status, 200, config.error);
  const boot = await api('/bootstrap'); assert.equal(boot.settings.hasKey, true); assert.equal(boot.settings.workflowEnabled, true);
  const created = await api('/tasks', 'POST', { title: '阶段API', goal: '检查覆盖', datasetId: boot.datasets[0].id, mode: 'automatic', useAI: true }); assert.equal(created.status, 201, created.error);
  let task;
  for (let i = 0; i < 200; i++) { task = (await api(`/tasks/${created.task.id}`)).task; if (['completed', 'failed'].includes(task.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(task.status, 'completed', task.error); assert.equal(task.steps.length, 13); assert.ok(calls >= 8);
  assert.equal(JSON.stringify(task).includes('fake-api-private-key'), false);
  assert.equal((await api('/wallet')).wallet.spent, 20);
  const pdf = await fetch(base + `/api/tasks/${task.id}/report.pdf`); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /application\/pdf/); assert.match(await pdf.text(), /^%PDF/);
  assert.equal(pdfCalls, 1); assert.equal((await api('/wallet')).wallet.spent, 20);
  const changed = app.locals.store.get('task', task.id); changed.report.summary += ' 已更改'; app.locals.store.put('task', changed);
  const stale = await fetch(base + `/api/tasks/${task.id}/report.pdf`); assert.equal(stale.status, 409); assert.equal(pdfCalls, 1);
});
