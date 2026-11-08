import test from 'node:test';
import assert from 'node:assert/strict';
const data = await import('./operation-chart-data.ts').catch(() => ({}));

const daily = [
  { date: '2026-10-01', dau: 10, newUsers: 2, revenue: 5, payers: 1 },
  { date: '2026-10-02', dau: null, newUsers: 3, revenue: null, payers: null },
  { date: '2026-10-03', dau: 20, newUsers: null, revenue: 7.5, payers: 2 },
  { date: '2026-10-04', dau: 30, newUsers: 4, revenue: 1.25, payers: 3 },
  { date: '2026-10-05', dau: 40, newUsers: 5, revenue: 10, payers: null },
];

test('daily rows group into weeks without turning missing coverage into zero', () => {
  assert.equal(typeof data.groupDaily, 'function');
  const weeks = data.groupDaily(daily, 'week');
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].key, '2026-09-28');
  assert.equal(weeks[0].label, '2026-10-01');
  assert.equal(weeks[0].days, 4);
  assert.deepEqual(weeks[0].values, { dau: 60, newUsers: 9, revenue: 13.75, payers: 6 });
  assert.deepEqual(weeks[0].coverage, { dau: 3, newUsers: 3, revenue: 3, payers: 3 });
  assert.equal(weeks[0].payerRate, 10);
  assert.equal(weeks[1].values.dau, 40);
  assert.equal(weeks[1].values.payers, null);
  assert.equal(weeks[1].payerRate, null);
});

test('month grouping and cumulative totals preserve running values and weights payment rate', () => {
  const month = data.groupDaily(daily, 'month');
  assert.equal(month.length, 1);
  assert.equal(month[0].values.dau, 100);
  assert.equal(month[0].values.revenue, 23.75);
  assert.equal(month[0].values.payers, 6);
  assert.equal(month[0].payerRate, 10);

  const cumulative = data.cumulativeSeries(daily, 'day', 'newUsers');
  assert.deepEqual(cumulative.map(point => point.value), [2, 5, 5, 9, 14]);
  assert.deepEqual(cumulative.map(point => point.coverage), [1, 1, 0, 1, 1]);

  const weekly = data.cumulativeSeries(daily, 'week', 'revenue');
  assert.deepEqual(weekly.map(point => point.value), [13.75, 23.75]);
  assert.deepEqual(weekly.map(point => point.coverage), [3, 1]);
});

test('payment series keeps daily values exact and aggregates weekly payers and rate', () => {
  const dailyPoints = data.paymentSeries(daily, 'day');
  assert.equal(dailyPoints[0].payers, 1);
  assert.equal(dailyPoints[0].rate, 10);
  assert.equal(dailyPoints[1].payers, null);
  const weekly = data.paymentSeries(daily, 'week');
  assert.equal(weekly[0].payers, 6);
  assert.equal(weekly[0].rate, 10);
  assert.equal(weekly[1].rate, null);
});
