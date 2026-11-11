import { test, expect } from '@playwright/test';

test('AI 规划可以把窗口 Agent 作为步骤目标', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `wplan${Date.now()}`, displayName: '窗口计划', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [{ id: '42', handle: 42, pid: 7, process: 'Codex', title: 'Codex 任务窗口' }] } }));
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: {
    capabilities: { work: true }, tickets: [], attention: [], datasets: [], plans: [], tools: [],
    agents: [{ id: 'window', name: '窗口 Agent', kind: 'tool', status: 'available', capabilities: ['window'] }],
    policy: { mode: 'personal', allowedExecutors: ['window'] }
  } }));
  await page.route('**/api/work/plans', route => route.fulfill({ status: 201, json: { plan: { id: 'p', goal: 'x', status: 'active', autoRun: false, currentStep: 0, totalSteps: 2, steps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } }));
  await page.route('**/api/work/plans/suggest', route => route.fulfill({ json: { steps: [
    { executorId: 'window', text: '继续执行', executorInput: { handle: 42, process: 'Codex', submit: true } },
    { executorId: 'window', text: '读取结果', executorInput: { handle: 42, process: 'Codex', submit: true }, dependsOn: [0] }
  ] } }));

  await page.goto('/');
  await page.getByRole('button', { name: '多步计划', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('计划目标').fill('让 Codex 继续');
  await dialog.getByRole('button', { name: 'AI 帮我规划' }).click();
  await expect(dialog.getByLabel('第 1 步窗口')).toHaveValue('42');
  await expect(dialog.getByLabel('第 2 步窗口')).toHaveValue('42');
  await expect(dialog.getByLabel('第 1 步说明')).toHaveValue('继续执行');
});
