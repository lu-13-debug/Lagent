import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-policy-'));
  const store = new Store(dir);
  const analysis = { id: 'analysis', name: '分析', kind: 'analysis', available: true, requiresDataset: true, capabilities: [], start() { throw new Error('unused'); }, get() { return null; } };
  const codex = { id: 'codex', name: 'Codex', kind: 'cli', available: true, capabilities: [], validateInput: input => input, start() { throw new Error('unused'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([analysis, codex]), () => {}, { env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, engine };
}

test('Work policy 默认拒绝外部执行器并允许 analysis/terminal', t => {
  const { engine } = fixture(t);
  const policy = engine.policy();
  assert.deepEqual(policy.allowedExecutors, ['analysis', 'terminal']);
  // 默认不再「先批准再执行」，信任由权限模式表达。
  assert.equal(policy.requireApproval, false);
  assert.equal(policy.permission, 'workspace');
  assert.throws(() => engine.command({ text: '读取仓库', executorId: 'codex', executorInput: { prompt: 'hi' } }), { status: 403 });
  assert.equal(engine.command({ text: '检查活跃' }).executor, 'analysis');
});

test('Work policy 需要策略允许与外部开关同时成立', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-policy-env-'));
  const store = new Store(dir);
  const codex = { id: 'codex', name: 'Codex', kind: 'cli', available: true, capabilities: [], validateInput: input => input, start() { throw new Error('unused'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([codex]), () => {}, { policy: { allowedExecutors: ['codex'] }, env: { LAGENT_ALLOW_EXTERNAL_EXECUTORS: '' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => engine.command({ text: '读取', executorId: 'codex', executorInput: { prompt: 'hi' } }), { status: 403 });
  const enabled = createWorkEngine(store, createExecutorRegistry([codex]), () => {}, { policy: { allowedExecutors: ['codex'] }, env: { LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' } });
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

test('Work policy 的三档权限决定写权限与危险操作确认', t => {
  const { engine } = fixture(t);
  const initial = engine.policy();
  assert.equal(initial.permission, 'workspace');
  assert.equal(initial.limits.modelWrites, true);
  assert.equal(initial.limits.acpWrites, true);
  assert.equal(initial.limits.confirmDanger, true);

  const read = engine.updatePolicy({ permission: 'read' });
  assert.equal(read.permission, 'read');
  assert.equal(read.limits.modelWrites, false);
  assert.equal(read.limits.acpWrites, false);
  assert.equal(read.limits.confirmDanger, false);

  const full = engine.updatePolicy({ permission: 'full' });
  assert.equal(full.permission, 'full');
  assert.equal(full.limits.modelWrites, true);
  assert.equal(full.limits.confirmDanger, false);

  assert.throws(() => engine.updatePolicy({ permission: 'root' }), { status: 400 });
  // 旧开关不再反向覆盖权限模式：传 modelWrites:false 也不会让 workspace 变只读。
  const back = engine.updatePolicy({ permission: 'workspace', limits: { modelWrites: false, browserHosts: [], githubRepos: [] } });
  assert.equal(back.permission, 'workspace');
  assert.equal(back.limits.modelWrites, true);
});
