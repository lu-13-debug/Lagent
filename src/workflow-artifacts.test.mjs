import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./workflow-artifacts.ts').catch(() => ({}));
test('阶段产物摘要区分旧格式、验证和范围，不输出模型原文或内部JSON', () => {
  assert.equal(typeof module.artifactSummary, 'function');
  const lines = module.artifactSummary({ summary: '结果', validation: { status: 'validated' }, fingerprint: 'private-hash', deliverable: { kind: 'AnalysisPlan', questions: ['核对留存'], evidenceIds: ['metric:dau'] } });
  assert.ok(lines.some(line => /已校验/.test(line)));
  assert.equal(lines.some(line => /private-hash|metric:dau|AnalysisPlan/.test(line)), false);
  assert.ok(module.artifactSummary({ validation: { status: 'legacy' } }).some(line => /旧格式/.test(line)));
  assert.ok(module.artifactSummary({ scopeInvalidated: true }).some(line => /范围已变化/.test(line)));
});
test('恢复与修订信息只展示计数和可读状态', () => {
  assert.equal(typeof module.artifactSummary, 'function');
  assert.ok(module.artifactSummary({ reused: true }).some(line => /复用/.test(line)));
  assert.ok(module.artifactSummary({ revisions: [{}, {}] }).some(line => /2/.test(line)));
});

test('评审摘要只输出参与和共识分歧与失败数量', () => {
 const lines=module.artifactSummary({panel:{enabled:true,participants:2,agreements:[{title:'共识'}],disagreements:{judgeOnly:[{title:'分歧'}],reviewerOnly:[]},reviewers:[{status:'failed',error:'secret'}]}});
 assert.match(lines.join('；'),/参与模型.*2/);assert.match(lines.join('；'),/共识.*1/);assert.match(lines.join('；'),/分歧.*1/);assert.match(lines.join('；'),/失败.*1/);assert.doesNotMatch(lines.join('；'),/secret/);
 assert.doesNotMatch(module.artifactSummary({scopeInvalidated:true,panel:{enabled:true,participants:2,agreements:[],disagreements:{judgeOnly:[],reviewerOnly:[]},reviewers:[]}}).join('；'),/参与模型/);
});

