import { SCHEMA, analyze, normalizeRecords, timestamp, dateOf, shiftDate, yesterday } from './analytics.js';
import { normalizeTimezone, timezoneMinutes, timezoneCaption } from './timezone.js';
import { buildCapability } from './capability.js';
import { getProfile } from './domain-profiles.js';
import { analyzeDomain } from './domain-analytics.js';

const timeFields = { users: 'registered_at', activity: 'event_time', payments: 'paid_at' };
const gameLabels = { users: '注册表', activity: '活跃表', payments: '支付表' };
const gameAffected = {
  users: ['new_users', 'd1_retention', 'd7_retention', 'channels'],
  activity: ['dau', 'd1_retention', 'd7_retention', 'pay_rate', 'arpdau'],
  payments: ['revenue', 'arppu', 'payers', 'pay_rate', 'arpdau'],
};
function affectedFor(profile) {
  if (profile.id === 'game') return gameAffected;
  const map = { users: ['channels'], activity: [], payments: [] };
  for (const [id, deps] of Object.entries(profile.metricDependencies)) {
    for (const dep of deps) {
      const table = dep.split('.')[0];
      if (map[table] && !map[table].includes(id)) map[table].push(id);
    }
  }
  return map;
}
const fieldSet = dataset => new Set(Object.entries(dataset.fieldPresence || {}).flatMap(([table, fields]) => fields.map(field => `${table}.${field}`)));
const qualityRule = '复用 analyze 的 quality.score：max(0, 100 - 计分提示数 × 5)。计分提示为分析器去重输出前的 warnings、缺表、当日或未来、无完整覆盖、跨表覆盖不一致、非成功订单和未匹配注册用户提示；同类提示可合并展示，结构化问题数不等于计分提示数。无法分析时不评分。';
const issue = (code, severity, problem, metrics, fix, location) => ({ code, severity, problem, metrics, fix, ...(location ? { location } : {}) });
export const inspectionError = (message, issues) => Object.assign(new Error(message), { issues });
const rowLocation = (table, field, indices, evidence) => {
  const first = evidence?.rows?.[table]?.[indices[0]];
  const locations = indices.map(index => evidence?.rows?.[table]?.[index]).filter(Boolean);
  return { table, ...(first?.source && new Set((evidence?.rows?.[table] || []).map(row => row.source)).size > 1 ? { source: first.source } : {}), ...(field ? { column: first?.columns?.[field] || field } : {}), ...(locations.length ? { rows: [...new Set(locations.map(location => location.row))].slice(0, 5) } : {}) };
};
const duplicateGroups = (records, table, offsetMinutes = 480) => {
  const field = table === 'users' ? 'user_id' : 'order_id';
  const groups = new Map();
  (records[table] || []).forEach((row, index) => {
    const key = table === 'activity' ? JSON.stringify([String(row.user_id ?? '').trim(), timestamp(row.event_time, '时间', offsetMinutes)]) : String(row[field] ?? '').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  return [...groups.values()].filter(indices => indices.length > 1);
};

export function normalizeDatasetRecords(records, warnings = [], evidence, offsetMinutes = 480) {
  try { return normalizeRecords(records, warnings, offsetMinutes); }
  catch (error) {
    if (/^重复订单 [\s\S]*冲突/.test(error.message)) {
      const indices = duplicateGroups(records, 'payments', offsetMinutes).find(group => {
        try { normalizeRecords({ payments: group.map(index => records.payments[index]) }, [], offsetMinutes); return false; }
        catch { return true; }
      }) || [];
      throw inspectionError('重复订单的金额、用户、状态或时间冲突，请先核对数据', [issue('conflicting_orders', 'error', '同一订单的金额、用户、状态或时间存在冲突，无法安全计算支付指标。', gameAffected.payments, '根据定位行核对并修正重复订单，保留一致的订单记录。', rowLocation('payments', 'order_id', indices, evidence))]);
    }
    const match = /^(users|activity|payments) 第 (\d+) 行(.*)$/.exec(error.message);
    let table = match?.[1];
    let index = match ? Number(match[2]) - 2 : null;
    let field = match?.[3].match(/缺少 (\w+)/)?.[1] || (table ? timeFields[table] : undefined);
    if (!match) {
      invalidRow: for (const [type, rows] of Object.entries(records)) {
        if (!SCHEMA[type]) continue;
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          try { normalizeRecords({ [type]: [rows[rowIndex]] }, [], offsetMinutes); }
          catch (rowError) {
            table = type; index = rowIndex;
            field = /金额/.test(rowError.message) ? 'amount' : /币种/.test(rowError.message) ? 'currency' : timeFields[type];
            break invalidRow;
          }
        }
      }
    }
    const location = table ? rowLocation(table, field, [index], evidence) : undefined;
    const message = match && location.rows?.length ? `${table} 第 ${location.rows[0]} 行${match[3]}` : error.message;
    throw inspectionError(message, [issue('invalid_data', 'error', message, table ? gameAffected[table] : ['revenue', 'arppu'], '核对指定字段格式、必填值及币种口径后重新上传。', location)]);
  }
}

export function assertAnalyzable(dataset, options = {}) {
  const profile = getProfile(options.domain || dataset.domain);
  try { return analyzeDomain(dataset, { ...options, domain: profile.id }); }
  catch (error) {
    // Stored metadata is advisory. Always inspect the actual records before reserving credit.
    let message = error.message;
    if (/^重复订单 [\s\S]*冲突/.test(message)) message = '重复订单的金额、用户、状态或时间冲突，请先核对数据';
    throw inspectionError(message, [issue('not_analyzable', 'error', message, profile.metricOrder, '修正数据并确保至少一个有效记录位于已结束自然日，分析跨度不超过十年。')]);
  }
}

export function inspectDataset(dataset, { rawRecords = dataset.records, evidence, now = new Date() } = {}) {
  const records = dataset.records;
  const profile = getProfile(dataset.domain);
  const labels = profile.tableLabels;
  const affected = affectedFor(profile);
  const fields = fieldSet(dataset);
  const capability = buildCapability(Object.keys(records), profile, fields);
  const timezone = normalizeTimezone(dataset.timezone, { legacyAt: dataset.createdAt });
  const tz = timezoneMinutes(timezone);
  const mappings = evidence?.mappings || (dataset.source === 'demo' ? Object.keys(records).flatMap(table => SCHEMA[table].map(field => ({ table, source: dataset.name, field, sourceColumn: null, origin: 'generated', required: field !== 'channel' }))) : []);
  const coverage = Object.entries(records).map(([table, rows]) => {
    const dates = rows.map(row => dateOf(row[timeFields[table]], tz)).sort();
    const rawStart = dates[0] || null, rawEnd = dates.at(-1) || null;
    const end = dataset.completeness?.declared === 'partial' && rawEnd && rawStart !== rawEnd ? shiftDate(rawEnd, -1) : rawEnd;
    return { table, start: rawStart, end: end && rawStart <= end ? end : null, validRows: rows.length };
  });
  const missingTables = capability.missingTables.map(table => table.table);
  const issues = missingTables.map(table => issue(`missing_${table}`, 'warning', table === 'payments' ? (profile.id === 'game' ? '缺少支付表，收入、ARPPU、付费人数不可计算，活跃付费率与 ARPDAU 也无数据。' : `缺少${labels.payments}，${(affected.payments || []).slice(0, 4).join('、')}等指标不可计算。`) : `缺少${labels[table]}，相关指标不可计算。`, affected[table], `补充具有标准必填字段的${labels[table]}后重新上传。`, { table }));
  for (const table of ['users', 'payments', 'activity']) {
    const groups = duplicateGroups(rawRecords, table, tz);
    if (groups.length) issues.push(issue(`duplicate_${table}`, table === 'activity' ? 'info' : 'warning', table === 'users' ? '检测到重复用户，注册时间取最早记录。' : table === 'payments' ? '检测到一致的重复订单，已按订单编号去重。' : '检测到用户与时间相同的重复事件；有效事件记录保留，活跃指标按用户去重。', affected[table], '根据定位示例核对重复记录，清理源表后重新上传。', rowLocation(table, table === 'users' ? 'user_id' : table === 'payments' ? 'order_id' : 'event_time', groups.flat().slice(0, 5), evidence)));
  }
  const cutoff = yesterday(now, tz);
  for (const [table, rows] of Object.entries(rawRecords)) {
    if (!SCHEMA[table]) continue;
    const future = rows.flatMap((row, index) => dateOf(timestamp(row[timeFields[table]], '时间', tz), tz) > cutoff ? [index] : []);
    if (future.length) issues.push(issue('incomplete_day', 'warning', `${labels[table]}有 ${future.length} 行当日或未来记录，分析将排除这些未结束自然日；全量覆盖与有效行数仍保留。`, affected[table], '等待自然日结束，或修正源表中的错误日期后重新上传。', rowLocation(table, timeFields[table], future.slice(0, 5), evidence)));
  }
  const missingChannel = (rawRecords.users || []).flatMap((row, index) => String(row.channel ?? '').trim() ? [] : [index]);
  if (missingChannel.length) issues.push(issue('generated_channel', 'info', '缺少渠道值的用户已归入“未标记渠道”。', ['channels'], '补充源表渠道字段，以支持真实的渠道比较。', rowLocation('users', 'channel', missingChannel.slice(0, 5), evidence)));
  let report;
  try { report = assertAnalyzable(dataset, { now }); }
  catch (error) { issues.push(...error.issues); }
  for (const problem of report?.quality.issues || []) {
    if (new RegExp(`重复用户|重复订单|缺少(${Object.values(labels).join('|')})|当日或未来记录`).test(problem)) continue;
    if (/跨表覆盖范围不一致/.test(problem)) issues.push(issue('coverage_mismatch', 'warning', problem, Object.values(affected).flat(), '核对各表导出范围，补齐需要比较的日期区间。'));
    else if (/时区/.test(problem)) issues.push(issue(timezone.assumed ? 'timezone_unconfirmed' : 'timezone_mismatch', 'warning', problem, Object.values(affected).flat(), `在数据检查中确认项目时区；当前${timezone.assumed ? `未确认，按 ${timezoneCaption(timezone)}解释` : `声明为 ${timezoneCaption(timezone)}`}，带时区时间按自身偏移换算。`));
    else if (/完整性|分片/.test(problem)) issues.push(issue('completeness_declaration', 'warning', problem, Object.values(affected).flat(), '确认数据完整性声明；分片数据请补充其他分片，或将声明改为全量后重新分析。'));
    else if (/没有已结束自然日覆盖/.test(problem)) {
      const table = Object.keys(labels).find(type => problem.startsWith(labels[type]));
      issues.push(issue('no_complete_coverage', 'warning', problem, affected[table] || [], '补充已结束自然日数据后重新上传。', table ? { table } : undefined));
    } else if (/非成功状态订单/.test(problem)) {
      const successful = new Set(profile.successStatuses);
      const indices = (rawRecords.payments || []).flatMap((row, index) => successful.has(String(row.status ?? '').trim().toLowerCase()) ? [] : [index]);
      issues.push(issue('unsuccessful_payments', 'info', problem, affected.payments, '核对订单状态；支付指标仅统计成功订单。', rowLocation('payments', 'status', indices.slice(0, 5), evidence)));
    } else if (/未匹配注册表/.test(problem)) issues.push(issue('unmatched_users', 'warning', problem, (affected.users || []).concat(['new_users', 'd1_retention', 'd7_retention', 'channels']), '补齐对应注册记录并核对跨表用户标识。'));
    else issues.push(issue('source_notice', 'info', dataset.source === 'demo' ? '确定性生成的示例数据，仅用于产品演示，不代表真实业务。' : '源数据包含分析器质量提示。', [], '核对数据来源与分析使用范围。'));
  }
  return { version: 1, mappings, coverage, missingTables, capability, issues, timezone: { name: timezone.name, offsetMinutes: timezone.offsetMinutes, assumed: timezone.assumed, source: timezone.source }, quality: { score: report?.quality.score ?? null, rule: qualityRule }, analyzable: Boolean(report), rawRows: Object.values(rawRecords).reduce((count, rows) => count + rows.length, 0), validRows: coverage.reduce((count, table) => count + table.validRows, 0) };
}
