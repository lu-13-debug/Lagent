import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-work-policy-'));
  const store = new Store(dir);
  const analysis = { id: 'analysis', name: '分析', kind: 'analysis', available: true, requiresDataset: true, capabilities: [], start() { throw new Error('unused'); }, get() { return null; } };
  const codex = { id: 'codex', name: 'Codex', kind: 'cli', available: true, capabilities: [], validateInput: input => input, start() { throw new Error('unused'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([analysis, codex]), () => {}, { env: { ...process.env, DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, engine };
}

test('Work policy 默认拒绝外部执行器并允许 analysis/terminal', t => {
  const { engine } = fixture(t);
  const policy = engine.policy();
  assert.deepEqual(policy.allowedExecutors, ['analysis', 'terminal']);
  assert.equal(policy.requireApproval, true);
  assert.throws(() => engine.command({ text: '读取仓库', executorId: 'codex', executorInput: { prompt: 'hi' } }), { status: 403 });
  assert.equal(engine.command({ text: '检查活跃' }).executor, 'analysis');
});

test('Work policy 需要策略允许与外部开关同时成立', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-work-policy-env-'));
  const store = new Store(dir);
  const codex = { id: 'codex', name: 'Codex', kind: 'cli', available: true, capabilities: [], validateInput: input => input, start() { throw new Error('unused'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([codex]), () => {}, { policy: { allowedExecutors: ['codex'] }, env: { DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => engine.command({ text: '读取', executorId: 'codex', executorInput: { prompt: 'hi' } }), { status: 403 });
  const enabled = createWorkEngine(store, createExecutorRegistry([codex]), () => {}, { policy: { allowedExecutors: ['codex'] }, env: { DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' } });
  t.after(() => enabled.close());
  assert.equal(enabled.command({ text: '读取', executorId: 'codex', executorInput: { prompt: 'hi' } }).executor, 'codex');
});

test('Work policy 校验白名单字段并写脱敏审计', t => {
  const { store, engine } = fixture(t);
  const policy = engine.updatePolicy({ allowedExecutors: ['analysis'], budgets: { maxConcurrent: 1, maxCallsPerTicket: 1, maxRuntimeMs: 1000, maxTokensPerTicket: 1000 } });
  assert.deepEqual(policy.allowedExecutors, ['analysis']);
  assert.throws(() => engine.updatePolicy({ allowedExecutors: ['shell'] }), { status: 400 });
  assert.throws(() => engine.command({ text: 'secret-goal', executorId: 'codex', executorInput: { prompt: 'secret-prompt' } }), { status: 403 });
  const audits = store.list('work-audit');
  assert.equal(audits[0].result, 'denied');
  assert.equal(audits[0].executor, 'codex');
  assert.doesNotMatch(JSON.stringify(audits), /secret-goal|secret-prompt|token/);
  assert.ok(store.get('work-policy', 'default'));
});

test('Work policy 的 acpWrites 默认开启、可关闭且只接受布尔值', t => {
  const { engine } = fixture(t);
  assert.equal(engine.policy().limits.acpWrites, true);
  const off = engine.updatePolicy({ limits: { acpWrites: false } });
  assert.equal(off.limits.acpWrites, false);
  assert.equal(engine.policy().limits.acpWrites, false);
  assert.throws(() => engine.updatePolicy({ limits: { acpWrites: 'no' } }), { status: 400 });
  const on = engine.updatePolicy({ limits: { acpWrites: true, browserHosts: [], githubRepos: [] } });
  assert.equal(on.limits.acpWrites, true);
});
