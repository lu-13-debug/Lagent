import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('./quality-receipts.js').catch(()=>({}));
test('质量回执区分未运行、禁用、内容过期和真实通过',()=>{
 assert.equal(typeof api.buildQualityReceipts,'function');
 const report={quality:{issues:[]},metrics:[]};const a=api.buildQualityReceipts({},report);
 assert.equal(a.checks[0].status,'pass');assert.equal(a.checks.find(c=>c.id==='visual').status,'unreviewed');
 assert.equal(api.buildQualityReceipts({qualityChecks:{visual:false}},report).checks.find(c=>c.id==='visual').status,'disabled');
 const review={executed:true,status:'pass',contentHash:a.contentHash,ruleVersion:a.ruleVersion,reasons:['已审查'],source:'visual-service'};
 assert.equal(api.buildQualityReceipts({qualityReviews:{visual:review}},report).checks.find(c=>c.id==='visual').status,'pass');
 for(const changed of [{...review,reasons:[]},{...review,executed:false},{...review,ruleVersion:'old'}]) assert.equal(api.buildQualityReceipts({qualityReviews:{visual:changed}},report).checks.find(c=>c.id==='visual').status,'unreviewed');
 assert.equal(api.buildQualityReceipts({qualityReviews:{visual:review}},{...report,title:'changed'}).checks.find(c=>c.id==='visual').status,'unreviewed');
 assert.equal(api.buildQualityReceipts({}, {...report,quality:{issues:['missing date']}}).checks[0].status,'issue');
 assert.equal(api.buildQualityReceipts({}, {...report,qualityReceipts:a}).contentHash,a.contentHash);
});
test('质量决定保留原状态，人工只能处理允许复核的待复核项',()=>{
 assert.equal(typeof api.buildQualityReceipts,'function');
 const report={quality:{issues:[{id:'a',status:'issue',reason:'负金额',source:'payments:2'},{id:'b',status:'unreviewed',reason:'日期歧义',source:'events:3',allowHumanReview:true}]}};
 const before=structuredClone(report);
 const result=api.buildQualityReceipts({qualityDecisions:[{issueId:'a',decision:'accept',reason:'有效退款'},{issueId:'b',decision:'accept',reason:'已核对日期'}]},report);
 assert.deepEqual(report,before);assert.equal(result.decisions[0].applied,false);assert.equal(result.decisions[0].originalStatus,'issue');
 assert.equal(result.decisions[1].applied,true);assert.equal(result.decisions[1].originalStatus,'unreviewed');assert.equal(result.checks[0].status,'issue');
});
