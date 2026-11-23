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
    { id: 'model', name: 'Lagent', kind: 'model', status: 'available', capabilities: [] },
    { id: 'analysis', name: '分析执行器', kind: 'analysis', status: 'available', capabilities: ['data analysis', 'reports'] },
    { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'available', capabilities: ['git', 'npm'] },
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', status: 'available', capabilities: ['code'] },
  ],
  tools: [{ id: 'github', name: 'GitHub', kind: 'github', status: 'connected', permissions: ['read', 'comment'] }],
  policy: { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['model', 'analysis', 'terminal', 'claude-code'] },
  lagent: { ready: true, configured: true, available: true },
};

test('Super-agent 指挥台：导航、派活模式、审批与移动端', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `super${Date.now()}`, displayName: '指挥测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/command', async route => route.fulfill({ json: { ticket: { ...ticket, id: 't-new', title: '运行终端命令', status: 'working' } } }));
  let sentBody: any = null;
  let collabBody: any = null;
  await page.route('**/api/work/collaborate', route => {
    collabBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { plan: { id: 'plan-1', steps: [] }, steps: [], mainChatId: null, conversationId: 'conv-new-1' } });
  });
  await page.route('**/api/work/conversations', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { conversations: [] } });
    return route.fulfill({ status: 201, json: { conversation: { id: 'conv-new-1', title: '检查 GitHub 仓库状态', goal: '检查 GitHub 仓库状态', host: 'lagent', projectId: null, participants: ['model', 'claude-code'], ticketIds: [], turnCount: 0, lastPrompt: '', lastMode: 'auto', status: 'waiting', createdAt: ticket.createdAt, updatedAt: ticket.createdAt } } });
  });
  await page.route('**/api/work/conversations/conv-new-1', route => route.fulfill({ json: { conversation: { id: 'conv-new-1', title: '检查 GitHub 仓库状态', goal: '检查 GitHub 仓库状态', host: 'lagent', projectId: null, participants: ['model', 'claude-code'], ticketIds: ['t-new'], turnCount: 1, lastPrompt: '检查 GitHub 仓库状态', lastMode: 'auto', status: 'working', createdAt: ticket.createdAt, updatedAt: ticket.createdAt, turns: [] }, tickets: [] } }));
  await page.route('**/api/work/conversations/conv-new-1/messages', route => {
    sentBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { conversation: { id: 'conv-new-1', title: '检查 GitHub 仓库状态', goal: '检查 GitHub 仓库状态', host: 'lagent', projectId: null, participants: ['model', 'claude-code'], ticketIds: ['t-new'], turnCount: 1, lastPrompt: '检查 GitHub 仓库状态', lastMode: 'auto', status: 'working', createdAt: ticket.createdAt, updatedAt: ticket.createdAt }, turn: { id: 'turn-1' }, tickets: [{ ...ticket, id: 't-new', title: '运行终端命令', status: 'working', executor: 'claude-code' }] } });
  });
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

  // 两种派活模式：单 Agent 只由 Lagent 执行；多 Agent 由 Lagent 拆解分发、协作方互相验收。
  await expect(page.getByRole('button', { name: '单 Agent', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('只由 Lagent 理解、执行并交付')).toBeVisible();
  await page.getByRole('button', { name: '多 Agent', exact: true }).click();
  await expect(page.getByText('Lagent 拆解 · 协作执行 · 互相验收 · Lagent 汇总')).toBeVisible();
  await page.getByRole('button', { name: /Claude Code/ }).first().click();
  await page.locator('.sa-composer textarea').fill('检查 GitHub 仓库状态');
  await page.getByRole('button', { name: '拆解并派发' }).click();
  // 多 Agent 走团队协作入口；Lagent 由服务端强制加入，不由前端伪装。
  await expect.poll(() => collabBody?.agentIds).toEqual(['claude-code']);
  await expect.poll(() => collabBody?.goal).toBe('检查 GitHub 仓库状态');

  // 主导航收成 指挥台 / 项目 / 报告（工单已并入报告页），其余页面进「更多」。
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '团队', exact: true }).click();
  await expect(page.getByRole('heading', { name: '团队', exact: true })).toBeVisible();
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
  const navBox = await page.getByRole('button', { name: '指挥台' }).boundingBox();
  expect(navBox?.height || 0).toBeGreaterThanOrEqual(44);
});

