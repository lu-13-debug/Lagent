import test from 'node:test';
import assert from 'node:assert/strict';
const m=await import('./agent-tools.js').catch(()=>({}));

test('数值变换缺参数可修复，非法或额外参数立即拒绝',()=>{
 const stage={id:'insights',skill:{allowedTools:[]}};
 assert.throws(()=>m.validateAgentAction({tool:'numeric-transform',input:{}},stage),{code:'ANALYSIS_TOOL_MISSING_PARAMETER'});
 assert.throws(()=>m.validateAgentAction({tool:'numeric-transform',input:{name:'round',inputRefs:['a'],parameters:{digits:2},path:'private'}},stage),{code:'ANALYSIS_TOOL_INVALID'});
 assert.throws(()=>m.validateAgentAction({tool:'numeric-transform',input:{name:'round',inputRefs:'a',parameters:{digits:2}}},stage),{code:'ANALYSIS_TOOL_INVALID'});
});
test('注册表声明全部受限工具及元数据',()=>{
 for(const name of ['profile','clean','describe','group','statistics','chart','numeric-transform'])for(const key of ['name','description','inputSchema','allowedStages','sideEffects','timeout','resultProjection'])assert.ok(m.AGENT_TOOLS[name][key]!==undefined);
});
test('唯一校验源区分缺参数与非法字段且阶段白名单生效',()=>{
 assert.throws(()=>m.validateAgentAction({tool:'group',input:{}},{id:'activity',skill:{allowedTools:['group']}}),{code:'ANALYSIS_TOOL_MISSING_PARAMETER'});
 assert.throws(()=>m.validateAgentAction({tool:'describe',input:{columns:['user_id']}},{id:'activity',skill:{allowedTools:['describe']}}));
 assert.throws(()=>m.validateAgentAction({tool:'chart',input:{kind:'line'}},{id:'plan',skill:{allowedTools:[]}}));
 assert.doesNotThrow(()=>m.validateAgentAction({tool:'numeric-transform',input:{name:'round',inputRefs:['a'],parameters:{digits:2}}},{id:'insights',skill:{allowedTools:[]}}));
});
test('错误固定脱敏且Abort冒泡',()=>{
 assert.equal(m.classifyToolError({code:'ANALYSIS_TOOL_TIMEOUT',message:'secret /tmp/file SQL'}).recoverable,true);
 assert.equal(m.classifyToolError({code:'ANALYSIS_TOOL_INVALID'}).recoverable,false);
 assert.equal(m.classifyToolError({code:'ANALYSIS_TOOL_MISSING_PARAMETER'}).recoverable,true);
 assert.doesNotMatch(JSON.stringify(m.classifyToolError({message:'secret /tmp/file SQL'})),/secret|\/tmp|SQL/);
 assert.throws(()=>m.classifyToolError(new DOMException('stop','AbortError')),{name:'AbortError'});
});
test('投影只允许聚合字段和元数据且不修改原产物',()=>{
 const raw={data:[{channel:'a',amount_sum:12,user_id:'SECRET',custom_upload_column:'PRIVATE'}],svg:'BINARY',totalGroups:120};
 const result=m.projectToolResult('group',raw);
 assert.doesNotMatch(JSON.stringify(result),/SECRET|PRIVATE|BINARY|user_id|custom_upload_column/);
 assert.equal(result.data[0].amount_sum,12);assert.equal(result.totalRows,120);assert.equal(result.truncated,true);assert.ok(result.scope);
 assert.equal(raw.data[0].user_id,'SECRET');
});
test('投影限制行数与字节，保留数值证据',()=>{
 const result=m.projectToolResult('chart',{data:Array.from({length:150},(_,i)=>({date:String(i),revenue:i}))});
 assert.equal(result.data.length,100);assert.equal(result.totalRows,150);assert.equal(result.truncated,true);
 assert.throws(()=>m.projectToolResult('profile',{note:'a'.repeat(1024*1024+1)}));
 const evidence=m.projectToolResult('numeric-transform',{evidence:{id:'transform:a',value:2,unit:'元',metricId:'revenue'},receipt:{status:'pass'}});
 assert.equal(evidence.evidence.id,'transform:a');assert.equal(evidence.evidence.value,2);
});
test('数据行不能借元数据同名字段泄漏上传列，空结果可修复',()=>{
 const safe=m.projectToolResult('group',{data:[{channel:'A',summary:'PRIVATE',note:'SECRET',amount_sum:3}]});
 assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|SECRET/);
 assert.throws(()=>m.projectToolResult('group',{data:[]}),{code:'ANALYSIS_TOOL_EMPTY_RESULT'});
});
