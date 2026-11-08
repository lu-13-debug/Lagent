import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportHtml } from './report-document.js';
import { buildReportPdf } from './report-pdf.js';

const task = { id: 'task', title: '测试分析', datasetName: '离线样例', goal: '查看趋势', report: {
  title: '中文运营报告', period: '2026-10-01 至 2026-10-02', summary: '<script>fetch("https://attacker.invalid")</script>',
  metrics: [{ label: '收入', value: 30, unit: 'CNY', note: '已核对' }],
  findings: [{ title: '增长', detail: '收入增加。', evidence: '指标事实', evidenceRefs: ['f1'] }],
  facts: [{ id: 'f1', text: '收入为 30 CNY' }], recommendations: ['继续观察'], methodology: ['按成功支付统计'],
  quality: { rows: 3, score: 100, issues: ['存在覆盖限制'] }, daily: [{ date: '2026-10-01', dau: 2, revenue: 10 }],
}, workflowSnapshot: { stages: { quality: { profile: { model: 'test-model' }, effort: 'medium', skill: { name: '质量', version: 1, content: 'PRIVATE-SKILL-TEXT' } } } } };

test('PDF HTML includes verified report fields and escapes untrusted strings without dumping task secrets', () => {
  const html = buildReportHtml({ ...task, apiKey: 'PRIVATE-KEY', messages: [{ content: 'PRIVATE-MESSAGE' }] });
  assert.match(html, /中文运营报告/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|PRIVATE-KEY|PRIVATE-MESSAGE|PRIVATE-SKILL-TEXT/);
  assert.match(html, /test-model/);
  assert.match(html, /page-break|break-inside/);
  assert.match(html, /A4/);
});

test('PDF审计附录使用真实冻结阶段设置中的模型ID', () => {
  const html = buildReportHtml({ ...task, workflowSnapshot: { stages: { quality: {
    settings: { model: '实际快照模型MARKER', protocol: 'responses' }, effort: 'high',
    skill: { name: '质量Skill', version: 3, content: 'PRIVATE-SNAPSHOT-SKILL' },
  } } } });
  assert.match(html, /实际快照模型MARKER/);
  assert.match(html, /high/);
  assert.match(html, /质量Skill 3/);
  assert.doesNotMatch(html, /PRIVATE-SNAPSHOT-SKILL/);
});

test('external and unsafe image/chart payloads cannot enter document', () => {
  const html = buildReportHtml({ ...task, report: { ...task.report, charts: [
    { title: 'remote', dataUrl: 'https://attacker.invalid/image.png' },
    { title: 'bad', svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    { title: 'event', svg: '<svg onload="alert(1)"></svg>' },
    { title: 'external', svg: '<svg><image href="https://attacker.invalid/a"/></svg>' },
  ] } });
  assert.doesNotMatch(html, /src="https|<script|onload=|<image|data:image\/svg/);
});

test('PDF rejects absent report and already cancelled exports', async () => {
  await assert.rejects(buildReportPdf({}), /报告/);
  await assert.rejects(buildReportPdf(task, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('timed out and cancelled PDF jobs release their slots for subsequent exports', async () => {
  await assert.rejects(buildReportPdf(task, { timeoutMs: 1 }), { code: 'PDF_TIMEOUT' });
  const controller = new AbortController();
  const jobs = Array.from({ length: 4 }, () => buildReportPdf(task, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  const results = await Promise.allSettled(jobs);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
});

test('Chromium generates real offline A4 PDF bytes with Chinese report', async () => {
  const pdf = await buildReportPdf(task);
  assert.ok(Buffer.isBuffer(pdf));
  assert.match(pdf.subarray(0, 8).toString(), /^%PDF-/);
  assert.ok(pdf.length > 10000);
});
