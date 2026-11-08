import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./report-version.js').catch(() => ({}));
test('报告版本绑定图文内容而不被PDF缓存与独立审查回执改变', () => {
  assert.equal(typeof module.reportContentHash, 'function');
  const report = { summary: '收入', charts: [{ data: [{ revenue: 12 }] }] };
  const first = module.reportContentHash(report);
  assert.equal(module.reportContentHash({ ...report, pdf: { ready: true }, qualityReceipts: [{ status: 'pass' }] }), first);
  assert.notEqual(module.reportContentHash({ ...report, summary: '不同结论' }), first);
  assert.notEqual(module.reportContentHash({ ...report, charts: [{ data: [{ revenue: 13 }] }] }), first);
});
