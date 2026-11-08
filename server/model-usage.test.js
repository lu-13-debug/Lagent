import test from 'node:test';
import assert from 'node:assert/strict';
const m=await import('./model-usage.js').catch(()=>({}));
const now='2026-11-03T16:30:00Z';
const tasks=[{id:'t',status:'completed',workflowSnapshot:{},createdAt:now}];
const entry=(extra={})=>m.modelCallEntry({taskId:'t',stage:{id:'insights',name:'洞察'},kind:'stage',now,call:{provider:'p',model:'m',protocol:'chat-completions',usage:{inputTokens:10,outputTokens:5,totalTokens:15}},...extra});
const summary=(calls,extra={})=>m.summarizeModelUsage({calls,tasks,days:'all',now,...extra});

test('最近任务按最新调用排序而非输入顺序',()=>{
 const s=summary([entry({taskId:'old',now:'2026-11-01T00:00:00Z'}),entry({taskId:'new',now})],{tasks:[{id:'old'},{id:'new'}]});
 assert.deepEqual(s.byTask.map(r=>r.taskId),['new','old']);
});
test('每次调用独立ID并只返回白名单字段',()=>{const a=entry();assert.notEqual(a.id,entry().id);assert.equal(a.stageId,'insights');assert.equal(a.totalTokens,15);assert.equal(a.recordedAt,new Date(now).toISOString());});
test('缺用量调用仅计数',()=>{const s=summary([entry({call:{usage:null}})]);assert.equal(s.totals.missingUsage,1);assert.equal(s.totals.totalTokens,0);});
test('非法Token归null且保留合法零',()=>{const a=entry({call:{usage:{inputTokens:-1,outputTokens:0,totalTokens:1.5,reasoningTokens:Infinity,cacheReadInputTokens:'2'}}});assert.equal(a.inputTokens,null);assert.equal(a.outputTokens,0);assert.equal(a.totalTokens,null);assert.equal(a.reasoningTokens,null);assert.equal(a.cacheReadInputTokens,null);});
test('文本去换行并限长',()=>{const a=entry({call:{provider:'p\r\nx',model:'a'.repeat(300),effort:'hi\n',protocol:'x\r'}});assert.equal(a.provider,'px');assert.equal(a.model.length,200);assert.equal(a.effort,'hi');});
test('评审与裁判分别计一次而不读panelTokens',()=>{const s=summary([entry(),entry({kind:'reviewer',lens:'risk'})],{tasks:[{...tasks[0],panelTokens:99999}]});assert.equal(s.totals.calls,2);assert.equal(s.review.calls,1);assert.equal(s.review.tokens,15);assert.equal(s.totals.totalTokens,30);});
test('上海午夜归不同自然日',()=>{const s=summary([entry({now:'2026-11-03T15:30:00Z'}),entry({now})]);assert.deepEqual(s.byDay.map(r=>r.date),['2026-11-04','2026-11-03']);});
test('7/30/90与all按上海整天过滤',()=>{const calls=[entry(),entry({now:'2026-10-27T16:00:00Z'}),entry({now:'2026-09-20T16:00:00Z'}),entry({now:'2026-01-01T00:00:00Z'})];for(const [days,count] of [[7,1],[30,2],[90,3],['all',4]])assert.equal(summary(calls,{days}).totals.calls,count);});
test('未知task记录不计入',()=>assert.equal(summary([entry({taskId:'other'})]).totals.calls,0));
test('无账本旧单模型从aiUsage回退并注明来源',()=>{const task={id:'old',status:'completed',report:{generatedAt:now,aiUsage:{provider:'p',model:'m',inputTokens:3,outputTokens:2,totalTokens:5}}};assert.equal(m.legacyUsageEntry(task).source,'legacy');assert.equal(summary([],{tasks:[task]}).totals.totalTokens,5);});
test('已有账本不再回退aiUsage，即使账本不在范围内',()=>{const task={id:'t',report:{generatedAt:now,aiUsage:{totalTokens:999}}};assert.equal(summary([entry()],{tasks:[task]}).totals.totalTokens,15);assert.equal(summary([entry({now:'2025-01-01T00:00:00Z'})],{tasks:[task],days:7}).totals.calls,0);});
test('升级前阶段任务不反推产物',()=>{const s=summary([],{tasks:[{...tasks[0],report:{generatedAt:now,aiUsage:{totalTokens:999}},artifacts:{insights:{calls:[{usage:{totalTokens:999}}]}}}]});assert.equal(s.unledgeredTasks,1);assert.equal(s.totals.calls,0);});
test('各分组求和与合计一致且协议独立',()=>{const s=summary([entry(),entry({call:{provider:'p',model:'m',protocol:'anthropic',usage:{inputTokens:8,outputTokens:2,totalTokens:10}}}),entry({call:{usage:null}})]);assert.equal(s.byModel.length,3);for(const key of ['byModel','byStage','byDay','byTask'])for(const field of ['calls','withUsage','missingUsage','inputTokens','outputTokens','totalTokens'])assert.equal(s[key].reduce((n,r)=>n+r[field],0),s.totals[field]);});
test('接口输出不泄漏目标消息报告或额外调用字段',()=>{const s=summary([entry({call:{usage:{inputTokens:1},key:'PRIVATE'}})],{tasks:[{...tasks[0],goal:'GOAL',messages:['MESSAGE'],report:{summary:'BODY'}}]});assert.doesNotMatch(JSON.stringify(s),/PRIVATE|GOAL|MESSAGE|BODY/);});
test('缺失单字段不推算合计且空范围正确',()=>{const a=entry({call:{usage:{inputTokens:5,outputTokens:3}}});assert.equal(a.totalTokens,null);assert.equal(summary([a]).totals.totalTokens,0);assert.equal(summary([]).totals.tasks,0);});
test('total-only usage标记缺失输入输出，非法日期不进入范围',()=>{const s=summary([entry({call:{usage:{totalTokens:15}}}),{...entry(),recordedAt:'invalid'}]);assert.equal(s.totals.calls,1);assert.equal(s.byModel[0].inputMissing,1);assert.equal(s.byModel[0].outputMissing,1);assert.equal(s.byModel[0].withUsage,1);});

test('规划调用计入合计与模型/阶段分组但不伪造任务数',()=>{
 const planner=m.modelCallEntry({taskId:null,stage:{id:'work-plan',name:'任务规划'},kind:'planner',now,call:{provider:'p',model:'m',protocol:'responses',usage:{inputTokens:7,outputTokens:3,totalTokens:10}}});
 const s=summary([entry(),planner]);
 assert.equal(s.totals.calls,2);assert.equal(s.totals.totalTokens,25);assert.equal(s.totals.tasks,1);
 assert.equal(s.byTask.length,1);assert.equal(s.byStage.find(r=>r.stageId==='work-plan').totalTokens,10);
 assert.equal(s.byModel.reduce((n,r)=>n+r.calls,0),2);
});
