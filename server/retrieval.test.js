import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('./retrieval.js').catch(() => ({}));
test('Memory只收同账号confirmed有效启用项，偏好最多三条无词法命中仍保留',()=>{
 const base={ownerId:'a',enabled:true,status:'confirmed',expiresAt:'2099-01-01',type:'preference',scope:'user',key:'表达',value:'简洁'};
 const memory=[...Array.from({length:5},(_,i)=>({...base,id:String(i)})),{...base,id:'foreign',ownerId:'b'},{...base,id:'expired',expiresAt:'2020-01-01'},{...base,id:'disabled',enabled:false},{...base,id:'candidate',status:'candidate'}];
 const corpus=api.buildRetrievalCorpus({metrics:[],memory,ownerId:'a'});assert.equal(corpus.length,5);
 const result=api.retrieveDocuments({corpus,query:'unrelated',stageId:'activity'});assert.equal(result.length,3);assert.ok(result.every(d=>d.kind==='memory'));
 assert.ok(!JSON.stringify(result).includes('evidenceRefs'));
});
test('NFKC英文和中文二元分词、去重与预算、无命中',()=>{
 assert.deepEqual(api.tokenize('ＡＢＣ 留存'),['abc','留存']);
 const doc={id:'a',kind:'task',sourceId:'a',text:'留存分析'.repeat(100),stageIds:[],tags:[],metricIds:[],authority:'historical'};
 const result=api.retrieveDocuments({corpus:[doc,doc,{...doc,id:'b'}],query:'留存',limit:1,maxChars:9});
 assert.equal(result.length,1);assert.equal(result[0].id,'a');assert.equal(result[0].text.length,9);
 assert.deepEqual(api.retrieveDocuments({corpus:[doc],query:'xyz'}),[]);
});
test('字段目录仅含白名单与类型，历史按日期限制，查询不读正文',()=>{
 const tasks=['2026-11-01','2026-11-04'].map((updatedAt,i)=>({id:String(i),domain:'game',status:'completed',updatedAt,title:'历史',report:{summary:'x'.repeat(500),findings:Array.from({length:5},()=>({title:'观察'}))}}));
 const corpus=api.buildRetrievalCorpus({tasks,domain:'game',limit:1,dataset:{records:{payments:[{amount:3,user_id:'secret',order_id:'secret',private:'secret'}]}}});
 assert.equal(corpus.find(d=>d.kind==='task').sourceId,'1');assert.match(corpus.find(d=>d.kind==='field').text,/amount:number/);assert.doesNotMatch(JSON.stringify(corpus),/secret|order_id/);
 const query=api.retrievalQuery({task:{goal:'留存'},stage:{id:'retention'},plan:{questions:[]},report:{summary:'PRIVATE-BODY',sections:['PRIVATE-BODY']}});
 assert.equal(query.mode,'lexical');assert.doesNotMatch(JSON.stringify(query),/PRIVATE-BODY/);
});
test('检索语料排除当前任务、其他领域和失败任务，不收入正文或原始行', () => {
 const task = {id:'old',domain:'game',status:'completed',title:'留存核对',goal:'核对留存',report:{summary:'成熟队列覆盖',sections:[{text:'PRIVATE-BODY'}]},updatedAt:'2026-11-04'};
 const corpus = api.buildRetrievalCorpus({tasks:[task,{...task,id:'current'},{...task,id:'other',domain:'education'},{...task,id:'failed',status:'failed'}],dataset:{id:'dataset',currentTaskId:'current',records:{users:[{user_id:'PRIVATE-ID'}]}},domain:'game',currentTaskId:'current'});
 assert.deepEqual(corpus.filter(doc=>doc.kind==='task').map(doc=>doc.sourceId),['old']);
 assert.doesNotMatch(JSON.stringify(corpus),/PRIVATE-BODY|PRIVATE-ID/);
});
test('计划明确引用的指标不因没有词法匹配而丢失，且字符预算有界', () => {
 const corpus=[{id:'metric:dau',kind:'metric',sourceId:'dau',text:'每日活跃口径',stageIds:['activity'],metricIds:['dau'],tags:[],authority:'authoritative'}];
 const query=api.retrievalQuery({task:{goal:''},stage:{id:'activity'},plan:{questions:[{question:'检查覆盖',metricIds:['dau']}]},report:{}});
 const docs=api.retrieveDocuments({corpus,query,stageId:'activity',maxChars:20});
 assert.equal(docs[0].id,'metric:dau');assert.ok(docs.reduce((n,d)=>n+d.text.length,0)<=20);
 assert.deepEqual(api.retrieveDocuments({corpus,query:'完全无关资料',stageId:'retention'}),[]);
});
