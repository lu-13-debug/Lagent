import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-trace-'));
  const store = new Store(dir);
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, usage: { input_tokens: 10, output_tokens: 5 }, artifacts: { terminal: { command: 'pwd', exitCode: 0 } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine };
}

test('工单 trace 聚合执行、报告、用量与事件', t => {
  const { engine } = fixture(t);
  const ticket = engine.command({ text: '跑一次', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } });
  assert.equal(ticket.status, 'completed');

  const trace = engine.ticketTrace(ticket.id);
  assert.equal(trace.ticket.id, ticket.id);
  assert.ok(trace.spans.length >= 3);
  const kinds = new Set(trace.spans.map(span => span.kind));
  assert.ok(kinds.has('assignment'));
  assert.ok(kinds.has('report'));
  assert.ok(kinds.has('usage'));
  assert.ok(kinds.has('event'));
  assert.ok(trace.spans.every(span => typeof span.at === 'string'));
  const sorted = [...trace.spans].map(span => span.at);
  assert.deepEqual(sorted, [...sorted].sort());

  assert.equal(trace.summary.assignments, 1);
  assert.ok(trace.summary.reports >= 1);
  assert.ok(trace.summary.events >= 1);
  assert.equal(trace.summary.calls, 1);
  assert.equal(trace.summary.tokens, 15);
  assert.equal(typeof trace.summary.durationMs, 'number');
});

test('不存在的工单 trace 返回 404', t => {
  const { engine } = fixture(t);
  assert.throws(() => engine.ticketTrace('missing'), { status: 404 });
});
