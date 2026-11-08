import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('./stage-contracts.js').catch(() => ({}));
const report = { period:'2026-10', metrics:[{id:'revenue',value:12,unit:'元',denominator:'paidUsers'}], daily:Array.from({length:100},(_,i)=>({date:String(i),dau:i,secret:'private'})) };

const planResult=()=>({summary:'核对合法收入证据',questions:[{id:'q1',question:'收入是否有覆盖？',stageIds:['monetization'],metricIds:['revenue'],priority:'must',status:'planned'}],steps:[{id:'s1',stageId:'monetization',purpose:'核对收入覆盖',dependsOn:[],expectedOutput:'收入证据',optional:false}],evidenceRequirements:[{id:'e1',metricId:'revenue',table:'payments',stageId:'monetization',required:true,reason:'收入分析需要支付覆盖'}],confirmations:[{id:'c1',topic:'业务范围',question:'是否核对范围？',blocking:true}],planVersion:2,successCriteria:['指标口径已核对'],outOfScope:['不推断因果'],estimatedCalls:3});
test('plan合同保留可选规划元数据并校验结构化引用',()=>{
 const context={task:{domain:'game'},dataset:{id:'d',records:{payments:[{}]}},report};
 const result=planResult(),built=api.buildStageDeliverable('plan',result,context);
 assert.equal(built.planVersion,2);assert.deepEqual(built.successCriteria,result.successCriteria);assert.deepEqual(built.outOfScope,result.outOfScope);assert.equal(built.estimatedCalls,3);
 assert.doesNotThrow(()=>api.validateStageDeliverable('plan',built));
 const bad=structuredClone(built);bad.questions[0].metricIds=['made-up'];assert.throws(()=>api.validateStageDeliverable('plan',bad),e=>String(e.code).startsWith('PLAN_'));
 const unknown=planResult();unknown.steps[0].stageId='unknown';assert.throws(()=>api.buildStageDeliverable('plan',unknown,context),e=>String(e.code).startsWith('PLAN_'));
});
test('plan旧空数组继续有效，缺字段或错类型仍失败',()=>{
 const empty={summary:'旧计划',questions:[],steps:[],evidenceRequirements:[],confirmations:[]};
 assert.doesNotThrow(()=>api.buildStageDeliverable('plan',empty,{report}));
 for(const key of ['questions','steps','evidenceRequirements','confirmations']) {
  const missing={...empty};delete missing[key];assert.throws(()=>api.buildStageDeliverable('plan',missing,{report}));
  assert.throws(()=>api.buildStageDeliverable('plan',{...empty,[key]:{}},{report}));
 }
});
test('非game计划通过显式context校验业务指标，不改变共享合同结构',()=>{
 const result=planResult();result.questions[0].metricIds=['completion_rate'];result.evidenceRequirements=[];
 const context={task:{domain:'education'},report};
 const built=api.buildStageDeliverable('plan',result,context);
 assert.doesNotThrow(()=>api.validateStageDeliverable('plan',built,context));
 assert.throws(()=>api.validateStageDeliverable('plan',built),e=>e.code==='PLAN_UNKNOWN_METRIC');
 assert.equal(Object.hasOwn(built.contract,'domain'),false);
 assert.equal(built.version,1);
});
test('报告展示期间不能代替末日DAU等指标专属期间，未知口径保持未确认',()=>{
 const production={period:'2026-10-01 至 2026-10-31',metrics:[{id:'dau',value:12,unit:'人',note:'最后完整日活跃用户'}]};
 const fact=api.buildEvidence(production)[0];
 assert.equal(fact.period,null);assert.equal(fact.denominator,null);
 assert.equal(fact.note,'最后完整日活跃用户');
 assert.equal(fact.scope.status,'unconfirmed');assert.deepEqual(fact.scope.unconfirmedFields,['denominator','period']);
 const contract=api.buildAnalysisContract({}, {},production);
 assert.equal(contract.reportPeriod,production.period);assert.equal(contract.metrics[0].period,null);
 assert.match(contract.scopePolicy,/null.*未确认/);
 const explicit={...production,metrics:[{...production.metrics[0],period:'2026-10-31',denominator:'去重活跃用户'}]};
 const known=api.buildEvidence(explicit)[0];assert.equal(known.period,'2026-10-31');assert.equal(known.scope.status,'confirmed');
 assert.equal(api.buildContextProjection(production).metrics[0].scope.status,'unconfirmed');
});
test('证据绑定指标口径与版本，并披露上下文截断',()=>{
 const facts=api.buildEvidence(report,{dataset:{id:'d',version:2}});
 assert.equal(facts[0].datasetVersion,2); assert.equal(facts[0].denominator,'paidUsers');
 const projection=api.buildContextProjection(report);
 assert.equal(projection.coverage.daily.totalRows,100); assert.equal(projection.coverage.daily.providedRows,90);
 assert.equal(projection.coverage.daily.truncated,true); assert.equal(projection.daily[0].secret,undefined);
});
test('阶段结构独立，缺字段及引用错口径被运行时拒绝',()=>{
 const context={report,dataset:{id:'d',version:2},task:{goal:'收入'}};
 const evidence=api.buildEvidence(report,context);
 const metric={...evidence[0],evidenceRefs:[evidence[0].id]};
 const result=api.buildStageDeliverable('monetization',{summary:'收入',metrics:[metric],limitations:[]},context);
 assert.equal(api.validateStageDeliverable('monetization',result),result);
 for(const [key,value] of [['unit','美元'],['period','2025'],['denominator','activeUsers'],['datasetVersion',1]]) {
  const bad=structuredClone(result); bad.metrics[0][key]=value; assert.throws(()=>api.validateStageDeliverable('monetization',bad),/证据|口径/);
 }
 assert.throws(()=>api.buildStageDeliverable('plan',{summary:'计划'},context),/缺少|字段/);
 assert.throws(()=>api.validateStageDeliverable('plan',result),/阶段/);
});
test('所有阶段具有可执行专有字段，失败核验可交给定向修订',()=>{
 for(const [stageId,definition] of Object.entries(api.STAGE_FIELDS)) {
  const result={summary:'已检查',...Object.fromEntries(Object.entries(definition.fields).map(([key,type])=>[key,type==='array'?[]:type==='object'?{}:type==='boolean'?false:type==='number'?1:'output']))};
  const deliverable=api.buildStageDeliverable(stageId,result,{report});
  assert.equal(deliverable.type,definition.type);
  for(const field of Object.keys(definition.fields)) {const missing=structuredClone(deliverable);delete missing[field];assert.throws(()=>api.validateStageDeliverable(stageId,missing),/字段/);}
 }
 const review=api.buildStageDeliverable('verify',{summary:'待修订',approved:false,issues:[{stageId:'report',field:'sections.0',severity:'blocking'}],checks:[]},{report});
 assert.equal(review.approved,false);
 review.approved=true;assert.throws(()=>api.validateStageDeliverable('verify',review),/阻断/);
});
test('合同不包含任务身份或创建时间，证据值与未知引用不能被替换',()=>{
 assert.deepEqual(api.buildAnalysisContract({id:'a',goal:'收入',createdAt:1},{id:'d'},report),api.buildAnalysisContract({id:'b',goal:'收入',createdAt:2},{id:'d'},report));
 const context={dataset:{id:'d'},report};const fact=api.buildEvidence(report,context)[0];
 const result=api.buildStageDeliverable('activity',{summary:'检查',metrics:[{...fact,evidenceRefs:[fact.id]}],limitations:[]},context);
 result.metrics[0].value=99;assert.throws(()=>api.validateStageDeliverable('activity',result),/口径/);
 result.metrics[0].evidenceRefs=['unknown'];assert.throws(()=>api.validateStageDeliverable('activity',result),/证据/);
});

