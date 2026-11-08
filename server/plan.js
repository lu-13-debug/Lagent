import { STAGE_DEFINITIONS } from './stage-definitions.js';
import { ANALYSIS_TOOL_NAMES } from './analysis-tools.js';
import { getMetricCatalog } from './metric-catalog.js';

const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const schemas={questions:['id','question','stageIds','metricIds','priority','status'],steps:['id','stageId','purpose','dependsOn','expectedOutput','optional'],evidenceRequirements:['id','metricId','table','stageId','required','reason'],confirmations:['id','topic','question','blocking']};
const limits={questions:8,steps:12,evidenceRequirements:20,confirmations:8};
const fail=(code,path,message)=>{throw Object.assign(new Error(message),{code,planValidationErrors:[{code,path,message}]});};
const string=(v,path,max=300)=>{if(typeof v!=='string'||!v.trim())fail('PLAN_INVALID_TYPE',path,'计划文本字段须为非空文本');if([...v].length>max)fail('PLAN_LIMIT',path,'计划文本超过长度上限');};
const boolean=(v,path)=>{if(typeof v!=='boolean')fail('PLAN_INVALID_TYPE',path,'计划布尔字段无效');};
const strings=(v,path,max=30,textMax=100)=>{if(!Array.isArray(v))fail('PLAN_INVALID_TYPE',path,'计划引用字段须为数组');if(v.length>max)fail('PLAN_LIMIT',path,'计划引用数量超过上限');for(const x of v)string(x,path,textMax);};

export function validatePlan(plan,{task={},dataset}={}) {
 if(!object(plan))fail('PLAN_INVALID_TYPE','plan','计划须为对象');
 for(const key of ['tool','actions'])if(Object.hasOwn(plan,key))fail('PLAN_UNKNOWN_FIELD',key,'计划包含未注册的执行字段');
 const knownTools=new Set([...ANALYSIS_TOOL_NAMES,'numeric-transform']);
 for(const key of ['tools','operations'])if(plan[key]!==undefined){
  if(!Array.isArray(plan[key]))fail('PLAN_INVALID_TYPE',key,'计划工具元数据须为数组');
  for(const entry of plan[key])if(!knownTools.has(key==='tools'?entry?.name:entry?.tool))fail('PLAN_UNKNOWN_TOOL',key,'计划引用未注册工具');
 }
 const stages=new Set(STAGE_DEFINITIONS.map(([id])=>id));
 const metrics=new Map(getMetricCatalog(task.domain||'game').map(m=>[m.id,m]));
 const stage=(v,path)=>{if(!stages.has(v))fail('PLAN_UNKNOWN_STAGE',path,'计划引用未知阶段');};
 const metric=(v,path)=>{if(!metrics.has(v))fail('PLAN_UNKNOWN_METRIC',path,'计划引用未知指标');};
 for(const [key,fields] of Object.entries(schemas)) {
  if(!Array.isArray(plan[key]))fail('PLAN_INVALID_TYPE',key,'计划四个结构字段必须为数组');
  if(plan[key].length>limits[key])fail('PLAN_LIMIT',key,'计划条目超过数量上限');
  const ids=new Set();
  for(const [index,row] of plan[key].entries()) {
   const path=`${key}[${index}]`;
   if(!object(row))fail('PLAN_INVALID_TYPE',path,'计划条目须为对象');
   if(Object.keys(row).some(k=>!fields.includes(k)))fail('PLAN_UNKNOWN_FIELD',path,'计划条目包含未注册字段');
   string(row.id,`${path}.id`,100);if(ids.has(row.id))fail('PLAN_DUPLICATE_ID',path,'计划条目ID重复');ids.add(row.id);
   if(key==='questions') {
    string(row.question,path);strings(row.stageIds,path);strings(row.metricIds,path);
    row.stageIds.forEach(v=>stage(v,path));row.metricIds.forEach(v=>metric(v,path));
    if(!['must','should','optional'].includes(row.priority)||!['planned','skipped','blocked'].includes(row.status))fail('PLAN_INVALID_ENUM',path,'计划问题优先级或状态无效');
   } else if(key==='steps') {
    stage(row.stageId,path);string(row.purpose,path);string(row.expectedOutput,path);strings(row.dependsOn,path,12);boolean(row.optional,path);
   } else if(key==='evidenceRequirements') {
    stage(row.stageId,path);if(row.metricId!==undefined)metric(row.metricId,path);
    if(row.table!==undefined&&!['users','activity','payments'].includes(row.table))fail('PLAN_UNKNOWN_TABLE',path,'计划引用未知数据表');
    boolean(row.required,path);string(row.reason,path);
   } else {string(row.topic,path,100);string(row.question,path);boolean(row.blocking,path);}
  }
 }
 const steps=new Map(plan.steps.map(s=>[s.id,s]));const active=new Set(),done=new Set();
 const visit=id=>{if(active.has(id))fail('PLAN_DEPENDENCY_CYCLE','steps','计划步骤依赖存在环');if(done.has(id))return;active.add(id);for(const dep of steps.get(id).dependsOn){if(!steps.has(dep))fail('PLAN_UNKNOWN_DEPENDENCY','steps','计划依赖引用不存在的步骤');visit(dep);}active.delete(id);done.add(id);};
 for(const id of steps.keys())visit(id);
 for(const key of ['planVersion','estimatedCalls'])if(plan[key]!==undefined&&(!Number.isSafeInteger(plan[key])||plan[key]<(key==='planVersion'?1:0)))fail('PLAN_INVALID_METADATA',key,'计划版本或调用估计无效');
 for(const key of ['successCriteria','outOfScope'])if(plan[key]!==undefined){strings(plan[key],key,12,300);for(const value of plan[key])string(value,key,300);}
 const blocked=[];
 for(const q of plan.questions.filter(q=>q.priority==='must')) {
  const tables=new Set(q.metricIds.flatMap(id=>metrics.get(id)?.source?.tables||[]));
  for(const e of plan.evidenceRequirements.filter(e=>e.required&&q.stageIds.includes(e.stageId)))if(e.table)tables.add(e.table);
  const missing=dataset&&[...tables].some(table=>!dataset.records?.[table]?.length);
  const skipped=q.stageIds.some(id=>task.skippedSteps?.includes(id));
  if(q.status==='blocked'||q.status==='skipped'||missing||skipped)blocked.push({id:q.id,reason:missing?'必需问题缺少必要数据，须确认可执行范围':skipped?'必需问题对应用户已排除阶段，须确认范围':'必需问题被计划标为不可执行，须确认原因'});
 }
 return {status:plan.planVersion===undefined?'legacy':'verified',errors:[],blocked};
}

export function planForStage(plan,stageId) {
 if(!plan)return undefined;
 const result={questions:(plan.questions||[]).filter(q=>q.stageIds?.includes(stageId)),steps:(plan.steps||[]).filter(s=>s.stageId===stageId),evidenceRequirements:(plan.evidenceRequirements||[]).filter(e=>e.stageId===stageId),confirmations:plan.confirmations||[]};
 for(const key of ['successCriteria','outOfScope'])if(plan[key]!==undefined)result[key]=plan[key];
 return structuredClone(result);
}
