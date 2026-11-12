import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { buildRoster } from './work/roster.js';

const agents = [
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code', 'writes'] },
  { id: 'browser', name: '浏览器', kind: 'tool', status: 'needs_setup', capabilities: ['browser'] },
  { id: 'terminal', name: '受控终端', kind: 'tool', status: 'available', capabilities: ['commands'] }
];

test('档案按历史工单与用量计算成功率、成本与擅长任务', () => {
  const tickets = [
    { id: 't1', executor: 'claude-code', status: 'completed', updatedAt: '2026-11-12T01:00:00.000Z' },
    { id: 't2', executor: 'claude-code', status: 'failed', updatedAt: '2026-11-12T02:00:00.000Z' },
    { id: 't3', executor: 'claude-code', status: 'completed', updatedAt: '2026-11-12T03:00:00.000Z' },
    { id: 't4', executor: 'terminal', status: 'completed', updatedAt: '2026-11-12T01:30:00.000Z' }
  ];
  const usage = [
    { executorId: 'claude-code', calls: 2, totalTokens: 3000, durationMs: 2000, costEstimate: 0.02 },
    { executorId: 'terminal', calls: 1, totalTokens: 10, durationMs: 100, costEstimate: 0 }
  ];
  const roster = buildRoster({ agents, tickets, usage, policy: { allowedExecutors: ['claude-code', 'terminal'], permission: 'workspace' } });
  assert.equal(roster.length, 3);

  const claude = roster.find(entry => entry.id === 'claude-code');
  assert.equal(claude.reliability.finished, 3);
  assert.equal(claude.reliability.succeeded, 2);
  assert.equal(claude.reliability.failed, 1);
  assert.equal(claude.reliability.successRate, 0.67);
  assert.equal(claude.costProfile.avgTokens, 1500);
  assert.equal(claude.bestFor, '实现与修复');
  assert.equal(claude.permissions.allowed, true);
  assert.equal(claude.lastUsedAt, '2026-11-12T03:00:00.000Z');

  const browser = roster.find(entry => entry.id === 'browser');
  assert.equal(browser.health, 'needs_setup');
  assert.equal(browser.permissions.allowed, false);
  assert.equal(browser.bestFor, '网页读取');
  assert.equal(browser.reliability.successRate, null);

  // available 的排前面，needs_setup 的排后面。
  assert.ok(roster.findIndex(entry => entry.health === 'available') < roster.findIndex(entry => entry.health === 'needs_setup'));
});

test('引擎 agentRoster 聚合真实工单与用量', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-roster-'));
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

  const ticket = engine.command({ text: '跑一次', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } });
  assert.equal(ticket.status, 'completed');

  const roster = engine.agentRoster();
  const row = roster.find(entry => entry.id === 'terminal');
  assert.ok(row);
  assert.equal(row.health, 'available');
  assert.equal(row.reliability.finished, 1);
  assert.equal(row.reliability.succeeded, 1);
  assert.equal(row.reliability.successRate, 1);
  assert.equal(row.costProfile.totalTokens, 15);
  assert.equal(row.costProfile.avgTokens, 15);
  assert.equal(row.bestFor, '验证与命令');
});
