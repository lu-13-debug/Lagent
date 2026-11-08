import { test, expect } from '@playwright/test';
test('报告列表只有一个主新建入口',async({page})=>{
 await page.request.post('/api/auth/register',{data:{username:`buttons${Date.now()}`,displayName:'入口测试',password:'test-password-123'}});
 await page.goto('/');await page.getByRole('button',{name:'分析报告',exact:true}).click();
 for(const width of [1440,1024,390]){await page.setViewportSize({width,height:900});await expect(page.locator('.app-main').getByRole('button',{name:'新建分析',exact:true})).toHaveCount(1);}
});
test('无其他可用模型时不能启用评审',async({page})=>{
 await page.request.post('/api/auth/register',{data:{username:`noreviewer${Date.now()}`,displayName:'开关测试',password:'test-password-123'}});
 const hub=await(await page.request.get('/api/model-hub')).json();hub.profiles=[{id:'judge',name:'裁判',model:'mock',credentialId:'c',capabilities:{efforts:['default'],tools:false}}];hub.workflow.defaultProfileId='judge';
 await page.route('**/api/model-hub',route=>route.fulfill({json:hub}));await page.goto('/');
 await page.getByRole('button',{name:'模型与 API 设置',exact:true}).click();await page.getByText('多模型评审（可选）',{exact:true}).click();
 await expect(page.getByLabel('启用洞察多模型评审',{exact:true})).toBeDisabled();await expect(page.getByText('没有可用的其他模型配置',{exact:true})).toBeVisible();
});
