import {validatePlan} from './plan.js';
const verdict=issues=>({verdict:issues.some(i=>i.severity==='blocking')?'reject':issues.some(i=>i.severity==='warning')?'revise':'pass',issues,rubricVersion:'critic-1'});
const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
const issue=(code,severity,message,fix,evidenceRefs=[])=>({code,severity,message,fix,evidenceRefs});
export function critiquePlanUnsafe(plan,context={}){
 if(!plan)return {verdict:'unreviewed',issues:[],rubricVersion:'critic-1'};
 const issues=[];try{const validation=validatePlan(plan,context);for(const b of validation.blocked)issues.push(issue('CRITIC_PLAN_BLOCKED','blocking',b.reason,'补齐必要数据或明确确认分析范围'));}catch{issues.push(issue('CRITIC_PLAN_INVALID','blocking','计划结构或引用无效','修正计划合同'));}
 for(const e of plan.evidenceRequirements||[])if(e.required&&e.table&&!context.dataset?.records?.[e.table]?.length)issues.push(issue('CRITIC_PLAN_EVIDENCE','blocking','计划必需证据缺失','补齐必要来源或确认限制'));
 if((plan.steps||[]).some(s=>context.task?.skippedSteps?.includes(s.stageId)))issues.push(issue('CRITIC_PLAN_SKIPPED','warning','计划引用已排除阶段','核对计划与用户范围'));
 if((plan.confirmations||[]).some(c=>c.blocking)&&!context.task?._approved?.includes('plan'))issues.push(issue('CRITIC_CONFIRMATION','blocking','计划仍有待处理的必要确认','通过协作审批明确确认'));
 return verdict(issues);
}
export function critiqueResultUnsafe(report,{task={},facts=report?.facts||[]}={}){
 if(!report)return {verdict:'unreviewed',issues:[],rubricVersion:'critic-1'};
 const issues=[],refs=new Set(facts.map(f=>f.id)),titles=new Set(),metrics=new Map();
 for(const f of report.findings||[]){if(f.unverified===true||(f.evidenceRefs!==undefined&&(!Array.isArray(f.evidenceRefs)||!f.evidenceRefs.length||f.evidenceRefs.some(id=>!refs.has(id)))))issues.push(issue('CRITIC_EVIDENCE','blocking','发现缺少有效证据引用','引用当前已登记证据'));
 const title=String(f.title||'').normalize('NFKC').replace(/\s/g,'');if(title&&titles.has(title))issues.push(issue('CRITIC_DUPLICATE','warning','存在重复发现','合并重复结论'));titles.add(title);}
 const visit=node=>{if(!node||typeof node!=='object')return;if(node.metricId&&Object.hasOwn(node,'value')){const key=node.metricId,signature=JSON.stringify(stable([node.value,node.unit,node.period]));if(metrics.has(key)&&metrics.get(key)!==signature)issues.push(issue('CRITIC_METRIC_CONFLICT','blocking','同一指标存在值或口径冲突','核对指标值、单位与期间'));metrics.set(key,signature);}for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(visit):visit(value);};
 visit({metrics:(report.metrics||[]).map(m=>({...m,metricId:m.metricId||m.id})),findings:report.findings,sections:report.sections});
 const directions=new Map();
 // Only numeric changes with explicit comparison windows establish a direction.
 for(const f of report.findings||[])for(const claim of f.claims||[]){
  if(!claim.metricId||!claim.period||!claim.comparisonPeriod||!Number.isFinite(claim.change)||claim.change===0)continue;
  const key=JSON.stringify(stable([claim.metricId,claim.period,claim.comparisonPeriod,claim.unit,claim.denominator]));const direction=Math.sign(claim.change);
  if(directions.has(key)&&directions.get(key)!==direction)issues.push(issue('CRITIC_DIRECTION_CONFLICT','blocking','同一指标和比较期间存在相反数值方向','核对变化值与比较期间，移除矛盾断言'));
  directions.set(key,direction);
 }
 if((task.skippedSteps?.length||Object.values(report.coverage||{}).some(c=>c?.truncated))&&!report.limitations?.length)issues.push(issue('CRITIC_COVERAGE','warning','未披露覆盖或排除范围限制','在limitations说明范围与截断'));
 const charts=new Set((report.charts||[]).map(c=>c.id));if((report.figureRefs||[]).some(id=>!charts.has(id)))issues.push(issue('CRITIC_FIGURE','blocking','图表引用无效','仅引用当前报告图表'));
 if((report.recommendations||[]).some(r=>typeof r!=='string'||!r.trim()||/^(建议|待补充|无)$/.test(r.trim())))issues.push(issue('CRITIC_RECOMMENDATION','warning','建议缺少可执行内容','补充有证据对应的行动'));
 return verdict(issues);
}
const unreviewed=()=>({verdict:'unreviewed',issues:[issue('CRITIC_UNREVIEWED','warning','确定性评审无法完成','检查产物结构后重新核验')],rubricVersion:'critic-1'});
export function critiqueResult(report,context){try{return critiqueResultUnsafe(report,context);}catch{return unreviewed();}}
export function critiquePlan(plan,context){try{return critiquePlanUnsafe(plan,context);}catch{return unreviewed();}}
