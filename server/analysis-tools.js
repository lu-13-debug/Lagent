import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('./tools/analysis.py', import.meta.url));
const MAX_INPUT = 24 * 1024 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_ROWS = 250000;
const numeric = new Set(['amount', 'refund_amount', 'revenue', 'spend', 'duration_seconds', 'distance_km', 'impressions', 'clicks', 'conversions', 'online_minutes', 'expansion']);
const dimensions = new Set(['channel', 'currency', 'status', 'product_type', 'plan', 'industry', 'stage', 'event_type']);
const dates = new Set(['registered_at', 'event_time', 'paid_at', 'created_at', 'start_at', 'end_at', 'check_in', 'check_out', 'close_at', 'started_at', 'completed_at', 'renewal_at']);
const reportFields = {
  daily: ['date', 'dau', 'newUsers', 'revenue', 'payers'],
  channels: ['name', 'users', 'revenue', 'd1', 'payers', 'payRate', 'arppu'],
  retention: ['date', 'users', 'd1', 'd7'],
  weekday: ['label', 'index', 'days', 'dau', 'newUsers', 'revenue'],
};
const schemas = {
  profile: ['table'], clean: ['table', 'operations'], describe: ['table', 'columns'],
  group: ['table', 'by', 'metrics', 'limit'], statistics: ['table', 'method', 'columns'],
  chart: ['kind', 'source', 'table', 'x', 'y', 'title', 'unit', 'bins'],
};
export const ANALYSIS_INPUT_SCHEMAS = Object.freeze(Object.fromEntries(Object.entries(schemas).map(([name, keys]) => [name, Object.freeze([...keys])])));
export function isAnalysisOutputField(key) {
  return numeric.has(key) || dimensions.has(key) || dates.has(key) || Object.values(reportFields).some(fields => fields.includes(key)) || /_(count|sum|mean|min|max)$/.test(key) && numeric.has(key.replace(/_(count|sum|mean|min|max)$/, ''));
}
export const ANALYSIS_TOOL_NAMES = Object.freeze(Object.keys(schemas));
export const ANALYSIS_TOOL_HELP = 'profile({table?}); clean({table?,operations?:["trim_strings","normalize_newlines"]}); describe({table?,columns?:string[]}); group({table,by:string[],metrics:[{column,op:"count"|"sum"|"mean"|"min"|"max"}],limit?}); statistics({table?,method:"pearson"|"spearman"|"ttest"|"describe",columns:string[]}); chart({kind:"line"|"bar"|"histogram"|"scatter"|"heatmap",source?:"daily"|"channels"|"retention"|"weekday",table?,x?,y?,title?,unit?,bins?}). table is users/activity/payments. Only registered numeric fields and business dimensions are accepted; raw IDs/private fields are forbidden. chart defaults to report.daily date/dau; heatmap uses report.retention d1/d7. clean returns a non-destructive preview summary, never deletes/fills rows.';

const fail = (message, code = 'ANALYSIS_TOOL_INVALID') => Object.assign(new Error(message), { code });
function column(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) throw fail('不允许的分析字段（原始标识和私人字段不可输出）');
}
export function validateAnalysisTool(name, input) {
  if (!Object.hasOwn(schemas, name)) throw fail('未知或不允许的分析工具');
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 12000) throw fail('工具参数结构或长度无效');
  if (Object.keys(input).some(key => !schemas[name].includes(key))) throw fail('包含未注册的工具参数');
  if ((name === 'group' && ['table','by','metrics'].some(key => input[key] === undefined)) || (name === 'statistics' && ['method','columns'].some(key => input[key] === undefined)) || (name === 'chart' && input.kind === undefined)) throw fail('缺少必需工具参数', 'ANALYSIS_TOOL_MISSING_PARAMETER');
  if (input.table !== undefined && !['users', 'activity', 'payments'].includes(input.table)) throw fail('无效的数据表参数');
  if (input.columns !== undefined) {
    if (!Array.isArray(input.columns) || !input.columns.length || input.columns.length > 12) throw fail('columns 参数需要 1 至 12 个数值字段');
    input.columns.forEach(value => column(value, numeric));
  }
  if (name === 'clean' && input.operations !== undefined && (!Array.isArray(input.operations) || input.operations.length > 2 || input.operations.some(op => !['trim_strings', 'normalize_newlines'].includes(op)))) throw fail('只支持字符串标准化；删行和填补需要用户确认');
  if (name === 'group') {
    if (!input.table || !Array.isArray(input.by) || !input.by.length || input.by.length > 2) throw fail('分组参数需要 table 和 1 至 2 个业务字段');
    input.by.forEach(value => column(value, dimensions));
    if (!Array.isArray(input.metrics) || !input.metrics.length || input.metrics.length > 8) throw fail('分组需要 1 至 8 个聚合指标');
    for (const metric of input.metrics) {
      if (!metric || Object.keys(metric).some(key => !['column', 'op'].includes(key)) || !['count', 'sum', 'mean', 'min', 'max'].includes(metric.op)) throw fail('不支持的分组聚合参数');
      column(metric.column, numeric);
    }
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw fail('分组 limit 必须为 1 至 100');
  }
  if (name === 'statistics') {
    if (!['pearson', 'spearman', 'ttest', 'describe'].includes(input.method) || !input.columns?.length) throw fail('不支持的统计方法或缺少数值字段');
    if (input.method !== 'describe' && input.columns.length !== 2) throw fail('相关和双样本检验需要两个数值字段');
  }
  if (name === 'chart') {
    if (!['line', 'bar', 'histogram', 'scatter', 'heatmap'].includes(input.kind)) throw fail('不支持的图表类型');
    if (input.table && input.source) throw fail('图表 table 和 source 不能同时指定');
    const source = input.source || (input.kind === 'heatmap' ? 'retention' : 'daily');
    if (!Object.hasOwn(reportFields, source)) throw fail('不支持的图表数据源');
    const allowed = input.table ? new Set([...numeric, ...dimensions, ...dates]) : new Set(reportFields[source]);
    if (input.x !== undefined) column(input.x, allowed);
    if (input.y !== undefined) column(input.y, input.table ? numeric : new Set(reportFields[source].filter(f => !['date', 'name', 'label'].includes(f))));
    for (const key of ['title', 'unit']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 160 || /[<>\x00-\x08]/.test(input[key]))) throw fail('图表标题或单位参数无效');
    if (input.bins !== undefined && (!Number.isInteger(input.bins) || input.bins < 2 || input.bins > 50)) throw fail('bins 必须为 2 至 50');
  }
}

