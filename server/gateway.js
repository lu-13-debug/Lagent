import { normalizeCompleteness, completenessCopy } from './completeness.js';
import { modelError, modelRequest, httpModelError, readModelResponse, visibleReply, providerUsage } from './model-protocol.js';
import { getProfile } from './domain-profiles.js';
import { randomUUID } from 'node:crypto';
export const DEFAULT_MODEL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_SETTINGS = { provider: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' };
export const DEFAULT_MODEL_HOSTS = Object.freeze(['api.deepseek.com', 'api.anthropic.com', 'api.openai.com']);

export function validateSettings(input, previous = DEFAULT_SETTINGS) {
  const provider = String(input.provider ?? previous.provider).trim();
  const model = String(input.model ?? previous.model).trim();
  if (!provider || provider.length > 80 || !model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('请填写有效的服务商和模型名称');
  return { provider, baseUrl: normalizeBaseUrl(input.baseUrl ?? previous.baseUrl), model };
}

export function normalizeBaseUrl(value) {
  const rawUrl = String(value ?? '').trim();
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('模型服务地址无效'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('模型服务必须使用 HTTPS；仅 loopback 本地服务允许 HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('模型服务地址不能包含凭据、查询参数或片段');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models|messages|responses)$/, '');
  if ((!url.pathname || url.pathname === '/') && ['api.openai.com', 'api.anthropic.com'].includes(url.hostname)) url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效');
  return key.trim();
}
export function redact(text, key) { return key ? String(text).split(key).join('[已隐藏凭据]') : String(text); }

export async function chat({ settings, key, messages, signal, fetchImpl = fetch, timeoutMs = DEFAULT_MODEL_TIMEOUT_MS, maxTokens = 8192, connectionTest = false, onUsage, sessionId }) {
  if (!key) throw modelError('KEY_REQUIRED', '尚未设置 API Key；请先在模型设置中配置。');
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const request = modelRequest(normalizeBaseUrl(settings.baseUrl), settings.model, messages, key, maxTokens, connectionTest, settings);
  if (normalizeBaseUrl(settings.baseUrl) === 'https://opencode.ai/inference/go/openai/v1') {
    request.headers['user-agent'] = 'DataAgent/1.1.0';
    request.headers['x-opencode-session'] = typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : randomUUID();
  }
  try {
    const response = await fetchImpl(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: combined, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw httpModelError(response.status); }
    const payload = await readModelResponse(response);
    onUsage?.(providerUsage(payload?.usage, request.protocol));
    return redact(visibleReply(payload, request.protocol, connectionTest), key);
  } catch (error) {
    if (combined.aborted) {
      if (signal?.aborted) throw modelError('CANCELLED', '任务已取消。');
      throw modelError('TIMEOUT', '模型请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）；请检查服务连接或更换模型后重试。');
    }
    if (error?.modelFailure) throw error;
    throw modelError('UNREACHABLE', '无法连接模型服务，请检查地址、网络和证书；供应商原始错误已隐藏。');
  }
}

export async function enhanceReport(report, task, options) {
  const profile = getProfile(task.domain || report.domain);
  const aggregate = {
    domain: profile.id, period: report.period, currency: report.currency,
    metrics: report.metrics.map(({ id, label, value, unit }) => ({ id, label, value, unit })),
    daily: report.daily, retention: report.retention, channels: report.channels, weekday: report.weekday || [], payerSummary: report.payerSummary || null,
    extras: report.extras || null,
    quality: { rows: report.quality.rows, issueCount: report.quality.issues.length, score: report.quality.score },
  };
  const facts = [];
  report.quality.issues.slice(0, 50).forEach((text, index) => facts.push({ id: `quality:issue:${index}`, text }));
  const labels = profile.tableLabels;
  for (const table of report.factContext?.missingTables || []) if (labels[table]) facts.push({ id: `missing:${table}`, text: `缺少${labels[table]}` });
  const tableOrder = profile.id === 'game'
    ? Object.keys(labels)
    : [...new Set([...Object.keys(report.factContext?.coverage || {}), ...(report.factContext?.missingTables || [])])].filter(table => labels[table]);
  for (const table of tableOrder) {
    const range = report.factContext?.coverage?.[table];
    facts.push({ id: `coverage:${table}`, text: range ? `${labels[table]}覆盖范围：${range.start} 至 ${range.end}` : `${labels[table]}未记录可用覆盖范围` });
    const excludedRows = report.factContext?.incomplete?.[table] ?? null;
    facts.push({ id: `incomplete:${table}`, text: excludedRows === null ? `${labels[table]}未记录当日或未来排除行数` : `${labels[table]}排除当日或未来记录 ${excludedRows} 行` });
  }
  const tz = report.timezone || report.factContext?.timezone || { name: 'Asia/Shanghai', assumed: true };
  facts.push({ id: 'timezone', text: tz.assumed !== false ? `项目时区未确认，分析按 ${tz.name} 解释无时区时间；带时区时间按自身偏移换算，来源时区是否正确未经用户确认。` : `项目时区已由用户确认为 ${tz.name}；带时区时间按自身偏移换算，无时区时间按该时区解释。` });
  const completeness = normalizeCompleteness(report.dataCompleteness);
  const completenessText = report.dataCompleteness ? (report.dataCompleteness.message || completenessCopy[completeness.declared]) : '报告生成时未记录数据完整性声明；无法据此确认边界日期是否完整。';
  facts.push({ id: 'completeness', text: completenessText });
  facts.push({ id: 'quality:summary', text: `处理记录 ${report.quality.rows} 行，质量评分 ${report.quality.score}` });
  for (const metric of report.metrics) facts.push({ id: `metric:${metric.id}`, text: metric.value === null ? `${metric.label}：无数据；${metric.note || ''}` : `${metric.label}：${metric.value} ${metric.unit}；${metric.note || ''}` });
  let usage = null;
  const content = await chat({ ...options, sessionId: task.id, onUsage: value => { usage = value; options.onUsage?.(value); }, messages: [
    { role: 'system', content: profile.systemPrompt },
    { role: 'user', content: JSON.stringify({ goal: task.goal, context: task.messages.filter(m => m.role === 'user').map(m => m.content), aggregates: aggregate, facts }) },
  ] });
  let ai;
  try { ai = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw modelError('INVALID_REPORT', '模型报告不是有效 JSON；任务失败并释放额度，请调整模型后重试'); }
  if (typeof ai.summary !== 'string' || !Array.isArray(ai.findings) || !Array.isArray(ai.recommendations) || !ai.recommendations.every(x => typeof x === 'string') || !ai.findings.every(x => x && typeof x.title === 'string' && typeof x.detail === 'string' && typeof x.evidence === 'string' && ['positive', 'warning', 'neutral'].includes(x.severity))) throw modelError('INVALID_REPORT', '模型报告字段不完整；任务失败并释放额度，请选择支持结构化文本的模型');
  const allowedIds = new Set(facts.map(f => f.id));
  const qualityCount = /(?:共|共有|存在|发现|有|发现了|存在着)?\s*[\d一二三四五六七八九十百两]+\s*(?:项|个|条|处)\s*(?:数据)?质量(?:问题|提示|风险)/;
  // Models sometimes copy internal field names and fact ids into prose. Replace the known
  // patterns, then drop anything that still reads like machine output.
  const internalTerm = /\b(?:declared|unknown|undefined|null|payload|evidenceRefs)\b|(?:metric|quality:issue|coverage|incomplete|missing):[a-z0-9_]+/i;
  const humanize = value => String(value)
    .replace(/完整性\s*declared\s*(?:为|是|[:：])?\s*['"]?unknown['"]?/gi, '完整性未声明')
    .replace(/完整性\s*declared\s*(?:为|是|[:：])?\s*['"]?partial['"]?/gi, '完整性声明为分片')
    .replace(/完整性\s*declared\s*(?:为|是|[:：])?\s*['"]?full['"]?/gi, '完整性声明为全量')
    .replace(/(?:metric|quality:issue|coverage|incomplete|missing):[a-z0-9_]+\s*[:：]?\s*/gi, '')
    .replace(/\bdeclared\b/gi, '完整性声明')
    .replace(/\bunknown\b/gi, '未声明')
    .replace(/\bnull\b/gi, '无数据')
    .replace(/\bundefined\b/gi, '无数据')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const findings = ai.findings.filter(f => !qualityCount.test(`${f.title} ${f.detail} ${f.evidence}`)).map(f => {
    const evidenceRefs = [...new Set((Array.isArray(f.evidenceRefs) ? f.evidenceRefs : []).filter(id => typeof id === 'string' && allowedIds.has(id)))];
    return { ...f, title: humanize(f.title), detail: humanize(f.detail), evidence: humanize(f.evidence), kind: evidenceRefs.length && ['fact', 'inference', 'recommendation'].includes(f.kind) ? f.kind : 'inference', evidenceRefs, ...(!evidenceRefs.length ? { unverified: true } : { unverified: false }) };
  }).filter(f => [f.title, f.detail, f.evidence].every(text => text && !internalTerm.test(text))).slice(0, 12);
  const numberTokens = text => String(text).match(/\d+(?:\.\d+)?/g) || [];
  const knownNumbers = new Set([...numberTokens(JSON.stringify(aggregate)), ...facts.flatMap(({ id, ...fact }) => numberTokens(JSON.stringify(fact)))]);
  const summary = qualityCount.test(ai.summary) || internalTerm.test(ai.summary) || numberTokens(ai.summary).some(n => !knownNumbers.has(n)) ? report.summary : humanize(ai.summary);
  const recommendations = ai.recommendations.filter(text => !internalTerm.test(text)).map(humanize).filter(text => text && !internalTerm.test(text)).slice(0, 12);
  return { ...report, facts, summary: `${report.source === 'local' && task.datasetName.includes('演示') ? '本报告使用示例数据，不代表真实业务。' : ''}${summary.slice(0, 12000)}`, findings: task.skippedSteps?.includes('insights') ? [] : findings, recommendations: task.skippedSteps?.includes('insights') ? [] : recommendations, ...(usage ? { aiUsage: { ...usage, provider: options.settings.provider || '自定义接口', model: options.settings.model } } : {}), source: 'ai' };
}
