import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTimezone, timezoneMinutes, timezoneLabel, timezoneCaption, formatOffset } from './timezone.js';
import { analyze } from './analytics.js';
import { createDataset } from './datasets.js';

const day = (timezone, event_time) => analyze({ name: '时区样本', source: 'upload', timezone, completeness: { declared: 'full' }, records: {
  users: [{ user_id: 'a', registered_at: '2026-09-30', channel: '自然' }],
  activity: [{ user_id: 'a', event_time }],
  payments: [{ order_id: 'p', user_id: 'a', paid_at: '2026-10-01T16:30:00Z', amount: '1', currency: 'CNY', status: 'paid' }],
} }, { now: '2026-10-05T00:00:00Z' });

test('timezone normalization keeps an explicit default assumption visible and rejects invalid declarations', () => {
  const fallback = normalizeTimezone(undefined, { legacyAt: '2026-10-01T00:00:00Z' });
  assert.deepEqual({ name: fallback.name, offsetMinutes: fallback.offsetMinutes, source: fallback.source, assumed: fallback.assumed }, { name: 'Asia/Shanghai', offsetMinutes: 480, source: 'default', assumed: true });
  assert.equal(fallback.declaredAt, '2026-10-01T00:00:00.000Z');
  const shanghai = normalizeTimezone('asia/shanghai');
  assert.equal(shanghai.assumed, false); assert.equal(shanghai.source, 'user');
  assert.equal(normalizeTimezone('UTC').offsetMinutes, 0);
  assert.equal(normalizeTimezone('UTC+05:30').offsetMinutes, 330);
  assert.equal(normalizeTimezone('UTC-03:00').offsetMinutes, -180);
  assert.equal(normalizeTimezone('-03:00').offsetMinutes, -180);
  assert.throws(() => normalizeTimezone('Mars/Base', { strict: true }), /时区/);
  assert.equal(normalizeTimezone('Mars/Base').assumed, true);
  assert.equal(timezoneMinutes({ offsetMinutes: 330 }), 330);
  assert.equal(timezoneMinutes({ offsetMinutes: 9999 }), 480);
  assert.equal(formatOffset(330), 'UTC+05:30');
  assert.equal(formatOffset(-180), 'UTC-03:00');
  assert.equal(timezoneLabel(fallback), 'Asia/Shanghai（未确认）');
  assert.equal(timezoneLabel(shanghai), 'Asia/Shanghai');
  assert.equal(timezoneCaption(shanghai), 'Asia/Shanghai（UTC+08:00）');
  assert.equal(timezoneCaption(normalizeTimezone('UTC+09:00')), 'UTC+09:00');
});

test('the declared offset decides which calendar day an absolute instant belongs to', () => {
  const utc = day('UTC', '2026-10-01T16:30:00Z');
  const shanghai = day(undefined, '2026-10-01T16:30:00Z');
  assert.equal(utc.daily.find(row => row.date === '2026-10-01').dau, 1);
  assert.equal(utc.daily.some(row => row.date === '2026-10-02' && row.dau === 1), false);
  assert.equal(shanghai.daily.find(row => row.date === '2026-10-02').dau, 1);
  assert.deepEqual(utc.timezone, { name: 'UTC', offsetMinutes: 0, assumed: false, source: 'user' });
  assert.equal(utc.summary.includes('时区未确认'), false);
});

test('unzoned timestamps use the declared timezone while explicit offsets keep their own instant', () => {
  const report = analyze({ name: '显式偏移', source: 'upload', timezone: 'Asia/Shanghai', completeness: { declared: 'full' }, records: {
    users: [{ user_id: 'a', registered_at: '2026-10-01 23:30', channel: '自然' }],
    activity: [{ user_id: 'a', event_time: '2026-10-01T23:30:00-07:00' }],
    payments: [],
  } }, { now: '2026-10-04T00:00:00Z' });
  assert.equal(report.retention.find(row => row.date === '2026-10-01').users, 1, '无时区注册时间按上海解释仍属 10-01');
  assert.equal(report.daily.find(row => row.date === '2026-10-02').dau, 1, '带偏移事件绝对时间为 10-02');
  assert.equal(JSON.stringify(report).includes('23:30'), false);
});

test('an undeclared timezone is reported as assumed everywhere and never silently claims confirmation', () => {
  const report = day(undefined, '2026-10-01T04:00:00Z');
  assert.equal(report.timezone.assumed, true);
  assert.equal(report.timezone.source, 'default');
  assert.match(report.summary, /时区未确认/);
  assert.match(report.methodology[0], /未确认/);
  assert.match(report.methodology[0], /UTC\+08:00/);
  assert.deepEqual(report.factContext.timezone, { name: 'Asia/Shanghai', offsetMinutes: 480, assumed: true });
});

test('consistent explicit offsets are detected but still require confirmation', () => {
  const dataset = createDataset({ activity: [
    { user_id: 'a', event_time: '2026-10-01T09:00:00Z' },
    { user_id: 'b', event_time: '2026-10-01T10:00:00Z' },
  ] }, { now: '2026-10-05T00:00:00Z', completeness: { declared: 'full' } });
  assert.deepEqual({ name: dataset.timezone.name, offsetMinutes: dataset.timezone.offsetMinutes, source: dataset.timezone.source, assumed: dataset.timezone.assumed }, { name: 'UTC+00:00', offsetMinutes: 0, source: 'detected', assumed: true });
  assert.match(dataset.warnings.join(' '), /推断/);
  assert.equal(dataset.inspection.timezone.assumed, true);
  assert.equal(dataset.inspection.issues.some(issue => issue.code === 'timezone_unconfirmed'), true);
});

test('declared timezone wins over data and unzoned or mixed inputs are called out', () => {
  const declared = createDataset({ activity: [{ user_id: 'a', event_time: '2026-10-01T09:00:00Z' }] }, { timezone: 'Asia/Shanghai', now: '2026-10-05T00:00:00Z', completeness: { declared: 'full' } });
  assert.equal(declared.timezone.source, 'user'); assert.equal(declared.timezone.assumed, false);
  assert.match(declared.warnings.join(' '), /与声明的 UTC\+08:00 不同/);

  const naive = createDataset({ activity: [{ user_id: 'a', event_time: '2026-10-01 09:00' }] }, { timezone: 'UTC', now: '2026-10-05T00:00:00Z', completeness: { declared: 'full' } });
  assert.equal(naive.records.activity[0].event_time, '2026-10-01T09:00:00.000Z');
  assert.match(naive.warnings.join(' '), /未带时区，已按声明的 UTC/);

  const mixed = createDataset({ activity: [
    { user_id: 'a', event_time: '2026-09-30T17:00:00-07:00' },
    { user_id: 'b', event_time: '2026-10-01T00:30:00Z' },
    { user_id: 'c', event_time: '2026-10-01T15:00:00-07:00' },
  ] }, { now: '2026-10-05T00:00:00Z', completeness: { declared: 'full' } });
  assert.equal(mixed.timezone.assumed, true);
  assert.match(mixed.warnings.join(' '), /多种时区偏移/);
  assert.deepEqual(mixed.dateRange, { start: '2026-10-01', end: '2026-10-02' });
});

test('an invalid timezone declaration is rejected instead of silently falling back', () => {
  assert.throws(() => createDataset({ activity: [{ user_id: 'a', event_time: '2026-10-01' }] }, { timezone: 'Mars/Base', now: '2026-10-05T00:00:00Z' }), /时区/);
});
