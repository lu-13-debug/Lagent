import inputContract from '../src/input-contract.json' with { type: 'json' };
export const SUPPORTED_FORMATS = Object.freeze(inputContract.supportedFormats);
export const REQUIRED_COLUMNS = Object.freeze(inputContract.requiredColumns);
import { normalizeCompleteness } from './completeness.js';
import { normalizeTimezone, timezoneMinutes, formatOffset, timezoneCaption } from './timezone.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { SCHEMA, OPTIONAL_FIELDS, fieldsFor, dateOf, shiftDate, yesterday } from './analytics.js';
import { getProfile } from './domain-profiles.js';
import { inspectDataset, inspectionError, normalizeDatasetRecords } from './inspection.js';
import { buildCapability } from './capability.js';

const MAX_ROWS = 200000;
const MAX_BYTES = 20 * 1024 * 1024;
// 生产固定三文件；分片实验只能在非生产环境显式开启。
const MAX_FILES = process.env.NODE_ENV !== 'production' && process.env.DATAAGENT_ENABLE_MULTI_SHARD === '1' ? 20 : inputContract.maxFiles;
// 基准（scripts/bench-dataset.mjs，2026-10-30，本机）：20 万行三表 CSV 解析 7.1 秒、堆增量 283MB；
// 50 万行 18.5 秒、654MB。升到 50 万需同时满足“5 秒内、堆增量 400MB 内”，实测两项均超，
// 且 20MB 体积上限本身只容纳约 55 万行，因此维持 20 万行；提升上限必须改为流式解析而非只改常量。
export const DATASET_LIMITS = Object.freeze({ maxRows: MAX_ROWS, maxBytes: MAX_BYTES, maxFiles: MAX_FILES });
const rowLimitMessage = limit => `解析后最多支持 ${limit} 行数据，本次已超过该上限；请按时间范围拆分文件、只导出必要列，或缩小日期范围后重试。`;
const sizeLimitMessage = bytes => `文件总大小不能超过 20MB（当前 ${(bytes / 1048576).toFixed(1)}MB）；请按时间范围拆分文件、只导出必要列，或压缩日期范围后重试。`;
const aliases = {
  user_id: ['user_id', 'properties.user_id', 'userid', 'uid', '用户id', '用户编号', '玩家id', '玩家编号', '用户标识', 'account_id', '账户id', '账户编号', '学员id', 'student_id', '客户id', 'customer_id'],
  registered_at: ['registered_at', 'registeredat', 'register_time', 'registration_time', 'register_at', 'signup_at', 'signup_time', '注册时间', '注册日期', '创建时间', '注册日'],
  channel: ['channel', '渠道', '来源渠道', '注册渠道', '渠道来源', '媒体', '获客渠道'],
  event_time: ['event_time', 'properties.event_time', 'eventtime', 'active_time', 'activity_time', '事件时间', '活跃时间', '活动时间', '登录时间', '访问时间', '浏览时间', '观看时间', '行为时间', '日期'],
  order_id: ['order_id', 'orderid', '订单id', '订单号', '订单编号', '订单编码', '交易号', '交易编号', 'booking_id', '预订id', '预订编号'],
  paid_at: ['paid_at', 'paidat', 'pay_time', 'payment_time', '支付时间', '付款时间', '支付日期', '付款日期', '交易时间', '成交时间', '下单时间'],
  amount: ['amount', '金额', '支付金额', '付款金额', '实付金额', '订单金额', '交易金额', '实付'],
  currency: ['currency', '币种', '货币', '货币代码'],
  status: ['status', '状态', '支付状态', '订单状态', '订阅状态'],
  event_type: ['event_type', 'eventtype', '事件类型', '事件名', '事件名称', '行为类型', '行为', '动作', 'type'],
  event_name: ['event_name'],
  content_id: ['content_id', '内容id', '内容编号', '视频id', '直播id'],
  course_id: ['course_id', '课程id', '课程编号'],
  store_id: ['store_id', '门店id', '门店编号', '店铺id', '店铺编号'],
  creator_id: ['creator_id', '创作者id', '作者id', '主播id'],
  property_id: ['property_id', '房源id', '酒店id', '酒店编号'],
  duration_seconds: ['duration_seconds', 'duration', '观看时长', '时长秒', '时长'],
  refund_amount: ['refund_amount', '退款金额', '退款额'],
  product_type: ['product_type', '产品类型', '商品类型', '品类', '收入类型'],
  plan: ['plan', '套餐', '订阅计划', '会员计划'],
  industry: ['industry', '行业'],
  owner: ['owner', '负责人', '销售负责人', '客户经理'],
  start_at: ['start_at', '订阅开始时间', '开始时间'],
  end_at: ['end_at', '订阅结束时间', '结束时间'],
  check_in: ['check_in', '入住日期', '入住时间'],
  check_out: ['check_out', '离店日期', '离店时间'],
  distance_km: ['distance_km', '距离', '公里数'],
  driver_id: ['driver_id', '司机id', '骑手id'],
  stage: ['stage', '阶段', '商机阶段'],
  close_at: ['close_at', '成交日期', '成交时间'],
  impressions: ['impressions', '曝光', '曝光数'],
  clicks: ['clicks', '点击', '点击数'],
  conversions: ['conversions', '转化', '转化数'],
  spend: ['spend', '消耗', '花费'],
  campaign_id: ['campaign_id', '计划id', '计划编号'],
  trip_id: ['trip_id', '行程id', '行程编号'],
  created_at: ['created_at', '创建时间', '创建日期'],
  started_at: ['started_at', '开始时间'],
  completed_at: ['completed_at', '完成时间'],
  renewal_at: ['renewal_at', '续费时间'],
  subscription_id: ['subscription_id', '订阅id', '订阅编号'],
  account_id: ['account_id', '账户id', '账户编号'],
  opportunity_id: ['opportunity_id', '商机id', '商机编号'],
  revenue: ['revenue', '收入', '广告收入'],
  online_minutes: ['online_minutes', '在线时长', '在线分钟'],
  expansion: ['expansion', '扩张金额', '增购金额'],
};
const cleanHeader = text => String(text ?? '').trim().replace(/^\uFEFF/, '').toLowerCase().replaceAll(' ', '').replaceAll('/', '.');
const baseAliasMap = new Map(Object.entries(aliases).flatMap(([key, list]) => list.map(x => [cleanHeader(x), key])));
function aliasMapFor(type, profile) {
  const fields = new Set(fieldsFor(type));
  const map = new Map();
  for (const [key, field] of baseAliasMap) if (fields.has(field)) map.set(key, field);
  for (const [key, list] of Object.entries(profile?.aliases || {})) {
    if (!fields.has(key)) continue;
    for (const name of list) map.set(cleanHeader(name), key);
  }
  for (const field of fields) map.set(cleanHeader(field), field);
  return map;
}
function columnsFor(matrix, type, profile) {
  const map = aliasMapFor(type, profile);
  return matrix[0].map(h => map.get(cleanHeader(h)) || cleanHeader(h));
}
const typesByName = name => {
  const value = name.toLowerCase();
  if (/payment|order|支付|付款|订单|交易|订阅|商机|行程|投放|广告/.test(value)) return 'payments';
  if (/activity|active|event|活跃|活动|事件|登录|学习|观看|浏览|互动|触点/.test(value)) return 'activity';
  if (/user|register|account|student|用户|注册|玩家|账户|学员|客户|会员/.test(value)) return 'users';
  return null;
};
function typeByName(name, profile) {
  const hint = profile?.tableHints?.find(([pattern]) => pattern.test(name.toLowerCase()));
  return hint ? hint[1] : typesByName(name);
}
function resolveDefault(spec, row) {
  let value;
  if ('value' in spec) value = spec.value;
  else if (spec.join) value = spec.join.map(field => row[field]).filter(item => item !== undefined && item !== '').join(spec.separator || '');
  else if (spec.from) value = spec.from.map(field => row[field]).find(item => item !== undefined && item !== '');
  if ((value === undefined || value === '') && spec.fallback !== undefined) value = spec.fallback;
  if (value !== undefined && value !== '' && spec.prefix) value = `${spec.prefix}${value}`;
  return value === '' ? undefined : value;
}
function tableFromRows(name, matrix, source = name, rowNumbers = [], profile = getProfile('game')) {
  if (!matrix.length) throw new Error(`${name} 是空表`);
  const named = typeByName(name, profile);
  let type = named;
  if (!type) {
    const matches = Object.keys(SCHEMA).filter(candidate => {
      const columns = columnsFor(matrix, candidate, profile);
      const defaults = profile.defaults?.[candidate] || {};
      return SCHEMA[candidate].filter(field => field !== 'channel').every(field => columns.includes(field) || defaults[field]);
    });
    type = matches.length === 1 ? matches[0] : null;
  }
  if (!type) {
    const guide = profile.id === 'game'
      ? 'users(user_id,registered_at,channel)、activity(user_id,event_time) 或 payments(order_id,user_id,paid_at,amount,currency,status)'
      : `users、activity 或 payments 标准表；也可以提供 ${profile.name} 常见的订单、订阅、商机、行程或投放日报列名`;
    throw inspectionError(`${name} 无法识别标准表类型。请提供 ${guide}`, []);
  }
  const columns = columnsFor(matrix, type, profile);
  if (new Set(columns).size !== columns.length) throw new Error(`${name} 含重复列名或映射后重复的列`);
  const defaults = profile.defaults?.[type] || {};
  const missingRequired = SCHEMA[type].filter(field => field !== 'channel' && !columns.includes(field) && !defaults[field]);
  if (missingRequired.length) {
    throw inspectionError(`${name} 无法识别标准表类型：缺少 ${profile.tableLabels[type] || type} 的必填字段 ${missingRequired.join('、')}`, missingRequired.map(field => ({
      code: 'missing_required_field', severity: 'error', problem: `${name} 缺少必填字段 ${field}，无法解析该表。`, metrics: [], fix: '补充必填列后重新上传；已有表不能缺少必填字段。', location: { table: type, column: field },
    })));
  }
  const fields = fieldsFor(type);
  const mappings = fields.filter(field => columns.includes(field) || defaults[field] || (type === 'users' && field === 'channel')).map(field => ({
    table: type, source, field, sourceColumn: columns.includes(field) ? String(matrix[0][columns.indexOf(field)]) : null,
    origin: columns.includes(field) ? 'automatic' : 'generated', required: field !== 'channel',
  }));
  const sourceColumns = Object.fromEntries(mappings.map(mapping => [mapping.field, mapping.sourceColumn]));
  const rows = [];
  const locations = [];
  for (let index = 1; index < matrix.length; index++) {
    const values = matrix[index];
    if (values.every(v => v === '' || v === null || v === undefined)) continue;
    const row = {};
    for (const field of fields) {
      const idx = columns.indexOf(field);
      if (idx >= 0 && values[idx] !== '' && values[idx] !== null && values[idx] !== undefined) row[field] = values[idx];
    }
    for (const field of fields) {
      if (row[field] !== undefined || !defaults[field]) continue;
      const value = resolveDefault(defaults[field], row);
      if (value !== undefined) row[field] = value;
    }
    if (type === 'users' && row.user_id === undefined && row.account_id !== undefined) row.user_id = row.account_id;
    if (type === 'payments' && row.user_id === undefined && row.account_id !== undefined) row.user_id = row.account_id;
    for (const field of SCHEMA[type]) {
      if (row[field] !== undefined) continue;
      if (field === 'channel' && type === 'users') row.channel = '未标记渠道';
      else throw new Error(`${name} 第 ${rowNumbers[index] || index + 1} 行缺少必填字段 ${field}`);
    }
    rows.push(row);
    locations.push({ row: rowNumbers[index] || index + 1, columns: sourceColumns, source });
  }
  if (!rows.length) throw new Error(`${name} 没有数据行`);
  return { type, rows, mappings, locations, columns, unrecognized: matrix[0].filter((_, i) => !fields.includes(columns[i])).map(String) };
}
const timeFields = { users: 'registered_at', activity: 'event_time', payments: 'paid_at' };
const zonedPattern = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;
function timezoneSurvey(records) {
  const offsets = new Map();
  let zoned = 0, unzoned = 0, rows = 0;
  for (const [type, list] of Object.entries(records)) {
    if (!SCHEMA[type] || !Array.isArray(list)) continue;
    for (const row of list) {
      rows++;
      const text = String(row?.[timeFields[type]] ?? '').trim();
      const match = zonedPattern.exec(text);
      if (!match) { unzoned++; continue; }
      zoned++;
      const zone = match[1];
      const minutes = /^z$/i.test(zone) ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2)));
      offsets.set(minutes, (offsets.get(minutes) || 0) + 1);
    }
  }
  return { offsets, zoned, unzoned, rows };
}
function timezoneWarnings(timezone, survey, declared, inferred) {
  const warnings = [];
  const mix = [...survey.offsets.keys()];
  if (declared) {
    if (survey.unzoned) warnings.push(`有 ${survey.unzoned} 条时间未带时区，已按声明的 ${timezoneCaption(timezone)}解释`);
    if (mix.length > 1) warnings.push(`数据包含多种时区偏移（${mix.map(formatOffset).join('、')}），日期按每条记录自身偏移归属，请确认是否存在混用`);
    else if (mix.length === 1 && mix[0] !== timezone.offsetMinutes) warnings.push(`数据中的带时区时间为 ${formatOffset(mix[0])}，与声明的 ${formatOffset(timezone.offsetMinutes)} 不同；带时区时间按自身偏移换算`);
  } else if (inferred) {
    warnings.push(`未声明时区，已从数据中的 ${formatOffset(timezone.offsetMinutes)} 偏移推断，请在数据检查中确认`);
    if (survey.unzoned) warnings.push(`另有 ${survey.unzoned} 条时间未带时区，暂按推断的 ${timezone.name} 解释`);
  } else {
    warnings.push(`未声明时区，${survey.rows} 条时间按默认 ${timezoneCaption(timezone)}解释，请在数据检查中确认`);
  }
  if (!declared && mix.length > 1) warnings.push(`数据包含多种时区偏移（${mix.map(formatOffset).join('、')}），日期归属可能不一致；请声明项目时区`);
  return warnings;
}
function excelValue(cell) {
  const value = cell.value;
  // Excel has no timezone. ExcelJS's UTC fields hold the displayed wall clock,
  // so emit it naive and let the dataset timezone decide the day boundary.
  if (value instanceof Date) return value.toISOString().slice(0, 19);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    if ('formula' in value || 'sharedFormula' in value) throw new Error('不接受公式单元格，请将公式转换为值后上传');
    if ('richText' in value) return value.richText.map(x => x.text).join('');
    if ('text' in value) return value.text;
    throw new Error('表格含不支持的单元格类型，请转换为纯文本或数值');
  }
  return value ?? '';
}
export function createDataset(records, { name = '上传数据', source = 'upload', warnings = [], now = new Date(), evidence, completeness, timezone: declared, maxRows = MAX_ROWS, domain = 'game' } = {}) {
  const profile = getProfile(domain);
  const all = Object.values(records).flat();
  if (all.length > maxRows) throw new Error(rowLimitMessage(maxRows));
  const survey = timezoneSurvey(records);
  const offsets = [...survey.offsets.keys()];
  const inferred = !declared && survey.unzoned === 0 && offsets.length === 1 ? { name: formatOffset(offsets[0]), offsetMinutes: offsets[0] } : null;
  const timezone = normalizeTimezone(inferred || declared, { legacyAt: now, strict: Boolean(declared), source: declared ? 'user' : inferred ? 'detected' : 'default', assumed: !declared });
  const tz = timezoneMinutes(timezone);
  const normalized = normalizeDatasetRecords(records, [...warnings, ...timezoneWarnings(timezone, survey, Boolean(declared), Boolean(inferred))], evidence, tz);
  const dates = Object.entries(normalized.records).flatMap(([type, rows]) => rows.map(x => dateOf(x[timeFields[type]], tz))).sort();
  if (!dates.length) throw new Error('没有可分析的数据行');
  const tables = Object.entries(normalized.records).map(([type, rows]) => ({ name: type, type, columns: SCHEMA[type], rowCount: rows.length, preview: rows.slice(0, 5) }));
  const fieldPresence = Object.fromEntries(Object.entries(normalized.records).map(([type, rows]) => [type, [...new Set(rows.flatMap(row => Object.keys(row)))]]));
  const dataset = { domain: profile.id, timezone, timezoneZoneless: survey.unzoned, completeness: normalizeCompleteness(completeness, { now, strict: true }), id: randomUUID(), name, source, createdAt: new Date(now).toISOString(), rowCount: all.length, tableCount: tables.length, tables, warnings: normalized.warnings, dateRange: { start: dates[0], end: dates.at(-1) }, channelCount: new Set((normalized.records.users || []).map(u => u.channel)).size, records: normalized.records, fieldPresence };
  dataset.inspection = inspectDataset(dataset, { rawRecords: records, evidence, now });
  return dataset;
}
export function publicDataset(dataset) {
  const { records, ...safe } = dataset;
  const capability = safe.inspection?.capability || buildCapability((dataset.tables || []).map(table => table.type));
  const result = { ...safe, domain: dataset.domain || 'game', capability, completeness: normalizeCompleteness(dataset.completeness, { legacyAt: dataset.createdAt }), timezone: normalizeTimezone(dataset.timezone, { legacyAt: dataset.createdAt }) };
  if (safe.inspection) result.inspection = safe.inspection.capability ? safe.inspection : { ...safe.inspection, capability };
  return result;
}

