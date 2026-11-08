import test from 'node:test';
import assert from 'node:assert/strict';
const p=await import('./insight-panel.js').catch(()=>({}));
const finding=(title,refs)=>({title,detail:'观察',evidenceRefs:refs});

test('无成功评审不将裁判结论当成分歧',()=>{
 const result=p.summarizePanel({reviewers:[{status:'failed'}],judge:{findings:[finding('正常结论',['a'])]},validRefs:['a']});
 assert.deepEqual(result.agreements,[]);assert.deepEqual(result.judgeOnly,[]);assert.deepEqual(result.reviewerOnly,[]);
 assert.match(result.summary,/评审不可用/);
});
test('空白或非字符串标题丢弃，归一后空标题不能虚增匹配',()=>{
 const invalid=['','  ',null,42].map(t=>finding(t,['a']));
 const reviewers=[{status:'completed',lens:'growth',result:{findings:invalid}}];
 assert.deepEqual(p.panelPrevious({reviewers},['a'])['panel:growth'].deliverable.findings,[]);
 const result=p.summarizePanel({reviewers:[{status:'completed',result:{findings:[finding('!!!',['a'])]}}],judge:{findings:[finding('???',['b'])]},validRefs:['a','b']});
 assert.equal(result.agreements.length,0);
 const overlap=p.summarizePanel({reviewers:[{status:'completed',result:{findings:[finding('!!!',['a'])]}}],judge:{findings:[finding('???',['a'])]},validRefs:['a']});
 assert.equal(overlap.agreements.length,1);
});
test('异常评审结构不能使摘要或裁判上下文崩溃',()=>{
 for(const findings of [[null,'text',12,{}, {evidenceRefs:{}}, {evidenceRefs:['a']}], {}, 'text', null]) {
  const reviewers=[{status:'completed',lens:'growth',result:{findings,recommendations:{}}}];
  assert.doesNotThrow(()=>p.summarizePanel({reviewers,judge:{findings:[]},validRefs:['a']}));
  assert.doesNotThrow(()=>p.panelPrevious({reviewers},['a']));
 }
});
test('视角和指令禁止工具',()=>{assert.equal(p.PANEL_LENSES.length,3);assert.match(p.panelInstruction('基础',p.PANEL_LENSES[0]),/不得调用工具/);});
test('合法引用交集和归一标题匹配，共识与分歧独立输出',()=>{
 const result=p.summarizePanel({judge:{findings:[finding('收入变化',['a']),finding('裁判独有',['b'])]},reviewers:[{status:'completed',result:{findings:[finding('收入 变化',['c']),finding('评审独有',['d']),finding('非法',['bad'])]}},{status:'completed',result:{findings:[finding('不同标题',['a'])]}}],validRefs:new Set(['a','b','c','d'])});
 assert.equal(result.agreements[0].support,3);assert.equal(result.agreements[0].consensus,'unanimous');assert.equal(result.judgeOnly.length,1);assert.equal(result.reviewerOnly.length,1);
});
test('并行编排失败降级与全部失败标记',async()=>{let started=0;const result=await p.runInsightPanel({reviewers:[{},{}],runReviewer:async(_,i)=>{started++;await new Promise(r=>setTimeout(r,5));if(i===0)throw Error('secret');return {summary:'完成',findings:[]};}});assert.equal(started,2);assert.equal(result.degraded,true);assert.equal(result.allFailed,false);const all=await p.runInsightPanel({reviewers:[{}],runReviewer:async()=>{throw Error('bad');}});assert.equal(all.allFailed,true);});
test('Abort不能降级吞掉',async()=>{await assert.rejects(p.runInsightPanel({reviewers:[{}],runReviewer:async()=>{throw new DOMException('停止','AbortError');}}),{name:'AbortError'});});
test('多数支持与裁判独有分级、无效引用不得进入裁判摘要',()=>{
 const result=p.summarizePanel({judge:{findings:[finding('支持',['a']),finding('独有',['b'])]},reviewers:[{status:'completed',result:{findings:[finding('同证据',['a'])]}},{status:'completed',result:{findings:[]}},{status:'completed',result:{findings:[]}}],validRefs:['a','b']});
 assert.equal(result.agreements[0].consensus,'single');
 const majority=p.summarizePanel({judge:{findings:[finding('支持',['a'])]},reviewers:[{status:'completed',result:{findings:[finding('同证据',['a'])]}},{status:'completed',result:{findings:[]}}],validRefs:['a']});assert.equal(majority.agreements[0].consensus,'majority');
 const previous=p.panelPrevious({reviewers:[{status:'completed',lens:'growth',result:{summary:'短摘要',findings:[finding('非法',['secret'])],recommendations:['复核'],numericTransforms:[{evidence:{id:'secret'}}]}}]},['a']);assert.deepEqual(previous['panel:growth'].deliverable.findings,[]);assert.equal(JSON.stringify(previous).includes('numericTransforms'),false);
});
