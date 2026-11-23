import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

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
const lagent = { ready: true, configured: true, available: true, name: 'Lagent', executorId: 'model' };

function conversationSummary(id: string, title: string, participants = ['model', 'claude-code']) {
  return {
    id, title, goal: title, host: 'lagent', projectId: 'p1', participants, ticketIds: [`${id}-ticket`],
    turnCount: 1, lastPrompt: title, lastMode: 'review', status: 'completed',
    createdAt: '2026-11-11T09:00:00.000Z', updatedAt: '2026-11-11T09:05:00.000Z'
  };
}
function conversationDetail(id: string, title: string, prompt: string | null, participants = ['model', 'claude-code']) {
  const summary = conversationSummary(id, title, participants);
  return {
    ...summary,
    turns: prompt ? [{
      id: `${id}-turn-1`, index: 0, prompt, mode: 'review', agentIds: participants,
      runs: [{ ticketId: 't-chat', agentId: 'claude-code', role: 'answer' }],
      createdAt: '2026-11-11T09:00:00.000Z'
    }] : []
  };
}

async function mockShell(page: Page, chats = project, allowedExecutors = ['model', 'claude-code', 'codex']) {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.2.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    capabilities: { work: true }, tickets: [], attention: [], datasets: [],
    agents: [
      { id: 'model', name: 'Lagent', kind: 'model', status: 'available', capabilities: [] },
      { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] },
      { id: 'codex', name: 'Codex CLI', kind: 'cli', status: 'available', capabilities: ['code'] }
    ],
    tools: [], policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors },
    lagent
  } }));
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: [chats] } }));
  await page.route('**/api/work/conversations', route => route.fulfill({ json: { conversations: [] } }));
  await page.route('**/api/work/projects/p1/brief', route => route.fulfill({ json: { brief: null } }));
  await page.route('**/api/work/projects/p1/changes', route => route.fulfill({ json: { changes: [] } }));
  await page.route('**/api/work/projects/p1/memory', route => route.fulfill({ json: { projectId: 'p1', entries: [] } }));
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/work/tickets/t-chat', route => route.fulfill({ json: { ticket: chatTicket, assignments: [], reports: [] } }));
}

test('旧项目对话打开后物化成统一会话线程，可继续发消息', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `pchat${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  await mockShell(page);
  let materialized = 0;
  const sentBodies: any[] = [];
  await page.route('**/api/work/chats/c1/materialize', route => {
    materialized += 1;
    return route.fulfill({ json: { chat: { ...project.chats[0], executorId: 'model', role: 'host', conversationId: 'conv-1' }, conversation: conversationSummary('conv-1', '主对话'), created: true } });
  });
  await page.route('**/api/work/conversations/conv-1/messages', route => {
    sentBodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { conversation: conversationSummary('conv-1', '主对话'), turn: { id: 'turn-2' }, tickets: [chatTicket] } });
  });
  await page.route('**/api/work/conversations/conv-1', route => route.fulfill({ json: { conversation: conversationDetail('conv-1', '主对话', '修复登录接口'), tickets: [chatTicket] } }));

  await page.goto('/');
  await page.getByRole('button', { name: '主对话', exact: true }).click();

  await expect.poll(() => materialized).toBe(1);
  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
  // 与普通会话同一套线程：用户气泡 + 思考/编排面板，而不是只列工单的旧壳。
  await expect(page.locator('.sa-bubble-user')).toHaveText('修复登录接口');
  await expect(page.locator('.sa-conv-turn')).toBeVisible();
  await expect(page.getByRole('button', { name: '单 Agent', exact: true })).toBeVisible();

  await page.locator('.sa-composer textarea').fill('再补一个回归测试');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => sentBodies[0]?.text).toBe('再补一个回归测试');
  expect(sentBodies[0]?.agentIds).toContain('model');

  // 旧地址 ?view=chat&chat=c1 也落到同一条会话线程。
  await page.goto('/?view=chat&chat=c1');
  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
  await expect(page.locator('.sa-composer textarea')).toBeVisible();
});

test('从项目页打开对话时不会被最近工单抢占', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `pchatopen${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  await mockShell(page);
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    capabilities: { work: true }, tickets: [chatTicket], attention: [], datasets: [], projects: [project],
    agents: [
      { id: 'model', name: 'Lagent', kind: 'model', status: 'available', capabilities: [] },
      { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] }
    ],
    tools: [], policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['model', 'claude-code'] },
    lagent
  } }));
  await page.route('**/api/work/chats/c1/materialize', route => route.fulfill({ json: { chat: { ...project.chats[0], executorId: 'model', role: 'host', conversationId: 'conv-1' }, conversation: conversationSummary('conv-1', '主对话'), created: true } }));
  await page.route('**/api/work/conversations/conv-1', route => route.fulfill({ json: { conversation: conversationDetail('conv-1', '主对话', '修复登录接口'), tickets: [chatTicket] } }));

  await page.goto('/?view=projects&project=p1');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.locator('.pj-chat').filter({ hasText: '主对话' }).click();

  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
  await expect(page.locator('.sa-composer textarea')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('ticket')).toBeNull();
});

