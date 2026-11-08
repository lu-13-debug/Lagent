import { attachMetricMetadata } from './metric-catalog.js';
import { analyze, dateOf, moneyCents, normalizeRecords, round, shiftDate, yesterday } from './analytics.js';
import { normalizeCompleteness, completenessCopy } from './completeness.js';
import { normalizeTimezone, timezoneMinutes, offsetSuffix, timezoneCaption } from './timezone.js';
import { buildCapability } from './capability.js';
import { CANCELLED_STATUSES, LOST_STATUSES, TRIAL_STATUSES, getProfile } from './domain-profiles.js';

const DAY = 86400000;
const pct = (n, d) => d ? round(100 * n / d) : null;
const ratio = (n, d) => d ? round(n / d) : null;
const cents = value => Math.round(Number(value || 0) * 100);
const netCents = row => cents(row.amount) - cents(row.refund_amount || 0);
const sumBy = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
const uniqueCount = (rows, key = 'user_id') => new Set(rows.map(row => row[key])).size;
const dateDiff = (from, to) => Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / DAY);
const eventText = row => `${row.event_type || ''} ${row.event_name || ''}`.toLowerCase();
const eventIs = (row, words) => words.some(word => eventText(row).includes(word));
const monthFraction = row => {
  if (!row.start_at || !row.end_at) return 1;
  return Math.max(1, (Date.parse(row.end_at) - Date.parse(row.start_at)) / DAY / 30.44);
};
const monthlyCents = row => Math.round(cents(row.amount) / monthFraction(row));
const statusOf = row => String(row.status || '').trim().toLowerCase();
const isCancelled = row => CANCELLED_STATUSES.has(statusOf(row)) || /cancel|取消|退款/.test(statusOf(row));
const isLost = row => LOST_STATUSES.has(statusOf(row)) || /lost|输单|流失/.test(statusOf(row));
const weightedRetention = (rows, key) => {
  const mature = rows.filter(row => row[key] !== null);
  const total = mature.reduce((count, row) => count + row.users, 0);
  return total ? round(mature.reduce((count, row) => count + row.users * row[key], 0) / total) : null;
};
const fieldSetOf = (dataset, records) => new Set(Object.entries(dataset.fieldPresence || Object.fromEntries(Object.entries(records).map(([table, rows]) => [table, [...new Set(rows.flatMap(row => Object.keys(row)))]]))).flatMap(([table, fields]) => fields.map(field => `${table}.${field}`)));

function subscriptionsAt(payments, date, tz, success) {
  return payments.filter(row => success.has(statusOf(row)) && row.start_at && dateOf(row.start_at, tz) <= date && (!row.end_at || dateOf(row.end_at, tz) >= date));
}
function subscriptionMonthly(payments, date, tz, success) {
  return subscriptionsAt(payments, date, tz, success).reduce((total, row) => total + monthlyCents(row), 0);
}
function subscriptionChurn(payments, start, end, tz, success) {
  const startMonthly = subscriptionMonthly(payments, start, tz, success);
  const ended = payments.filter(row => row.end_at && dateOf(row.end_at, tz) >= start && dateOf(row.end_at, tz) <= end && !success.has(statusOf(row)));
  const endedMonthly = ended.reduce((total, row) => total + monthlyCents(row), 0);
  return startMonthly ? pct(endedMonthly, startMonthly) : null;
}
function renewalRate(payments, tz, success) {
  const groups = new Map();
  for (const row of payments) {
    if (!success.has(statusOf(row))) continue;
    const key = row.user_id;
    const date = dateOf(row.start_at || row.paid_at, tz);
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(date);
  }
  const paid = [...groups.values()].filter(dates => dates.size > 0);
  const renewed = paid.filter(dates => dates.size > 1).length;
  return paid.length ? pct(renewed, paid.length) : null;
}
function trialConversion(payments, tz, success) {
  const trials = new Map(), paid = new Map();
  for (const row of payments) {
    const date = dateOf(row.start_at || row.paid_at, tz);
    if (TRIAL_STATUSES.has(statusOf(row))) trials.set(row.user_id, Math.min(trials.get(row.user_id) || date, date));
    else if (success.has(statusOf(row)) && trials.has(row.user_id)) paid.set(row.user_id, Math.max(paid.get(row.user_id) || date, date));
  }
  return trials.size ? pct(paid.size, trials.size) : null;
}
function creatorRetention(activity, tz, publishWords) {
  const creators = new Map();
  for (const row of activity) {
    if (!row.creator_id || !eventIs(row, publishWords)) continue;
    const date = dateOf(row.event_time, tz);
    if (!creators.has(row.creator_id) || date < creators.get(row.creator_id)) creators.set(row.creator_id, date);
  }
  if (!creators.size) return null;
  const activeByDate = new Map();
  for (const row of activity) {
    const date = dateOf(row.event_time, tz);
    if (!activeByDate.has(date)) activeByDate.set(date, new Set());
    if (row.creator_id) activeByDate.get(date).add(row.creator_id);
  }
  let mature = 0, returned = 0;
  for (const [id, date] of creators) {
    const target = shiftDate(date, 7);
    if (!activeByDate.has(target)) continue;
    mature++;
    if (activeByDate.get(target).has(id)) returned++;
  }
  return mature ? pct(returned, mature) : null;
}

