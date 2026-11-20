import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createReportCenter } from './work/report-center.js';

function seed(t) {
  const root = mkdtempSync(join(tmpdir(), 'lagent-reports-'));
  const store = new Store(join(root, 'store.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  store.put('work-project', { id: 'p1', name: '实验软件', path: root, createdAt: '2026-11-01T00:00:00.000Z' });
  store.put('work-project', { id: 'p2', name: '另一个项目', path: root, createdAt: '2026-11-01T00:00:00.000Z' });
  store.put('work-conversation', { id: 'c1', title: '鉴权审查', goal: '审查鉴权', projectId: 'p1', participants: ['model', 'claude-code'], turns: [], createdAt: '2026-11-02T00:00:00.000Z' });
  store.put('work-conversation', { id: 'c2', title: '性能排查', goal: '排查性能', projectId: 'p2', participants: ['model'], turns: [], createdAt: '2026-11-03T00:00:00.000Z' });
  store.put('work-ticket', { id: 't1', title: '检查会话固定', status: 'completed', executor: 'model', role: 'synthesis', conversationId: 'c1', turnId: 'turn-1', summary: '已修复', createdAt: '2026-11-02T01:00:00.000Z', executorInput: { secretPrompt: '不要导出我' } });
  store.put('work-ticket', { id: 't2', title: '排查数据库', status: 'failed', executor: 'claude-code', role: 'answer', conversationId: 'c2', turnId: 'turn-2', summary: '连接超时', createdAt: '2026-11-03T01:00:00.000Z' });
  store.put('work-ticket', { id: 't3', title: '历史孤工单', status: 'completed', executor: 'analysis', summary: '无会话', createdAt: '2026-10-01T01:00:00.000Z' });
  // 旧报告只有 ticketId，没有 conversationId/executorId，查询时要回查工单补上。
  store.put('work-report', { id: 'r1', ticketId: 't1', kind: 'ready', summary: '鉴权结论：没有越权路径', artifacts: { cli: { summary: '改了 2 个文件' }, taskId: 'task-1' }, createdAt: '2026-11-02T02:00:00.000Z' });
  store.put('work-report', { id: 'r2', ticketId: 't1', kind: 'progress', summary: '正在扫描', artifacts: {}, createdAt: '2026-11-02T03:00:00.000Z' });
  store.put('work-report', { id: 'r3', ticketId: 't2', kind: 'failed', summary: '数据库连接超时', artifacts: {}, createdAt: '2026-11-03T02:00:00.000Z' });
  store.put('work-report', { id: 'r4', ticketId: 't3', kind: 'completed', summary: '旧版结论', artifacts: {}, createdAt: '2026-10-01T02:00:00.000Z' });
  return { store, center: createReportCenter({ store }) };
}

test('默认按会话聚合，旧报告回查工单补归属', t => {
  const { center } = seed(t);
  const result = center.list();
  assert.equal(result.group, 'conversation');
  assert.equal(result.total, 3, '进展报告默认不出现');
  const auth = result.items.find(item => item.groupId === 'c1');
  assert.equal(auth.title, '鉴权审查');
  assert.equal(auth.reportId, 'r1');
  assert.equal(auth.executorId, 'model');
  assert.equal(auth.projectName, '实验软件');
  assert.equal(auth.reportCount, 1, 'progress 不计入结论数');
  const orphan = result.items.find(item => item.groupId === 'ticket:t3');
  assert.equal(orphan.title, '历史孤工单');
});

test('按工单分组、项目/会话/关键词/类型过滤与分页', t => {
  const { center } = seed(t);
  const byTicket = center.list({ group: 'ticket' });
  assert.equal(byTicket.total, 3);
  assert.ok(byTicket.items.every(item => item.group === 'ticket'));

  assert.equal(center.list({ projectId: 'p1' }).total, 1, '旧报告能通过工单会话回查到项目');
  assert.equal(center.list({ conversationId: 'c2' }).total, 1);
  assert.equal(center.list({ q: '数据库' }).total, 1, '源工单标题也参与关键词匹配');
  assert.equal(center.list({ kind: 'failed' }).total, 1);
  assert.equal(center.list({ kind: 'progress' }).total, 1, '显式筛选进展时可见');

  const page = center.list({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.cursor, '还有下一页');
  const next = center.list({ limit: 1, cursor: page.cursor });
  assert.equal(next.items.length, 1);
  assert.notEqual(next.items[0].id, page.items[0].id);
});

test('报告详情带产物名称，Markdown 不含执行输入', t => {
  const { center } = seed(t);
  const detail = center.detail('r1');
  assert.equal(detail.report.summary, '鉴权结论：没有越权路径');
  assert.equal(detail.ticket.title, '检查会话固定');
  assert.equal(detail.conversation.title, '鉴权审查');
  assert.equal(detail.project.name, '实验软件');
  assert.deepEqual(detail.artifacts.map(item => item.name), ['cli']);

  const markdown = center.markdown('r1');
  assert.match(markdown, /# 完成报告/);
  assert.match(markdown, /鉴权结论/);
  assert.match(markdown, /改了 2 个文件/);
  assert.doesNotMatch(markdown, /不要导出我/, '执行输入不能出现在分享文本里');
  assert.doesNotMatch(markdown, /secretPrompt/);
});

test('不存在的报告返回 404', t => {
  const { center } = seed(t);
  assert.throws(() => center.detail('missing'), error => error.status === 404);
});
