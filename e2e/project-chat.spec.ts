import { test, expect } from '@playwright/test';

const project = {
  id: 'p1', name: 'lagent', path: 'D:\\lagent', gitBranch: 'main', entryCount: 12, chatCount: 1,
  chats: [{ id: 'c1', projectId: 'p1', executorId: 'claude-code', title: '主对话', writable: true, permission: 'workspace', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z' }],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-10T00:00:00.000Z',
};
const chatTicket = {
  id: 't-chat', title: '修复登录接口', status: 'completed' as const, stage: 'completed',
  source: 'chat', executor: 'claude-code', summary: '已修复并跑过测试。', projectChatId: 'c1',
  createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:05:00.000Z',
};

test('项目对话在主线程里查看与继续发消息', async ({ page }) => {
  let sent = '';
  await page.request.post('/api/auth/register', { data: { username: `pchat${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    capabilities: { work: true }, tickets: [], attention: [], datasets: [],
    agents: [{ id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] }],
    tools: [], policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['claude-code'] },
  } }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [project] } }));
  await page.route('**/api/work/chats/c1/tickets', route => route.fulfill({ json: { tickets: [chatTicket] } }));
  await page.route('**/api/work/tickets/t-chat', route => route.fulfill({ json: { ticket: chatTicket, assignments: [], reports: [] } }));
  await page.route('**/api/work/chats/c1/messages', async route => {
    sent = route.request().postDataJSON().text;
    return route.fulfill({ json: { ticket: { ...chatTicket, id: 't-chat-2', title: '再补一个回归测试', status: 'working' } } });
  });
  await page.route('**/api/work/projects/p1/brief', route => route.fulfill({ json: { brief: null } }));
  await page.route('**/api/work/projects/p1/changes', route => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/work/projects/p1/memory', route => route.fulfill({ json: { projectId: 'p1', entries: [] } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));

  await page.goto('/');
  await page.getByRole('button', { name: '主对话', exact: true }).click();

  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
  await expect(page.getByText('修复登录接口')).toBeVisible();
  await expect(page.getByRole('button', { name: '自动', exact: true })).toHaveCount(0);

  await page.getByText('修复登录接口').click();
  await expect(page.getByText('已修复并跑过测试。')).toBeVisible();
  await page.getByRole('button', { name: '新对话' }).click();
  await page.getByRole('button', { name: '主对话', exact: true }).click();
  await page.locator('.sa-composer textarea').fill('再补一个回归测试');
  await page.getByRole('button', { name: '发送' }).click();

  await expect.poll(() => sent).toBe('再补一个回归测试');
  await expect(page.getByText('再补一个回归测试')).toBeVisible();

  // 旧地址（?view=chat&chat=c1）也落到主线程，而不是旧项目聊天壳。
  await page.goto('/?view=chat&chat=c1');
  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
});
