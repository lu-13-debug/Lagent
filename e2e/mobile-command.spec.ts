import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const ticket = {
  id: 't-1', title: '检查 GitHub 仓库状态', status: 'awaiting_review', stage: 'approval', source: 'manual',
  executor: 'analysis', summary: '已完成初步检查，等待确认。', datasetId: 'd1',
  planId: 'plan-1', planStep: 0, planTotal: 2,
  createdAt: '2026-11-05T03:00:00.000Z', updatedAt: '2026-11-05T03:01:00.000Z',
  attention: { question: '是否继续执行下一步？', createdAt: '2026-11-05T03:01:00.000Z', options: [{ id: 'approve', label: '确认继续', action: 'approve' }, { id: 'reject', label: '退回', action: 'reject' }] },
};
const bootstrap = {
  capabilities: { work: true },
  tickets: [ticket],
  attention: [{ ticketId: 't-1', title: ticket.title, question: ticket.attention.question, options: ticket.attention.options, createdAt: ticket.createdAt }],
  datasets: [{ id: 'd1', name: '演示数据', rowCount: 120, source: 'demo' }],
  agents: [
    { id: 'analysis', name: '分析执行器', kind: 'analysis', status: 'available', capabilities: ['data analysis'] },
    { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'available', capabilities: ['git'] }
  ],
  policy: { mode: 'personal', allowedExecutors: ['analysis', 'terminal'] },
  plans: [{ id: 'plan-1', goal: '检查并修复', status: 'active', currentStep: 0, totalSteps: 2, updatedAt: '2026-11-05T03:01:00.000Z' }],
  projects: [],
  conversations: [],
  lagent: { name: 'Lagent', executorId: 'model', ready: true, configured: true }
};

test('手机配对后默认可对话，并能从抽屉执行工具指令、查看任务与审批', async ({ page }, info) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, capabilities: { superagent: true } } }));
  await page.route('**/api/mobile/pair/claim', route => route.fulfill({ status: 201, json: { deviceId: 'device-mobile-1', deviceToken: 'A'.repeat(43), expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString() } }));
  await page.route('**/api/mobile/events', route => route.abort());
  await page.route('**/api/mobile/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/mobile/notifications**', route => route.request().url().endsWith('/read-all') ? route.fulfill({ json: { ok: true, unread: 0 } }) : route.fulfill({ json: { notifications: [{ id: 'n1', ticketId: 't-1', title: '检查 GitHub 仓库状态', status: 'awaiting_review', summary: '等待确认。', createdAt: ticket.updatedAt, unread: true }], unread: 1 } }));
  await page.route('**/api/mobile/command', route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working', attention: undefined } } }));
  await page.route('**/api/mobile/tickets/t-new', route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working', attention: undefined }, assignments: [], reports: [{ id: 'r-new', kind: 'ready', summary: '指令已进入执行队列。', createdAt: ticket.updatedAt }] } }));
  await page.route('**/api/mobile/tickets/t-1', route => route.fulfill({ json: { ticket, assignments: [], reports: [{ id: 'r1', kind: 'ready', summary: '检查完成', createdAt: ticket.updatedAt }] } }));
  await page.route('**/api/mobile/tickets/t-1/actions', route => route.fulfill({ json: { ticket: { ...ticket, status: 'working', attention: undefined } } }));

  await page.goto('/m');
  await expect(page.getByRole('heading', { name: '连接你的指挥台' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-pair.png'), fullPage: true });
  await page.getByLabel('六位配对码').fill('123456');
  await page.getByRole('button', { name: '连接', exact: true }).click();

  // 默认进入「对话」：没有会话时显示空状态。
  await expect(page.getByRole('heading', { name: '今天想让我做什么？' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('mobile-chat.png'), fullPage: true });

  await page.locator('.mob-nav').getByRole('button', { name: /收件箱/ }).click();
  await expect(page.locator('.mob-attention').getByText('检查 GitHub 仓库状态')).toBeVisible();
  await expect(page.getByText('最近提醒 · 1 条未读')).toBeVisible();
  await page.getByRole('button', { name: '全部已读' }).click();
  await expect(page.getByText('最近提醒 · 1 条未读')).toHaveCount(0);
  await page.getByRole('button', { name: '确认继续' }).click();
  await expect(page.locator('.mob-toast')).toContainText('操作已提交');

  await page.locator('.mob-nav').getByRole('button', { name: '任务', exact: true }).click();
  await expect(page.getByText('检查并修复')).toBeVisible();
  await expect(page.getByText(/计划第 1\/2 步/)).toBeVisible();

  // 旧「指挥」tab 已移到会话抽屉的「工具指令」。
  await page.locator('.mob-nav').getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: '会话列表' }).click();
  await page.getByRole('button', { name: /工具指令/ }).click();
  await page.getByRole('dialog', { name: '工具指令' }).getByRole('textbox', { name: '指令' }).fill('运行 git status');
  await page.getByRole('combobox').selectOption('terminal');
  await page.getByRole('button', { name: '发送指令' }).click();
  await expect(page.getByRole('heading', { name: '运行终端命令' })).toBeVisible();
  await expect(page.getByText('指令已进入执行队列。')).toBeVisible();

  await page.getByRole('button', { name: '返回' }).click();
  await page.locator('.mob-nav').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
  await expect(page.getByText('撤销这台设备')).toBeVisible();
  await expect(page.getByText('可为会话选择 Lagent 模型与各 Agent 思考强度')).toBeVisible();
});
