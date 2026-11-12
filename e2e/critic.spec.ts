import {test,expect} from '@playwright/test';
for(const verdict of ['pass','revise','reject','unreviewed',null])test(`评审状态 ${verdict}`,async({page})=>{
 await page.request.post('/api/auth/register',{data:{username:`critic${Date.now()}${verdict}`,displayName:'评审',password:'test-password-123'}});
 const boot=await(await page.request.get('/api/bootstrap')).json();
 for(const task of boot.tasks.filter((t:any)=>t.report))task.artifacts={report:{summary:'报告',...(verdict?{critic:{verdict,rubricVersion:'critic-1',issues:[]}}:{})}};
 await page.route('**/api/bootstrap',route=>route.fulfill({json:boot}));await page.goto('/');
 const openReport=page.getByRole('button',{name:'完整报告',exact:true});
 await expect(openReport).toBeVisible();
 await openReport.click();
 const fullTab=page.getByRole('tab',{name:'完整报告',exact:true});
 if(await fullTab.count())await fullTab.click();
 const block=page.getByLabel('评审状态', {exact:true});if(verdict){await expect(block).toBeVisible();await expect(block).toContainText(({pass:'通过',revise:'需修订',reject:'未通过',unreviewed:'未审查'} as Record<string,string>)[verdict]);await page.setViewportSize({width:390,height:844});await block.screenshot({path:`artifacts/critic-${verdict}-390.png`});}else await expect(block).toHaveCount(0);
});