export async function parseFiles(files, { completeness, timezone, maxRows = MAX_ROWS, maxBytes = MAX_BYTES, domain = 'game' } = {}) {
  if (!files?.length) throw new Error(inputContract.description);
  if (files.length > MAX_FILES) throw new Error(`最多上传 ${MAX_FILES} 个文件；请合并同表文件或按时间范围拆分后分批上传。`);
  const profile = getProfile(domain);
  const totalBytes = files.reduce((n, f) => n + f.buffer.length, 0);
  if (totalBytes > maxBytes) throw new Error(sizeLimitMessage(totalBytes));
  const records = {};
  const shards = []; const structures = new Map();
  const evidence = { mappings: [], rows: {}, unrecognizedColumns: [] };
  let rowCount = 0;
  for (const file of files) {
    const name = path.basename(file.originalname).replace(/[\x00-\x1f]/g, '').slice(0, 100);
    const ext = path.extname(name).toLowerCase();
    const append = (label, matrix, source = name, rowNumbers) => {
      const { type, rows, mappings, locations, columns, unrecognized } = tableFromRows(label, matrix, source, rowNumbers, profile);
      const signature = JSON.stringify([...columns].sort());
      if (structures.has(type) && structures.get(type) !== signature) throw new Error(`${source} 的 ${type} 分片列结构不一致，请统一表头后重试。`);
      structures.set(type, signature);
      shards.push({ source, table: type, rows });
      evidence.unrecognizedColumns.push(...unrecognized.map(column => ({ source, table: type, column, label: column === 'properties.level' ? '等级' : column, status: 'identified_unused', reason: '当前分析引擎没有对应指标，已识别但未参与计算' })));
      rowCount += rows.length;
      if (rowCount > maxRows) throw new Error(rowLimitMessage(maxRows));
      const target = records[type] ||= [];
      for (const row of rows) target.push(row);
      evidence.mappings.push(...mappings);
      const sourceRows = evidence.rows[type] ||= [];
      for (const location of locations) sourceRows.push(location);
    };
    if (ext === '.csv') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
      let matrix;
      try { matrix = parse(text, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: false, max_record_size: 1024 * 1024, info: true }); }
      catch { throw new Error(`${name} CSV 格式无效，请检查列数、引号并使用 UTF-8 编码`); }
      // Walk physical source bytes once. Parser line counters differ for CRLF inside quotes.
      const bytes = Buffer.from(text, 'utf8'); let offset = 0; let line = 1;
      const consume = end => {
        for (; offset < end; offset++) if (bytes[offset] === 13 || (bytes[offset] === 10 && bytes[offset - 1] !== 13)) line++;
      };
      const rowNumbers = matrix.map(row => {
        let first = offset;
        while (first < row.info.bytes && [9, 10, 13, 32].includes(bytes[first])) first++;
        consume(first); const start = line; consume(row.info.bytes); return start;
      });
      append(name, matrix.map(row => row.record), name, rowNumbers);
    } else if (ext === '.xlsx') {
      // Inspect ZIP central directory before decompression to reject oversized workbook bombs.
      let totalUncompressed = 0;
      const buf = file.buffer;
      for (let i = 0; i + 46 <= buf.length; i++) if (buf.readUInt32LE(i) === 0x02014b50) {
        totalUncompressed += buf.readUInt32LE(i + 24);
        if (totalUncompressed > 100 * 1024 * 1024) throw new Error('XLSX 解压后超过 100MB，请缩小文件');
        i += 45 + buf.readUInt16LE(i + 28) + buf.readUInt16LE(i + 30) + buf.readUInt16LE(i + 32);
      }
      let workbook;
      try { workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buf); }
      catch { throw new Error(`${name} 无法读取，请上传有效 XLSX 工作簿`); }
      if (workbook.worksheets.length > 10) throw new Error('工作簿最多支持 10 个工作表');
      for (const sheet of workbook.worksheets) {
        if (!sheet.actualRowCount) continue;
        if (sheet.rowCount > maxRows + 1) throw new Error(rowLimitMessage(maxRows));
        const matrix = [];
        const rowNumbers = [];
        sheet.eachRow({ includeEmpty: false }, row => { matrix.push(Array.from({ length: sheet.columnCount }, (_, i) => excelValue(row.getCell(i + 1)))); rowNumbers.push(row.number); });
        append(sheet.name, matrix, `${name} / ${sheet.name}`, rowNumbers);
      }
    } else throw new Error(ext === '.parquet' ? inputContract.parquetGuide : inputContract.description);
  }
  const dataset = createDataset(records, { name: files.length === 1 ? path.basename(files[0].originalname).replace(/\.[^.]+$/, '').slice(0, 100) : `${files.length} 个文件 · ${profile.id === 'game' ? '运营数据' : `${profile.name}数据`}`, completeness, timezone, evidence, maxRows, domain });
  const tz = timezoneMinutes(dataset.timezone);
  const manifest = [];
  for (const shard of shards) {
    const dates = shard.rows.map(row => dateOf(row[timeFields[shard.table]], tz)).sort();
    const start = dates[0], end = dates.at(-1);
    const overlaps = manifest.filter(previous => previous.table === shard.table && start <= previous.end && end >= previous.start).map(previous => previous.source);
    manifest.push({ source: shard.source, table: shard.table, rowCount: shard.rows.length, start, end, overlaps });
    if (overlaps.length) dataset.warnings.push(`${shard.source} 与 ${overlaps.join('、')} 日期范围重叠；原始分片行数保留，指标按既有用户/订单去重规则计算。`);
  }
  for (const table of Object.keys(SCHEMA)) {
    const ranges = manifest.filter(item => item.table === table).sort((a,b) => a.start.localeCompare(b.start));
    let end = ranges[0]?.end;
    for (const range of ranges.slice(1)) {
      if (range.start > shiftDate(end, 1)) dataset.warnings.push(`${table} 分片日期缺口：${shiftDate(end, 1)} 至 ${shiftDate(range.start, -1)}，不能证明缺口期间没有事件。`);
      if (range.end > end) end = range.end;
    }
  }
  dataset.shardManifest = manifest;
  dataset.rowSources = evidence.rows;
  dataset.inspection.unrecognizedColumns = evidence.unrecognizedColumns;
  dataset.inspection.shardManifest = manifest;
  return dataset;
}

