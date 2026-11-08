import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './analytics.js';
import { createDataset, publicDataset } from './datasets.js';

const now = '2026-10-05T00:00:00Z';
const users = [
  { user_id: 'a', registered_at: '2026-10-01T03:00:00Z', channel: '自然' },
  { user_id: 'b', registered_at: '2026-10-02T03:00:00Z', channel: '买量' },
];
const activity = [
  { user_id: 'a', event_time: '2026-10-01T04:00:00Z' },
  { user_id: 'b', event_time: '2026-10-02T04:00:00Z' },
];
const payments = [{ order_id: 'p1', user_id: 'a', paid_at: '2026-10-01T05:00:00Z', amount: '6', currency: 'CNY', status: 'paid' }];
const dataset = records => ({ name: '可完成度样本', source: 'upload', timezone: 'Asia/Shanghai', completeness: { declared: 'full' }, records });

test('activity-only reports mark table-dependent metrics unavailable with the missing table', () => {
  const report = analyze(dataset({ activity }), { now });
  for (const id of ['new_users', 'd1_retention', 'd7_retention', 'revenue', 'arppu', 'pay_rate', 'arpdau']) {
    assert.equal(report.capability.metrics[id].status, 'unavailable', id);
  }
  assert.equal(report.capability.metrics.dau.status, 'computed');
  assert.deepEqual(report.capability.metrics.new_users.missing, ['users']);
  assert.deepEqual(report.capability.metrics.d1_retention.missing, ['users']);
  assert.deepEqual(report.capability.metrics.revenue.missing, ['payments']);
  assert.deepEqual(report.capability.metrics.pay_rate.missing, ['payments']);
  assert.deepEqual(report.capability.missingTables.map(table => table.table), ['users', 'payments']);
  assert.deepEqual(report.capability.missingTables.find(table => table.table === 'users').unlocks, ['新增注册用户', '次日留存率', '7日留存率']);
  assert.deepEqual(report.capability.missingTables.find(table => table.table === 'payments').unlocks, ['成功支付收入', '付费用户平均收入', '活跃付费率', '日活跃用户平均收入']);
  assert.doesNotMatch(report.summary, /收入为|留存率为/);
  assert.match(report.title, /部分数据分析报告/);
});

test('a complete three-table dataset computes every metric and keeps the full report title', () => {
  const report = analyze(dataset({ users, activity, payments }), { now });
  assert.deepEqual(report.capability.unavailable, []);
  assert.equal(report.capability.missingTables.length, 0);
  for (const metric of Object.values(report.capability.metrics)) assert.equal(metric.status, 'computed');
  assert.match(report.title, /运营分析报告/);
  assert.doesNotMatch(report.title, /部分/);
});

test('dataset inspection exposes the same capability before a task is created', () => {
  const created = createDataset({ activity }, { now, timezone: 'Asia/Shanghai', completeness: { declared: 'full' } });
  assert.equal(created.inspection.capability.metrics.dau.status, 'computed');
  assert.deepEqual(created.inspection.capability.unavailable, ['new_users', 'd1_retention', 'd7_retention', 'revenue', 'arppu', 'pay_rate', 'arpdau']);
  assert.deepEqual(created.inspection.capability.missingTables.map(table => table.table), ['users', 'payments']);
});

test('legacy datasets without a stored capability gain one when served', () => {
  const created = createDataset({ activity }, { now, timezone: 'Asia/Shanghai', completeness: { declared: 'full' } });
  delete created.inspection.capability;
  const served = publicDataset(created);
  assert.equal(served.inspection.capability.metrics.dau.status, 'computed');
  assert.deepEqual(served.inspection.capability.missingTables.map(table => table.table), ['users', 'payments']);
  assert.equal('capability' in created.inspection, false);
  const uninspected = publicDataset({ ...created, inspection: undefined });
  assert.equal(uninspected.capability.metrics.dau.status, 'computed');
  assert.deepEqual(uninspected.capability.missingTables.map(table => table.table), ['users', 'payments']);
});
