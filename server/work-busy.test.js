import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';

const stamp = () => new Date().toISOString();

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-busy-'));
  const app = createApp({ dataDir: dir, workEnabled: true, serveStatic: false });
  t.after(() => { app.locals.close(); rmSync(dir, { recursive: true, force: true }); });
  return { app };
}

test('执行中的 Work 工单会让工作区保持忙碌', t => {
  const { app } = setup(t);
  assert.equal(app.locals.isBusy(), false);
  app.locals.store.put('work-ticket', { id: 'ticket-1', status: 'working', createdAt: stamp(), updatedAt: stamp() });
  assert.equal(app.locals.isBusy(), true);
  app.locals.store.put('work-ticket', { id: 'ticket-1', status: 'completed', createdAt: stamp(), updatedAt: stamp() });
  assert.equal(app.locals.isBusy(), false);
});

test('排队中的 Work 工单不会阻止工作区空闲回收', t => {
  const { app } = setup(t);
  app.locals.store.put('work-ticket', { id: 'ticket-2', status: 'queued', createdAt: stamp(), updatedAt: stamp() });
  assert.equal(app.locals.isBusy(), false);
});
