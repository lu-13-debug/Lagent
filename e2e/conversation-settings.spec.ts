import { test, expect } from '@playwright/test';

const ticket = {
  id: 't-conv', title: '检查仓库', status: 'working' as const, stage: 'cli',
  source: 'manual', executor: 'model', summary: '执行中',
  createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:01.000Z',
};

const bootstrap = {
  capabilities: { work: true },
  tickets: [],
  attention: [],
  datasets: [],
  projects: [],
  plans: [],
  workspace: 'D:\\lagent',
  agents: [
    { id: 'model', name: 'Lagent', kind: 'cli', status: 'available', capabilities: ['code'] },
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] },
  ],
  tools: [],
  policy: { mode: 'personal', acceptMode: 'explicit', permission: 'workspace', allowedExecutors: ['model', 'claude-code'] },
};

test.beforeEach(async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `conv${Date.now()}${Math.random().toString(36).slice(2, 6)}`, displayName: '对话测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [] } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/model-hub', route => route.fulfill({
    json: {
      profiles: [
        { id: 'p1', name: 'Claude Sonnet', model: 'claude-sonnet-5', capabilities: { efforts: ['low', 'medium', 'high', 'max'], tools: true } },
        { id: 'p2', name: 'Claude Opus', model: 'claude-opus-5', capabilities: { efforts: ['low', 'high', 'max'], tools: true } },
      ],
      workflow: { defaultProfileId: 'p1' },
    },
  }));
  await page.route('**/api/work/tickets/t-conv', route => route.fulfill({ json: { ticket, assignments: [], reports: [] } }));
});

test('内置 Agent 对话可以选择模型、思考强度和工作权限', async ({ page }) => {
  const commands: any[] = [];
  await page.route('**/api/work/command', async route => {
    commands.push(route.request().postDataJSON());
    await route.fulfill({ json: { ticket } });
  });

  await page.goto('/');
  await expect(page.locator('.sa-shell')).toBeVisible();
  await page.locator('.sa-pick', { hasText: 'Lagent' }).first().click();

  await expect(page.getByLabel('这个对话使用的模型')).toBeVisible();
  await expect(page.getByLabel('这个对话的思考强度')).toBeVisible();
  await page.getByLabel('这个对话使用的模型').selectOption('p1');
  await page.getByLabel('这个对话的思考强度').selectOption('high');
  await page.getByLabel('这次对话的工作权限').selectOption('read');

  await page.locator('.sa-composer textarea').fill('检查仓库');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => commands.length).toBeGreaterThan(0);

  const body = commands[0];
  expect(body.executorId).toBe('model');
  expect(body.executorInput).toEqual({ prompt: '检查仓库' });
  expect(body.settings).toEqual({ profileId: 'p1', effort: 'high', permission: 'read' });
});

test('CLI 对话只显示权限，并随指令发送', async ({ page }) => {
  const commands: any[] = [];
  await page.route('**/api/work/command', async route => {
    commands.push(route.request().postDataJSON());
    await route.fulfill({ json: { ticket: { ...ticket, executor: 'claude-code' } } });
  });

  await page.goto('/');
  await expect(page.locator('.sa-shell')).toBeVisible();
  await page.locator('.sa-pick', { hasText: 'Claude Code' }).first().click();

  await expect(page.getByLabel('这个对话使用的模型')).toHaveCount(0);
  await expect(page.getByLabel('这次对话的工作权限')).toBeVisible();
  await page.getByLabel('这次对话的工作权限').selectOption('workspace');

  await page.locator('.sa-composer textarea').fill('修一个 bug');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => commands.length).toBeGreaterThan(0);

  const body = commands[0];
  expect(body.executorId).toBe('claude-code');
  expect(body.executorInput).toEqual({ prompt: '修一个 bug' });
  expect(body.settings).toEqual({ permission: 'workspace' });
});
