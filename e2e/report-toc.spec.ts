import { test, expect } from '@playwright/test';

test('完整报告目录可跳转、跟随滚动高亮并按顶栏避让', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `toc${Date.now()}`, displayName: '目录测试', password: 'test-password-123' } });
  await page.goto('/');
  await page.getByRole('tab', { name: '完整报告', exact: true }).click();
  const nav = page.getByRole('navigation', { name: '报告目录', exact: true });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button')).toHaveCount(9);
  await nav.getByRole('button', { name: /图表查看/ }).click();
  const charts = page.locator('#report-charts');
  await expect(charts).toBeInViewport();
  await expect(nav.getByRole('button', { name: /图表查看/ })).toHaveAttribute('aria-current', 'location');
  const pinned = await nav.boundingBox();
  const toolbar = await page.locator('.page-toolbar').boundingBox();
  expect(Math.abs(pinned!.y - (toolbar!.y + toolbar!.height))).toBeLessThan(2);
  await page.emulateMedia({ media: 'print' });
  await expect(nav).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await expect(nav).toBeVisible();
});
