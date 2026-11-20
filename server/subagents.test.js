import test from 'node:test';import assert from 'node:assert/strict';
const api=await import('./subagents.js').catch(()=>({}));
const profiles=[{id:'judge'},{id:'reader'}];const row={id:'growth',profileId:'reader',name:'增长',role:'核查增长证据'};
test('角色Skill与effort独立校验，缺省不写入新字段',()=>{
 const context={stageId:'insights',profiles:[{id:'reader',capabilities:{efforts:['default','low']}}],skills:[{id:'s',stageId:'insights',enabled:true}],effort:'default'};
 assert.equal(api.validateSubagents([{...row,skillId:'s',effort:'low'}],context)[0].effort,'low');
 for(const patch of [{skillId:'missing'},{effort:'high'}])assert.throws(()=>api.validateSubagents([{...row,...patch}],context));
 assert.equal(Object.hasOwn(api.validateSubagents([row],context)[0],'skillId'),false);
});
test('子智能体仅允许指定阶段且保持旧配置缺失',()=>{
 assert.equal(api.validateSubagents(undefined,{stageId:'insights',profiles,judgeId:'judge'}),undefined);
 assert.deepEqual(api.validateSubagents([row],{stageId:'insights',profiles,judgeId:'judge'}),[row]);
 for(const [rows,stageId] of [[[row],'activity'],[[row,row],'insights'],[[{...row,profileId:'judge'}],'report'],[[{...row,maxTokens:1}],'report'],[[{...row,subagents:[]}],'report']])assert.throws(()=>api.validateSubagents(rows,{stageId,profiles,judgeId:'judge'}));
});
test('委派输出只保留合法证据与摘要，原始提示和思维链不可透传',()=>{
 const result=api.projectSubagentResult({summary:'已核查',findings:[{title:'可用',evidenceRefs:['a']},{title:'无效',evidenceRefs:['secret']}],recommendations:['复核'],thinking:'PRIVATE'},new Set(['a']));
 assert.equal(result.findings.length,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret/);
});
test('团队角色 allowedTools 只接受受控工具且可显式收窄',()=>{
 const context={stageId:'insights',profiles,judgeId:'judge'};
 assert.deepEqual(api.validateSubagents([{...row,allowedTools:['chart','clean']}],context)[0].allowedTools,['chart','clean']);
 assert.deepEqual(api.validateSubagents([{...row,allowedTools:[]}],context)[0].allowedTools,[]);
 for(const allowedTools of [['shell'],['chart','chart'],'chart'])assert.throws(()=>api.validateSubagents([{...row,allowedTools}],context),/工具权限/);
});
test('子智能体三段式回传：结论、证据指针、trace 与失败原因',()=>{
 const ok=api.projectSubagentResult({summary:'已核查',findings:[{title:'可用',detail:'a=1',evidenceRefs:['a']}],recommendations:['复核']},new Set(['a']),{trace:{taskId:'t1',stageId:'insights',calls:3}});
 assert.equal(ok.summary,'已核查');
 assert.deepEqual(ok.findings[0].evidenceRefs,['a']);
 assert.deepEqual(ok.trace,{taskId:'t1',stageId:'insights',kind:'subagent',calls:3,log:'model-call'});
 const failed=api.projectSubagentResult({summary:'不可用',findings:[],recommendations:[],failure:{code:'SUBAGENT_FAILED',reason:'子智能体执行失败，主阶段继续'}},new Set());
 assert.deepEqual(failed.failure,{code:'SUBAGENT_FAILED',reason:'子智能体执行失败，主阶段继续'});
 assert.equal(failed.trace,undefined);
});
