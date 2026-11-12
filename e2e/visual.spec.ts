import { test, expect } from '@playwright/test';

const ticket = {
  id: 't-1', title: '检查 GitHub 仓库状态', status: 'awaiting_review' as const, stage: 'awaiting_review',
  source: 'manual', executor: 'analysis', summary: '已完成初步检查，等待确认。', datasetId: 'd1',
  createdAt: '2026-11-05T03:00:00.000Z', updatedAt: '2026-11-05T03:01:00.000Z',
};
const bootstrap = {
  capabilities: { work: true },
  tickets: [ticket],
  attention: [{ ticketId: 't-1', title: ticket.title, question: '是否继续执行下一步？', options: [{ id: 'approve', label: '确认继续', action: 'approve' }], createdAt: ticket.createdAt }],
  datasets: [{ id: 'd1', name: '演示数据', rowCount: 120, source: 'demo' }],
  agents: [
    { id: 'analysis', name: '分析执行器', kind: 'analysis', status: 'available', capabilities: ['data analysis', 'reports'] },
    { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'available', capabilities: ['git', 'npm'] },
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] },
  ],
  tools: [{ id: 'github', name: 'GitHub', kind: 'github', status: 'connected', permissions: ['read', 'comment'] }],
  policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['analysis', 'terminal', 'claude-code'] },
};

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `visual${Date.now()}`, displayName: '视觉测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/tickets/t-1', route => route.fulfill({ json: { ticket, assignments: [], reports: [] } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [] } }));
  await page.route('**/api/work/runs**', route => route.fulfill({ json: { runs: [] } }));
});

const views = [
  { name: '指挥台', url: '/?view=command' },
  { name: '项目', url: '/?view=projects' },
  { name: '团队', url: '/?view=agents' },
  { name: '设置', url: '/?view=settings' },
  { name: '工具', url: '/?view=tools' },
  { name: '运行', url: '/?view=runs' },
];

for (const view of views) {
  test(view.name, async ({ page }) => {
    await page.goto(view.url);
    await expect(page.locator('.sa-shell')).toBeVisible();
    await expect(page).toHaveScreenshot(`${view.name}-light.png`, { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.01 });
    await page.getByRole('button', { name: '切换到深色主题' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page).toHaveScreenshot(`${view.name}-dark.png`, { fullPage: true, animations: 'disabled', maxDiffPixelRatio: 0.01 });
  });
}
