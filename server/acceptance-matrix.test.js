import test from 'node:test';import assert from 'node:assert/strict';
import {matrixFixture,NOW} from './fixtures/acceptance.js';import {parseFiles} from './datasets.js';import {analyze} from './analytics.js';
for(const kind of ['full','activity','no-payments','no-users','coverage','future','mixed','partial']) test(`acceptance matrix: ${kind}`,async()=>{
 const {files,options}=matrixFixture(kind);const dataset=await parseFiles(files,options);const r=analyze(dataset,{now:NOW});const metric=id=>r.metrics.find(m=>m.id===id)?.value;
 assert.ok(r.quality.rows>0);assert.ok(r.daily.every(d=>d.dau===null||Number.isInteger(d.dau)));
 if(['activity','no-users'].includes(kind)){assert.equal(metric('d1_retention'),null);assert.ok(r.quality.issues.some(s=>s.includes('缺少注册表')));}
 else {assert.equal(metric('d1_retention'),kind==='future'?95.24:100);assert.equal(metric('d7_retention'),kind==='future'?66.67:100);}
 if(['activity','no-payments'].includes(kind)){assert.equal(metric('revenue'),null);assert.ok(r.quality.issues.some(s=>s.includes('缺少支付表')));}
 else if(kind==='coverage') {assert.equal(metric('revenue'),10);assert.equal(r.daily.at(-1).revenue,null);}
 else if(kind!=='partial') assert.equal(metric('revenue'),210);
 if(kind==='future') assert.ok(r.quality.issues.some(s=>s.includes('当日或未来')));
 if(kind==='partial'){assert.equal(r.dataCompleteness.declared,'partial');assert.ok(r.metrics.every(m=>m.change===null));}
 // An explicitly unavailable period must remain null even for complete fixtures.
 const absent=analyze(dataset,{now:NOW,range:{start:'2026-09-01',end:'2026-09-02'}});assert.equal(absent.metrics.find(m=>m.id==='dau').value,null);
});
