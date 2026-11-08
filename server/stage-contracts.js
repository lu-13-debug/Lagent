import {applyNumericTransform} from './numeric-transforms.js';
import {validatePlan} from './plan.js';
// Server-owned contracts. Skill prose never changes these checks.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), {code:'INVALID_REPORT',modelFailure:true}); };
export const STAGE_FIELDS = Object.freeze({
 quality:{type:'DataProfile',fields:{profile:'object',blockers:'array',capabilities:'array'}},
 plan:{type:'AnalysisPlan',fields:{questions:'array',steps:'array',evidenceRequirements:'array',confirmations:'array'}},
 preprocess:{type:'TransformReceipt',fields:{operations:'array',receipts:'array',needsApproval:'array'}},
 ...Object.fromEntries(['activity','retention','monetization','channel','seasonality'].map(id=>[id,{type:'AnalysisResult',fields:{metrics:'array',limitations:'array'}}])),
 charts:{type:'FigureReceipt',fields:{figures:'array',limitations:'array'}},
 insights:{type:'FindingsLedger',fields:{facts:'array',inferences:'array',hypotheses:'array',recommendations:'array'}},
 report:{type:'ReportDocument',fields:{sections:'array',figureRefs:'array',limitations:'array'}},
 verify:{type:'ReviewReceipt',fields:{approved:'boolean',issues:'array',checks:'array'}},
 pdf:{type:'ExportReceipt',fields:{contentVersion:'string',file:'string',pages:'number',status:'string'}},
});
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,value[key]]));
const scopePolicy='报告 period/reportPeriod 仅为展示范围；指标期间只能取指标自身显式 period。null 表示未确认，不能视为已锁定、推断为全期或据此宣称同口径可比；note 保留原口径说明供进一步确认。';
const metricScope = metric => {
 const unconfirmedFields=['denominator','period'].filter(key=>metric[key]==null);
 return {status:unconfirmedFields.length?'unconfirmed':'confirmed',unconfirmedFields};
};
export function buildAnalysisContract(task={},dataset={},report={}) {
 return {version:1,question:task.goal||'',nonGoals:task.nonGoals||[],excludedStages:[...(task.skippedSteps||[])],datasetId:dataset.id??null,datasetVersion:dataset.version??dataset.id??'unknown',period:report.period??null,reportPeriod:report.period??null,scopePolicy,timezone:report.timezone?.name??null,currency:report.currency??null,metrics:(report.metrics||[]).map(m=>({metricId:m.id,unit:m.unit??null,denominator:m.denominator??null,period:m.period??null,note:m.note??null,scope:metricScope(m)})),budget:task.budget??null};
}
export function buildEvidence(report={},context={}) {
 const version=context.dataset?.version??context.dataset?.id??context.contract?.datasetVersion??'unknown';
 const metrics=(report.metrics||[]).map(m=>({id:`metric:${m.id}`,text:`${m.label||m.id}：${m.value??'无数据'} ${m.unit||''}`,metricId:m.id,value:m.value??null,unit:m.unit??null,denominator:m.denominator??null,period:m.period??null,note:m.note??null,scope:metricScope(m),datasetVersion:version,source:'metrics'}));
 const ids=new Set(metrics.map(m=>m.id));
 const evidence=[...metrics,...(report.facts||[]).filter(f=>f?.id&&!ids.has(f.id)).map(f=>f.source==='numeric-transform' ? pick(f,['id','text','metricId','value','unit','denominator','period','datasetVersion','source','transformName','inputRefs']) : ({ ...pick(f,['id','text']),metricId:null,value:null,unit:null,denominator:null,period:report.period??null,datasetVersion:version,source:'facts'}))];
 for(const request of context.numericTransforms||[]) evidence.push(applyNumericTransform(request,evidence).evidence);
 return evidence;
}
const tableKeys={daily:['date','dau','newUsers','revenue','payers','payingUsers','payments','arpu','arppu'],channels:['name','channel','users','newUsers','revenue','payers','payRate','arppu','d1','payingUsers','retention','share'],retention:['date','users','cohort','cohortDate','cohortSize','day','retained','rate','d1','d3','d7','d14','d30','size'],weekday:['label','index','weekday','day','dau','newUsers','revenue','days','count','averageDau','averageRevenue']};
export function buildContextProjection(report={}) {
 const result=pick(report,['title','period','currency','timezone','methodology','capability']);
 result.scopePolicy=scopePolicy;
 result.metrics=(report.metrics||[]).map(m=>({...pick(m,['id','label','value','unit','note']),denominator:m.denominator??null,period:m.period??null,scope:metricScope(m)}));
 result.quality=pick(report.quality,['rows','score','issues','missingTables','coverage']);
 result.facts=(report.facts||[]).map(f=>pick(f,['id','text','metricId','value','unit','denominator','period','note','scope','datasetVersion','source']));
 result.coverage={};
 for(const [key,keys] of Object.entries(tableKeys)) {
  const rows=Array.isArray(report[key])?report[key]:[]; const limit={daily:90,channels:40,retention:40,weekday:7}[key];
  const supplied=key==='daily'||key==='retention'?rows.slice(-limit):rows.slice(0,limit);
  result[key]=supplied.map(row=>pick(row,keys));
  result.coverage[key]={totalRows:rows.length,providedRows:supplied.length,truncated:rows.length>supplied.length,method:key==='daily'||key==='retention'?'last_rows':'first_rows',scope:rows.length>supplied.length?'仅提供部分聚合行，不能据此声称全量覆盖':'全部聚合行'};
 }
 return result;
}
export function buildStageDeliverable(stageId,result,context={}) {
 const definition=STAGE_FIELDS[stageId]; if(!definition) fail('未知阶段');
 if(stageId==='plan') validatePlan(result,context);
 const contract=context.contract||buildAnalysisContract(context.task,context.dataset,context.report);
 if(['report','insights'].includes(stageId)) validateNarrativeClaims(result,buildEvidence(context.report,{...context,contract}));
 const evidence=buildEvidence(context.report,{...context,contract});
 const numericReceipts=(context.numericTransforms||[]).map(request=>applyNumericTransform(request,evidence).receipt);
 const deliverable={...pick(result,['summary',...Object.keys(definition.fields),...(stageId==='plan'?['planVersion','successCriteria','outOfScope','estimatedCalls']:[])]),version:1,stageId,type:definition.type,contract,evidence,numericReceipts};
 return validateStageDeliverable(stageId,deliverable,context);
}
// Numeric prose is rendered from registered evidence, never validated by a bag
// of numbers. Claims bind all semantic fields, including otherwise equal values.
export function validateNarrativeClaims(result,evidence=[]) {
 const byId=new Map(evidence.map(f=>[f.id,f]));
 const fields=['metricId','value','unit','denominator','period','datasetVersion'];
 const check=(value,inherited=[])=>{
  if(typeof value==='string') {
   if(/\d/.test(value)&&!inherited.some(f=>value===f.text)) fail('数值叙事必须使用已绑定证据原文');
   return;
  }
  if(Array.isArray(value)){value.forEach(item=>check(item,inherited));return;}
  if(!object(value))return;
  const bound=[...inherited];
  for(const claim of value.claims||[]) {
   if(!object(claim)||!Array.isArray(claim.evidenceRefs)||!claim.evidenceRefs.length)fail('叙事claim缺少证据引用');
   for(const id of claim.evidenceRefs) {
    const fact=byId.get(id);if(!fact)fail('叙事claim引用未知证据');
    for(const key of fields)if(!Object.hasOwn(claim,key)||JSON.stringify(claim[key])!==JSON.stringify(fact[key]))fail(`叙事证据口径不匹配：${key}`);
    bound.push(fact);
   }
  }
  for(const [key,item] of Object.entries(value))if(!['claims','evidenceRefs','figureRefs','metricId','datasetVersion','id'].includes(key))check(item,bound);
 };
 check(Object.fromEntries(['claims','summary','findings','recommendations','sections','facts','inferences','hypotheses'].filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]])));
 return true;
}
// Standalone plan validation defaults to game; pass task.domain for other domains.
export function validateStageDeliverable(stageId,value,context={}) {
 const definition=STAGE_FIELDS[stageId];
 if(!definition||!object(value)||value.version!==1||value.stageId!==stageId||value.type!==definition.type) fail('阶段产物类型或版本无效');
 if(typeof value.summary!=='string'||!value.summary.trim()||value.summary.length>12000||!object(value.contract)||!Array.isArray(value.evidence)) fail('阶段产物缺少摘要、合同或证据字段');
 for(const [key,type] of Object.entries(definition.fields)) if(type==='array'?!Array.isArray(value[key]):type==='object'?!object(value[key]):typeof value[key]!==type) fail(`阶段产物缺少或无效字段：${key}`);
 if(stageId==='plan') validatePlan(value,context);
 const evidence=new Map(value.evidence.map(f=>[f.id,f]));
 const visit=node=>{
  if(Array.isArray(node)) {node.forEach(visit);return;} if(!object(node)) return;
  if(node.evidenceRefs!==undefined) {
   if(!Array.isArray(node.evidenceRefs)||!node.evidenceRefs.length) fail('结论缺少证据引用');
   for(const id of node.evidenceRefs) {
    const fact=evidence.get(id); if(!fact) fail('无效证据引用');
    for(const key of ['metricId','value','unit','denominator','period','datasetVersion']) if(Object.hasOwn(node,key)&&JSON.stringify(node[key])!==JSON.stringify(fact[key])) fail(`证据口径不匹配：${key}`);
   }
  }
  Object.values(node).forEach(visit);
 };
 for(const key of Object.keys(definition.fields)) visit(value[key]);
 if(definition.type==='AnalysisResult') for(const m of value.metrics) {
  if(!object(m)||['metricId','value','unit','denominator','period','datasetVersion','evidenceRefs'].some(key=>!Object.hasOwn(m,key))) fail('指标缺少证据或口径字段');
 }
 if(stageId==='verify'&&value.approved&&value.issues.some(i=>typeof i==='string'||i?.severity==='blocking')) fail('存在阻断问题不能通过核验');
 return value;
}
