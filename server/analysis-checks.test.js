import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisChecks, validateCharts } from './analysis-checks.js';
test('少于两日比较明确不适用，非因果且不臆造稳健性', () => {
  const checks = analysisChecks({ daily: [{date:'2026-01-01',dau:1}] });
  assert.equal(checks.comparison.status,'not_applicable');
  assert.equal(checks.robustness.status,'not_applicable');
});
test('图表数据和聚合源不一致会失败', () => {
 assert.throws(() => validateCharts({ daily:[{date:'a',dau:1}], charts:[{source:'daily',x:'date',y:'dau',data:[{date:'a',dau:7}]}] }), /图表/);
});

test('未实现明确期间聚合时不能以首末日差冒充指定期间比较', () => {
 const checks = analysisChecks({daily:[{date:'2026-01-01',dau:1},{date:'2026-01-15',dau:100},{date:'2026-02-01',dau:2}]}, {comparisonSpec:{periods:[['2026-01-01','2026-01-31'],['2026-02-01','2026-02-28']]}});
 assert.equal(checks.comparison.status,'not_applicable');
 assert.match(checks.comparison.reason,/暂不支持|尚未实现/);
 assert.equal(checks.comparison.delta,undefined);
});
