import {test,expect} from '@playwright/test';
for(const theme of ['light','dark'])test(`记忆CRUD与390截图 ${theme}`,async({page})=>{
 await page.request.post('/api/auth/register',{data:{username:`memory${Date.now()}${theme}`,displayName:'记忆测试',password:'test-password-123'}});
 await page.goto('/');await page.getByRole('button',{name:'记忆',exact:true}).click();
 const panel=page.locator('.memory-panel');await panel.getByLabel('名称').fill('报告语言');await panel.getByLabel('内容').fill('使用简体中文');await panel.getByRole('button',{name:'确认添加'}).click();
 const card=panel.locator('article').filter({hasText:'报告语言'});await expect(card).toContainText('使用简体中文');await card.getByRole('button',{name:'编辑'}).click();await panel.getByLabel('内容').fill('简洁表达');await panel.getByRole('button',{name:'确认修改'}).click();await expect(card).toContainText('简洁表达');
 await card.getByRole('button',{name:'禁用'}).click();await expect(card.getByRole('button',{name:'恢复'})).toBeVisible();await card.getByRole('button',{name:'恢复'}).click();await expect(card.getByRole('button',{name:'禁用'})).toBeVisible();await card.getByRole('button',{name:'删除'}).click();await expect(card.getByRole('button',{name:'恢复'})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await page.evaluate(t=>document.documentElement.setAttribute('data-theme',t),theme);await panel.screenshot({path:`artifacts/memory-390-${theme}.png`});
});
test('旧服务无memory能力时隐藏入口',async({page})=>{
 await page.request.post('/api/auth/register',{data:{username:`oldmemory${Date.now()}`,displayName:'旧服务',password:'test-password-123'}});
 await page.route('**/api/runtime',async route=>{const response=await route.fetch();const data=await response.json();delete data.capabilities.memory;await route.fulfill({json:data});});await page.goto('/');await expect(page.getByRole('button',{name:'记忆',exact:true})).toHaveCount(0);
});
