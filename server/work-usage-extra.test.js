import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { Store } from './store.js';
import { registerWork } from './work/routes.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { summarizeUsage, usageEntry } from './work/usage.js';
import { scanHistoricalUsage } from './work/session-usage.js';

test('用量汇总：按项目、缓存命中与 80% 预算告警', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-extra-'));
  const store = new Store(dir);
  store.put('work-usage', usageEntry({ ticketId: 't1', executorId: 'claude-code', projectId: 'p1', calls: 1, tokensIn: 100, tokensOut: 50, cacheReadTokens: 300, cacheWriteTokens: 20, totalTokens: 150, costEstimate: 0.02, model: 'claude-sonnet-5-5', now: '2026-11-14T02:00:00.000Z' }));
  store.put('work-usage', usageEntry({ ticketId: 't2', executorId: 'codex', projectId: 'p2', calls: 1, tokensIn: 20, tokensOut: 20, totalTokens: 40, costEstimate: 0.01, model: 'gpt-5', now: '2026-11-14T03:00:00.000Z' }));
  const history = [usageEntry({ executorId: 'claude-code', projectId: '', calls: 1, tokensIn: 10, tokensOut: 10, cacheReadTokens: 30, totalTokens: 20, source: 'history', now: '2026-11-14T04:00:00.000Z' })];

  const report = summarizeUsage(store, { days: 'all', extraRows: history, budgetTokens: 100, now: '2026-11-14T12:00:00.000Z' });
  assert.equal(report.totals.calls, 3);
  assert.equal(report.totals.cacheReadTokens, 330);
  assert.equal(report.totals.tokensIn, 130);
  assert.deepEqual(report.byProject.map(row => row.projectId), ['p1', 'p2', '']);
  assert.equal(report.byProject[0].totalTokens, 150);
  assert.equal(report.alerts.topProject.projectId, 'p1');
  assert.equal(report.alerts.topTicket.ticketId, 't1');
  assert.equal(report.alerts.today.date, '2026-11-14');
  assert.equal(Number(report.alerts.cacheHitRate.toFixed(4)), 0.7174);
  // 工单 t1 用了 150 / 100，达到 80% 告警线。
  const warning = report.budget.warnings.find(row => row.ticketId === 't1');
  assert.ok(warning);
  assert.equal(warning.ratio, 1.5);
  assert.equal(report.budget.warnings.some(row => row.ticketId === 't2'), false);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('工单用量达到 80% 时发布一次预算告警事件', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-warning-'));
  const store = new Store(dir);
  const published = [];
  const cli = {
    id: 'codex', name: 'Codex', kind: 'cli', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ prompt: text }), validateInput: input => input,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: { cli: { usage: { input_tokens: 850, output_tokens: 50, total_tokens: 900 } } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([cli]), event => published.push(event), {
    workspace: dir,
    policy: { allowedExecutors: ['codex'], budgets: { maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 1000 } },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' }
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const ticket = engine.command({ text: '预算告警', executorId: 'codex', executorInput: { prompt: 'x' } });
  const deadline = Date.now() + 8000;
  while (!store.list('work-event').some(event => event.type === 'usage-alert')) {
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const alerts = store.list('work-event').filter(event => event.type === 'usage-alert');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ticketId, ticket.id);
  assert.equal(alerts[0].payload.status, 'budget_warning');
  assert.match(alerts[0].payload.summary, /900/);
  assert.ok(published.some(event => event.type === 'usage-alert' && event.ticketId === ticket.id));
});

test('历史会话扫描：Claude 与 Codex 只提取用量并做增量', () => {
  const home = mkdtempSync(join(tmpdir(), 'lagent-history-'));
  const claudeDir = join(home, '.claude', 'projects', 'demo');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'session-a.jsonl'), [
    JSON.stringify({ sessionId: 'claude-session', cwd: '/work/demo', timestamp: '2026-11-13T10:00:00.000Z', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } }),
    JSON.stringify({ sessionId: 'claude-session', cwd: '/work/demo', timestamp: '2026-11-13T10:05:00.000Z', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 } } }),
    '{broken json'
  ].join('\n'));

  const codexDir = join(home, '.codex', 'sessions', '2026', '11', '14');
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(join(codexDir, 'rollout.jsonl'), [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'codex-session', cwd: '/work/codex-demo' } }),
    JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model: 'gpt-5', cwd: '/work/codex-demo' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 10, total_tokens: 120 } } }, timestamp: '2026-11-14T01:00:00.000Z' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 300, output_tokens: 60, cached_input_tokens: 30, total_tokens: 360 } } }, timestamp: '2026-11-14T01:10:00.000Z' })
  ].join('\n'));

  const result = scanHistoricalUsage({ home, environment: {} });
  assert.deepEqual(result.scanned, { files: 2, claudeFiles: 1, codexFiles: 1 });
  assert.equal(result.entries.length, 2);
  const claude = result.entries.find(row => row.executorId === 'claude-code');
  assert.equal(claude.sessionId, 'claude-session');
  assert.equal(claude.model, 'claude-sonnet-5-5');
  assert.equal(claude.tokensIn, 30);
  assert.equal(claude.tokensOut, 15);
  assert.equal(claude.cacheReadTokens, 140);
  assert.equal(claude.cacheWriteTokens, 20);
  assert.equal(claude.totalTokens, 45);
  assert.equal(claude.calls, 2);
  assert.equal(claude.source, 'history');
  assert.equal(claude.costEstimate, 0);

  const codex = result.entries.find(row => row.executorId === 'codex');
  assert.equal(codex.sessionId, 'codex-session');
  assert.equal(codex.model, 'gpt-5');
  // 累计值取增量：100→300 输入、20→60 输出。
  assert.equal(codex.tokensIn, 300);
  assert.equal(codex.tokensOut, 60);
  assert.equal(codex.cacheReadTokens, 30);
  assert.equal(codex.totalTokens, 360);

  // 第二次读取命中文件缓存，结果稳定。
  assert.deepEqual(scanHistoricalUsage({ home, environment: {} }).entries, result.entries);
  rmSync(home, { recursive: true, force: true });
});

