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
  lagent: { ready: true, configured: true, available: true, name: 'Lagent', executorId: 'model' },
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

// 发送走「建会话 → 往会话里追加一条消息」，模型/思考强度/权限都挂在消息上。
async function mockConversationSend(page: import('@playwright/test').Page, sent: any[], executor: 'model' | 'claude-code') {
  const conversation = { id: 'conv-settings', title: '检查仓库', agentIds: [executor], turns: [] };
  await page.route('**/api/work/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { conversations: [] } });
    await route.fulfill({ json: { conversation } });
  });
  await page.route('**/api/work/conversations/*', async route => {
    await route.fulfill({ json: { conversation, tickets: [{ ...ticket, executor }] } });
  });
  await page.route('**/api/work/conversations/*/messages', async route => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ json: { conversation, turn: { id: 'turn-1' }, tickets: [{ ...ticket, executor }] } });
  });
}

test('内置 Agent 对话可以选择模型、思考强度和工作权限', async ({ page }) => {
  const commands: any[] = [];
  await mockConversationSend(page, commands, 'model');

  await page.goto('/');
  await expect(page.locator('.sa-shell')).toBeVisible();
  // Lagent 是固定主控，默认就在名单里；不需要再点选。
  await expect(page.locator('.sa-pick-fixed')).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByLabel('这个对话使用的模型')).toBeVisible();
  await expect(page.getByLabel('这个对话的思考强度')).toBeVisible();
  await page.getByLabel('这个对话使用的模型').selectOption('p1');
  await page.getByLabel('这个对话的思考强度').selectOption('high');
  await page.getByLabel('这次对话的工作权限').selectOption('read');

  await page.locator('.sa-composer textarea').fill('检查仓库');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => commands.length).toBeGreaterThan(0);

  const body = commands[0];
  expect(body.agentIds).toEqual(['model']);
  expect(body.executorInputs).toEqual({ model: { prompt: '检查仓库' } });
  expect(body.settings).toEqual({ profileId: 'p1', effort: 'high', permission: 'read' });
});

test('CLI 对话也可以选择模型、思考强度和工作权限', async ({ page }) => {
  const commands: any[] = [];
  await mockConversationSend(page, commands, 'claude-code');

  await page.goto('/');
  await expect(page.locator('.sa-shell')).toBeVisible();
  await page.locator('.sa-pick', { hasText: 'Claude Code' }).first().click();

  await expect(page.getByLabel('Claude Code 使用的模型')).toBeVisible();
  await expect(page.getByLabel('Claude Code 的思考强度')).toBeVisible();
  await expect(page.getByLabel('这次对话的工作权限')).toBeVisible();
  await page.getByLabel('Claude Code 使用的模型').selectOption('claude-opus-5');
  await page.getByLabel('Claude Code 的思考强度').selectOption('high');
  await page.getByLabel('这次对话的工作权限').selectOption('workspace');

  await page.locator('.sa-composer textarea').fill('修一个 bug');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => commands.length).toBeGreaterThan(0);

  const body = commands[0];
  // Lagent 固定主控：外部 CLI 只能作为协作 Agent，一起进入同一回合。
  expect(body.agentIds).toEqual(['model', 'claude-code']);
  expect(body.executorInputs).toEqual({ model: { prompt: '修一个 bug' }, 'claude-code': { prompt: '修一个 bug' } });
  expect(body.settings).toMatchObject({ model: 'claude-opus-5', permission: 'workspace' });
  expect(body.settings.profileId).toBeDefined();
});

test('Lagent 未配置模型时禁用发送并给出去设置入口', async ({ page }) => {
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    ...bootstrap,
    lagent: { ready: false, configured: false, available: false, code: 'LAGENT_MODEL_NOT_CONFIGURED', reason: 'Lagent 尚未配置模型。请到「设置 → 模型与 API」配置后重试。' }
  } }));

  await page.goto('/');
  await expect(page.locator('.sa-lagent-blocked')).toContainText('尚未配置模型');
  await expect(page.getByRole('button', { name: '去设置模型' })).toBeVisible();
  await page.locator('.sa-composer textarea').fill('解释一下这个报错');
  const send = page.getByRole('button', { name: '发送指令' });
  await expect(send).toBeDisabled();
  await expect(send).toContainText('先配置模型');
});

test('简单任务选了协作 Agent 时建议仅用 Lagent，一键清空协作名单', async ({ page }) => {
  const commands: any[] = [];
  await mockConversationSend(page, commands, 'model');

  await page.goto('/');
  await page.locator('.sa-pick', { hasText: 'Claude Code' }).first().click();
  await page.locator('.sa-composer textarea').fill('解释一下这个报错是什么原因');
  await expect(page.locator('.sa-lagent-suggestion')).toContainText('可以只用 Lagent');
  await page.getByRole('button', { name: '仅用 Lagent' }).click();
  await expect(page.locator('.sa-pick', { hasText: 'Claude Code' }).first()).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.sa-lagent-suggestion')).toHaveCount(0);

  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => commands[0]?.agentIds).toEqual(['model']);
  await expect.poll(() => commands[0]?.text).toBe('解释一下这个报错是什么原因');
});
