import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {matrixFixture} from '../server/fixtures/acceptance.js';
test('居中任务首页布局、主题基线与快捷意图',async({page})=>{
 test.setTimeout(120000);
 await page.request.post('/api/auth/register',{data:{username:`center${Date.now()}`,displayName:'首页测试',password:'test-password-123'}});
 const prefix=process.env.HOME_BASELINE?'before':'after';
 await page.setViewportSize({width:1440,height:900});await page.goto('/');
 async function appearance(theme:string){await page.evaluate(()=>scrollTo(0,0));await page.getByRole('button',{name:'显示设置',exact:true}).click();await page.getByRole('button',{name:theme,exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).last().click();}
 const tokens:any={};
 for(const theme of ['白天','夜间']){
 await appearance(theme);
 tokens[theme]=await page.evaluate(()=>Object.fromEntries(['--surface-0','--surface-1','--surface-2','--surface-3','--line','--line-strong','--text-1','--text-2','--text-3','--primary-bg','--primary-text','--primary-hover'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue(k)])));
 for(const [width,height] of [[1440,900],[1024,768],[390,844]]){await page.setViewportSize({width,height});if(width===390)await expect.poll(async()=>{const r=await page.locator('.sidebar').boundingBox();return r?r.x+r.width:0;}).toBeLessThanOrEqual(1);await page.screenshot({path:`artifacts/home-${prefix}-${width}-${theme}.png`,animations:'disabled',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);}
 await page.setViewportSize({width:1440,height:900});
 }
 await writeFile(`artifacts/home-${prefix}-tokens.json`,JSON.stringify(tokens));
 if(process.env.HOME_BASELINE)return;
 for(const [width,column] of [[1440,760],[1600,880],[1900,980]]){await page.setViewportSize({width,height:900});expect(Math.round((await page.locator('.concise-start').boundingBox())!.width)).toBe(column);}
 await page.setViewportSize({width:1440,height:900});
 await page.getByLabel('分析目标',{exact:true}).focus();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'选择数据',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(page.locator('.concise-model')).toBeFocused();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'开始分析',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'收入与付费',exact:true})).toBeFocused();
 const before=await(await page.request.get('/api/bootstrap')).json();
 await page.getByRole('button',{name:'收入与付费',exact:true}).click();
 await expect(page.getByLabel('分析目标',{exact:true})).not.toHaveValue('');await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.locator('.concise-composer')).toHaveCSS('border-radius','22px');
 await expect(page.locator('.concise-recent ul')).toHaveCSS('grid-template-columns',/\S+ \S+ \S+/);
 await page.getByRole('button',{name:'开始分析',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
 await page.getByRole('button',{name:/默认模型|模型设置/}).filter({visible:true}).last().click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
 const after=await(await page.request.get('/api/bootstrap')).json();expect(after.tasks.length).toBe(before.tasks.length);expect(after.wallet).toEqual(before.wallet);expect((await(await page.request.get('/__e2e/stats')).json()).calls).toBe(0);
});
test('简洁首页上传并确认后可查看确定性分析报告',async({page})=>{
 test.skip(!!process.env.HOME_BASELINE,'仅保存基线');test.setTimeout(90000);
 await page.request.post('/api/auth/register',{data:{username:`homeflow${Date.now()}`,displayName:'流程测试',password:'test-password-123'}});await page.goto('/');
 await page.getByLabel('分析目标',{exact:true}).fill('核对上传数据的活跃与收入');await page.getByRole('button',{name:'开始分析',exact:true}).click();
 const dialog=page.getByRole('dialog');const {files}=matrixFixture();await dialog.locator('input[type=file]').setInputFiles(files.map(f=>({name:f.originalname,mimeType:'text/csv',buffer:f.buffer})));
 await dialog.getByLabel('我已核对自动识别结果、时间范围和缺表影响').check();await dialog.getByRole('button',{name:'下一步',exact:true}).click();await dialog.getByRole('button',{name:'下一步',exact:true}).click();await dialog.getByRole('button',{name:/自动模式 确认开始后/}).click();await dialog.getByRole('button',{name:'下一步',exact:true}).click();await expect(dialog).toContainText('仅确定性分析');await dialog.getByRole('button',{name:'确认并开始分析 · 20 额度'}).click();
 await expect.poll(async()=>{const boot=await(await page.request.get('/api/bootstrap')).json();return boot.tasks.some((t:any)=>t.status==='completed'&&t.title!=='近 28 天运营复盘');}).toBe(true);
 await page.locator('.concise-current').getByRole('button',{name:'完整报告',exact:true}).click();await expect(page.locator('.full-report')).toBeVisible();expect((await(await page.request.get('/__e2e/stats')).json()).calls).toBe(0);
});
