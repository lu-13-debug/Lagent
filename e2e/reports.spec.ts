import { test, expect } from '@playwright/test';

const item = {
  id: 'conv-1', group: 'conversation' as const, groupId: 'conv-1', reportId: 'r1', reportIds: ['r1'], reportCount: 1,
  title: '鉴权审查', kind: 'ready', kindLabel: '完成', summary: '鉴权结论：没有越权路径。',
  createdAt: '2026-11-18T10:00:00.000Z', ticketId: 't1', ticketTitle: '检查会话固定', ticketStatus: 'completed',
  conversationId: 'conv-1', turnId: 'turn-1', executorId: 'model', role: 'synthesis', projectId: 'p1', projectName: '实验软件'
};

test('报告页展示真实结论与产物，并可导出 Markdown', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `reports${Date.now()}`, displayName: '报告测试', password: 'test-password-123' } });
  let listQuery = '';
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.2.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    capabilities: { work: true }, tickets: [], attention: [], datasets: [], projects: [],
    agents: [{ id: 'model', name: 'Lagent', kind: 'model', status: 'available', capabilities: [] }],
    tools: [], policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['model'] },
    lagent: { ready: true, configured: true, available: true }
  } }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [{ id: 'p1', name: '实验软件', path: 'D:\\homework', chats: [] }] } }));
  await page.route('**/api/work/conversations', route => route.fulfill({ json: { conversations: [] } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/work/reports?*', route => {
    listQuery = new URL(route.request().url()).search;
    return route.fulfill({ json: { group: 'conversation', total: 1, reportTotal: 1, cursor: null, items: [item] } });
  });
  await page.route('**/api/work/reports/r1', route => route.fulfill({ json: {
    report: { id: 'r1', ticketId: 't1', assignmentId: 'a1', kind: 'ready', kindLabel: '完成', summary: '鉴权结论：没有越权路径。', createdAt: item.createdAt, conversationId: 'conv-1', turnId: 'turn-1', executorId: 'model', role: 'synthesis' },
    ticket: { id: 't1', title: '检查会话固定', status: 'completed', executorId: 'model', role: 'synthesis', summary: '已修复', conversationId: 'conv-1', turnId: 'turn-1', projectId: 'p1', createdAt: item.createdAt, updatedAt: item.createdAt },
    conversation: { id: 'conv-1', title: '鉴权审查', goal: '审查鉴权', projectId: 'p1', participants: ['model'], createdAt: item.createdAt },
    project: { id: 'p1', name: '实验软件' },
    artifacts: [{ name: 'cli', kind: 'cli', summary: '改了 2 个文件' }]
  } }));
  await page.route('**/api/work/reports/r1/markdown', route => route.fulfill({ contentType: 'text/markdown', body: '# 完成报告\n\n鉴权结论：没有越权路径。\n' }));

  await page.goto('/');
  await page.getByRole('button', { name: '报告', exact: true }).first().click();

  await expect(page.getByRole('heading', { name: '报告', exact: true })).toBeVisible();
  await expect(page.locator('.sa-report-body')).toHaveText('鉴权结论：没有越权路径。');
  await expect(page.locator('.sa-report-artifacts')).toContainText('改了 2 个文件');
  // 报告页不再是会话列表的别名：没有对话标题那一行。
  await expect(page.locator('.sa-report-preview')).toContainText('检查会话固定');
  expect(listQuery).toContain('group=conversation');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/lagent-report-r1/);

  await page.getByRole('button', { name: '按工单' }).click();
  await expect.poll(() => listQuery).toContain('group=ticket');
});

const attentionTicket = {
  id: 't1', title: '检查会话固定', status: 'awaiting_review', stage: 'review', source: 'chat', executor: 'model',
  summary: '等待确认修复范围。', conversationId: 'conv-1', agentId: 'model', role: 'answer',
  createdAt: '2026-11-18T10:00:00.000Z', updatedAt: '2026-11-18T10:05:00.000Z'
};
const doneTicket = {
  id: 't2', title: '补一条回归测试', status: 'completed', stage: 'completed', source: 'chat', executor: 'claude-code',
  summary: '已补并通过。', createdAt: '2026-11-17T09:00:00.000Z', updatedAt: '2026-11-17T09:10:00.000Z'
};

test('执行工单并入报告页，可按状态筛选并打开详情', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `reportsTickets${Date.now()}`, displayName: '报告测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.2.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    capabilities: { work: true }, tickets: [attentionTicket, doneTicket], attention: [], datasets: [], projects: [],
    agents: [{ id: 'model', name: 'Lagent', kind: 'model', status: 'available', capabilities: [] }],
    tools: [], policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['model'] },
    lagent: { ready: true, configured: true, available: true }
  } }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [] } }));
  await page.route('**/api/work/conversations', route => route.fulfill({ json: { conversations: [] } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/work/reports?*', route => route.fulfill({ json: { group: 'conversation', total: 0, reportTotal: 0, cursor: null, items: [] } }));
  await page.route('**/api/work/tickets/t1', route => route.fulfill({ json: { ticket: attentionTicket, assignments: [], reports: [] } }));

  // 旧地址 /?view=tickets 继续可用，落到报告页的执行工单标签。
  await page.goto('/?view=tickets');

  await expect(page.getByRole('heading', { name: '报告', exact: true })).toBeVisible();
  const tab = page.getByRole('tab', { name: /执行工单/ });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(tab).toContainText('1');
  await expect(page.locator('.sa-recent-item')).toHaveCount(2);

  await page.getByRole('button', { name: '待我处理', exact: true }).click();
  await expect(page.locator('.sa-recent-item')).toHaveCount(1);
  await expect(page.locator('.sa-recent-item')).toContainText('检查会话固定');
  await expect(page.locator('.sa-recent-item')).toContainText('需要你');

  await page.locator('.sa-recent-item').first().click();
  await expect(page.locator('.sa-topbar')).toContainText('检查会话固定');
  await page.getByRole('tab', { name: '当前运行', exact: true }).click();
  await expect(page.locator('.sa-card2-name')).toHaveText('检查会话固定');
});
