import test from 'node:test';
import assert from 'node:assert/strict';
import { reportTextOf, reportTextOfReport } from './report-text.ts';

const detail = reports => ({ ticket: { summary: '工单摘要' }, reports });

test('多份报告时优先取最新一份（服务端按写入倒序返回）', () => {
  const value = reportTextOf(detail([
    { id: 'new', summary: '第二次执行的结论' },
    { id: 'old', summary: '已修复 token 过期' }
  ]));
  assert.equal(value, '第二次执行的结论');
});

test('最新报告没有正文时回退到较新的可用正文，而不是最旧的一份', () => {
  const value = reportTextOf(detail([
    { id: 'new', summary: '' },
    { id: 'mid', summary: '中间结论' },
    { id: 'old', summary: '旧结论' }
  ]));
  assert.equal(value, '中间结论');
});

test('正文优先级：ACP > CLI > 窗口 > 验收报告 > 摘要', () => {
  assert.equal(reportTextOfReport({ summary: '摘要', artifacts: { acp: { text: 'ACP' }, cli: { summary: 'CLI' } } }), 'ACP');
  assert.equal(reportTextOfReport({ summary: '摘要', artifacts: { cli: { summary: 'CLI' }, window: { text: '窗口' } } }), 'CLI');
  assert.equal(reportTextOfReport({ summary: '摘要', artifacts: { window: { text: '窗口' }, report: { summary: '验收' } } }), '窗口');
  assert.equal(reportTextOfReport({ summary: '摘要', artifacts: { report: { summary: '验收' } } }), '验收');
  assert.equal(reportTextOfReport({ summary: '摘要', artifacts: { report: { summary: '' } } }), '摘要');
});

test('没有报告时使用工单摘要', () => {
  assert.equal(reportTextOf(detail([])), '工单摘要');
  assert.equal(reportTextOf(null), '');
});
