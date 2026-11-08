import {test,expect} from '@playwright/test';
test('首页尺寸、六条上限、长标题行高与媒体模式',async({page})=>{
 await page.request.post('/api/auth/register',{data:{username:`audit${Date.now()}`,displayName:'核对测试',password:'test-password-123'}});
 const boot=await(await page.request.get('/api/bootstrap')).json();const seed=boot.tasks[0];
 boot.tasks=[seed,...Array.from({length:8},(_,i)=>({...seed,id:`audit-${i}`,title:'这是一个很长的分析任务标题'.repeat(8),datasetName:'这是很长的数据来源名称'.repeat(6),updatedAt:`2026-10-${String(20-i).padStart(2,'0')}T00:00:00Z`}))];
 await page.route('**/api/bootstrap',r=>r.fulfill({json:boot}));await page.goto('/');
 await page.setViewportSize({width:1900,height:1000});
 expect((await page.locator('.concise-composer').boundingBox())!.width).toBeLessThanOrEqual(760);
 await expect(page.locator('.concise-recent li')).toHaveCount(6);
 for(const width of [1024,390]){await page.setViewportSize({width,height:844});for(const row of await page.locator('.concise-recent li button').all())expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
 for(const button of await page.locator('.concise-composer-actions button,.concise-intents button').all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 await page.emulateMedia({reducedMotion:'reduce'});await expect(page.locator('.concise-composer')).toHaveCSS('transition-duration','0s');
 await page.emulateMedia({media:'print'});expect(await page.locator('.workspace-content').evaluate(e=>getComputedStyle(e).backgroundImage)).toBe('none');await expect(page.locator('html')).toHaveCSS('background-color','rgb(255, 255, 255)');
});
