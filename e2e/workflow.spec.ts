import { test, expect } from '@playwright/test';
import { matrixFixture } from '../server/fixtures/acceptance.js';
let sequence=0;
const evidence=new Map();
test.beforeEach(async({page,context},info)=>{
 const external=[]; const logs=[];
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname)){external.push(u.origin);return route.abort();}return route.continue();});
 page.on('console',msg=>logs.push(msg.type()+': '+msg.text()));
 evidence.set(page,{logs,external});

 const response=await page.request.post('/api/auth/register',{data:{username:`e2euser${sequence++}`,displayName:'测试运营',password:'test-password-123'}});expect(response.status()).toBe(201);
 await page.request.put('/api/settings',{data:{provider:'本地模拟',baseUrl:'https://api.openai.com/v1',model:info.title.includes('401')?'mock-401':'mock-ok',apiKey:'test-only'}});
});
test.afterEach(async({page},info)=>{ const e=evidence.get(page);if(e){await info.attach('console',{body:e.logs.join('\n'),contentType:'text/plain'});expect(e.external).toEqual([]);evidence.delete(page);}});
async function create(page){
 await page.goto('/');await page.getByRole('button',{name:'新建分析',exact:true}).first().click();
 const dialog=page.getByRole('dialog');
 const {files}=matrixFixture();await dialog.locator('input[type=file]').setInputFiles(files.map(f=>({name:f.originalname,mimeType:'text/csv',buffer:f.buffer})));
 await dialog.getByLabel('我已核对自动识别结果、时间范围和缺表影响').check();
 await dialog.getByRole('button',{name:'下一步',exact:true}).click();await dialog.getByLabel('分析目标',{exact:true}).fill('分析21天活跃留存和付费');
 await dialog.getByRole('button',{name:'下一步',exact:true}).click();
 await dialog.getByRole('button',{name:/协作模式 分析计划/}).click();
 await dialog.locator('.wizard-ai input[type=checkbox]').check();
 await dialog.getByRole('button',{name:'下一步',exact:true}).click();
 await dialog.getByRole('button',{name:'确认并开始分析 · 20 额度'}).click();
 await page.getByRole('button',{name:'确认并继续',exact:true}).click();
 await expect(page.getByText('分析结果已整理，确认后生成报告。',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'确认并继续',exact:true}).click();
}
test('三表协作、筛选和只读隐藏收入分享',async({page,browser})=>{
 await create(page);await expect(page.getByText('分析完成，报告已就绪',{exact:true})).toBeVisible();
 const state=await (await page.request.get('/api/bootstrap')).json();expect(state.wallet).toEqual({balance:480,frozen:0,spent:20});
 const report=state.tasks.find(t=>t.title!=='近 28 天运营复盘'&&t.status==='completed').report;
 expect(report.metrics.find(m=>m.id==='revenue').value).toBe(210);
 await page.getByRole('tab',{name:'完整报告',exact:true}).click();await expect(page.getByText('本次分析范围',{exact:true}).first()).toBeVisible();
 const before=await (await page.request.get('/__e2e/stats')).json();await page.getByLabel('开始日期',{exact:true}).fill('2026-10-05');await page.getByRole('button',{name:'应用筛选',exact:true}).click();
 await expect(page.getByText(/当前已应用.*2026-10-05/).first()).toBeVisible();await expect(page.getByRole('row').filter({hasText:'成功支付收入'}).first()).toContainText('170');expect((await (await page.request.get('/__e2e/stats')).json()).calls).toBe(before.calls);
 await page.getByRole('button',{name:'分享原始完整报告'}).click();await page.getByLabel('我确认公开原始完整报告的范围，不包含当前筛选。').check();await page.getByLabel('隐藏收入和付费相关内容').check();await page.getByRole('button',{name:'创建分享链接',exact:true}).click();const link=await page.getByLabel('分享链接',{exact:true}).inputValue();
 const context=await browser.newContext();await context.route('**/*',route=>{const u=new URL(route.request().url());if(!['127.0.0.1','localhost'].includes(u.hostname)){evidence.get(page).external.push(u.origin);return route.abort();}return route.continue();});const shared=await context.newPage();await shared.goto(link);await expect(shared.getByText('只读分享',{exact:true})).toBeVisible();await expect(shared.getByRole('columnheader',{name:'收入',exact:true})).toHaveCount(0);await expect(shared.getByRole('button',{name:/下载|导出/})).toHaveCount(0);await expect(shared.getByRole('heading',{name:'成功支付收入',exact:true})).toHaveCount(0);await context.close();
});
test('401 失败退款且不重复扣费',async({page})=>{await create(page);await expect(page.getByText(/Key 无效|API Key.*无效|密钥/).first()).toBeVisible();await expect.poll(async()=>{const s=await(await page.request.get('/api/bootstrap')).json();return s.wallet;}).toEqual({balance:500,frozen:0,spent:0});});
test('超限文件不进入分析队列',async({page})=>{await page.goto('/');await page.getByRole('button',{name:'数据源',exact:true}).click();await page.locator('input[type=file]').setInputFiles({name:'activity.csv',mimeType:'text/csv',buffer:Buffer.alloc(20*1024*1024+1,32)});await expect(page.getByText(/文件总大小不能超过 20MB/).first()).toBeVisible();const s=await(await page.request.get('/api/bootstrap')).json();expect(s.wallet.balance).toBe(500);expect(s.tasks.filter(t=>t.status==='running')).toHaveLength(0);});
