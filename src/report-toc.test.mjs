import test from 'node:test';
import assert from 'node:assert/strict';
const s = await import('./report-toc.ts').catch(() => ({}));

const report = (over = {}) => ({ labels: {}, charts: [], findings: [], recommendations: [], metrics: [], channels: [], ...over });

test('目录按报告实际内容生成，并使用报告自定义标题', () => {
  assert.equal(typeof s.reportToc, 'function');
  const items = s.reportToc(report({ labels: { summaryTitle: '本周运营摘要', trendTitle: '趋势观察', channelTitle: '获客渠道' }, charts: [{ id: 'figure-1' }], findings: [{ title: '发现' }], recommendations: ['继续观察'] }));
  assert.deepEqual(items.map(item => item.label), ['本周运营摘要', '来源与审查记录', '关键指标', '趋势观察', '图表查看', '获客渠道', '补充图表', '主要发现', '下一步行动', '数据质量与方法']);
  assert.equal(new Set(items.map(item => item.id)).size, items.length);
});

test('已应用筛选时不会生成未渲染的补充图表目录项', () => {
  const items = s.reportToc(report({ charts: [{ id: 'figure-1' }] }), true);
  assert.ok(!items.some(item => item.id === s.REPORT_TOC_IDS.figures));
});

test('缺少发现或建议时不生成空目录项', () => {
  const items = s.reportToc(report());
  assert.ok(!items.some(item => item.id === s.REPORT_TOC_IDS.findings || item.id === s.REPORT_TOC_IDS.actions));
  assert.deepEqual(items.map(item => item.id), [s.REPORT_TOC_IDS.summary, s.REPORT_TOC_IDS.source, s.REPORT_TOC_IDS.metrics, s.REPORT_TOC_IDS.trend, s.REPORT_TOC_IDS.charts, s.REPORT_TOC_IDS.channels, s.REPORT_TOC_IDS.quality]);
});

test('滚动时高亮最后一条已越过顶栏的章节', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(s.activeTocId(items, { a: 100, b: 300, c: 500 }, 100), 'a');
  assert.equal(s.activeTocId(items, { a: 100, b: 300, c: 500 }, 350), 'b');
  assert.equal(s.activeTocId(items, { a: 100, b: 300, c: 500 }, 600), 'c');
  assert.equal(s.activeTocId(items, { a: 500 }, 100), 'a');
  assert.equal(s.activeTocId([], {}, 100), '');
});
