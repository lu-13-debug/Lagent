import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

const deviceToken = 'C'.repeat(43);
const now = '2026-11-25T10:00:00.000Z';

const project = { id: 'p1', name: 'Lagent 仓库', path: 'D:/lagent', gitBranch: 'main' };
const agents = [
  { id: 'model', name: 'Lagent', kind: 'model', status: 'available', capabilities: ['chat'] },
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] },
  { id: 'codex', name: 'Codex CLI', kind: 'cli', status: 'available', capabilities: ['code'] },
  { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'available', capabilities: ['git'] }
];
const conversation = {
  id: 'c1', title: '修复 CI', goal: '修复 CI', projectId: 'p1', participants: ['model'],
  status: 'working', turnCount: 1, lastPrompt: '修复 CI', lastMode: 'auto', createdAt: now, updatedAt: now
};
const ticket = { id: 't1', title: '修复 CI', status: 'working', executor: 'model', createdAt: now, updatedAt: now };

async function pair(page) {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, capabilities: { superagent: true } } }));
  await page.route('**/api/mobile/pair/claim', route => route.fulfill({ status: 201, json: { deviceId: 'device-chat', deviceToken, expiresAt: new Date(Date.now() + 86400000).toISOString() } }));
  await page.route('**/api/mobile/events', route => route.abort());
  await page.route('**/api/mobile/notifications**', route => route.fulfill({ json: { notifications: [], unread: 0 } }));
  await page.goto('/m');
  await page.getByLabel('六位配对码').fill('123456');
  await page.getByRole('button', { name: '连接', exact: true }).click();
}

test('历史会话展示思考、报告全文与权限确认', async ({ page }) => {
  const permissionCalls: string[] = [];
  await page.route('**/api/mobile/bootstrap', route => route.fulfill({
    json: {
      capabilities: { work: true }, tickets: [], attention: [], agents, policy: { allowedExecutors: agents.map(agent => agent.id) },
      projects: [project], conversations: [conversation], lagent: { name: 'Lagent', executorId: 'model', ready: true, configured: true }
    }
  }));
  await page.route('**/api/mobile/conversations?limit=60', route => route.fulfill({ json: { conversations: [conversation] } }));
  await page.route('**/api/mobile/conversations/c1?**', route => route.fulfill({
    json: {
      conversation: {
        ...conversation,
        turns: [{ id: 'turn-1', index: 0, prompt: '修复 CI', mode: 'auto', agentIds: ['model'], runs: [{ ticketId: 't1', agentId: 'model', role: 'answer' }], createdAt: now }],
        hasMore: false, nextBefore: null
      },
      tickets: [ticket]
    }
  }));
  await page.route('**/api/mobile/tickets/t1', route => route.fulfill({
    json: {
      ticket,
      assignments: [],
      activity: [
        { kind: 'thought', text: '先看测试失败项', at: now },
        { kind: 'permission', text: '允许运行 npm test？', requestId: 'req-1', at: now }
      ],
      reports: [{ id: 'r1', ticketId: 't1', kind: 'result', summary: '摘要', text: '完整结论', truncated: true, createdAt: now }]
    }
  }));
  await page.route('**/api/mobile/reports/r1/text', route => route.fulfill({ json: { text: '完整结论（全文）', truncated: false } }));
  await page.route('**/api/mobile/tickets/t1/permissions/req-1', route => {
    permissionCalls.push(route.request().url());
    return route.fulfill({ json: { ticket } });
  });

  await pair(page);
  await page.getByRole('button', { name: '会话列表' }).click();
  await page.locator('.mob-drawer-open').filter({ hasText: '修复 CI' }).click();

  await expect(page.getByText('先看测试失败项')).toBeVisible();
  await expect(page.getByText('完整结论', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '展开全文' }).click();
  await expect(page.getByText('完整结论（全文）')).toBeVisible();
  await page.getByRole('button', { name: '允许一次' }).click();
  await expect.poll(() => permissionCalls.length).toBe(1);
});

