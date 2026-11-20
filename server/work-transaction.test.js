import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import {
  compensationPlan, latestCheckpoint, listCompensations, normalizeCompensation,
  recordCheckpoint, rememberCompensations
} from './work/transaction.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-transaction-'));
  const store = new Store(dir);
  const executor = {
    id: 'terminal', name: 'Mock', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    start() { throw new Error('not used'); },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, {
    workspace: dir,
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    policy: { allowedExecutors: ['terminal'] }
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine };
}

test('补偿清单按完成步骤逆序生成，跳过我声明和未完成步骤', () => {
  const plan = {
    id: 'p',
    steps: [
      { index: 0, ticketId: 'a', executorId: 'terminal', compensate: { command: 'node --test undo-a.test.mjs' } },
      { index: 1, ticketId: 'b', executorId: 'terminal', compensate: 'node --test undo-b.test.mjs' },
      { index: 2, ticketId: 'c', executorId: 'terminal' },
      { index: 3, ticketId: 'd', executorId: 'terminal', compensate: { command: 'node undo-d.mjs' } }
    ]
  };
  const tickets = [
    { id: 'a', status: 'completed' },
    { id: 'b', status: 'completed' },
    { id: 'c', status: 'completed' },
    { id: 'd', status: 'failed' }
  ];
  const rows = compensationPlan(plan, tickets);
  assert.deepEqual(rows.map(row => row.step), [1, 0]);
  assert.match(rows[0].command, /undo-b/);
  assert.equal(normalizeCompensation('   '), null);
  assert.equal(normalizeCompensation({ label: '没有命令' }), null);
});

test('检查点记录最新完成步骤，回滚按逆序执行并留下状态', async t => {
  const { dir, store, engine } = fixture(t);
  recordCheckpoint(store, {
    planId: 'plan1',
    step: 1,
    tickets: [{ id: 'a', status: 'completed', executor: 'terminal', title: '第一步', planStep: 0 }],
    files: ['a.txt']
  });
  const checkpoint = latestCheckpoint(store, 'plan1');
  assert.equal(checkpoint.completed.length, 1);
  assert.deepEqual(checkpoint.files, ['a.txt']);

  writeFileSync(join(dir, 'undo-a.test.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('a.rolled.txt', 'a');\n");
  writeFileSync(join(dir, 'undo-b.test.mjs'), "import { writeFileSync } from 'node:fs'; writeFileSync('b.rolled.txt', 'b');\n");
  store.put('work-project', { id: 'project1', name: 'P', path: dir, createdAt: new Date().toISOString() });
  store.put('work-plan', { id: 'plan1', status: 'failed', projectId: 'project1', steps: [], createdAt: new Date().toISOString() });
  rememberCompensations(store, 'plan1', [
    { step: 0, ticketId: 'a', executor: 'terminal', label: '撤销 A', command: 'node --test undo-a.test.mjs' },
    { step: 1, ticketId: 'b', executor: 'terminal', label: '撤销 B', command: 'node --test undo-b.test.mjs' }
  ]);
  assert.deepEqual(listCompensations(store, 'plan1').map(row => row.step), [1, 0]);

  const result = await engine.rollbackPlan('plan1');
  assert.equal(result.results.length, 2);
  assert.ok(result.compensations.every(row => row.status === 'done'));
  assert.ok(existsSync(join(dir, 'a.rolled.txt')));
  assert.ok(existsSync(join(dir, 'b.rolled.txt')));
});
