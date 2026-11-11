import { test, expect } from '@playwright/test';

const ticket = {
  id: 't-1', title: '检查 GitHub 仓库状态', status: 'awaiting_review' as const, stage: 'awaiting_review',
  source: 'manual', executor: 'analysis', summary: '已完成初步检查，等待确认。', datasetId: 'd1',
  createdAt: '2026-11-05T03:00:00.000Z', updatedAt: '2026-11-05T03:01:00.000Z',
};
const team = {
  limits: { maxDepth: 3, maxNodes: 12, maxConcurrent: 3, maxCalls: 48, maxTokens: 65536, timeoutMs: 600000, maxSubtasks: 12 },
  usage: { calls: 3, totalTokens: 1234, reservedTokens: 0 },
  cancelled: false, revision: 2, updatedAt: '2026-11-05T03:01:00.000Z',
  events: [{ type: 'node.completed', nodeId: 'child', status: 'completed', seq: 2, createdAt: '2026-11-05T03:01:00.000Z' }],
  nodes: [
    { id: 'root', parentId: null, depth: 1, name: '洞察', status: 'completed', dependsOn: [], retries: 0, proposals: [] },
    { id: 'child', parentId: 'root', depth: 2, name: '增长核查', status: 'completed', dependsOn: [], retries: 0, proposals: [
      { id: 'p1', kind: 'chart', status: 'proposed', summary: '图表提案：留存趋势' },
      { id: 'p2', kind: 'clean', status: 'needsApproval', summary: '处理提案：标准化字符串' },
    ] },
  ],
};
const bootstrap = {
  capabilities: { work: true },
  tickets: [ticket],
  attention: [{ ticketId: 't-1', title: ticket.title, question: '是否继续执行下一步？', options: [{ id: 'approve', label: '确认继续', action: 'approve' }], createdAt: ticket.createdAt }],
  datasets: [{ id: 'd1', name: '演示数据', rowCount: 120, source: 'demo' }, { id: 'd2', name: '上传数据', rowCount: 240, source: 'upload' }],
  agents: [{ id: 'analysis', name: '分析执行器', kind: 'analysis', status: 'available', capabilities: ['data analysis', 'reports'] }, { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'available', capabilities: ['git', 'npm'] }],
  tools: [{ id: 'github', name: 'GitHub', kind: 'github', status: 'connected', permissions: ['read', 'comment'] }],
  policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['analysis', 'terminal'] },
};

test('Super-agent 指挥台：指令、收件箱、Agent/工具与移动端', async ({ page }, info) => {
  await page.request.post('/api/auth/register', { data: { username: `super${Date.now()}`, displayName: '指挥测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/command', async route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working' } } }));
  await page.route('**/api/work/tickets/t-new', route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working' }, assignments: [], reports: [] } }));
  await page.route('**/api/work/tickets/t-1', route => route.fulfill({ json: { ticket, assignments: [], reports: [{ id: 'r1', ticketId: 't-1', assignmentId: 'a1', kind: 'ready', summary: '检查完成', createdAt: ticket.updatedAt }], team } }));
  await page.route('**/api/work/tickets/t-1/team/child/review', route => route.fulfill({ json: { team: { ...team, revision: 3 } } }));
  await page.route('**/api/work/tickets/t-1/team/child/proposals/p1', route => route.fulfill({ json: { team: { ...team, revision: 3 } } }));
  await page.route('**/api/work/tickets/t-1/actions', route => route.fulfill({ json: { ticket: { ...ticket, status: 'working' } } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/mobile/pair', route => route.fulfill({ status: 201, json: { code: '482913', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() } }));
  await page.goto('/');
  await expect(page.locator('.sa-shell')).toBeVisible();
  await expect(page.getByRole('heading', { name: '今天想让我做什么？' })).toBeVisible();
  await expect(page.getByText('需要你处理')).toBeVisible();
  await page.getByRole('textbox', { name: '指令', exact: true }).fill('检查 GitHub 仓库状态');
  await page.locator('.sa-executor-row select').selectOption('analysis');
  await page.locator('.sa-executor-fields select').selectOption('d1');
  await page.getByRole('button', { name: '发送指令', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('运行终端命令');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '收件箱' }).click();
  await expect(page.getByText('是否继续执行下一步？')).toBeVisible();
  await page.getByRole('button', { name: '确认继续' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByText('团队任务树')).toBeVisible();
  await expect(page.getByText('增长核查')).toBeVisible();
  const child = page.locator('.sa-tree-node').filter({ hasText: '增长核查' });
  await child.locator('.sa-node-actions').getByRole('button', { name: '接受', exact: true }).click();
  await child.locator('.sa-proposal').first().getByRole('button', { name: '接受', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByText('分析执行器')).toBeVisible();
  await page.getByRole('button', { name: '工具', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible();
  await page.locator('.sa-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByText('手机指挥')).toBeVisible();
  await page.getByRole('button', { name: '生成配对码' }).click();
  await expect(page.locator('.sa-mobile-code strong')).toHaveText(/^\d{6}$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sa-shell')).toBeVisible();
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.locator('.sa-sidebar')).toBeVisible();
  await page.screenshot({ path: info.outputPath('superagent-mobile.png'), fullPage: true });
});