export function generateDemo(now = new Date()) {
  const fixedEnd = '2026-10-22';
  const end = yesterday(now) < fixedEnd ? yesterday(now) : fixedEnd;
  const start = shiftDate(end, -27);
  const records = { users: [], activity: [], payments: [] };
  let state = 1731;
  const rand = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
  const channels = ['自然流量', '巨量引擎', '腾讯广告', '社区推荐'];
  let order = 0;
  for (let day = 0; day < 28; day++) {
    const date = shiftDate(start, day);
    const newCount = 38 + Math.floor(day * 1.4) + Math.floor(rand() * 18);
    for (let j = 0; j < newCount; j++) records.users.push({ user_id: `demo_${day}_${j}`, registered_at: `${date}T09:00:00+08:00`, channel: channels[Math.floor(rand() * channels.length)] });
    for (const user of records.users) {
      const age = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${dateOf(user.registered_at)}T00:00:00Z`)) / 86400000);
      const chance = age === 0 ? 0.92 : 0.5 * Math.exp(-age / 16) + 0.08;
      if (rand() > chance) continue;
      records.activity.push({ user_id: user.user_id, event_time: `${date}T15:20:00+08:00` });
      if (rand() < 0.08 + day / 2000) records.payments.push({ order_id: `demo_order_${++order}`, user_id: user.user_id, paid_at: `${date}T18:30:00+08:00`, amount: [6, 18, 30, 68, 128][Math.floor(rand() * 5)], currency: 'CNY', status: 'success' });
    }
  }
  return createDataset(records, { name: '星河远征 · 28 天演示数据', source: 'demo', now, completeness: { declared: 'full' }, timezone: 'Asia/Shanghai', warnings: ['确定性生成的示例数据，仅用于产品演示，不代表真实业务'] });
}
