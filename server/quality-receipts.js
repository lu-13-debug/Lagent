import {reportContentHash} from './report-version.js';
export const QUALITY_RULE_VERSION='quality-1';
export function qualityContentHash(report={}) {
 return reportContentHash(report);
}
export function buildQualityReceipts(task={},report={}) {
 const contentHash=qualityContentHash(report),ruleVersion=QUALITY_RULE_VERSION;
 const issues=(report.quality?.issues||[]).map((issue,index)=>typeof issue==='string'?{id:`issue:${index}`,status:'issue',reason:issue,source:`quality.issues.${index}`}:{...issue,id:issue.id??`issue:${index}`,status:issue.status??'issue',source:issue.source??`quality.issues.${index}`});
 const decisions=(task.qualityDecisions||[]).map(d=>{
  const issue=issues.find(i=>i.id===d.issueId);
  const applied=Boolean(issue?.status==='unreviewed'&&issue.allowHumanReview===true&&['accept','reject'].includes(d.decision)&&typeof d.reason==='string'&&d.reason.trim());
  return {...d,originalStatus:issue?.status??null,source:issue?.source??null,ruleVersion,contentHash,applied,reason:typeof d.reason==='string'?d.reason:'',resultStatus:applied?(d.decision==='reject'?'issue':'accepted-for-review'):issue?.status??'unreviewed'};
 });
 const entry=(id,status,reasons,source)=>({id,status,reasons,source,contentHash,ruleVersion});
 const data=entry('data-quality',!report.quality||!Array.isArray(report.quality.issues)?'unreviewed':issues.length?'issue':'pass',issues.length?issues.map(i=>i.reason??i.message??String(i.id)):['按已生成的数据质量结果登记'], 'report.quality.issues');
 const external=['narrative','visual'].map(id=>{
  if(task.qualityChecks?.[id]===false)return entry(id,'disabled',['此检查被明确禁用'],`task.qualityChecks.${id}`);
  const review=task.qualityReviews?.[id];
  const valid=review?.executed===true&&review.contentHash===contentHash&&review.ruleVersion===ruleVersion&&['pass','issue'].includes(review.status)&&Array.isArray(review.reasons)&&review.reasons.some(r=>typeof r==='string'&&r.trim())&&typeof review.source==='string'&&review.source.trim();
  return valid?entry(id,review.status,[...review.reasons],review.source):entry(id,'unreviewed',['没有与当前内容及规则版本匹配的已执行审查'],`task.qualityReviews.${id}`);
 });
 return {contentHash,ruleVersion,checks:[data,...external],issues,decisions};
}