test('新会话选择项目、多 Agent 强度并发出请求', async ({ page }) => {
  const created: Record<string, unknown>[] = [];
  const sent: Record<string, unknown>[] = [];
  const emptyConversation = { ...conversation, id: 'c2', title: '检查 CI', status: 'waiting', turnCount: 0 };
  await page.route('**/api/mobile/bootstrap', route => route.fulfill({
    json: {
      capabilities: { work: true }, tickets: [], attention: [], agents, policy: { allowedExecutors: agents.map(agent => agent.id) },
      projects: [project], conversations: [], lagent: { name: 'Lagent', executorId: 'model', ready: true, configured: true }
    }
  }));
  await page.route('**/api/mobile/models', route => route.fulfill({
    json: {
      profiles: [{ id: 'p1', name: '分析模型', model: 'gpt-5.4', available: true, efforts: ['default', 'low', 'medium', 'high'] }],
      defaultProfileId: 'p1'
    }
  }));
  await page.route('**/api/mobile/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { conversations: [] } });
    created.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { conversation: emptyConversation } });
  });
  await page.route('**/api/mobile/conversations/c2?**', route => route.fulfill({
    json: { conversation: { ...emptyConversation, turns: [], hasMore: false, nextBefore: null }, tickets: [] }
  }));
  await page.route('**/api/mobile/conversations/c2/messages', route => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: {
        conversation: { ...emptyConversation, status: 'working', turnCount: 1 },
        turn: {
          id: 'turn-2', index: 0, prompt: '检查 CI', mode: 'multi',
          agentIds: ['model', 'codex', 'claude-code'],
          runs: [{ ticketId: 't2', agentId: 'codex', role: 'answer' }], createdAt: now
        },
        tickets: [{ id: 't2', status: 'working', title: '检查 CI' }]
      }
    });
  });
  await page.route('**/api/mobile/tickets/t2', route => route.fulfill({ json: { ticket: { id: 't2', title: '检查 CI', status: 'working' }, assignments: [], activity: [], reports: [] } }));

  await pair(page);
  await expect(page.getByRole('heading', { name: '今天想让我做什么？' })).toBeVisible();

  await page.getByRole('button', { name: '工作文件夹' }).click();
  await page.getByRole('button', { name: /Lagent 仓库/ }).click();

  await page.getByRole('button', { name: '多 Agent', exact: true }).click();
  await page.getByRole('button', { name: /协作 Agent \(0\)/ }).click();
  await page.getByRole('checkbox', { name: 'Codex CLI' }).check();
  await page.getByLabel('Codex CLI 思考强度').selectOption('high');
  await page.getByRole('checkbox', { name: 'Claude Code' }).check();
  await page.getByLabel('Claude Code 思考强度').selectOption('low');
  await page.getByRole('dialog', { name: '协作 Agent' }).locator('.mob-sheet-head .mob-icon').click();

  await page.locator('.mob-chat-title').click();
  await page.getByRole('button', { name: /分析模型/ }).click();
  await page.getByRole('button', { name: '高', exact: true }).click();
  await page.getByRole('dialog', { name: 'Lagent 模型' }).locator('.mob-sheet-head .mob-icon').click();

  await page.getByLabel('消息').fill('检查 CI');
  await page.getByRole('button', { name: '发送' }).click();

  await expect.poll(() => created.length).toBe(1);
  expect(created[0]).toMatchObject({ projectId: 'p1', agentIds: ['codex', 'claude-code'] });
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({
    text: '检查 CI',
    mode: 'multi',
    agentIds: ['codex', 'claude-code'],
    settings: { profileId: 'p1', effort: 'high' },
    efforts: { model: 'high', codex: 'high', 'claude-code': 'low' }
  });
  expect(sent[0]).not.toHaveProperty('permission');
});