export function analyzeDomain(dataset, options = {}) {
  const domain = options.domain || dataset.domain || 'game';
  if (domain === 'game') return analyze(dataset, options);
  const profile = getProfile(domain);
  const now = options.now || new Date();
  const timezone = normalizeTimezone(dataset.timezone, { legacyAt: dataset.createdAt });
  const tz = timezoneMinutes(timezone);
  const { records: r, warnings } = normalizeRecords(dataset.records || {}, dataset.warnings || [], tz);
  const originalRecords = Object.fromEntries(Object.entries(r).map(([type, rows]) => [type, rows.slice()]));
  const completeness = normalizeCompleteness(dataset.completeness, { legacyAt: dataset.createdAt });
  const completenessNote = completenessCopy[completeness.declared];
  const timeFields = { users: 'registered_at', activity: 'event_time', payments: 'paid_at' };
  const boundaries = Object.entries(r).flatMap(([type, rows]) => {
    const dates = rows.map(row => dateOf(row[timeFields[type]], tz)).sort();
    return dates.length ? [{ table: type, date: dates.at(-1) }] : [];
  });
  const affectedDates = [...new Set(boundaries.map(boundary => boundary.date))].sort();
  if (completeness.declared === 'partial') {
    for (const [type, rows] of Object.entries(r)) {
      const boundary = boundaries.find(item => item.table === type)?.date;
      r[type] = rows.filter(row => dateOf(row[timeFields[type]], tz) !== boundary);
    }
  }
  const has = type => Object.hasOwn(r, type);
  const scoped = options.range !== undefined || options.channels !== undefined;
  const requested = options.range === undefined ? null : (() => {
    const range = options.range;
    const valid = value => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
    if (!range || !valid(range.start) || !valid(range.end) || range.start > range.end) throw new Error('日期须为合法的 YYYY-MM-DD 自然日');
    return { start: range.start, end: range.end };
  })();
  if (options.channels !== undefined && (!Array.isArray(options.channels) || options.channels.length > 50 || options.channels.some(name => typeof name !== 'string' || !name.trim() || name.length > 100))) throw new Error('渠道须为最多 50 项、每项 1–100 字的文本数组');
  const selectedChannels = new Set(options.channels || []);
  if (selectedChannels.size && !has('users')) throw new Error(`缺少${profile.tableLabels.users}，无法按渠道筛选`);
  const labels = profile.tableLabels;
  const issues = [...warnings];
  if (completeness.declared !== 'full') issues.push(completenessNote);
  const cutoff = yesterday(now, tz);
  if (requested && requested.end > cutoff) throw new Error('仅可探索原报告生成时已结束的自然日');
  const allDates = [...(r.users || []).map(x => dateOf(x.registered_at, tz)), ...(r.activity || []).map(x => dateOf(x.event_time, tz)), ...(r.payments || []).map(x => dateOf(x.paid_at, tz))].sort();
  if (!allDates.length) throw new Error(completeness.declared === 'partial' ? '分片声明排除了各表边界日期后没有可分析的数据；请补充其他分片或改为全量声明' : '数据集中没有可分析的数据行');
  const start = requested?.start || allDates[0];
  const end = requested?.end || (allDates.at(-1) > cutoff ? cutoff : allDates.at(-1));
  if (start > end) throw new Error('数据仅包含当日或未来日期，尚无已结束自然日可分析');
  const today = dateOf(now, tz);
  const dataAgeDays = Math.floor((Date.parse(today) - Date.parse(end)) / DAY);
  const freshnessNote = !scoped && dataAgeDays > 90 ? `数据截止 ${end}，距分析日 ${today} 已 ${dataAgeDays} 天，可能不代表当前业务。` : '';
  if (freshnessNote) issues.push(freshnessNote);
  const length = Math.floor((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  if (length > 3660) throw new Error('数据时间跨度超过十年，请缩小分析范围');
  if (allDates.some(date => date > cutoff)) issues.push(`已排除 ${shiftDate(cutoff, 1)} 起的当日或未来记录，避免使用未结束自然日`);
  const coverage = {};
  for (const [type, rows] of Object.entries(r)) {
    const originalRows = completeness.declared === 'partial' ? (dataset.records[type] || []) : rows;
    const dates = originalRows.map(row => dateOf(row[timeFields[type]], tz)).sort();
    const declaredEnd = dates.length ? (completeness.declared === 'partial' ? shiftDate(dates.at(-1), -1) : dates.at(-1)) : null;
    const tableEnd = declaredEnd ? (declaredEnd < cutoff ? declaredEnd : cutoff) : null;
    coverage[type] = tableEnd && dates[0] <= tableEnd ? { start: dates[0], end: tableEnd } : null;
    if (!coverage[type]) issues.push(`${labels[type]}没有已结束自然日覆盖，相关指标显示无数据`);
  }
  const covered = (type, date) => Boolean(date && coverage[type] && date >= coverage[type].start && date <= coverage[type].end);
  const overlaps = type => Boolean(coverage[type] && coverage[type].start <= end && coverage[type].end >= start);
  const ranges = Object.entries(coverage).filter(([, range]) => range);
  if (new Set(ranges.map(([, range]) => `${range.start}/${range.end}`)).size > 1) {
    issues.push(`跨表覆盖范围不一致：${ranges.map(([type, range]) => `${labels[type]} ${range.start} 至 ${range.end}`).join('；')}。各表覆盖范围之外显示无数据，不按零补齐。`);
  }
  const fields = fieldSetOf(dataset, r);
  const capability = buildCapability(Object.keys(originalRecords), profile, fields);
  const missingLabels = capability.missingTables.map(table => table.label);
  for (const table of capability.missingTables) issues.push(`缺少${table.label}，相关指标显示无数据`);
  for (const missing of capability.missingFields) if (missing.label) issues.push(`缺少${missing.label}，依赖它的指标显示无数据`);
  const channelOf = user => profile.channelFields.map(field => user[field]).find(value => value !== undefined && value !== '') || user.channel;
  const sourceUsers = r.users || [];
  const userMap = new Map(sourceUsers.map(user => [user.user_id, user]));
  const channelKey = user => channelOf(user);
  const selected = row => !selectedChannels.size || selectedChannels.has(channelKey(userMap.get(row.user_id) || { channel: '未标记渠道' }));
  const users = sourceUsers.filter(user => !selectedChannels.size || selectedChannels.has(channelKey(user)));
  const activity = (r.activity || []).filter(selected);
  const payments = (r.payments || []).filter(row => {
    if (!selectedChannels.size) return true;
    if (row.channel !== undefined) return selectedChannels.has(row.channel);
    return selected(row);
  });
  const successStatuses = new Set(profile.successStatuses.map(status => status.toLowerCase()));
  const active = new Map(), registered = new Map(), paid = new Map(), revenue = new Map(), orders = new Map();
  const addSet = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  const merge = (map, key, value) => map.set(key, (map.get(key) || 0) + value);
  for (const row of activity) {
    const date = dateOf(row.event_time, tz);
    if (date <= (scoped ? cutoff : end)) addSet(active, date, row.user_id);
  }
  for (const row of users) {
    const date = dateOf(row.registered_at, tz);
    if (date <= end && (!scoped || date >= start)) addSet(registered, date, row.user_id);
  }
  const allPayments = payments.filter(row => {
    const date = dateOf(row.paid_at, tz);
    return date <= end && (!scoped || date >= start);
  });
  const success = allPayments.filter(row => successStatuses.has(statusOf(row)));
  const excluded = allPayments.length - success.length;
  if (excluded) issues.push(`${excluded} 笔非成功状态记录未计入收入与转化指标`);
  let totalCents = 0, grossCents = 0, refundCents = 0;
  for (const row of success) {
    const date = dateOf(row.paid_at, tz);
    const gross = cents(row.amount), refund = cents(row.refund_amount || 0), net = gross - refund;
    addSet(paid, date, row.user_id);
    merge(revenue, date, net);
    merge(orders, date, 1);
    totalCents += net; grossCents += gross; refundCents += refund;
  }
  if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(grossCents)) throw new Error('支付总额超出可安全计算范围');
  const unknown = new Set([...activity, ...allPayments].map(row => row.user_id).filter(id => !userMap.has(id)));
  if (has('users') && unknown.size) issues.push(`${unknown.size} 位活动或支付主体未匹配${labels.users}；不将窗口首见视为注册`);
  const daily = Array.from({ length }, (_, index) => {
    const date = shiftDate(start, index);
    return {
      date,
      dau: covered('activity', date) ? active.get(date)?.size || 0 : null,
      newUsers: covered('users', date) ? registered.get(date)?.size || 0 : null,
      revenue: covered('payments', date) ? (revenue.get(date) || 0) / 100 : null,
      payers: covered('payments', date) ? paid.get(date)?.size || 0 : null,
      orders: covered('payments', date) ? orders.get(date) || 0 : null,
    };
  }).filter(day => completeness.declared !== 'partial' || !affectedDates.includes(day.date));
  const retention = [...registered].sort(([a], [b]) => a.localeCompare(b)).map(([date, cohort]) => {
    const retained = days => {
      if (!has('activity') || !covered('activity', shiftDate(date, days))) return null;
      const returned = active.get(shiftDate(date, days)) || new Set();
      return pct([...cohort].filter(id => returned.has(id)).length, cohort.size);
    };
    return { date, users: cohort.size, d1: retained(1), d7: retained(7) };
  });
  const payerIds = new Set(success.map(row => row.user_id));
  const activeEnd = coverage.activity && coverage.activity.start <= end && coverage.activity.end >= start ? (coverage.activity.end < end ? coverage.activity.end : end) : coverage.activity?.end || null;
  const activityBoundary = boundaries.find(boundary => boundary.table === 'activity')?.date;
  const boundaryDay = completeness.declared === 'unknown' && activeEnd && activeEnd === activityBoundary && coverage.activity && coverage.activity.start < activeEnd ? daily.find(day => day.date === activeEnd) : undefined;
  const headlineEnd = boundaryDay ? shiftDate(activeEnd, -1) : activeEnd || (coverage.payments ? (coverage.payments.end < end ? coverage.payments.end : end) : null);
  const last = daily.find(day => day.date === headlineEnd) || { dau: null, revenue: null };
  const previous = headlineEnd ? daily.find(day => day.date === shiftDate(headlineEnd, -1)) : undefined;
  const lastActive = active.get(headlineEnd) || new Set(), lastPaid = paid.get(headlineEnd) || new Set();
  const sameDayPaymentCoverage = covered('payments', headlineEnd);
  const activeDayNote = !headlineEnd ? '没有活跃覆盖自然日' : boundaryDay ? `${headlineEnd} 最近非边界活跃日；边界日 ${activeEnd} 完整性未验证` : `${headlineEnd} 最后覆盖自然日${completeness.declared === 'unknown' ? '（完整性未验证）' : ''}`;
  const currency = r.payments?.[0]?.currency || 'CNY';
  const currencyUnit = currency === 'CNY' ? '元' : currency;
  const change = (value, prev) => completeness.declared !== 'full' || value === null || !prev ? null : round((value - prev) * 100 / prev);
  const metric = (id, value, unit, note, delta = null) => ({ id, label: profile.metricLabels[id] || id, value: value == null ? null : value, unit, change: delta, note });
  const values = {};
  const periodLabel = `${start} 至 ${end}`;
  const paymentPeriod = coverage.payments ? (scoped ? `${start} 至 ${end} 筛选期，受原${labels.payments}覆盖限制` : `${coverage.payments.start} 至 ${coverage.payments.end}`) : `没有${labels.payments}覆盖自然日`;
  const registrationPeriod = coverage.users ? (scoped ? `${start} 至 ${end} 筛选期，受原${labels.users}覆盖限制` : `${coverage.users.start} 至 ${coverage.users.end}`) : `没有${labels.users}覆盖自然日`;
  values.dau = [last.dau, '人', `${activeDayNote}；按主体去重`, scoped ? null : change(last.dau, previous?.dau)];
  values.new_users = [overlaps('users') ? users.filter(user => dateOf(user.registered_at, tz) <= end && (!scoped || dateOf(user.registered_at, tz) >= start)).length : null, '人', `${registrationPeriod}；以${labels.users}为准`];
  values.d1_retention = [has('users') && has('activity') ? weightedRetention(retention, 'd1') : null, '%', `按${profile.entity}数加权，仅包含 D1 已成熟 cohort；第 1 天当日回访`];
  values.d7_retention = [has('users') && has('activity') ? weightedRetention(retention, 'd7') : null, '%', `按${profile.entity}数加权，仅包含 D7 已成熟 cohort；第 7 天当日回访`];
  values.revenue = [overlaps('payments') ? totalCents / 100 : null, currencyUnit, `${paymentPeriod}；成功记录按 order_id 去重；退款按净额扣减，金额以整数分计算`];
  values.arppu = [overlaps('payments') ? (payerIds.size ? round(totalCents / 100 / payerIds.size) : null) : null, currencyUnit, `${paymentPeriod}；成功收入 / 去重${profile.payerEntity}数`];
  values.pay_rate = [headlineEnd && sameDayPaymentCoverage && lastActive.size ? pct([...lastActive].filter(id => lastPaid.has(id)).length, lastActive.size) : null, '%', `${activeDayNote}；当日活跃且支付主体 / 活跃主体`];
  values.arpdau = [headlineEnd && sameDayPaymentCoverage && lastActive.size ? round((revenue.get(headlineEnd) || 0) / 100 / lastActive.size) : null, currencyUnit, `${activeDayNote}；当日成功收入 / 活跃主体`];

  const ordersForUser = new Map();
  for (const row of success) {
    const entry = ordersForUser.get(row.user_id) || { count: 0, cents: 0 };
    entry.count++; entry.cents += netCents(row); ordersForUser.set(row.user_id, entry);
  }
  const repeated = [...ordersForUser.values()].filter(entry => entry.count > 1).length;
  const buyers = ordersForUser.size;
  const paidUsers = new Set(success.map(row => row.user_id));
  const viewEvents = activity.filter(row => eventIs(row, ['view', '浏览', '播放', '观看', '阅读', '曝光']));
  const interactionEvents = activity.filter(row => eventIs(row, ['like', 'comment', 'share', 'collect', '点赞', '评论', '分享', '收藏', '互动']));
  const eventTypePresent = fields.has('activity.event_type');
  const durationPresent = fields.has('activity.duration_seconds');
  const creatorPresent = fields.has('activity.creator_id');
  const coursePresent = fields.has('activity.course_id');
  const storePresent = fields.has('payments.store_id');
  const checkInPresent = fields.has('payments.check_in');
  const startAtPresent = fields.has('payments.start_at');
  const endAtPresent = fields.has('payments.end_at');
  const driverPresent = fields.has('payments.driver_id');
  const onlinePresent = fields.has('payments.online_minutes');
  const expansionPresent = fields.has('payments.expansion');
  const productPresent = fields.has('payments.product_type');
  const stagePresent = fields.has('payments.stage');
  const closeAtPresent = fields.has('payments.close_at');
  const createdPresent = fields.has('payments.created_at');
  const startedPresent = fields.has('payments.started_at');
  const completedPresent = fields.has('payments.completed_at');
  const impressionsPresent = fields.has('payments.impressions');
  const clicksPresent = fields.has('payments.clicks');
  const conversionsPresent = fields.has('payments.conversions');
  const spendPresent = fields.has('payments.spend');
  const totalImpressions = sumBy(allPayments, 'impressions');
  const totalClicks = sumBy(allPayments, 'clicks');
  const totalConversions = sumBy(allPayments, 'conversions');
  const totalSpendCents = allPayments.reduce((total, row) => total + cents(row.spend || 0), 0);
  const cancelled = allPayments.filter(isCancelled);
  const lost = allPayments.filter(isLost);
  const won = success.filter(row => !isLost(row));
  const open = allPayments.filter(row => !success.includes(row) && !isLost(row) && !isCancelled(row));
  const activeSubscriptions = subscriptionsAt(allPayments, end, tz, successStatuses);
  const churn = startAtPresent && endAtPresent ? subscriptionChurn(allPayments, start, end, tz, successStatuses) : null;
  const renewal = startAtPresent ? renewalRate(allPayments, tz, successStatuses) : null;
  const trial = startAtPresent ? trialConversion(allPayments, tz, successStatuses) : null;
  const activationEvents = eventTypePresent && activity.some(row => eventIs(row, ['activation', '激活', 'onboard', '启用'])) ? activity.filter(row => eventIs(row, ['activation', '激活', 'onboard', '启用'])) : activity;
  const activationUsers = new Set(activationEvents.map(row => row.user_id));
  const activationCohort = users.filter(user => dateOf(user.registered_at, tz) >= start && dateOf(user.registered_at, tz) <= end);
  const activated = activationCohort.filter(user => {
    const registeredDate = dateOf(user.registered_at, tz);
    return activationUsers.has(user.user_id) && activity.some(row => row.user_id === user.user_id && dateOf(row.event_time, tz) >= registeredDate && dateOf(row.event_time, tz) <= shiftDate(registeredDate, 7));
  });
  const lastActivityDates = new Set(Array.from({ length: Math.min(7, length) }, (_, index) => shiftDate(end, -index)));
  const lastMonthDates = new Set(Array.from({ length: Math.min(30, length) }, (_, index) => shiftDate(end, -index)));
  const wau = new Set(activity.filter(row => lastActivityDates.has(dateOf(row.event_time, tz))).map(row => row.user_id)).size;
  const mau = new Set(activity.filter(row => lastMonthDates.has(dateOf(row.event_time, tz))).map(row => row.user_id)).size;
  const startedPairs = new Set(), completedPairs = new Set();
  for (const row of activity) {
    const key = `${row.user_id}|${row.course_id || ''}`;
    if (eventIs(row, ['start', '开始', 'begin', 'enroll', '报名'])) startedPairs.add(key);
    if (eventIs(row, ['complete', 'finish', '完成', '结课', '毕业'])) completedPairs.add(key);
  }
  const issueEvents = activity.filter(row => eventIs(row, ['issue', '发放', '领取', '购买券']));
  const redeemEvents = activity.filter(row => eventIs(row, ['redeem', '核销', '使用券']));
  const matchUsers = new Set(activity.filter(row => eventIs(row, ['match', '匹配', '配对'])).map(row => row.user_id));
  const messageEvents = activity.filter(row => eventIs(row, ['message', 'msg', '消息', '聊天']));
  const watchEvents = durationPresent ? viewEvents : [];
  const watchSeconds = watchEvents.reduce((total, row) => total + Number(row.duration_seconds || 0), 0);
  const watchUsers = new Set(watchEvents.map(row => row.user_id)).size;
  const checkInRows = success.filter(row => row.check_in);
  const leadDays = checkInPresent && checkInRows.length ? round(checkInRows.reduce((total, row) => total + Math.max(0, dateDiff(dateOf(row.paid_at, tz), dateOf(row.check_in, tz))), 0) / checkInRows.length) : null;
  const stores = new Map();
  for (const row of success) if (row.store_id) stores.set(row.store_id, (stores.get(row.store_id) || 0) + netCents(row));
  const topStore = stores.size ? [...stores.entries()].sort((a, b) => b[1] - a[1])[0] : null;
  const products = new Map();
  for (const row of success) if (row.product_type) products.set(row.product_type, (products.get(row.product_type) || 0) + netCents(row));
  const topProduct = products.size ? [...products.entries()].sort((a, b) => b[1] - a[1])[0] : null;
  const tipCents = success.filter(row => row.product_type && /tip|gift|打赏|礼物/.test(String(row.product_type).toLowerCase())).reduce((total, row) => total + netCents(row), 0);
  const stages = new Map();
  for (const row of allPayments) if (row.stage) stages.set(row.stage, (stages.get(row.stage) || 0) + 1);
  const qualified = allPayments.filter(row => row.stage && /qualified|sql|mql|合格|确认|商机/.test(String(row.stage).toLowerCase()));
  const closed = won.length + lost.length;
  const wonCents = won.reduce((total, row) => total + netCents(row), 0);
  const cycleRows = won.filter(row => row.close_at && row.created_at);
  const salesCycle = cycleRows.length ? round(cycleRows.reduce((total, row) => total + Math.max(0, (Date.parse(row.close_at) - Date.parse(row.created_at)) / DAY), 0) / cycleRows.length) : null;
  const expansionCents = success.reduce((total, row) => total + cents(row.expansion || 0), 0);
  const completionDurations = success.filter(row => row.started_at && row.completed_at);
  const completionMinutes = completionDurations.length ? round(completionDurations.reduce((total, row) => total + (Date.parse(row.completed_at) - Date.parse(row.started_at)) / 60000, 0) / completionDurations.length) : null;
  const onlineMinutes = allPayments.reduce((total, row) => total + Number(row.online_minutes || 0), 0);
  const driverUtilization = driverPresent && onlinePresent && onlineMinutes && completionDurations.length ? pct(completionDurations.reduce((total, row) => total + (Date.parse(row.completed_at) - Date.parse(row.started_at)) / 60000, 0), onlineMinutes) : null;

  values.orders = [overlaps('payments') ? success.length : null, '笔', `${paymentPeriod}；按 order_id 去重`];
  values.buyers = [overlaps('payments') ? buyers : null, '人', `${paymentPeriod}；至少一笔成功记录的${profile.payerEntity}`];
  values.aov = [overlaps('payments') && success.length ? round(totalCents / 100 / success.length) : null, currencyUnit, `${paymentPeriod}；成功收入 / 成功记录数`];
  values.repeat_rate = [overlaps('payments') && buyers ? pct(repeated, buyers) : null, '%', `${paymentPeriod}；成功记录数大于 1 的${profile.payerEntity} / 去重${profile.payerEntity}数`];
  values.refund_amount = [overlaps('payments') ? refundCents / 100 : null, currencyUnit, `${paymentPeriod}；退款字段合计`];
  values.refund_rate = [overlaps('payments') && grossCents ? pct(refundCents, grossCents) : null, '%', `${paymentPeriod}；退款金额 / 成功记录原始金额`];
  values.activation_rate = [overlaps('users') && overlaps('activity') && activationCohort.length ? pct(activated.length, activationCohort.length) : null, '%', `${registrationPeriod}；注册后 7 天内出现激活行为的${profile.entity} / 期间新增${profile.entity}`];
  values.wau = [overlaps('activity') ? wau : null, '人', `${end} 前 7 个覆盖自然日内活跃主体去重`];
  values.mau = [overlaps('activity') ? mau : null, '人', `${end} 前 30 个覆盖自然日内活跃主体去重`];
  values.mrr = [startAtPresent && subscriptionsAt(allPayments, end, tz, successStatuses).length ? round(subscriptionStartMrrEnd(allPayments, end, tz, successStatuses) / 100) : null, currencyUnit, `${end} 时点活跃订阅的月度折算金额；年付按 12 个月折算，缺订阅周期时按记录金额视为月费`];
  values.active_subscriptions = [startAtPresent ? new Set(activeSubscriptions.map(row => row.subscription_id || row.order_id)).size : null, '个', `${end} 时点仍有效的订阅，按订阅编号去重`];
  values.churn_rate = [churn, '%', `${start} 至 ${end} 期间结束且未续费的月度金额 / 期初月度金额`];
  values.renewal_rate = [renewal, '%', `${periodLabel}；有两次及以上成功订阅的${profile.entity} / 有成功订阅的${profile.entity}`];
  values.trial_conversion = [trial, '%', `${periodLabel}；试用后出现成功订阅的${profile.entity} / 有试用记录的${profile.entity}`];
  values.content_views = [eventTypePresent ? viewEvents.length : null, '次', `${periodLabel}；浏览/播放事件数，按事件计数不去重`];
  values.consumers = [eventTypePresent ? new Set(viewEvents.map(row => row.user_id)).size : null, '人', `${periodLabel}；至少一次浏览/播放事件的去重${profile.entity}`];
  values.interaction_rate = [eventTypePresent && viewEvents.length ? pct(interactionEvents.length, viewEvents.length) : null, '%', `${periodLabel}；互动事件数 / 浏览播放事件数`];
  values.creator_d7 = [eventTypePresent && creatorPresent ? creatorRetention(activity, tz, ['publish', 'post', '发布', '上传', '开播', '投稿']) : null, '%', '创作者首次发布后第 7 个自然日仍有活跃的比例；按成熟创作者加权'];
  values.enrollments = [overlaps('payments') ? success.length : null, '笔', `${paymentPeriod}；成功报名记录数`];
  values.completion_rate = [eventTypePresent && coursePresent && startedPairs.size ? pct([...completedPairs].filter(key => startedPairs.has(key)).length, startedPairs.size) : null, '%', `${periodLabel}；完成人数 / 开始人数，按主体 + 课程去重`];
  values.redemption_rate = [eventTypePresent && issueEvents.length ? pct(redeemEvents.length, issueEvents.length) : null, '%', `${periodLabel}；核销事件数 / 发放事件数`];
  values.store_rank = [storePresent && topStore ? round(topStore[1] / 100) : null, currencyUnit, storePresent && topStore ? `门店 ${topStore[0]} 的期间成功收入` : '缺少门店字段'];
  values.match_rate = [eventTypePresent && new Set(activity.map(row => row.user_id)).size ? pct(matchUsers.size, new Set(activity.map(row => row.user_id)).size) : null, '%', `${periodLabel}；有匹配事件的${profile.entity} / 活跃${profile.entity}`];
  values.message_rate = [eventTypePresent && new Set(activity.map(row => row.user_id)).size ? round(messageEvents.length / new Set(activity.map(row => row.user_id)).size) : null, '条', `${periodLabel}；消息事件数 / 活跃${profile.entity}`];
  values.product_revenue = [productPresent && topProduct ? round(topProduct[1] / 100) : null, currencyUnit, productPresent && topProduct ? `最高贡献产品 ${topProduct[0]} 的期间收入` : '缺少产品类型字段'];
  values.watch_seconds = [durationPresent ? watchSeconds : null, '秒', `${periodLabel}；观看事件 duration_seconds 合计，不估算缺失时长`];
  values.avg_watch_seconds = [durationPresent && watchUsers ? round(watchSeconds / watchUsers) : null, '秒', `${periodLabel}；观看时长 / 观看用户数`];
  values.tip_revenue = [productPresent ? round(tipCents / 100) : null, currencyUnit, `${paymentPeriod}；产品类型包含打赏/礼物的成功收入`];
  values.bookings = [overlaps('payments') ? success.length : null, '笔', `${paymentPeriod}；成功预订记录数`];
  values.cancellation_rate = [overlaps('payments') && allPayments.length ? pct(cancelled.length, allPayments.length) : null, '%', `${paymentPeriod}；取消状态记录 / 全部预约记录`];
  values.lead_days = [leadDays, '天', `${paymentPeriod}；入住日期 - 下单日期，仅统计有入住日期的成功预订`];
  values.completed_trips = [overlaps('payments') ? success.length : null, '单', `${paymentPeriod}；完成状态行程数`];
  values.completion_minutes = [completionMinutes, '分钟', `${paymentPeriod}；完成时间 - 开始时间，仅统计同时具备两个时间戳的完成行程`];
  values.driver_utilization = [driverUtilization, '%', `${paymentPeriod}；完成时长合计 / 在线时长合计，需要司机/骑手与在线时长字段`];
  values.qualified_rate = [stagePresent && allPayments.length ? pct(qualified.length, allPayments.length) : null, '%', `${paymentPeriod}；阶段为合格/已确认的商机 / 全部商机`];
  values.win_rate = [closed ? pct(won.length, closed) : null, '%', `${paymentPeriod}；赢单商机 / 已关闭商机，open 不计入分母`];
  values.acv = [won.length ? round(wonCents / 100 / won.length) : null, currencyUnit, `${paymentPeriod}；赢单金额 / 赢单商机数`];
  values.sales_cycle_days = [salesCycle, '天', `${paymentPeriod}；赢单商机的成交日期 - 创建日期平均值`];
  values.pipeline = [stagePresent ? round(open.reduce((total, row) => total + netCents(row), 0) / 100) : null, currencyUnit, `${paymentPeriod}；未赢单、未输单、未取消的 open 商机金额，不等同于收入`];
  values.nrr = [expansionPresent && wonCents ? pct(wonCents + expansionCents, wonCents) : null, '%', `${paymentPeriod}；（赢单金额 + 扩张金额）/ 赢单金额；缺扩张收缩数据时为无数据`];
  values.impressions = [impressionsPresent ? totalImpressions : null, '次', `${paymentPeriod}；投放日报曝光合计，按计划 + 日期去重`];
  values.clicks = [clicksPresent ? totalClicks : null, '次', `${paymentPeriod}；投放日报点击合计`];
  values.conversions = [conversionsPresent ? totalConversions : null, '次', `${paymentPeriod}；投放日报转化合计`];
  values.spend = [spendPresent ? totalSpendCents / 100 : null, currencyUnit, `${paymentPeriod}；投放消耗合计，不是利润`];
  values.ctr = [impressionsPresent && clicksPresent && totalImpressions ? pct(totalClicks, totalImpressions) : null, '%', `${paymentPeriod}；点击 / 曝光，零分母返回无数据`];
  values.cvr = [clicksPresent && conversionsPresent && totalClicks ? pct(totalConversions, totalClicks) : null, '%', `${paymentPeriod}；转化 / 点击，零分母返回无数据`];
  values.cpa = [spendPresent && conversionsPresent && totalConversions ? round(totalSpendCents / 100 / totalConversions) : null, currencyUnit, `${paymentPeriod}；消耗 / 转化，零分母返回无数据`];
  values.roas = [spendPresent && totalSpendCents ? round(totalCents / totalSpendCents) : null, '倍', `${paymentPeriod}；收入 / 消耗，ROAS 不是利润率`];
  values.roi = [spendPresent && totalSpendCents ? round((totalCents - totalSpendCents) * 100 / totalSpendCents) : null, '%', `${paymentPeriod}；（收入 - 消耗）/ 消耗`];

  function subscriptionStartMrrEnd(paymentsList, date, zone, statuses) {
    return subscriptionsAt(paymentsList, date, zone, statuses).reduce((total, row) => total + monthlyCents(row), 0);
  }

  if (profile.id === 'adtech' && !(r.payments || []).some(row => row.revenue !== undefined)) {
    values.revenue[0] = null; values.roas[0] = null; values.roi[0] = null;
  }
  for (const [id, entry] of Object.entries(values)) if (capability.metrics[id]?.status === 'unavailable') entry[0] = null;

  const metrics = profile.metricOrder.filter(id => values[id] || capability.metrics[id]).map(id => {
    const entry = values[id];
    const unavailable = capability.metrics[id] && capability.metrics[id].status === 'unavailable';
    if (!entry) return metric(id, null, '', '当前领域未定义该指标口径');
    const missing = capability.metrics[id]?.missing || [];
    const note = unavailable
      ? `缺少${missing.map(dep => dep.includes('.') ? profile.fieldLabels[dep] || dep : profile.tableLabels[dep] || dep).join('、')}，无法计算`
      : entry[2];
    return metric(id, unavailable ? null : entry[0], entry[1], note, entry[3] || null);
  });

  attachMetricMetadata(metrics, { domain, coverage, start, end });
  let channels;
  const groups = new Map();
  const paymentCoverage = overlaps('payments');
  if (has('users')) {
    const userCoverage = overlaps('users');
    for (const user of users) {
      const name = channelKey(user);
      if (!groups.has(name)) groups.set(name, { name, users: userCoverage ? 0 : null, cents: 0, payers: new Set(), cohorts: new Map() });
      const group = groups.get(name), date = dateOf(user.registered_at, tz);
      if (date < start || date > end) continue;
      if (group.users !== null) group.users++;
      if (!group.cohorts.has(date)) group.cohorts.set(date, { users: 0, returned: 0 });
      const cohort = group.cohorts.get(date); cohort.users++;
      const returned = active.get(shiftDate(date, 1)) || new Set();
      if (returned.has(user.user_id)) cohort.returned++;
    }
    for (const row of success) {
      const user = userMap.get(row.user_id);
      const group = groups.get(user ? channelKey(user) : row.channel);
      if (group) { group.cents += netCents(row); group.payers.add(row.user_id); }
    }
    channels = [...groups.values()].map(group => {
      const payers = paymentCoverage ? group.payers.size : null;
      return {
        name: group.name, users: group.users, revenue: paymentCoverage ? group.cents / 100 : null,
        payers, payRate: group.users && payers !== null ? pct(payers, group.users) : null, arppu: paymentCoverage && payers ? round(group.cents / 100 / payers) : null,
        d1: weightedRetention([...group.cohorts].map(([date, cohort]) => ({ users: cohort.users, d1: covered('activity', shiftDate(date, 1)) ? pct(cohort.returned, cohort.users) : null })), 'd1'),
      };
    });
  } else if (paymentCoverage) {
    for (const row of success) {
      const name = row.channel || '未标记渠道';
      if (selectedChannels.size && !selectedChannels.has(name)) continue;
      if (!groups.has(name)) groups.set(name, { name, users: new Set(), cents: 0, payers: new Set(), cohorts: new Map() });
      const group = groups.get(name); group.users.add(row.user_id); group.cents += netCents(row); group.payers.add(row.user_id);
    }
    channels = [...groups.values()].map(group => ({
      name: group.name, users: group.users.size, revenue: group.cents / 100,
      payers: group.payers.size, payRate: group.users.size ? pct(group.payers.size, group.users.size) : null,
      arppu: group.payers.size ? round(group.cents / 100 / group.payers.size) : null, d1: null,
    }));
  } else channels = [];
  channels.sort((a, b) => (b.users || 0) - (a.users || 0));

  const weekdayLabels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const weekday = weekdayLabels.map((label, index) => {
    const rows = daily.filter(day => (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7 === index);
    const average = key => {
      const values = rows.map(row => row[key]).filter(value => typeof value === 'number' && Number.isFinite(value));
      return values.length ? round(values.reduce((total, value) => total + value, 0) / values.length) : null;
    };
    return { index, label, days: rows.filter(row => row.dau !== null || row.newUsers !== null || row.revenue !== null).length, dau: average('dau'), newUsers: average('newUsers'), revenue: average('revenue') };
  });
  const weekdayCovered = weekday.filter(row => row.dau !== null && row.dau > 0);
  const weekdayPeak = weekdayCovered.length >= 3 ? weekdayCovered.reduce((a, b) => b.dau > a.dau ? b : a) : null;
  const weekdayLow = weekdayPeak ? weekdayCovered.reduce((a, b) => b.dau < a.dau ? b : a) : null;
  const weekdaySpread = weekdayPeak ? round((weekdayPeak.dau - weekdayLow.dau) * 100 / weekdayPeak.dau) : null;
  const channelTotal = channels.reduce((total, channel) => total + (channel.users || 0), 0);
  const topChannel = channels.length && channelTotal ? channels.reduce((a, b) => (b.users || 0) > (a.users || 0) ? b : a) : null;
  const topChannelShare = topChannel ? pct(topChannel.users, channelTotal) : null;
  const payerSummary = paymentCoverage && payerIds.size ? {
    payers: payerIds.size, repeatPayers: repeated, repeatRate: pct(repeated, payerIds.size),
    topPayerShare: totalCents ? pct(Math.max(...[...ordersForUser.values()].map(entry => entry.cents)), totalCents) : null,
    averageOrders: round(success.length / payerIds.size), averageRevenue: round(totalCents / 100 / payerIds.size),
  } : null;
  const totalRows = Object.values(dataset.records || {}).reduce((total, rows) => total + rows.length, 0);
  const demo = dataset.source === 'demo' ? '本报告使用确定性生成的示例数据，不代表真实业务。' : '';
  const goal = options.goal || '了解核心经营指标和数据质量';
  const context = (options.messages || []).filter(message => message.role === 'user').map(message => message.content).join('；');
  const findings = [];
  const keyMetrics = metrics.filter(metric => metric.value !== null).slice(0, 4);
  if (keyMetrics.length) findings.push({
    title: '核心指标概览',
    detail: `本报告计算出的主要指标为：${keyMetrics.map(metric => `${metric.label} ${metric.value}${metric.unit}`).join('、')}。这些是所选期间和覆盖范围内的观察值，不能单独证明变化原因。`,
    severity: 'neutral', evidence: `${keyMetrics.map(metric => metric.label).join('、')}；基于确定性聚合`,
  });
  const domainFindings = [];
  const addFinding = (title, detail, severity, evidence) => domainFindings.push({ title, detail, severity, evidence });
  if (profile.id === 'commerce' || profile.id === 'local') {
    const refund = values.refund_rate?.[0];
    if (refund !== null && refund !== undefined) addFinding('退款观察', `退款金额占成功记录原始金额的 ${refund}%。退款率越高，GMV 的可持续性越需要复核；这里只描述当前口径，不推断退款原因。`, refund >= 5 ? 'warning' : 'neutral', `退款率 ${refund}%`);
    const repeat = values.repeat_rate?.[0];
    if (repeat !== null && repeat !== undefined) addFinding('复购观察', `${profile.payerEntity}复购率为 ${repeat}%。复购率按成功记录数大于 1 的主体计算，样本较小时仅作观察。`, repeat < 20 ? 'warning' : 'positive', `复购率 ${repeat}%`);
    const redemption = values.redemption_rate?.[0];
    if (profile.id === 'local' && redemption !== null && redemption !== undefined) addFinding('核销观察', `核销率为 ${redemption}%，分母是发放事件。支付成功不等于到店履约，核销缺口需要结合门店和有效期数据复核。`, redemption < 60 ? 'warning' : 'neutral', `核销率 ${redemption}%`);
  }
  if (profile.id === 'saas' || profile.id === 'subscription') {
    const churnValue = values.churn_rate?.[0];
    if (churnValue !== null && churnValue !== undefined) addFinding('订阅流失观察', `毛收入流失率为 ${churnValue}%。该口径只描述已结束订阅的月度金额占比，不推断流失原因。`, churnValue >= 5 ? 'warning' : 'neutral', `毛收入流失率 ${churnValue}%`);
    const activation = values.activation_rate?.[0];
    if (activation !== null && activation !== undefined) addFinding('激活观察', `期间新增${profile.entity}的 7 天激活率为 ${activation}%。激活依赖明确的激活事件，缺事件类型时不做推断。`, activation < 40 ? 'warning' : 'positive', `激活率 ${activation}%`);
    const trialValue = values.trial_conversion?.[0];
    if (trialValue !== null && trialValue !== undefined) addFinding('试用转化观察', `试用转付费率为 ${trialValue}%。该值只覆盖有试用状态记录的${profile.entity}。`, trialValue < 20 ? 'warning' : 'neutral', `试用转付费率 ${trialValue}%`);
  }
  if (profile.id === 'content' || profile.id === 'streaming') {
    const interaction = values.interaction_rate?.[0];
    if (interaction !== null && interaction !== undefined) addFinding('互动观察', `互动率为 ${interaction}%，分母是浏览/播放事件数。互动率高低需要结合内容类型和曝光结构判断。`, 'neutral', `互动率 ${interaction}%`);
    const watch = values.avg_watch_seconds?.[0];
    if (watch !== null && watch !== undefined) addFinding('观看时长观察', `人均观看时长为 ${watch} 秒。时长只来自 duration_seconds，缺失时长的会话没有被估算。`, 'neutral', `人均观看 ${watch} 秒`);
    const creator = values.creator_d7?.[0];
    if (creator !== null && creator !== undefined) addFinding('创作者留存观察', `创作者第 7 日留存为 ${creator}%。该值仅覆盖有明确发布事件和创作者标识的成熟群体。`, creator < 20 ? 'warning' : 'neutral', `创作者 D7 ${creator}%`);
  }
  if (profile.id === 'education') {
    const completion = values.completion_rate?.[0];
    if (completion !== null && completion !== undefined) addFinding('完课观察', `完课率为 ${completion}%，按主体 + 课程去重，分母是开始学习人数。报名或支付记录没有被当作完课。`, completion < 50 ? 'warning' : 'positive', `完课率 ${completion}%`);
  }
  if (profile.id === 'social') {
    const match = values.match_rate?.[0];
    if (match !== null && match !== undefined) addFinding('匹配观察', `匹配率为 ${match}%，分母是活跃${profile.entity}。匹配事件缺失时该指标为无数据。`, match < 30 ? 'warning' : 'neutral', `匹配率 ${match}%`);
  }
  if (profile.id === 'travel' || profile.id === 'mobility') {
    const cancellation = values.cancellation_rate?.[0];
    if (cancellation !== null && cancellation !== undefined) addFinding('取消观察', `取消率为 ${cancellation}%，分母是全部预约/行程记录。取消原因和未履约记录需要单独的运营数据验证。`, cancellation >= 20 ? 'warning' : 'neutral', `取消率 ${cancellation}%`);
    const lead = values.lead_days?.[0];
    if (profile.id === 'travel' && lead !== null && lead !== undefined) addFinding('提前预订观察', `平均提前预订天数为 ${lead} 天，仅统计有入住日期的成功预订。`, 'neutral', `提前预订 ${lead} 天`);
    const minutes = values.completion_minutes?.[0];
    if (profile.id === 'mobility' && minutes !== null && minutes !== undefined) addFinding('履约时长观察', `平均完成时长为 ${minutes} 分钟，仅统计同时具备开始和完成时间戳的完成行程。`, 'neutral', `平均完成时长 ${minutes} 分钟`);
  }
  if (profile.id === 'enterprise') {
    const win = values.win_rate?.[0];
    if (win !== null && win !== undefined) addFinding('赢单观察', `赢单率为 ${win}%，分母是已关闭商机，open 管道没有被当作收入。`, win < 20 ? 'warning' : 'neutral', `赢单率 ${win}%`);
    const pipeline = values.pipeline?.[0];
    if (pipeline !== null && pipeline !== undefined) addFinding('管道观察', `Open 管道金额为 ${pipeline} ${currencyUnit}。管道覆盖不等同于已实现收入，需要结合阶段和成交周期判断。`, 'neutral', `Open 管道 ${pipeline} ${currencyUnit}`);
    const cycle = values.sales_cycle_days?.[0];
    if (cycle !== null && cycle !== undefined) addFinding('销售周期观察', `平均销售周期为 ${cycle} 天，仅统计同时具备创建和成交日期的赢单商机。`, 'neutral', `销售周期 ${cycle} 天`);
  }
  if (profile.id === 'adtech') {
    const roas = values.roas?.[0];
    if (roas !== null && roas !== undefined) addFinding('投放回报观察', `ROAS 为 ${roas} 倍，计算方式是收入 / 消耗。ROAS 不是利润率，也不包含未回传的转化价值。`, roas < 1 ? 'warning' : 'positive', `ROAS ${roas}`);
    const ctr = values.ctr?.[0];
    if (ctr !== null && ctr !== undefined) addFinding('点击效率观察', `CTR 为 ${ctr}%，曝光和点击均来自投放日报聚合值，零分母时返回无数据。`, 'neutral', `CTR ${ctr}%`);
  }
  if (weekdayPeak && weekdaySpread !== null && weekdaySpread >= 15) findings.push({
    title: '周内活跃规律', detail: `${weekdayPeak.label}平均活跃最高（${weekdayPeak.dau} 人），${weekdayLow.label}最低（${weekdayLow.dau} 人），相差 ${weekdaySpread}%。这是所选范围内的描述性规律，不能单独证明活动或推送造成了差异。`, severity: 'neutral', evidence: `${weekdayPeak.label} 平均活跃 ${weekdayPeak.dau}；${weekdayLow.label} 平均活跃 ${weekdayLow.dau}`,
  });
  if (topChannel && channelTotal >= 30 && topChannelShare >= 50) findings.push({
    title: '渠道集中度', detail: `${topChannel.name} 贡献 ${topChannelShare}% 的${profile.labels.channelUsers || '新增'}（${topChannel.users} / ${channelTotal}）。渠道集中会放大单一渠道波动，不能仅凭占比判断质量。`, severity: topChannelShare >= 70 ? 'warning' : 'neutral', evidence: `${topChannel.name} 新增 ${topChannel.users}，占 ${channelTotal} 的 ${topChannelShare}%`,
  });
  findings.push(...domainFindings);
  if (issues.length) findings.push({ title: '数据质量提示', detail: `${issues.map(issue => issue.replace(/[。；;]\s*$/, '')).join('；')}。`, severity: 'warning', evidence: `${issues.length} 项质量提示` });
  if (!findings.length) findings.push({ title: '数据覆盖不足', detail: '当前数据没有足够的已结束自然日覆盖来形成领域观察，请补充完整日期范围后重新分析。', severity: 'neutral', evidence: '没有可计算的领域指标' });
  const recommendations = [
    `围绕“${goal}”，先确认${profile.name}的核心口径和已结束自然日覆盖，再比较细分群体的差异。`,
    channels.length ? `优先复核 ${channels[0].name} 的样本量、覆盖范围和收入贡献，再决定是否扩大投入。` : `补充${labels.users}或渠道字段，以支持细分群体比较。`,
    ...domainFindings.filter(finding => finding.severity === 'warning').slice(0, 2).map(finding => `针对“${finding.title}”补充明细数据和业务记录，再用下一周期数据验证观察是否稳定。`),
    ...(capability.missingTables.length ? [`补齐缺失数据表后可解锁更多指标：${capability.missingTables.map(table => `${table.label}（${table.unlocks.join('、') || '相关指标'}）`).join('；')}。`] : []),
    ...(capability.missingFields.length ? [`以下字段缺失导致部分指标无数据：${capability.missingFields.map(field => field.label).join('、')}；补齐后再判断相关表现。`] : []),
    context ? `结合追加背景“${context}”安排分组复盘或验证实验；现有数据只能支持观察性结论。` : '把活动日历、版本变更、投放成本或渠道成本补充为业务背景，再验证观察到的变化。',
  ];
  const summaryParts = keyMetrics.map(metric => `${metric.label} ${metric.value}${metric.unit}`);
  const summary = `${demo}${completenessNote}${freshnessNote}${timezone.assumed ? `时区未确认，已按 ${timezone.name} 解释。` : ''}围绕“${goal}”分析 ${start} 至 ${end} 的 ${totalRows} 行记录。${summaryParts.length ? `主要指标：${summaryParts.join('、')}。` : '当前没有足够的已结束自然日数据形成主要指标。'}${missingLabels.length ? `缺少${missingLabels.join('、')}，相关指标不可计算。` : ''}${context ? `已纳入追加背景：${context}。` : ''}`;
  return {
    title: `${options.title || dataset.name} · ${capability.missingTables.length ? '部分数据分析报告' : profile.reportName}`,
    domain: profile.id, labels: { ...profile.labels, metrics: profile.metricLabels, entity: profile.entity, newEntity: profile.newEntity, activeEntity: profile.activeEntity, payerEntity: profile.payerEntity, revenueName: profile.revenueName },
    period: `${start} 至 ${end}`, generatedAt: new Date(now).toISOString(), currency,
    timezone: { name: timezone.name, offsetMinutes: timezone.offsetMinutes, assumed: timezone.assumed, source: timezone.source },
    summary, findings, recommendations, metrics, daily, retention, channels, weekday, payerSummary, capability,
    extras: {
      topStore: topStore ? { name: topStore[0], revenue: round(topStore[1] / 100) } : null,
      topProduct: topProduct ? { name: topProduct[0], revenue: round(topProduct[1] / 100) } : null,
      stages: [...stages].map(([name, count]) => ({ name, count })),
      totalImpressions, totalClicks, totalConversions, totalSpend: totalSpendCents / 100,
    },
    factContext: {
      missingTables: capability.missingTables.map(table => table.table),
      coverage,
      incomplete: Object.fromEntries(Object.entries(originalRecords).map(([type, rows]) => [type, rows.filter(row => dateOf(row[timeFields[type]], tz) > cutoff).length])),
      timezone: { name: timezone.name, offsetMinutes: timezone.offsetMinutes, assumed: timezone.assumed },
    },
    quality: { rows: totalRows, issues: [...new Set(issues)], score: Math.max(0, 100 - issues.length * 5) },
    methodology: [
      `项目时区为 ${timezoneCaption(timezone)}${timezone.assumed ? '（未确认）' : ''}；仅使用已结束自然日，排除当日和未来记录。${completenessNote}`,
      ...profile.methodology,
      `${profile.name}的指标依赖按表级和字段级校验；缺少事件类型、时长、课程、门店、订阅周期、阶段或投放字段时，对应指标显示无数据而不是 0。`,
      `本报告为确定性聚合结果，口径为${profile.metricOrder.map(id => profile.metricLabels[id]).filter(Boolean).join('、')}；原始记录与聚合值均可追溯。`,
      ...(scoped ? [`本报告为筛选派生结果：${periodLabel}；${selectedChannels.size ? `渠道 ${[...selectedChannels].join('、')}` : '全部渠道'}。原报告 AI 叙述与日环比不沿用。`] : []),
    ],
    source: 'local',
  };
}

