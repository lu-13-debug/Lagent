import { test, expect } from '@playwright/test';

test('工具页把内置浏览器加入允许策略', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `tool${Date.now()}`, displayName: '工具测试', password: 'test-password-123' } });
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true } } }));
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
  let saved = null;
  await page.route('**/api/work/policy', async route => {
    saved = route.request().postDataJSON();
    policy = { ...policy, ...(saved?.policy || saved || {}) };
    return route.fulfill({ json: { policy } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '工具', exact: true }).click();
  const browser = page.locator('.sa-card').filter({ hasText: '受控浏览器' });
  await expect(browser).toContainText('可用');
  await expect(page.locator('.sa-card').filter({ hasText: 'GitHub' })).toContainText('需要配置');
  await browser.getByRole('button', { name: '在策略中调整' }).click();
  const policyCard = page.locator('.sa-policy-card');
  await policyCard.getByRole('checkbox', { name: '浏览器', exact: true }).check({ force: true });
  await page.getByRole('button', { name: '保存策略' }).click();
  await expect.poll(() => saved?.policy?.allowedExecutors || saved?.allowedExecutors || []).toContain('browser');
});
