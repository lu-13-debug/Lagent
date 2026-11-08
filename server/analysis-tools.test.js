import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysisTool } from './analysis-tools.js';
import { safeChartDataUrl } from './report-document.js';

const dataset = { id: 'fixture', records: { payments: [
  { user_id: 'PRIVATE-101', order_id: 'ORDER-001', amount: 10, channel: 'A', status: 'success', currency: 'CNY', private_note: 'SECRET' },
  { user_id: 'PRIVATE-102', order_id: 'ORDER-002', amount: 20, channel: 'A', status: 'success', currency: 'CNY' },
  { user_id: 'PRIVATE-103', order_id: 'ORDER-003', amount: 30, channel: 'B', status: 'success', currency: 'CNY' },
] } };
const report = { daily: [{ date: '2026-10-01', dau: 2, revenue: 10 }, { date: '2026-10-02', dau: 4, revenue: 20 }] };

test('real Python describes numeric data without exposing original IDs or private fields', async () => {
  const result = await runAnalysisTool('describe', { table: 'payments', columns: ['amount'] }, { dataset });
  assert.equal(result.columns.amount.count, 3);
  assert.equal(result.columns.amount.mean, 20);
  assert.equal(result.columns.amount.std, 10);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-|ORDER-|SECRET|private_note/);
});

test('profile and safe grouping use actual input rows', async () => {
  const profile = await runAnalysisTool('profile', {}, { dataset });
  assert.equal(profile.tables.payments.rows, 3);
  assert.doesNotMatch(JSON.stringify(profile), /PRIVATE-|ORDER-|SECRET|private_note/);
  const result = await runAnalysisTool('group', { table: 'payments', by: ['channel'], metrics: [{ column: 'amount', op: 'sum' }] }, { dataset });
  assert.deepEqual(result.data, [{ channel: 'A', amount_sum: 30 }, { channel: 'B', amount_sum: 30 }]);
});

test('standardization preserves source and requires confirmation for row removal', async () => {
  const source = { records: { payments: [{ amount: 1, channel: ' A\r\n' }] } };
  const before = JSON.stringify(source);
  const result = await runAnalysisTool('clean', { operations: ['trim_strings', 'normalize_newlines'] }, { dataset: source });
  assert.equal(result.changedCells, 1);
  assert.equal(result.rowsBefore, result.rowsAfter);
  assert.equal(JSON.stringify(source), before);
  await assert.rejects(runAnalysisTool('clean', { operations: ['drop_rows'] }, { dataset }), /确认|支持|允许/);
});

test('statistics calculate correlation from actual numeric rows', async () => {
  const result = await runAnalysisTool('statistics', { table: 'activity', method: 'pearson', columns: ['duration_seconds', 'online_minutes'] }, { dataset: { records: { activity: [{ duration_seconds: 1, online_minutes: 2 }, { duration_seconds: 2, online_minutes: 4 }, { duration_seconds: 3, online_minutes: 6 }] } } });
  assert.ok(Math.abs(result.statistic - 1) < 1e-12);
  assert.equal(result.n, 3);
});

test('line chart embeds a local SVG with actual aggregate data', async () => {
  const chart = await runAnalysisTool('chart', { kind: 'line', y: 'revenue', title: '每日收入' }, { dataset, report });
  assert.equal(chart.mimeType, 'image/svg+xml');
  assert.match(chart.svg, /<svg/);
  assert.doesNotMatch(chart.svg, /<script|https?:\/\/(?!www\.w3\.org)|PRIVATE-|ORDER-/);
  assert.deepEqual(chart.data, [{ date: '2026-10-01', revenue: 10 }, { date: '2026-10-02', revenue: 20 }]);
  assert.match(safeChartDataUrl(chart) || '', /^data:image\/svg\+xml;base64,/);
});

test('all standard charts use real aggregates and remain safe for the PDF renderer', async () => {
  const contexts = [
    [{ kind: 'bar', source: 'channels', y: 'revenue' }, { channels: [{ name: 'A', revenue: 30 }, { name: 'B', revenue: 10 }] }],
    [{ kind: 'histogram', y: 'revenue', bins: 2 }, report],
    [{ kind: 'scatter', x: 'dau', y: 'revenue' }, report],
    [{ kind: 'heatmap' }, { retention: [{ date: '2026-10-01', users: 10, d1: 40, d7: null }, { date: '2026-10-02', users: 5, d1: 20, d7: 10 }] }],
  ];
  for (const [input, aggregate] of contexts) {
    const chart = await runAnalysisTool('chart', input, { dataset, report: aggregate });
    assert.ok(chart.data.length);
    assert.match(safeChartDataUrl(chart) || '', /^data:image\/svg\+xml;base64,/, input.kind);
    if (input.kind === 'histogram') assert.equal(chart.data.reduce((sum, bin) => sum + bin.count, 0), 2);
    if (input.kind === 'heatmap') assert.equal(chart.data[0].d1, 40);
  }
});

test('record-based date charts aggregate by the project day without exposing exact event timestamps', async () => {
  const chart = await runAnalysisTool('chart', { kind: 'line', table: 'payments', x: 'paid_at', y: 'amount' }, { dataset: { timezone: { offsetMinutes: 480 }, records: { payments: [
    { paid_at: '2026-10-01T17:01:00Z', amount: 10 }, { paid_at: '2026-10-01T18:03:00Z', amount: 20 },
  ] } } });
  assert.deepEqual(chart.data, [{ paid_at: '2026-10-02', amount: 30 }]);
  assert.doesNotMatch(JSON.stringify(chart), /T17:01|T18:03/);
  await assert.rejects(runAnalysisTool('chart', { kind: 'line' }, { report: { daily: [{ date: '2026-10-01', dau: null }] } }), /有效|数据/);
});

test('tool names, fields, paths, input sizes and cancellation are bounded', async () => {
  await assert.rejects(runAnalysisTool('python', { code: 'print(1)' }, { dataset }), /工具/);
  await assert.rejects(runAnalysisTool('describe', { table: 'payments', columns: ['user_id'] }, { dataset }), /字段/);
  await assert.rejects(runAnalysisTool('group', { table: 'payments', by: ['user_id'], metrics: [{ column: 'amount', op: 'sum' }] }, { dataset }), /字段/);
  await assert.rejects(runAnalysisTool('chart', { kind: 'line', path: 'C:/secret' }, { report }), /参数/);
  await assert.rejects(runAnalysisTool('profile', { table: 'x'.repeat(20000) }, { dataset }), /参数/);
  await assert.rejects(runAnalysisTool('profile', {}, { dataset, signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(runAnalysisTool('profile', {}, { dataset, timeoutMs: 1 }), /超时/);
});
