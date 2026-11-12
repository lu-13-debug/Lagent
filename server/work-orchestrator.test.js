import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createRunStore, RUN_STATUS } from './work/orchestrator/runs.js';

test('运行重启后活跃 run 被标为 paused，可续跑', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-runs-'));
  const store = new Store(dir);
  const runs = createRunStore({ store, clock: () => '2026-11-12T00:00:00Z' });
  const a = runs.create({ goal: 'g1' });
  const b = runs.create({ goal: 'g2' });
  const c = runs.create({ goal: 'g3' });
  runs.setStatus(a, RUN_STATUS.running);
  runs.setStatus(b, RUN_STATUS.verifying);
  runs.setStatus(c, RUN_STATUS.completed);

  const stale = runs.markPaused();
  assert.deepEqual(stale.sort(), [a.id, b.id].sort());
  assert.equal(runs.get(a.id).status, RUN_STATUS.paused);
  assert.equal(runs.get(b.id).status, RUN_STATUS.paused);
  assert.equal(runs.get(c.id).status, RUN_STATUS.completed);

  const resumed = runs.markResumable(a.id);
  assert.equal(resumed.status, RUN_STATUS.running);
  assert.equal(resumed.error, null);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('updateStep 持久化步骤状态，续跑时可读取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-runs-step-'));
  const store = new Store(dir);
  const runs = createRunStore({ store, clock: () => '2026-11-12T00:00:00Z' });
  const run = runs.create({ goal: 'g' });
  run.steps = [
    { index: 0, role: '调研', status: 'done', executorId: 'claude-code', ticketId: 't1', summary: 'ok', startedAt: 'a', endedAt: 'b' },
    { index: 1, role: '实现', status: 'running', executorId: 'codex', ticketId: 't2', summary: '', startedAt: 'c', endedAt: null }
  ];
  runs.save(run);

  const reloaded = runs.get(run.id);
  assert.equal(reloaded.steps[0].status, 'done');
  assert.equal(reloaded.steps[1].status, 'running');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});
