import { test, expect } from '@playwright/test';

test('工具页把内置浏览器加入允许策略', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `tool${Date.now()}`, displayName: '工具测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'DataAgent', version: '1.1.0', capabilities: { superagent: true } } }));
  await page.route('**/api/work/events', route => route.abort());
  await page.route('**/api/work/windows**', route => route.fulfill({ json: { windows: [] } }));
  await page.route('**/api/work/providers**', route => route.fulfill({ json: { providers: [] } }));
  let policy = { mode: 'personal', acceptMode: 'explicit', allowedExecutors: ['analysis'], budgets: { maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 200000 }, limits: { browserHosts: [], githubRepos: [] } };
  await page.route('**/api/work/bootstrap', route => route.fulfill({ json: { capabilities: { work: true }, tickets: [], attention: [], datasets: [], agents: [], plans: [], policy, tools: [
    { id: 'terminal', name: '受控终端', kind: 'terminal', status: 'connected', permissions: ['git'] },
    { id: 'browser', name: '受控浏览器', kind: 'tool', status: 'connected', permissions: ['read'] },
    { id: 'github', name: 'GitHub', kind: 'tool', status: 'needs_setup', permissions: ['read'] },
    { id: 'window', name: '窗口 Agent', kind: 'window', status: 'connected', permissions: ['send'] }
  ] } }));
  await page.route('**/api/work/policy', async route => { policy = { ...policy, allowedExecutors: ['analysis', 'browser'] }; return route.fulfill({ json: { policy } }); });

  await page.goto('/');
  await page.locator('.sa-sidebar').getByRole('button', { name: '工具', exact: true }).click();
  const browser = page.locator('.sa-card').filter({ hasText: '受控浏览器' });
  await expect(browser).toContainText('可用');
  await browser.getByRole('button', { name: '启用工具' }).click();
  await expect(browser.getByRole('button', { name: '已启用' })).toBeVisible();
  await expect(page.locator('.sa-card').filter({ hasText: 'GitHub' })).toContainText('需要先完成配置');
});