test('工作文件夹的 + 直接建 Lagent 会话，不再弹 Agent 选择框', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `pchatquick${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  const newChat = { id: 'c-new', projectId: 'p1', executorId: 'model', title: 'lagent · Lagent', writable: true, createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z' };
  let listed = [project];
  let created: Record<string, unknown> | null = null;
  await mockShell(page);
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: listed } }));
  await page.route('**/api/work/projects/p1/chats', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = route.request().postDataJSON();
    listed = [{ ...project, chats: [newChat, ...project.chats] }];
    return route.fulfill({ status: 201, json: { chat: newChat, project: listed[0] } });
  });
  await page.route('**/api/work/chats/c-new/materialize', route => route.fulfill({ json: { chat: { ...newChat, role: 'host', conversationId: 'conv-new' }, conversation: conversationSummary('conv-new', 'lagent · Lagent', ['model']), created: true } }));
  await page.route('**/api/work/conversations/conv-new', route => route.fulfill({ json: { conversation: conversationDetail('conv-new', 'lagent · Lagent', null, ['model']), tickets: [] } }));

  await page.goto('/');
  await page.locator('.sa-folder').filter({ hasText: 'lagent' }).locator('.sa-folder-add').click();

  await expect.poll(() => created?.executorId).toBe('model');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'lagent · Lagent' })).toBeVisible();
  await expect(page.locator('.sa-composer .sa-agent-pick').filter({ hasText: 'Lagent' })).toHaveAttribute('aria-pressed', 'true');
});

test('默认执行器策略下，+ 仍由 Lagent 建会话', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `pchatdefault${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  const newChat = { id: 'c-default', projectId: 'p1', executorId: 'model', title: 'lagent · Lagent', writable: true, createdAt: '2026-11-20T00:00:00.000Z', updatedAt: '2026-11-20T00:00:00.000Z' };
  let listed = [project];
  let created: Record<string, unknown> | null = null;
  // 默认策略只放行 analysis / terminal，二者都不是项目对话执行器；Lagent 仍必须可用。
  await mockShell(page, project, ['analysis', 'terminal']);
  await page.route('**/api/work/projects', route => route.fulfill({ json: { projects: listed } }));
  await page.route('**/api/work/projects/p1/chats', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    created = route.request().postDataJSON();
    listed = [{ ...project, chats: [newChat, ...project.chats] }];
    return route.fulfill({ status: 201, json: { chat: newChat, project: listed[0] } });
  });
  await page.route('**/api/work/chats/c-default/materialize', route => route.fulfill({ json: { chat: { ...newChat, role: 'host', conversationId: 'conv-default' }, conversation: conversationSummary('conv-default', 'lagent · Lagent', ['model']), created: true } }));
  await page.route('**/api/work/conversations/conv-default', route => route.fulfill({ json: { conversation: conversationDetail('conv-default', 'lagent · Lagent', null, ['model']), tickets: [] } }));

  await page.goto('/');
  await page.locator('.sa-folder').filter({ hasText: 'lagent' }).locator('.sa-folder-add').click();

  await expect.poll(() => created?.executorId).toBe('model');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
});

