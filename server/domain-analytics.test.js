import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataset, parseFiles } from './datasets.js';
import { analyzeDomain } from './domain-analytics.js';

const NOW = '2026-10-20T00:00:00Z';
const time = day => `2026-10-${String(day).padStart(2, '0')}T12:00:00+08:00`;
const dataset = (domain, records) => createDataset(records, { domain, name: domain, now: NOW });
const value = (report, id) => report.metrics.find(metric => metric.id === id)?.value;
const csv = (name, text) => ({ originalname: name, buffer: Buffer.from(text) });

test('commerce domain reports GMV, refund and repeat-buyer metrics', () => {
  const result = analyzeDomain(dataset('commerce', {
    users: [
      { user_id: 'u1', registered_at: time(1), channel: '自然' },
      { user_id: 'u2', registered_at: time(2), channel: '投放' },
      { user_id: 'u3', registered_at: time(3), channel: '投放' },
    ],
    activity: [
      { user_id: 'u1', event_time: time(4) },
      { user_id: 'u2', event_time: time(4) },
    ],
    payments: [
      { order_id: 'o1', user_id: 'u1', paid_at: time(2), amount: 100, currency: 'CNY', status: 'success', refund_amount: 10 },
      { order_id: 'o2', user_id: 'u1', paid_at: time(3), amount: 50, currency: 'CNY', status: 'success' },
      { order_id: 'o3', user_id: 'u2', paid_at: time(3), amount: 200, currency: 'CNY', status: 'success' },
      { order_id: 'o4', user_id: 'u3', paid_at: time(4), amount: 30, currency: 'CNY', status: 'cancelled' },
    ],
  }), { now: NOW });
  assert.equal(result.domain, 'commerce');
  assert.equal(value(result, 'revenue'), 340);
  assert.equal(value(result, 'orders'), 3);
  assert.equal(value(result, 'buyers'), 2);
  assert.equal(value(result, 'aov'), 113.33);
  assert.equal(value(result, 'repeat_rate'), 50);
  assert.equal(value(result, 'refund_rate'), 2.86);
  assert.equal(value(result, 'refund_amount'), 10);
  assert.match(result.metrics.find(metric => metric.id === 'revenue').note, /退款按净额/);
});

