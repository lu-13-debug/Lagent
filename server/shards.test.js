import test from 'node:test';
import assert from 'node:assert/strict';
process.env.LAGENT_ENABLE_MULTI_SHARD = '1';
const { parseFiles } = await import('./datasets.js');
const csv = (name, text) => ({ originalname:name, buffer:Buffer.from(text) });
test('four CSV shards preserve raw activity rows, provenance, overlaps and unknown columns', async () => {
 const d=await parseFiles(Array.from({length:4},(_,i)=>csv(`activity-${i}.csv`,`properties/user_id,properties.event_time,properties.level\na,2026-10-01,3\n`)));
 assert.equal(d.shardManifest.length,4); assert.equal(d.rowCount,4); assert.equal(d.records.activity.length,4);
 assert.equal(d.shardManifest[1].overlaps.length,1); assert.ok(d.warnings.some(x=>x.includes('重叠')));
 assert.equal(d.inspection.unrecognizedColumns[0].column,'properties.level');
 assert.equal(d.rowSources.activity[3].source,'activity-3.csv');
});
test('gaps, schema mismatch and parquet conversion instructions are actionable',async()=>{
 const d=await parseFiles([csv('activity-a.csv','user_id,event_time\na,2026-10-01'),csv('activity-b.csv','user_id,event_time\nb,2026-10-04')]);
 assert.ok(d.warnings.some(x=>x.includes('缺口')));
 await assert.rejects(parseFiles([csv('activity-a.csv','user_id,event_time\na,2026-10-01'),csv('activity-b.csv','user_id,event_time,extra\nb,2026-10-04,x')]),/结构不一致/);
 await assert.rejects(parseFiles([csv('a.parquet','x')]),/node scripts\/convert-parquet.mjs/);
});

test('extra fields are metadata only and do not enter aggregates or AI facts',async()=>{
 const {analyze}=await import('./analytics.js'); const {enhanceReport}=await import('./gateway.js');
 const d=await parseFiles([csv('activity.csv','properties/user_id,properties/event_time,properties.level\na,2026-10-01,private-level-value')]);
 const extra=d.inspection.unrecognizedColumns[0];assert.equal(extra.status,'identified_unused');assert.match(extra.reason,/未参与计算/);
 assert.equal(JSON.stringify(d.records).includes('private-level-value'),false);
 const report=analyze(d,{now:'2026-10-30T00:00:00Z'});assert.equal(JSON.stringify(report).includes('properties.level'),false);
 let sent;
 await enhanceReport(report,{id:'test-extra',datasetName:d.name,goal:'检查活跃',messages:[]},{settings:{baseUrl:'https://api.deepseek.com',model:'mock'},key:'mock-key',fetchImpl:async(_url,init)=>{sent=init.body;return Response.json({choices:[{message:{content:JSON.stringify({summary:'仅分析活跃。',findings:[],recommendations:[]})}}]});}});
 assert.equal(sent.includes('private-level-value'),false);assert.equal(sent.includes('properties.level'),false);
});
