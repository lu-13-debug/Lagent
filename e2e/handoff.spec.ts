import { test, expect } from '@playwright/test';

const agents = [
  { id: 'analysis', name: '分析执行器', kind: 'analysis', status: 'available', capabilities: ['data analysis'] },
  { id: 'codex', name: 'Codex CLI', kind: 'codex', status: 'available', capabilities: ['readonly code'] },
  { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'available', capabilities: ['git'] },
];
const done = {
  id: 't-done', title: '完成检查', status: 'completed', stage: 'result', source: 'manual', executor: 'analysis',
  summary: '检查完成，等待下一棒。', datasetId: 'd1', createdAt: '2026-11-06T03:00:00.000Z', updatedAt: '2026-11-06T03:05:00.000Z',
};
const next = {
  ...done, id: 't-next', title: '接手修复', status: 'awaiting_review', stage: 'approval', executor: 'codex',
  summary: '请确认交接给受控终端。', parentTicketId: 't-done', chainRootId: 't-done', handoffDepth: 1, handoffSummary: '检查完成，等待下一棒。',
  attention: { question: '请确认终端命令', createdAt: '2026-11-06T03:06:00.000Z', options: [{ id: 'approve', label: '批准', action: 'approve' }, { id: 'reject', label: '退回', action: 'reject' }] },
};
const bootstrap = {
  capabilities: { work: true }, tickets: [done], attention: [], datasets: [{ id: 'd1', name: '演示数据', rowCount: 10, source: 'demo' }],
  agents, tools: [], policy: { mode: 'personal', allowedExecutors: ['analysis', 'codex', 'terminal'] },
};

async function mockDesktop(page) {
  await page.request.post('/api/auth/register', { data: { username: `handoff${Date.now()}`, displayName: '交接测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/tickets/t-done', route => route.fulfill({ json: { ticket: done, assignments: [], reports: [{ id: 'r1', kind: 'ready', summary: '检查完成', createdAt: done.updatedAt }], team: null } }));
  await page.route('**/api/work/tickets/t-next', route => route.fulfill({ json: { ticket: next, assignments: [], reports: [], team: null } }));
  await page.route('**/api/work/tickets/t-done/actions', route => route.fulfill({ json: { ticket: next } }));
}

test('桌面端把已完成工单交接给另一个执行器', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.locator('.sa-ticket-list button').filter({ hasText: '完成检查' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('交给另一个 Agent');
  await dialog.getByRole('combobox').selectOption('codex');
  await dialog.getByPlaceholder('可选：希望下一棒关注什么').fill('请检查 CI');
  await dialog.getByRole('button', { name: '交接', exact: true }).click();
  await expect(dialog).toContainText('接手修复');
  await expect(dialog).toContainText('来自上一棒工单');
});

test('手机端把已完成工单交接给另一个执行器', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, capabilities: { superagent: true } } }));
  await page.route('**/api/mobile/pair/claim', route => route.fulfill({ status: 201, json: { deviceId: 'device-handoff', deviceToken: 'B'.repeat(43), expiresAt: new Date(Date.now() + 86400000).toISOString() } }));
  await page.route('**/api/mobile/events', route => route.abort());
  await page.route('**/api/mobile/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/mobile/notifications**', route => route.fulfill({ json: { notifications: [], unread: 0 } }));
  await page.route('**/api/mobile/tickets/t-done', route => route.fulfill({ json: { ticket: done, assignments: [], reports: [{ id: 'r1', kind: 'ready', summary: '检查完成', createdAt: done.updatedAt }] } }));
  await page.route('**/api/mobile/tickets/t-next', route => route.fulfill({ json: { ticket: next, assignments: [], reports: [] } }));
  await page.route('**/api/mobile/tickets/t-done/actions', route => route.fulfill({ json: { ticket: next } }));

  await page.goto('/m');
  await page.getByLabel('六位配对码').fill('123456');
  await page.getByRole('button', { name: '连接', exact: true }).click();
  await page.locator('.mob-nav').getByRole('button', { name: '任务', exact: true }).click();
  await page.locator('.mob-ticket-list button').filter({ hasText: '完成检查' }).click();
  await expect(page.getByRole('heading', { name: '完成检查' })).toBeVisible();
  await expect(page.getByText('交给另一个 Agent')).toBeVisible();
  await page.locator('.mob-handoff-form select').selectOption('codex');
  await page.getByPlaceholder('可选：希望下一棒关注什么').fill('请检查 CI');
  await page.getByRole('button', { name: '交接', exact: true }).click();
  await expect(page.getByRole('heading', { name: '接手修复' })).toBeVisible();
  await expect(page.getByText(/来自上一棒工单/)).toBeVisible();
});