test('saas domain reports activation, MRR and active subscriptions', () => {
  const result = analyzeDomain(dataset('saas', {
    users: [
      { user_id: 'u1', registered_at: time(1), channel: '自然', plan: 'pro' },
      { user_id: 'u2', registered_at: time(2), channel: '投放', plan: 'basic' },
    ],
    activity: [
      { user_id: 'u1', event_time: time(3), event_type: 'activation' },
      { user_id: 'u1', event_time: time(5), event_type: 'login' },
      { user_id: 'u2', event_time: time(4), event_type: 'login' },
    ],
    payments: [
      { order_id: 's1', user_id: 'u1', paid_at: time(1), amount: 120, currency: 'CNY', status: 'active', start_at: time(1), end_at: '2026-10-31T12:00:00+08:00' },
      { order_id: 's2', user_id: 'u2', paid_at: time(2), amount: 60, currency: 'CNY', status: 'active', start_at: time(2), end_at: '2026-10-31T12:00:00+08:00' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'activation_rate'), 50);
  assert.equal(value(result, 'active_subscriptions'), 2);
  assert.equal(value(result, 'mrr'), 180);
  assert.equal(value(result, 'revenue'), 180);
  assert.equal(result.metrics.find(metric => metric.id === 'mrr').unit, '元');
});

test('content domain separates views, consumers, interaction and creator retention', () => {
  const result = analyzeDomain(dataset('content', {
    users: [
      { user_id: 'u1', registered_at: time(1), channel: '自然' },
      { user_id: 'u2', registered_at: time(2), channel: '自然' },
    ],
    activity: [
      { user_id: 'u1', event_time: time(3), event_type: 'view', content_id: 'c1', creator_id: 'k1' },
      { user_id: 'u1', event_time: time(3), event_type: 'like', content_id: 'c1', creator_id: 'k1' },
      { user_id: 'u2', event_time: time(4), event_type: 'view', content_id: 'c1' },
      { user_id: 'u1', event_time: time(3), event_type: 'publish', content_id: 'c1', creator_id: 'k1' },
      { user_id: 'u1', event_time: time(10), event_type: 'view', content_id: 'c1', creator_id: 'k1' },
    ],
    payments: [{ order_id: 'o1', user_id: 'u1', paid_at: time(3), amount: 20, currency: 'CNY', status: 'success' }],
  }), { now: NOW });
  assert.equal(value(result, 'content_views'), 3);
  assert.equal(value(result, 'consumers'), 2);
  assert.equal(value(result, 'interaction_rate'), 33.33);
  assert.equal(value(result, 'creator_d7'), 100);
});

test('education completion requires explicit start and complete events', () => {
  const result = analyzeDomain(dataset('education', {
    users: [
      { user_id: 's1', registered_at: time(1), channel: '自然' },
      { user_id: 's2', registered_at: time(2), channel: '自然' },
    ],
    activity: [
      { user_id: 's1', event_time: time(3), event_type: 'start', course_id: 'c1' },
      { user_id: 's1', event_time: time(4), event_type: 'complete', course_id: 'c1' },
      { user_id: 's2', event_time: time(3), event_type: 'start', course_id: 'c1' },
    ],
    payments: [{ order_id: 'o1', user_id: 's1', paid_at: time(1), amount: 300, currency: 'CNY', status: 'success' }],
  }), { now: NOW });
  assert.equal(value(result, 'completion_rate'), 50);
  assert.equal(value(result, 'enrollments'), 1);
  assert.match(result.metrics.find(metric => metric.id === 'completion_rate').note, /开始人数/);
});

test('local redemption and store ranking use activity and store fields', () => {
  const result = analyzeDomain(dataset('local', {
    users: [
      { user_id: 'u1', registered_at: time(1), channel: '自然' },
      { user_id: 'u2', registered_at: time(2), channel: '自然' },
    ],
    activity: [
      { user_id: 'u1', event_time: time(3), event_type: '发放' },
      { user_id: 'u2', event_time: time(4), event_type: '核销' },
    ],
    payments: [
      { order_id: 'o1', user_id: 'u1', paid_at: time(3), amount: 80, currency: 'CNY', status: 'success', store_id: 's1' },
      { order_id: 'o2', user_id: 'u2', paid_at: time(4), amount: 40, currency: 'CNY', status: 'success', store_id: 's2' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'redemption_rate'), 100);
  assert.equal(value(result, 'store_rank'), 80);
  assert.deepEqual(result.extras.topStore, { name: 's1', revenue: 80 });
});

test('social match and message metrics use event types', () => {
  const result = analyzeDomain(dataset('social', {
    users: [
      { user_id: 'u1', registered_at: time(1), channel: '自然' },
      { user_id: 'u2', registered_at: time(2), channel: '自然' },
    ],
    activity: [
      { user_id: 'u1', event_time: time(3), event_type: 'match' },
      { user_id: 'u2', event_time: time(3), event_type: 'message' },
      { user_id: 'u2', event_time: time(4), event_type: 'login' },
    ],
    payments: [{ order_id: 'o1', user_id: 'u1', paid_at: time(3), amount: 30, currency: 'CNY', status: 'success', product_type: '礼物' }],
  }), { now: NOW });
  assert.equal(value(result, 'match_rate'), 50);
  assert.equal(value(result, 'message_rate'), 0.5);
  assert.equal(value(result, 'product_revenue'), 30);
});

test('streaming watch duration comes only from duration_seconds', () => {
  const result = analyzeDomain(dataset('streaming', {
    users: [
      { user_id: 'u1', registered_at: time(1), channel: '自然' },
      { user_id: 'u2', registered_at: time(2), channel: '自然' },
    ],
    activity: [
      { user_id: 'u1', event_time: time(3), event_type: 'view', duration_seconds: 120, creator_id: 'k1' },
      { user_id: 'u2', event_time: time(4), event_type: 'view', duration_seconds: 60 },
      { user_id: 'u1', event_time: time(3), event_type: 'like' },
      { user_id: 'u1', event_time: time(3), event_type: 'publish', creator_id: 'k1' },
    ],
    payments: [{ order_id: 'o1', user_id: 'u1', paid_at: time(3), amount: 100, currency: 'CNY', status: 'success', product_type: '打赏' }],
  }), { now: NOW });
  assert.equal(value(result, 'watch_seconds'), 180);
  assert.equal(value(result, 'avg_watch_seconds'), 90);
  assert.equal(value(result, 'tip_revenue'), 100);
  assert.equal(value(result, 'interaction_rate'), 50);
});

test('travel lead days and cancellation exclude cancelled bookings from GMV', () => {
  const result = analyzeDomain(dataset('travel', {
    payments: [
      { order_id: 'o1', user_id: 'u1', paid_at: time(1), amount: 500, currency: 'CNY', status: 'success', check_in: '2026-10-05' },
      { order_id: 'o2', user_id: 'u2', paid_at: time(2), amount: 300, currency: 'CNY', status: 'cancelled', check_in: '2026-10-06' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'bookings'), 1);
  assert.equal(value(result, 'revenue'), 500);
  assert.equal(value(result, 'cancellation_rate'), 50);
  assert.equal(value(result, 'lead_days'), 4);
});

test('subscription domain reports MRR and churn from subscription periods', () => {
  const result = analyzeDomain(dataset('subscription', {
    users: [{ user_id: 'u1', registered_at: time(1), channel: '自然' }],
    activity: [{ user_id: 'u1', event_time: time(3) }],
    payments: [
      { order_id: 's1', user_id: 'u1', paid_at: time(1), amount: 120, currency: 'CNY', status: 'active', start_at: time(1), end_at: '2026-10-31T12:00:00+08:00' },
      { order_id: 's2', user_id: 'u1', paid_at: time(5), amount: 120, currency: 'CNY', status: 'active', start_at: time(5), end_at: '2026-11-30T12:00:00+08:00' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'active_subscriptions'), 2);
  assert.equal(value(result, 'renewal_rate'), 100);
  assert.equal(result.capability.metrics.churn_rate.status, 'computed');
});

test('enterprise win rate, ACV, cycle and pipeline never treat open deals as revenue', () => {
  const result = analyzeDomain(dataset('enterprise', {
    users: [
      { user_id: 'a1', registered_at: time(1), channel: '伙伴', owner: '张三', industry: '制造' },
      { user_id: 'a2', registered_at: time(2), channel: '直客', owner: '李四', industry: '零售' },
      { user_id: 'a3', registered_at: time(3), channel: '直客', owner: '李四', industry: '金融' },
    ],
    activity: [{ user_id: 'a1', event_time: time(3), event_type: '电话' }],
    payments: [
      { order_id: 'op1', user_id: 'a1', paid_at: time(5), amount: 1000, currency: 'CNY', status: 'won', stage: 'won', close_at: '2026-10-05', created_at: '2026-10-01', expansion: 200 },
      { order_id: 'op2', user_id: 'a2', paid_at: time(6), amount: 500, currency: 'CNY', status: 'lost', stage: 'lost', created_at: '2026-10-02' },
      { order_id: 'op3', user_id: 'a3', paid_at: time(7), amount: 300, currency: 'CNY', status: 'open', stage: 'qualified', created_at: '2026-10-03' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'revenue'), 1000);
  assert.equal(value(result, 'win_rate'), 50);
  assert.equal(value(result, 'acv'), 1000);
  assert.equal(value(result, 'sales_cycle_days'), 4);
  assert.equal(value(result, 'pipeline'), 300);
  assert.equal(value(result, 'qualified_rate'), 33.33);
  assert.equal(value(result, 'nrr'), 120);
});

test('adtech computes aggregate ratios without a user table', () => {
  const result = analyzeDomain(dataset('adtech', {
    payments: [
      { order_id: 'a@2026-10-02', user_id: 'campaign:a', paid_at: time(2), amount: 200, currency: 'CNY', status: 'success', impressions: 1000, clicks: 50, conversions: 5, spend: 100, revenue: 200, campaign_id: 'a' },
      { order_id: 'b@2026-10-03', user_id: 'campaign:b', paid_at: time(3), amount: 100, currency: 'CNY', status: 'success', impressions: 2000, clicks: 100, conversions: 10, spend: 200, revenue: 100, campaign_id: 'b' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'impressions'), 3000);
  assert.equal(value(result, 'clicks'), 150);
  assert.equal(value(result, 'conversions'), 15);
  assert.equal(value(result, 'spend'), 300);
  assert.equal(value(result, 'revenue'), 300);
  assert.equal(value(result, 'ctr'), 5);
  assert.equal(value(result, 'cvr'), 10);
  assert.equal(value(result, 'cpa'), 20);
  assert.equal(value(result, 'roas'), 1);
  assert.equal(value(result, 'roi'), 0);
  assert.deepEqual(result.capability.missingTables, []);
});

test('mobility completion duration and driver utilization need explicit timestamps', () => {
  const result = analyzeDomain(dataset('mobility', {
    payments: [
      { order_id: 't1', user_id: 'u1', paid_at: time(1), amount: 100, currency: 'CNY', status: 'completed', started_at: '2026-10-01T08:00:00+08:00', completed_at: '2026-10-01T08:30:00+08:00', driver_id: 'd1', online_minutes: 60, trip_id: 't1' },
      { order_id: 't2', user_id: 'u2', paid_at: time(2), amount: 50, currency: 'CNY', status: 'cancelled' },
    ],
  }), { now: NOW });
  assert.equal(value(result, 'completed_trips'), 1);
  assert.equal(value(result, 'completion_minutes'), 30);
  assert.equal(value(result, 'driver_utilization'), 50);
  assert.equal(value(result, 'cancellation_rate'), 50);
});

test('domain metrics without their required field are null instead of zero', () => {
  const result = analyzeDomain(dataset('content', {
    users: [{ user_id: 'u1', registered_at: time(1), channel: '自然' }],
    activity: [{ user_id: 'u1', event_time: time(2) }],
  }), { now: NOW });
  assert.equal(value(result, 'content_views'), null);
  assert.equal(value(result, 'interaction_rate'), null);
  assert.equal(result.capability.metrics.content_views.status, 'unavailable');
  assert.ok(result.capability.missingFields.some(field => field.field === 'activity.event_type'));
  assert.match(result.metrics.find(metric => metric.id === 'content_views').note, /缺少/);
});

test('domain parser maps headers and synthesizes missing standard fields', async () => {
  const adtech = await parseFiles([csv('campaign.csv', '计划ID,日期,曝光,点击,转化,消耗,收入\ncmp1,2026-10-02,1000,50,5,100,200\n')], { domain: 'adtech' });
  assert.equal(adtech.domain, 'adtech');
  assert.equal(adtech.tables[0].type, 'payments');
  assert.equal(adtech.records.payments[0].order_id, 'cmp1@2026-10-02');
  assert.equal(adtech.records.payments[0].user_id, 'campaign:cmp1');
  assert.equal(adtech.records.payments[0].amount, 200);
  assert.equal(adtech.records.payments[0].status, 'success');

  const enterprise = await parseFiles([
    csv('accounts.csv', '账户ID,创建时间,渠道,负责人\nacc1,2026-10-01,伙伴,张三\n'),
    csv('opportunities.csv', '商机ID,账户ID,金额,币种,阶段,成交日期,创建日期\nop1,acc1,1000,CNY,won,2026-10-05,2026-10-01\n'),
  ], { domain: 'enterprise' });
  assert.equal(enterprise.records.users[0].user_id, 'acc1');
  assert.equal(enterprise.records.payments[0].order_id, 'op1');
  assert.equal(enterprise.records.payments[0].status, 'won');

  const subscription = await parseFiles([csv('subscriptions.csv', '订阅ID,用户ID,订阅开始时间,金额,币种\ns1,u1,2026-10-01,120,CNY\n')], { domain: 'subscription' });
  assert.equal(subscription.records.payments[0].order_id, 's1');
  assert.equal(subscription.records.payments[0].paid_at, subscription.records.payments[0].start_at);
  assert.equal(subscription.records.payments[0].status, 'active');
});

test('game domain keeps the original analyzer without optional domain fields', () => {
  const result = analyzeDomain(dataset('game', {
    users: [{ user_id: 'u1', registered_at: time(1), channel: '自然' }],
    activity: [{ user_id: 'u1', event_time: time(2) }],
    payments: [{ order_id: 'o1', user_id: 'u1', paid_at: time(2), amount: 10, currency: 'CNY', status: 'success' }],
  }), { now: NOW });
  assert.equal(result.title.includes('运营分析报告'), true);
  assert.equal(result.domain, undefined);
  assert.equal(value(result, 'dau'), 1);
});