test('strict叙事拒绝同值错单位与错期间，证据口径一致的claims可通过',()=>{
 const context={report,dataset:{id:'d',version:2}};
 const fact=api.buildEvidence(report,context)[0];
 const claim={...fact,evidenceRefs:[fact.id]};
 const base={summary:'已完成分析',sections:[],figureRefs:[],limitations:[],findings:[{title:'收入',detail:'收入12美元',evidence:fact.text,evidenceRefs:[fact.id],claims:[claim]}]};
 assert.throws(()=>api.buildStageDeliverable('report',base,context),/叙事|证据/);
 const good={...base,findings:[{...base.findings[0],detail:fact.text}]};
 assert.doesNotThrow(()=>api.buildStageDeliverable('report',good,context));
 const bad=structuredClone(good);bad.findings[0].claims[0].period='2025';
 assert.throws(()=>api.buildStageDeliverable('report',bad,context),/口径/);
 assert.throws(()=>api.buildStageDeliverable('report',{...base,summary:'收入12美元',findings:[]},context),/叙事|证据/);
});

test('严格叙事可消费服务器重算的命名变换，不能自行伪造新证据',()=>{
 const context={report,dataset:{id:'d',version:2},numericTransforms:[{name:'unit-conversion',inputRefs:['metric:revenue'],parameters:{toUnit:'万元'}}]};
 const facts=api.buildEvidence(report,context);const fact=facts.find(f=>f.source==='numeric-transform');assert.ok(fact);
 const result={summary:'已完成分析',sections:[{text:fact.text,claims:[{...fact,evidenceRefs:[fact.id]}]}],figureRefs:[],limitations:[]};
 const built=api.buildStageDeliverable('report',result,context);assert.equal(built.numericReceipts.length,1);
 assert.doesNotThrow(()=>api.validateStageDeliverable('report',built));
 assert.throws(()=>api.buildStageDeliverable('report',result,{...context,numericTransforms:[]}),/证据/);
 const arbitrary=structuredClone(result);arbitrary.sections[0].text='收入为12万美元';assert.throws(()=>api.buildStageDeliverable('report',arbitrary,context),/叙事/);
});
