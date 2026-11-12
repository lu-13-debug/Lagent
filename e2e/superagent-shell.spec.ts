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

test('Super-agent 指挥台：导航、派活模式、审批与移动端', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `super${Date.now()}`, displayName: '指挥测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/command', async route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working' } } }));
  await page.route('**/api/work/tickets/t-new', route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working' }, assignments: [], reports: [] } }));
  await page.route('**/api/work/tickets/t-1', route => route.fulfill({ json: { ticket, assignments: [], reports: [] } }));
  await page.route('**/api/work/tickets/t-1/actions', route => route.fulfill({ json: { ticket: { ...ticket, status: 'working' } } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/mobile/pair', route => route.fulfill({ status: 201, json: { code: '482913', expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() } }));

  await page.goto('/');
  await expect(page.locator('.sa-shell')).toBeVisible();

  // 有历史工单时默认回到对话；审批只在线程内联卡里，不再弹 Modal。
  await expect(page.getByText('是否继续执行下一步？').first()).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /需要你/ })).toBeVisible();
  await page.getByRole('button', { name: '确认继续' }).first().click();

  // 指挥台：新建对话回到落地页。
  await page.getByRole('button', { name: '新对话' }).click();
  await expect(page.getByRole('heading', { name: '今天想让我做什么？' })).toBeVisible();
  await page.getByRole('button', { name: '搜索与命令' }).click();
  await expect(page.getByRole('dialog', { name: '命令面板' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '命令面板' })).toHaveCount(0);

  // 三种派活模式：自动单选、计划改发「编辑计划」、复核多选。
  await page.getByRole('button', { name: '计划', exact: true }).click();
  await expect(page.getByRole('button', { name: '编辑计划', exact: true })).toBeDisabled();
  await page.locator('.sa-composer textarea').fill('检查仓库 CI 并修复失败项');
  await expect(page.getByRole('button', { name: '编辑计划', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '复核', exact: true }).click();
  await expect(page.getByText('并行独立作答，再由你选一个汇总')).toBeVisible();
  await page.getByRole('button', { name: '自动', exact: true }).click();
  await page.getByRole('button', { name: /Claude Code/ }).first().click();
  await page.locator('.sa-composer textarea').fill('检查 GitHub 仓库状态');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByText('运行终端命令').first()).toBeVisible();

  // 更多菜单承载低频页面。
  await page.getByRole('button', { name: '团队', exact: true }).click();
  await expect(page.getByRole('heading', { name: '本机 Agent' })).toBeVisible();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '工具', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'GitHub', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await expect(page.getByText('手机指挥')).toBeVisible();
  await page.getByRole('button', { name: '生成配对码' }).click();
  await expect(page.locator('.sa-mobile-code strong')).toHaveText(/^\d{6}$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sa-shell')).toBeVisible();
  await page.getByRole('button', { name: '打开导航' }).click();
  await expect(page.locator('.sa-sidebar')).toBeVisible();
  await expect(page.locator('.sa-sidebar')).toHaveCSS('width', '340px');
});
