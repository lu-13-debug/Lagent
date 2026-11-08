import { test, expect } from '@playwright/test';
for (const scenario of ['partial', 'failed', 'success']) test(`报告仅展示脱敏评审结果 ${scenario}`, async ({page}) => {
 await page.request.post('/api/auth/register',{data:{username:`panelreport${Date.now()}`,displayName:'评审报告',password:'test-password-123'}});
 const boot=await(await page.request.get('/api/bootstrap')).json();
 const task=boot.tasks.find((t:any)=>t.report);
 task.artifacts={...task.artifacts,insights:{summary:'评审摘要',panel:{enabled:true,degraded:true,participants:2,summary:'共识摘要',reviewers:[{lens:'growth',lensName:'增长',model:'model-a',status:'completed',summary:'已完成',tokens:20},{lens:'risk',lensName:'风险',model:'model-b',status:'failed',error:'PRIVATE-KEY-STACK'}],agreements:[{title:'一致发现',support:2,consensus:'unanimous'}],disagreements:{judgeOnly:[{title:'需要补充覆盖'}],reviewerOnly:[]}}}};
 if(scenario==='failed') task.artifacts.insights.panel.reviewers.forEach((r:any)=>r.status='failed');
 if(scenario==='success') task.artifacts.insights.panel.reviewers.forEach((r:any)=>r.status='completed');
 await page.route('**/api/bootstrap',route=>route.fulfill({json:boot}));
 await page.goto('/');
 await page.getByRole('tab',{name:'完整报告',exact:true}).click();
 const block=page.locator('.report-panel');
 if(scenario==='failed') {
 await expect(block).toContainText('评审不可用，已按单模型完成');
 await expect(block).not.toContainText('需要补充覆盖');
 await expect(block).not.toContainText('分歧表示');
 } else {
 await expect(block).toContainText('参与模型 2 个');
 await expect(block).toContainText('共识 1 条');
 await expect(block).toContainText('需要补充覆盖');
 }
 if(scenario==='success') await expect(block).not.toContainText('失败评审员');
 await expect(block).not.toContainText('PRIVATE-KEY-STACK');
 await block.screenshot({path:'artifacts/workflow-panel-report.png'});
});
test('洞察评审配置保存两位评审员', async ({page}) => {
 await page.request.post('/api/auth/register',{data:{username:`panel${Date.now()}`,displayName:'评审测试',password:'test-password-123'}});
 const hub=await(await page.request.get('/api/model-hub')).json();
 hub.profiles=['judge','growth','risk'].map(id=>({id,name:id,model:id,credentialId:'c',capabilities:{efforts:['default'],tools:false}}));hub.workflow.defaultProfileId='judge';
 await page.route('**/api/model-hub',route=>route.fulfill({json:hub}));
 let saved:any;
 await page.route('**/api/workflow-config',async route=>{saved=route.request().postDataJSON();await route.fulfill({json:{workflow:saved}});});
 await page.goto('/');await page.getByRole('button',{name:'模型与 API 设置',exact:true}).click();
 await page.getByText('多模型评审（可选）',{exact:true}).click();
 await page.getByLabel('启用洞察多模型评审',{exact:true}).check();
 await page.getByLabel('评审员 1',{exact:true}).selectOption('growth');
 await page.getByLabel('评审员 2',{exact:true}).selectOption('risk');
 await page.getByRole('button',{name:'保存工作流',exact:true}).click();
 await expect.poll(()=>saved?.stages.insights.review.reviewerProfileIds).toEqual(['growth','risk']);
 await expect(page.getByText('工作流已保存',{exact:false}).first()).toBeVisible();
});
