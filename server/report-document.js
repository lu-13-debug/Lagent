// This is an offline document template, not a Markdown/HTML execution surface.
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const text = (value, limit = 16000) => escape(typeof value === 'string' ? value.slice(0, limit) : '');
const array = value => Array.isArray(value) ? value : [];
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) : '无数据';

export function safeChartDataUrl(chart) {
  if (typeof chart?.svg === 'string' && Buffer.byteLength(chart.svg) <= 1024 * 1024) {
    const svg = chart.svg;
    if (!/^<svg[\s>]/.test(svg) || /<!|<\?|\bon\w+\s*=|@import|(?:javascript|data|file|https?):/i.test(svg.replace(/https?:\/\/www\.w3\.org\/\d{4}\/[^"'\s]+/g, '')) || /(?:href|src)\s*=\s*["'](?!#)/i.test(svg) || /url\(\s*["']?(?!#)/i.test(svg)) return null;
    const tags = [...svg.matchAll(/<\/?\s*([\w:-]+)/g)].map(match => match[1]);
    const allowed = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'clipPath', 'use', 'style', 'title', 'desc', 'metadata', 'rdf:RDF', 'cc:Work', 'dc:type', 'dc:date', 'dc:format', 'dc:creator', 'cc:Agent', 'dc:title']);
    if (tags.some(tag => !allowed.has(tag))) return null;
    // <img> adds a separate SVG image context; document scripts are disabled too.
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
  const png = typeof chart?.png === 'string' ? chart.png : typeof chart?.dataUrl === 'string' && chart.dataUrl.startsWith('data:image/png;base64,') ? chart.dataUrl.slice(22) : null;
  if (png && png.length <= 1400000 && /^[A-Za-z0-9+/]*={0,2}$/.test(png)) {
    const bytes = Buffer.from(png, 'base64');
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return `data:image/png;base64,${png}`;
  }
  return null;
}

function table(headers, rows) {
  if (!rows.length) return '<p class="muted">无可用数据</p>';
  return `<table><thead><tr>${headers.map(h => `<th>${text(h, 100)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function auditRows(task) {
  const snapshot = task.workflowSnapshot || task.workflowConfigSnapshot || task.workflow;
  return Object.entries(snapshot?.stages || {}).slice(0, 30).map(([id, stage]) => [id, stage.settings?.model || stage.profile?.model || stage.model || '', stage.effort || 'default', `${stage.skill?.name || stage.skillId || ''} ${stage.skill?.version ?? stage.skillVersion ?? ''}`]);
}

export function buildReportHtml(task) {
  if (!task?.report || typeof task.report !== 'object') throw Object.assign(new Error('没有可导出的报告'), { code: 'PDF_REPORT_MISSING' });
  const r = task.report;
  if (JSON.stringify(r).length > 12 * 1024 * 1024) throw Object.assign(new Error('报告内容超过 PDF 导出大小上限'), { code: 'PDF_TOO_LARGE' });
  for (const key of ['daily', 'retention', 'channels']) if (array(r[key]).length > 4000) throw new Error('报告明细聚合表超过 PDF 导出行数上限');
  const charts = array(r.charts);
  if (charts.length > 24) throw new Error('PDF 最多支持 24 张图表');
  const chartHtml = charts.map((chart, index) => {
    const dataUrl = safeChartDataUrl(chart);
    return `<figure>${dataUrl ? `<img src="${dataUrl}" alt="${text(chart.title, 160)}">` : '<p class="muted">图表产物缺失或不符合离线安全格式。</p>'}<figcaption>图 ${index + 1} · ${text(chart.title, 160)}${chart.unit ? `（${text(chart.unit, 160)}）` : ''}</figcaption><p class="muted">${text(chart.caption, 1000)}${chart.source ? ` 来源：${text(chart.source, 100)}` : ''}</p></figure>`;
  }).join('');
  const findings = array(r.findings).slice(0, 80).map(f => `<article class="finding"><h3>${text(f.title, 300)}${f.unverified ? ' <span class="badge">待核验</span>' : ''}</h3><p>${text(f.detail)}</p><p class="evidence">证据：${text(f.evidence, 3000)}${array(f.evidenceRefs).length ? `（${array(f.evidenceRefs).map(ref => text(ref, 100)).join('、')}）` : ''}</p></article>`).join('');
  const metadata = auditRows(task);
  const daily = table(['日期', '活跃', '新增', '收入', '付费人数'], array(r.daily).map(d => [d.date, number(d.dau), number(d.newUsers), number(d.revenue), number(d.payers)]));
  const retention = table(['cohort 日期', '人数', 'D1 (%)', 'D7 (%)'], array(r.retention).map(d => [d.date, number(d.users), number(d.d1), number(d.d7)]));
  const channels = table(['渠道', '人数', '收入', 'D1 (%)'], array(r.channels).map(d => [d.name, number(d.users), number(d.revenue), number(d.d1)]));
  const facts = array(r.facts).slice(0, 300);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none';"><title>${text(r.title, 300)}</title><style>
@page { size: A4; margin: 18mm 17mm 19mm; }
* { box-sizing: border-box; }
html { color: #18313a; font-family: 'Noto Sans CJK SC','Noto Sans CJK JP','Microsoft YaHei','PingFang SC',sans-serif; font-size: 10pt; line-height: 1.75; }
body { margin: 0; } h1,h2,h3 { line-height: 1.4; color: #123d42; overflow-wrap: anywhere; }
h1 { font-size: 27pt; margin: 26mm 0 9mm; font-weight: 700; } h2 { font-size: 16pt; padding-bottom: 3mm; margin: 9mm 0 5mm; border-bottom: 1.5px solid #2b7a78; break-after: avoid; }
h3 { font-size: 11.5pt; margin-bottom: 2mm; break-after: avoid; } p { margin: 2mm 0 4mm; white-space: pre-wrap; overflow-wrap: anywhere; orphans: 3; widows: 3; }
.cover { min-height: 235mm; break-after: page; page-break-after: always; } .eyebrow { margin-top: 12mm; text-transform: uppercase; letter-spacing: 2px; font-size: 10pt; color: #2b7a78; }
.cover-summary { background: #eef6f5; padding: 6mm; border-left: 3px solid #2b7a78; margin-top: 14mm; }
.muted,.evidence { font-size: 9pt; color: #52666d; } .meta { margin: 7mm 0; border-top: 1px solid #cddbdc; padding-top: 5mm; } .badge { font-size: 8pt; background: #fff0d3; padding: 1mm 2mm; }
table { width: 100%; border-collapse: collapse; margin: 4mm 0 7mm; table-layout: fixed; font-size: 8.5pt; }
thead { display: table-header-group; } th { background: #e7f1f0; font-weight: 600; color: #123d42; } td,th { text-align: left; padding: 2.3mm 2mm; border-bottom: 1px solid #dbe5e7; overflow-wrap: anywhere; }
tr { break-inside: avoid; page-break-inside: avoid; } td { vertical-align: top; } .metrics td:first-child { font-weight: 600; }
figure { margin: 7mm 0; break-inside: avoid; page-break-inside: avoid; } figure img { width: 100%; max-height: 190mm; object-fit: contain; display: block; } figcaption { text-align: center; font-size: 9.5pt; color: #123d42; margin-top: 2mm; }
ul,ol { padding-left: 6mm; } li { margin-bottom: 2mm; white-space: pre-wrap; overflow-wrap: anywhere; } .appendix { break-before: page; }
</style></head><body>
<section class="cover"><div class="eyebrow">DataAgent · 分析报告</div><h1>${text(r.title || task.title, 300)}</h1><p>${text(r.period, 500)}</p><div class="meta"><p>分析目标：${text(task.goal, 3000)}</p><p>数据来源：${text(task.datasetName, 500)}</p><p>生成时间：${text(r.generatedAt, 100)}${r.currency ? ` · 币种：${text(r.currency, 50)}` : ''}</p><p>报告范围：原始完整报告；使用报告既定口径与覆盖范围。</p></div><div class="cover-summary"><h3>执行摘要</h3><p>${text(r.summary, 30000)}</p></div></section>
<section><h2>来源与审查记录</h2><p>${task.sourceProvenance ? `${task.sourceProvenance.demo ? '演示数据' : '上传数据'} · ${number(task.sourceProvenance.rowCount)} 行 · 来源已登记` : '历史报告未登记完整来源链'}</p><p>生成文件不代表全部审查已完成。</p>${table(['检查','状态','说明'], array(r.qualityReceipts?.checks).map(c => [({'data-quality':'数据质量',narrative:'语义审查',visual:'视觉审查'})[c.id] || '专项审查', ({pass:'通过',issue:'有问题',unreviewed:'未审查',disabled:'已禁用'})[c.status] || '未审查', array(c.reasons).join('；')]))}</section>
<section><h2>关键指标</h2><div class="metrics">${table(['指标', '结果', '口径说明'], array(r.metrics).slice(0, 100).map(m => [m.label, `${number(m.value)} ${m.unit || ''}`, m.note || '']))}</div></section>
<section><h2>数据来源与处理</h2><p>记录数：${number(r.quality?.rows)} · 质量评分：${number(r.quality?.score)}</p>${r.dataCompleteness?.message ? `<p>${text(r.dataCompleteness.message, 4000)}</p>` : ''}<ul>${array(r.quality?.issues).slice(0, 100).map(issue => `<li>${text(issue, 4000)}</li>`).join('')}</ul><h3>方法与指标口径</h3><ol>${array(r.methodology).slice(0, 100).map(m => `<li>${text(m, 5000)}</li>`).join('')}</ol></section>
${charts.length ? `<section><h2>图表与解释</h2>${chartHtml}</section>` : ''}
<section><h2>发现与建议</h2>${findings || '<p class="muted">暂无已记录发现。</p>'}<h3>后续建议</h3><ol>${array(r.recommendations).slice(0, 80).map(item => `<li>${text(item, 5000)}</li>`).join('')}</ol></section>
<section><h2>限制与待核验事项</h2><p>报告描述既定数据范围内的观察结果。缺失值以“无数据”呈现；观察性关系不能直接解释为因果。请结合覆盖范围、统计样本和业务条件解读。</p>${r.timezone ? `<p>时区：${text(r.timezone.name, 100)}${r.timezone.assumed ? '（未确认）' : ''}</p>` : ''}${array(r.quality?.issues).map(issue => `<p>${text(issue, 4000)}</p>`).join('')}</section>
<section class="appendix"><h2>附录：数据与证据</h2><h3>每日指标${r.currency ? `（收入单位：${text(r.currency, 50)}）` : ''}</h3>${daily}<h3>留存 cohort</h3>${retention}<h3>渠道指标</h3>${channels}${facts.length ? `<h3>证据登记</h3>${table(['证据 ID', '事实'], facts.map(f => [f.id, f.text]))}` : ''}${metadata.length ? `<h3>模型与 Skill 版本</h3>${table(['阶段', '模型', '强度', 'Skill 版本'], metadata)}<p class="muted">本附录仅列执行配置元数据，不包含 API Key 或私人 Skill 原文。</p>` : ''}</section>
</body></html>`;
}