test('路由：用量汇总与 CSV 导出包含缓存、项目与费用列', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-usage-route-'));
  const store = new Store(dir);
  const terminal = {
    id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: ['commands'],
    validateInput: input => input, start() { throw new Error('unused'); }, get() { return null; }
  };
  const app = express();
  app.use(express.json());
  const closeWork = registerWork(app, store, createExecutorRegistry([terminal]), { isSessionValid: () => true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); closeWork(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;

  store.put('work-usage', usageEntry({ ticketId: 't1', executorId: 'claude-code', projectId: 'p1', calls: 1, tokensIn: 1200, tokensOut: 300, cacheReadTokens: 4000, cacheWriteTokens: 100, totalTokens: 1500, durationMs: 2000, costEstimate: 0.123456, model: 'claude-sonnet-5-5', now: '2026-11-14T02:00:00.000Z' }));

  const summary = await (await fetch(`${base}/api/work/usage?days=all`)).json();
  assert.equal(summary.totals.totalTokens, 1500);
  assert.equal(summary.totals.cacheReadTokens, 4000);
  assert.equal(summary.byProject[0].projectId, 'p1');
  assert.equal(summary.history.count, 0);

  const response = await fetch(`${base}/api/work/usage.csv?days=all`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/csv/);
  assert.match(response.headers.get('content-disposition'), /lagent-usage-.*\.csv/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = bytes.subarray(3).toString('utf8');
  assert.match(csv, /日期,项目,项目名称,执行器,模型,来源,调用,输入Token,输出Token,缓存读取,缓存写入,合计Token,耗时毫秒,费用估算USD/);
  assert.match(csv, /claude-sonnet-5-5/);
  assert.match(csv, /0\.123456/);
  assert.match(csv, /4000/);

  const diagnostics = await (await fetch(`${base}/api/work/diagnostics`)).json();
  assert.equal(diagnostics.diagnostics.app.name, 'Lagent');
  assert.doesNotMatch(JSON.stringify(diagnostics), /LAGENT_CREDENTIAL_MASTER_KEY=[^"]/);
});