test('协作 Agent 可增删，Lagent 始终是固定主控', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `pchatswitch${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  const modelChat = { ...project.chats[0], executorId: 'model', role: 'host', conversationId: 'conv-model' };
  await mockShell(page, { ...project, chats: [modelChat] });
  const sentBodies: any[] = [];
  await page.route('**/api/work/chats/c1/materialize', route => route.fulfill({ json: { chat: modelChat, conversation: conversationSummary('conv-model', '主对话', ['model']), created: false } }));
  await page.route('**/api/work/conversations/conv-model/messages', route => {
    sentBodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 201, json: { conversation: conversationSummary('conv-model', '主对话'), turn: { id: 'turn-2' }, tickets: [chatTicket] } });
  });
  await page.route('**/api/work/conversations/conv-model', route => route.fulfill({ json: { conversation: conversationDetail('conv-model', '主对话', null, ['model']), tickets: [] } }));

  await page.goto('/?view=chat&chat=c1');
  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
  const lagentChip = page.locator('.sa-composer .sa-agent-pick').filter({ hasText: 'Lagent' });
  await expect(lagentChip).toHaveAttribute('aria-pressed', 'true');

  await page.locator('.sa-composer .sa-agent-pick').filter({ hasText: 'Codex CLI' }).click();
  await expect(page.locator('.sa-composer .sa-agent-pick').filter({ hasText: 'Codex CLI' })).toHaveAttribute('aria-pressed', 'true');
  await expect(lagentChip).toHaveAttribute('aria-pressed', 'true');

  await page.locator('.sa-composer textarea').fill('用 Codex 跑一遍回归测试');
  await page.getByRole('button', { name: '发送' }).click();
  await expect.poll(() => sentBodies[0]?.agentIds).toEqual(['model', 'codex']);
  await expect.poll(() => sentBodies[0]?.text).toBe('用 Codex 跑一遍回归测试');

  await page.locator('.sa-composer .sa-agent-pick').filter({ hasText: 'Codex CLI' }).click();
  await expect(page.locator('.sa-composer .sa-agent-pick').filter({ hasText: 'Codex CLI' })).toHaveAttribute('aria-pressed', 'false');
  await expect(lagentChip).toHaveAttribute('aria-pressed', 'true');
});

test('项目对话接入失败时给出错误与重试，而不是一直转圈', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `pchatretry${Date.now()}`, displayName: '项目对话', password: 'test-password-123' } });
  await mockShell(page);
  let attempts = 0;
  await page.route('**/api/work/chats/c1/materialize', route => {
    attempts += 1;
    // 第一次接入失败，点「重试」后才放行。
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: '服务暂时不可用' } });
    return route.fulfill({ json: { chat: { ...project.chats[0], executorId: 'model', role: 'host', conversationId: 'conv-1' }, conversation: conversationSummary('conv-1', '主对话'), created: true } });
  });
  await page.route('**/api/work/conversations/conv-1', route => route.fulfill({ json: { conversation: conversationDetail('conv-1', '主对话', '修复登录接口'), tickets: [chatTicket] } }));

  await page.goto('/?chat=c1');
  await expect(page.getByText(/接入这个项目对话失败/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重试' })).toBeVisible();

  await page.getByRole('button', { name: '重试' }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole('heading', { name: '主对话' })).toBeVisible();
  await expect(page.getByText(/正在把这个项目对话接入/)).toHaveCount(0);
});