function projection(dataset, report, input) {
  const records = {}; let count = 0;
  for (const [table, rows] of Object.entries(dataset?.records || {})) {
    if (!['users', 'activity', 'payments'].includes(table) || !Array.isArray(rows) || (input.table && table !== input.table)) continue;
    count += rows.length;
    if (count > MAX_ROWS) throw fail('分析工具输入超过 250000 行上限');
    records[table] = rows.map(row => {
      const safe = {};
      for (const [key, value] of Object.entries(row || {})) {
        if (!numeric.has(key) && !dimensions.has(key) && !dates.has(key)) continue;
        if (value === null || value === undefined || value === '') safe[key] = null;
        else if (numeric.has(key)) safe[key] = typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
        else if (typeof value === 'string' && value.length <= 256) safe[key] = value;
      }
      return safe;
    });
  }
  const aggregates = {};
  for (const [source, fields] of Object.entries(reportFields)) {
    const rows = report?.[source];
    if (!Array.isArray(rows)) continue;
    if (rows.length > 4000) throw fail('报告聚合表超过 4000 行上限');
    aggregates[source] = rows.map(row => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => {
      const value = row[field];
      return [field, ['date', 'name', 'label'].includes(field) ? String(value ?? '').slice(0, 120) : typeof value === 'number' && Number.isFinite(value) ? value : null];
    })));
  }
  const offset = dataset?.timezone?.offsetMinutes;
  return { records, report: aggregates, timezoneOffsetMinutes: Number.isInteger(offset) && offset >= -720 && offset <= 840 ? offset : 480 };
}

// Deliberate allowlist: no credentials, HOME, proxy URLs, PYTHONPATH or inherited secrets.
function childEnvironment(directory) {
  const env = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', MPLCONFIGDIR: directory, TMP: directory, TEMP: directory, TMPDIR: directory, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'LD_LIBRARY_PATH']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

export async function runAnalysisTool(name, input, { dataset, report, signal, timeoutMs = 30000, pythonExecutable = process.env.LAGENT_PYTHON || 'python' } = {}) {
  signal?.throwIfAborted();
  validateAnalysisTool(name, input);
  const data = JSON.stringify({ name, input, ...projection(dataset, report, input) });
  if (Buffer.byteLength(data) > MAX_INPUT) throw fail('分析工具输入超过 24MB 上限');
  const directory = await mkdtemp(join(tmpdir(), 'lagent-tool-'));
  try {
    signal?.throwIfAborted();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(pythonExecutable, ['-I', '-B', script], { cwd: directory, env: childEnvironment(directory), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let settled = false, bytes = 0, stderrBytes = 0; const chunks = [];
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
      let stopError;
      const stop = error => { stopError ||= error; child.kill('SIGKILL'); };
      const abort = () => stop(signal.reason || new DOMException('已取消', 'AbortError'));
      const timer = setTimeout(() => stop(fail('分析工具执行超时', 'ANALYSIS_TOOL_TIMEOUT')), Math.max(1, Math.min(Number(timeoutMs) || 30000, 60000)));
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', error => finish(fail(error.code === 'ENOENT' ? 'Python 运行环境不可用，请配置 LAGENT_PYTHON 并安装固定工具依赖' : '分析工具进程无法启动', 'ANALYSIS_TOOL_UNAVAILABLE')));
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_OUTPUT) stop(fail('分析工具输出超过 2MB 上限')); else chunks.push(chunk); });
      child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop(fail('分析工具诊断输出超过上限')); });
      child.stdin.on('error', () => {});
      child.once('close', code => {
        if (stopError) return finish(stopError);
        if (code !== 0) return finish(fail('分析工具执行失败或运行依赖缺失，请检查 pandas/NumPy/SciPy/Matplotlib 环境', 'ANALYSIS_TOOL_FAILED'));
        try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed.ok) {
          const message = typeof parsed.error === 'string' ? parsed.error : '';
          const code = /字段不存在|所需字段|数值字段不存在/.test(message) ? 'ANALYSIS_TOOL_FIELD_NOT_FOUND' : /没有有效数值|没有可绘制数值|缺少图表所需数据/.test(message) ? 'ANALYSIS_TOOL_EMPTY_RESULT' : 'ANALYSIS_TOOL_INVALID';
          finish(fail('分析工具数据或请求无效', code));
        } else finish(null, parsed.result); }
        catch { finish(fail('分析工具未返回合法 JSON')); }
      });
      child.stdin.end(data);
      if (signal?.aborted) abort();
    });
    if (name === 'chart') result.id = `chart-${createHash('sha256').update(JSON.stringify({ input, data: result.data })).digest('hex').slice(0, 16)}`;
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
