import { test, expect } from '@playwright/test';

const catalog = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
  ...Array.from({ length: 60 }, (_, index) => ({ id: `vendor-model-${String(index).padStart(2, '0')}`, name: `示例模型 ${index}` })),
];

test('模型列表可按名称或 ID 筛选并用键盘选择', async ({ page }) => {
  await page.request.post('/api/auth/register', { data: { username: `picker${Date.now()}`, displayName: '模型选择', password: 'test-password-123' } });
  // 模型中心未开放的部署（旧服务/自建服务）才显示旧版「会话级模型设置」；本用例验证的就是这个降级界面。
  await page.route('**/api/runtime', route => route.fulfill({ json: { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: '1.1.0', capabilities: { superagent: true, memory: true }, modelHosts: ['api.openai.com'] } }));
  await page.route('**/api/settings/models', route => route.fulfill({ json: { models: catalog, baseUrl: 'https://api.openai.com/v1', partial: false } }));
  await page.goto('/');
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置' }).click();
  await page.getByRole('button', { name: '模型与 API', exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill('https://api.openai.com/v1');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-key');
  const combo = page.getByRole('combobox', { name: '模型名称', exact: true });
  // 设置里可能残留上一次保存的模型，先清空再验证下拉过滤。
  await combo.fill('');
  await expect(combo).toHaveValue('');
  // 模型目录是填完地址和 Key 后延迟检测的，等检测完成再展开列表。
  await expect(page.getByText('已检测到 64 个模型')).toBeVisible();
  await combo.click();
  const listbox = page.getByRole('listbox', { name: '可用模型', exact: true });
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(50);
  await expect(listbox).toContainText('共 64 个');
  await combo.fill('gpt-4o');
  await expect(listbox.getByRole('option')).toHaveCount(2);
  await expect(listbox.getByRole('option').first()).toContainText('gpt-4o');
  await page.screenshot({ path: 'artifacts/model-picker.png' });
  await combo.press('Enter');
  await expect(combo).toHaveValue('gpt-4o');
  await expect(listbox).toBeHidden();
  await combo.click();
  await combo.fill('sonnet');
  await expect(listbox.getByRole('option')).toHaveCount(1);
  await combo.press('ArrowDown');
  await combo.press('Enter');
  await expect(combo).toHaveValue('claude-sonnet-5-5');
  await combo.click();
  await combo.fill('不存在');
  await expect(listbox).toContainText('没有匹配的模型');
  await combo.press('Escape');
  await expect(listbox).toBeHidden();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.getByRole('button', { name: '夜间', exact: true }).click();
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  await page.getByRole('button', { name: '模型与 API', exact: true }).click();
  await page.getByLabel('API 地址', { exact: true }).fill('https://api.openai.com/v1');
  await page.getByLabel('API Key', { exact: true }).fill('test-only-key');
  await combo.click();
  await combo.fill('gpt');
  await expect(listbox.getByRole('option')).toHaveCount(2);
  await page.screenshot({ path: 'artifacts/model-picker-dark.png' });
});
