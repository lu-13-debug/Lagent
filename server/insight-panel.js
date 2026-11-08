export const PANEL_LENSES = [
  {id:'growth',name:'增长',focus:'活跃、新增、留存、渠道与体验'},
  {id:'revenue',name:'收益',focus:'收入、付费、客单与渠道收益质量'},
  {id:'risk',name:'风险',focus:'口径、覆盖、异常、混杂与反证'},
];
const list=value=>Array.isArray(value)?value:[];
const clip=(value,max=1200)=>typeof value==='string'?value.slice(0,max):'';
export function panelInstruction(baseSkill,lens){return `${baseSkill}\n评审视角：${lens.name}（${lens.focus}）。不得调用工具，只能使用已提供的事实与证据；输出仍满足阶段 JSON 合同，结论携带合法 evidenceRefs。`;}
const titleKey=value=>clip(value,200).normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu,'');
const cleanFindings=(result,validRefs)=>list(result?.findings).filter(f=>f&&typeof f==='object'&&!Array.isArray(f)&&typeof f.title==='string'&&f.title.trim().length>0&&Array.isArray(f.evidenceRefs)&&f.evidenceRefs.length&&f.evidenceRefs.every(ref=>validRefs.has(ref))).slice(0,12).map(f=>({title:clip(f.title.trim(),200),detail:clip(f.detail,1200),evidence:clip(f.evidence,1200),severity:['positive','warning','neutral'].includes(f.severity)?f.severity:'neutral',evidenceRefs:[...new Set(f.evidenceRefs)].slice(0,30)}));
const matches=(a,b)=>(!!titleKey(a.title)&&titleKey(a.title)===titleKey(b.title))||a.evidenceRefs.some(ref=>b.evidenceRefs.includes(ref));
export function summarizePanel({reviewers,judge,validRefs}){
 const refs=validRefs instanceof Set?validRefs:new Set(validRefs);const valid=reviewers.filter(r=>r.status==='completed').map(r=>cleanFindings(r.result,refs));const findings=cleanFindings(judge,refs);const agreements=[],judgeOnly=[],reviewerOnly=[];
 if(!valid.length)return {agreements,judgeOnly,reviewerOnly,summary:'评审不可用，已按单模型完成'};
 for(const f of findings){const support=1+valid.filter(rows=>rows.some(r=>matches(f,r))).length;const item={title:f.title,evidenceRefs:f.evidenceRefs,support,consensus:support===valid.length+1&&support>1?'unanimous':support>(valid.length+1)/2&&support>1?'majority':'single'};if(support>1)agreements.push(item);else judgeOnly.push(item);}
 for(const rows of valid)for(const f of rows)if(!findings.some(r=>matches(f,r))&&!reviewerOnly.some(r=>matches(f,r)))reviewerOnly.push(f);
 return {agreements,judgeOnly,reviewerOnly,summary:`共识 ${agreements.length} 条；裁判独有 ${judgeOnly.length} 条；评审独有 ${reviewerOnly.length} 条。`};
}
export async function runInsightPanel({reviewers,runReviewer}){
 const settled=await Promise.allSettled(reviewers.map((reviewer,index)=>Promise.resolve().then(()=>runReviewer(reviewer,index))));
 const abort=settled.find(r=>r.status==='rejected'&&r.reason?.name==='AbortError');if(abort)throw abort.reason;
 const results=settled.map((r,index)=>({lens:PANEL_LENSES[index].id,lensName:PANEL_LENSES[index].name,model:reviewers[index].model,status:r.status==='fulfilled'?'completed':'failed',...(r.status==='fulfilled'?{result:r.value,summary:clip(r.value?.summary)}:{error:'评审调用失败，已降级继续。'})}));
 return {reviewers:results,allFailed:results.every(r=>r.status==='failed'),degraded:results.some(r=>r.status==='failed')};
}
export function panelPrevious(panel,validRefs){const refs=new Set(validRefs);return Object.fromEntries(panel.reviewers.filter(r=>r.status==='completed').map(r=>[`panel:${r.lens}`,{summary:clip(r.result?.summary,600),deliverable:{kind:'PanelReview',lens:r.lens,summary:clip(r.result?.summary,600),findings:cleanFindings(r.result,refs).slice(0,6),recommendations:list(r.result?.recommendations).filter(x=>typeof x==='string').slice(0,6).map(x=>clip(x,400))}}]));}