test('运行页：列表、步骤详情与暂停续跑', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `runs${Date.now()}`, displayName: '运行测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: { ...bootstrap, tickets: [], attention: [] } }));
  await page.route('**/api/work/runs?limit=50&include=plans', route => route.fulfill({ json: { runs: [{
    id: 'run-1', goal: '修复登录页样式', projectId: null, chatId: null, templateId: 'fix', templateLabel: '修复', confidence: 1,
    status: 'paused', createdAt: '2026-11-12T01:00:00.000Z', updatedAt: '2026-11-12T01:05:00.000Z', endedAt: null,
    rounds: 0, maxRounds: 2,
    steps: [
      { index: 0, role: '调研', need: {}, executorId: 'claude-code', ticketId: 't-1', status: 'done', summary: '找到样式问题' },
      { index: 1, role: '实现', need: {}, executorId: 'codex', ticketId: null, status: 'pending' },
    ],
    board: [{ at: '2026-11-12T01:04:00.000Z', kind: 'check', text: '服务重启，这次运行已暂停' }],
    digest: '', error: '服务重启，这次运行已暂停，可续跑',
  }] } }));
  await page.route('**/api/work/runs/run-1/resume', route => route.fulfill({ json: { run: { id: 'run-1', goal: '修复登录页样式', status: 'running', createdAt: '2026-11-12T01:00:00.000Z', updatedAt: '2026-11-12T01:06:00.000Z', endedAt: null, rounds: 0, maxRounds: 2, steps: [], board: [], digest: '', error: null, projectId: null, chatId: null, templateId: 'fix', templateLabel: '修复', confidence: 1 } } }));
  await page.route('**/api/work/runs/run-1', route => route.fulfill({ json: { run: {
    id: 'run-1', goal: '修复登录页样式', projectId: null, chatId: null, templateId: 'fix', templateLabel: '修复', confidence: 1,
    status: 'paused', createdAt: '2026-11-12T01:00:00.000Z', updatedAt: '2026-11-12T01:05:00.000Z', endedAt: null,
    rounds: 0, maxRounds: 2,
    steps: [
      { index: 0, role: '调研', need: {}, executorId: 'claude-code', ticketId: 't-1', status: 'done', summary: '找到样式问题' },
      { index: 1, role: '实现', need: {}, executorId: 'codex', ticketId: null, status: 'pending' },
    ],
    board: [{ at: '2026-11-12T01:04:00.000Z', kind: 'check', text: '服务重启，这次运行已暂停' }],
    digest: '', error: '服务重启，这次运行已暂停，可续跑',
  } } }));
  await page.route('**/api/work/usage**', route => route.fulfill({ json: {
    range: { days: 30, from: '2026-10-14', to: '2026-11-12', timeZone: 'Asia/Shanghai' },
    totals: { calls: 6, tokensIn: 1200, tokensOut: 800, totalTokens: 2000, durationMs: 9000, costEstimate: 0.02 },
    byExecutor: [{ executorId: 'claude-code', calls: 4, tokensIn: 900, tokensOut: 600, totalTokens: 1500, durationMs: 6000, costEstimate: 0.015 }],
    byDay: [], byTicket: [],
  } }));

  await page.goto('/');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '运行', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行' })).toBeVisible();
  await expect(page.getByText('修复登录页样式')).toBeVisible();
  await expect(page.getByText('1/2 步')).toBeVisible();

  await page.getByRole('button', { name: '加载用量' }).click();
  await expect(page.getByText('2,000')).toBeVisible();

  await page.getByText('修复登录页样式').click();
  await expect(page.getByText('找到样式问题')).toBeVisible();
  await expect(page.getByText('服务重启，这次运行已暂停')).toBeVisible();
  await page.getByRole('button', { name: '续跑' }).click();
  await expect(page.getByText('已尝试续跑。')).toBeVisible();
});
