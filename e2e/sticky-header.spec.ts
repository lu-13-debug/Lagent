import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('滚动后工具栏紧接实际顶栏底部且不被遮挡', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `sticky${Date.now()}`, displayName: '布局测试', password: 'test-password-123' } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.page-toolbar')).toBeVisible();
  const results = [];
  for (const theme of ['白天', '夜间']) for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('button', { name: '显示设置', exact: true }).click();
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.getByRole('button', { name: '关闭', exact: true }).last().click();
    await page.evaluate(() => window.scrollTo(0, 500));
    const measure = () => page.evaluate(() => {
      const header = document.querySelector('.topbar')!.getBoundingClientRect();
      const toolbar = document.querySelector('.page-toolbar')!;
      const rect = toolbar.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      return { bottom: header.bottom, top: rect.top, position: getComputedStyle(toolbar).position, hit: !!document.elementFromPoint(x, rect.top + 5)?.closest('.page-toolbar') };
    });
    if (width === 390) {
      expect((await measure()).position).toBe('static');
    } else {
      await expect.poll(async () => Math.abs((await measure()).top - (await measure()).bottom)).toBeLessThanOrEqual(1);
      expect((await measure()).hit).toBe(true);
    }
    results.push({ view: 'concise', theme, width, ...await measure() });
  }
  await test.info().attach('header-geometry', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/sticky-header-geometry.json', JSON.stringify(results, null, 2));
});
