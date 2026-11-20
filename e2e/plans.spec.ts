import { test, expect } from '@playwright/test';

const step0 = {
  id: 'p-0', title: '检查 CI', status: 'awaiting_review', stage: 'approval', source: 'plan', executor: 'codex',
  summary: '请确认只读 CLI 任务后批准执行', planId: 'plan-1', planStep: 0, planTotal: 2,
  createdAt: '2026-11-06T03:00:00.000Z', updatedAt: '2026-11-06T03:00:00.000Z',
  attention: { question: '请确认只读 CLI 任务', createdAt: '2026-11-06T03:00:00.000Z', options: [{ id: 'approve', label: '批准', action: 'approve' }] },
};
const step1 = {
  ...step0, id: 'p-1', title: '修复失败项', status: 'waiting', stage: 'approval', planStep: 1, attention: undefined,
};
const plan = {
  id: 'plan-1', goal: '修复 CI 失败', status: 'active', currentStep: 0, totalSteps: 2,
  steps: [{ index: 0, ticketId: 'p-0', executorId: 'codex', title: '检查 CI', status: 'awaiting_review', dependsOn: [] }, { index: 1, ticketId: 'p-1', executorId: 'codex', title: '修复失败项', status: 'waiting', dependsOn: [0] }],
  createdAt: '2026-11-06T03:00:00.000Z', updatedAt: '2026-11-06T03:00:00.000Z',
};
const bootstrap = {
  capabilities: { work: true }, tickets: [step0, step1], attention: [], datasets: [], tools: [],
  agents: [{ id: 'codex', name: 'Codex CLI', kind: 'codex', status: 'available', capabilities: ['readonly'] }],
  policy: { mode: 'personal', allowedExecutors: ['codex'] },
  plans: [{ id: plan.id, goal: plan.goal, status: plan.status, currentStep: 0, totalSteps: 2, updatedAt: plan.updatedAt }],
};

test('多步计划一次性创建并按步骤展示', async ({ page }) => {
  const created: any[] = [];
  await page.request.post('/api/auth/register', { data: { username: `plan${Date.now()}`, displayName: '计划测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: bootstrap }));
  await page.route('**/api/work/tickets/p-0', route => route.fulfill({ json: { ticket: step0, assignments: [], reports: [], team: null } }));
  await page.route('**/api/work/plans', async route => {
    created.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { plan } });
  });
  await page.route('**/api/work/plans/suggest', route => route.fulfill({ json: { steps: [{ executorId: 'codex', text: '检查 CI' }, { executorId: 'codex', text: '修复失败项', dependsOn: [0] }] } }));
  await page.route('**/api/work/plans/plan-1', route => route.fulfill({ json: { plan, tickets: [step0, step1] } }));

  await page.goto('/');
  await page.getByRole('button', { name: '计划', exact: true }).click();
  await page.locator('.sa-composer textarea').fill('修复 CI 失败');
  await page.getByRole('button', { name: '编辑计划', exact: true }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('默认一路跑完');
  await dialog.getByLabel('计划目标').fill('修复 CI 失败');
  await dialog.getByRole('button', { name: 'AI 帮我规划' }).click();
  await expect(dialog.getByLabel('第1 步说明')).toHaveValue('检查 CI');
  await expect(dialog.getByLabel('第2 步说明')).toHaveValue('修复失败项');
  await expect(dialog.getByLabel('第2 步依赖')).toHaveValue('1');
  await dialog.getByRole('button', { name: '创建并执行' }).click();

  await expect.poll(() => created.length).toBe(1);
  expect(created[0].goal).toBe('修复 CI 失败');
  expect(created[0].steps).toHaveLength(2);
  expect(created[0].steps[1].dependsOn).toEqual([0]);
});
