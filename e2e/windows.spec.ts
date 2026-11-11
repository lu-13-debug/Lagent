import { test, expect } from '@playwright/test';

test('Agent 页面可以读取并发送到本机窗口', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `window${Date.now()}`, displayName: '窗口测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: { capabilities: { work: true }, tickets: [], attention: [], datasets: [], agents: [], tools: [], policy: { mode: 'personal', allowedExecutors: ['analysis'] } } }));
  let sent = null;
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  await page.route('**/api/work/windows**', async route => {
    const url = route.request().url();
    if (url.endsWith('/text')) return route.fulfill({ json: { text: 'Codex 窗口最近输出' } });
    if (url.endsWith('/send')) { sent = route.request().postDataJSON(); return route.fulfill({ json: { ok: true, process: 'WindowsTerminal', submitted: true } }); }
    return route.fulfill({ json: { windows: [{ id: '42', handle: 42, pid: 7, process: 'WindowsTerminal', title: 'Codex 任务窗口' }] } });
  });

  await page.goto('/');
  await page.locator('.sa-sidebar').getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByText('Codex 任务窗口')).toBeVisible();
  await page.getByRole('button', { name: '读取' }).click();
  await expect(page.getByText('Codex 窗口最近输出')).toBeVisible();
  const input = page.getByLabel('向 WindowsTerminal 发送指令');
  await input.fill('继续下一步');
  await expect(input).toHaveValue('继续下一步');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(sent).toEqual({ text: '继续下一步', submit: true });
});
