import { test, expect } from '@playwright/test';

test('没有 superagent 能力时仍能载入旧分析工作台', async ({ page }) => {
  await page.request.post('/api/auth/register', {
    data: { username: `legacy${Date.now()}`, displayName: '旧壳', password: 'test-password-123' }
  });
  const boot = await (await page.request.get('/api/bootstrap')).json();
  await page.route('**/api/bootstrap', route => route.fulfill({ json: boot }));
  await page.route('**/api/runtime', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.capabilities.superagent = false;
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByText('分析工作台', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '新建分析' }).first()).toBeVisible();
});
