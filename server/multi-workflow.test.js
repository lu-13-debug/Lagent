import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STAGE_FIELDS } from './stage-contracts.js';
import { Store } from './store.js';
import { Workflow, createTask, publicTask } from './workflow.js';
import { createDataset } from './datasets.js';
import { artifactFingerprint, canReuseArtifact } from './artifact-lifecycle.js';
const multi = await import('./multi-workflow.js').catch(() => ({}));
test('团队单分支Abort保留失败节点和同轮成功账本',async t=>{
 const env=await fixture(t,{fetchImpl:async body=>{if(body.model==='stop-reader')throw new DOMException('分支取消','AbortError');},modelResult:body=>body.model==='insights'&&body.messages.length===2?{operations:['stop-reader','keep-reader'].map(subagentId=>({tool:'delegate',input:{subagentId,question:'核对'}}))}:{}});
 env.task.workflowSnapshot.stages.insights.team={enabled:true};env.task.workflowSnapshot.stages.insights.subagents=['stop-reader','keep-reader'].map(id=>({id,name:id,role:'核对',model:id,maxTokens:1024}));env.workflow.modelHub.subagentContext=(stage,index)=>({settings:{model:stage.subagents[index].model,provider:'mock',baseUrl:'https://test.example/v1'},key:'fake'});env.store.put('task',env.task);
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);assert.equal(task.status,'completed',task.error);assert.ok(task.artifacts.insights.team.nodes.some(n=>n.name==='stop-reader'&&['failed','cancelled'].includes(n.status)));assert.ok(task.artifacts.insights.team.nodes.some(n=>n.name==='keep-reader'&&n.status==='completed'));assert.equal(env.store.list('model-call').filter(c=>c.kind==='subagent'&&c.model==='keep-reader').length,1);
});
test('团队父节点reject真实重试一次并共享调用预算',async t=>{
 const env=await fixture(t,{modelResult:body=>{
 if(body.model!=='insights')return {};const observations=body.messages.filter(m=>m.role==='user'&&m.content.includes('toolResults'));
 if(!observations.length)return {operations:[{tool:'delegate',input:{subagentId:'reader',question:'核对'}}]};
 if(observations.length===1){const id=JSON.parse(observations[0].content).toolResults[0].output.id;return {operations:[{tool:'delegate',input:{subagentId:'reader',question:'重新核对',resultId:id,decision:'reject'}}]};}return {};
 }});
 env.task.workflowSnapshot.stages.insights.team={enabled:true};env.task.workflowSnapshot.stages.insights.subagents=[{id:'reader',model:'reader',name:'核查',role:'核对',maxTokens:1024}];env.workflow.modelHub.subagentContext=()=>({settings:{model:'reader',provider:'mock',baseUrl:'https://test.example/v1'},key:'fake'});env.store.put('task',env.task);await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);assert.equal(task.status,'completed',task.error);assert.equal(env.calls.filter(c=>c.model==='reader').length,2);assert.equal(task.artifacts.insights.team.nodes.length,2);assert.equal(task.artifacts.insights.team.nodes[1].retries,1);assert.equal(task.artifacts.insights.team.usage.calls,5);
});
test('团队模式实际跨层委派、共享预算并保留旧模式',async t=>{
 const env=await fixture(t,{modelResult:body=>['insights','reader'].includes(body.model)&&body.messages.length===2&&body.messages[0].content.includes('可用只读子智能体')?{operations:[{tool:'delegate',input:{subagentId:'reader',question:'拆分核对'}}]}:{}});
 env.task.workflowSnapshot.stages.insights.team={enabled:true};env.task.workflowSnapshot.stages.insights.subagents=[{id:'reader',name:'核查',role:'检查证据',model:'reader',maxTokens:1024}];env.workflow.modelHub.subagentContext=()=>({settings:{model:'reader',provider:'mock',baseUrl:'https://test.example/v1'},key:'fake'});env.store.put('task',env.task);
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);assert.equal(task.status,'completed',task.error);assert.equal(task.artifacts.insights.team.nodes.length,3);assert.equal(task.artifacts.insights.team.nodes.at(-1).depth,3);assert.equal(env.calls.filter(c=>c.model==='reader').length,3);assert.equal(task.artifacts.insights.team.usage.calls,5);
});
test('子智能体单失败降级及取消不落产物，账本kind不重复',async t=>{
 for(const cancelled of [false,true]){
 let env;env=await fixture(t,{fetchImpl:async body=>{if(body.model==='reader-b'){if(cancelled)env.workflow.cancel(env.store.get('task',env.task.id));throw Error('PRIVATE');}},modelResult:body=>body.model==='insights'&&body.messages.length===2?{operations:['reader-a','reader-b'].map(subagentId=>({tool:'delegate',input:{subagentId,question:'核对覆盖'}}))}:{}});
 env.task.workflowSnapshot.stages.insights.subagents=['reader-a','reader-b'].map(id=>({id,name:id,role:'只读',model:id}));
 env.workflow.modelHub.subagentContext=(stage,index)=>({settings:{model:stage.subagents[index].model,provider:'mock',baseUrl:'https://test.example/v1'},key:'fake-key'});
 env.store.put('task',env.task);await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 if(cancelled){assert.equal(task.status,'cancelled');assert.equal(task.artifacts.insights,undefined);}else{assert.equal(task.status,'completed',task.error);assert.equal(task.artifacts.insights.delegations.length,2);assert.equal(task.artifacts.insights.delegations.filter(d=>d.status==='failed').length,1);const entries=env.store.list('model-call');assert.equal(entries.filter(c=>c.kind==='subagent').length,1);assert.equal(entries.length,env.calls.length-1);assert.equal(new Set(entries.map(c=>c.id)).size,entries.length);assert.doesNotMatch(JSON.stringify(task.artifacts.insights.delegations),/PRIVATE/);}
 }
});
test('团队 chart/clean 只生成提案且不写主报告或数据',async t=>{
 const env=await fixture(t,{modelResult:body=>{
  if(body.model==='insights'){const hasTool=body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults'));return hasTool?{}:{operations:[{tool:'delegate',input:{subagentId:'reader',question:'核对'}}]};}
  if(body.model==='reader'){const hasTool=body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults'));return hasTool?{}:{operations:[{tool:'chart',input:{kind:'line',source:'daily',x:'date',y:'revenue',title:'收入'}},{tool:'clean',input:{table:'users',operations:['trim_strings']}}]};}
  return {};
 }});
 env.task.workflowSnapshot.stages.insights.team={enabled:true};
 env.task.workflowSnapshot.stages.insights.subagents=[{id:'reader',name:'核查',role:'核对',model:'reader',maxTokens:1024,allowedTools:['chart','clean']}];
 env.workflow.modelHub.subagentContext=()=>({settings:{model:'reader',provider:'mock',baseUrl:'https://test.example/v1'},key:'fake'});
 env.store.put('task',env.task);
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'completed',task.error);
 const node=task.artifacts.insights.team.nodes.find(n=>n.name==='核查');
 assert.deepEqual(node.proposals.map(p=>p.kind).sort(),['chart','clean']);
 assert.equal((task.report.charts||[]).some(c=>c.title==='收入'),false);
 const delegation=task.artifacts.insights.delegations.find(d=>d.subagentId==='reader');
 assert.equal(delegation.proposals.length,2);assert.doesNotMatch(JSON.stringify(delegation),/PRIVATE|prompt|rows/);
});
test('团队子角色未授权工具被拒绝，不能借递归绕过',async t=>{
 const env=await fixture(t,{modelResult:body=>{
  if(body.model==='insights'){const hasTool=body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults'));return hasTool?{}:{operations:[{tool:'delegate',input:{subagentId:'reader',question:'核对'}}]};}
  if(body.model==='reader'&&!body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults')))return {operations:[{tool:'chart',input:{kind:'line',source:'daily',x:'date',y:'revenue'}}]};
  return {};
 }});
 env.task.workflowSnapshot.stages.insights.team={enabled:true};
 env.task.workflowSnapshot.stages.insights.subagents=[{id:'reader',name:'核查',role:'核对',model:'reader',maxTokens:1024,allowedTools:['profile']}];
 env.workflow.modelHub.subagentContext=()=>({settings:{model:'reader',provider:'mock',baseUrl:'https://test.example/v1'},key:'fake'});
 env.store.put('task',env.task);await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'completed',task.error);
 const node=task.artifacts.insights.team.nodes.find(n=>n.name==='核查');
 assert.equal(node.proposals.length,0);
});
test('Critic阻断复用两轮修订后通过，指令包含代码与修复且无额外分析调用',async t=>{
 const env=await fixture(t,{v2:true});let reviews=0;
 env.workflow.critiqueResult=()=>({verdict:++reviews<=4?'reject':'pass',rubricVersion:'critic-1',issues:reviews<=4?[{code:'CRITIC_FIGURE',severity:'blocking',evidenceRefs:[],message:'图表引用无效',fix:'修正引用'}]:[]});
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);assert.equal(task.status,'completed',task.error);
 assert.equal(env.calls.filter(c=>c.model==='report').length,3);assert.equal(task.artifacts.verify.revisions.length,2);
 const revision=JSON.parse(env.calls.filter(c=>c.model==='report')[1].messages[1].content).revision;assert.ok(revision.issues.some(i=>i.code==='CRITIC_FIGURE'&&i.fix));
 assert.equal(env.calls.filter(c=>c.model==='activity').length,1);
});
test('Critic异常降级unreviewed不能被verify批准掩盖',async t=>{
 const env=await fixture(t,{v2:true});env.workflow.critiqueResult=()=>{throw Error('PRIVATE-ERROR');};await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'failed');assert.equal(env.calls.filter(c=>c.model==='report').length,3);assert.equal(task.artifacts.report.critic?.verdict,'unreviewed');assert.doesNotMatch(JSON.stringify(task),/PRIVATE-ERROR/);
});
test('确定性Critic写入产物和verify输入，正常报告不增加模型调用',async t=>{
 const env=await fixture(t,{v2:true});await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'completed',task.error);assert.equal(task.artifacts.report.critic.rubricVersion,'critic-1');assert.equal(task.artifacts.verify.critic.verdict,'pass');
 const calls=env.calls.filter(c=>c.model==='verify');assert.equal(calls.length,1);assert.ok(JSON.parse(calls[0].messages[1].content).checks.critic);
 assert.equal(env.calls.filter(c=>c.model==='report').length,1);
});
test('RAG历史隔离、计划口径与最小审计贯穿真实阶段调用',async t=>{
 const env=await fixture(t,{v2:true,modelResult:body=>body.model==='plan'?{questions:[{id:'q',question:'检查活跃',stageIds:['activity'],metricIds:['dau'],priority:'should',status:'planned'}]}:{}});
 for(const [id,domain,status] of [['history','game','completed'],['foreign','education','completed'],['failed-history','game','failed']])env.store.put('task',{id,domain,status,title:'核验数据范围',goal:'核验数据范围',report:{summary:'历史覆盖MARKER'},updatedAt:'2026-11-04'});
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);assert.equal(task.status,'completed',task.error);
 const inputs=env.calls.map(c=>JSON.parse(c.messages.find(m=>m.role==='user').content));
 const docs=inputs.flatMap(i=>i.retrieval?.documents||[]);assert.ok(docs.some(d=>d.id==='task:history'));assert.ok(docs.some(d=>d.id==='metric:dau'));assert.ok(!docs.some(d=>['task:foreign','task:failed-history',`task:${task.id}`].includes(d.id)));
 for(const artifact of Object.values(task.artifacts).filter(a=>a.retrieval)){assert.deepEqual(Object.keys(artifact.retrieval).sort(),['count','ids','omitted']);assert.equal(artifact.retrieval.count,artifact.retrieval.ids.length);assert.ok(artifact.retrieval.count<=8);}
 for(const input of inputs){const documents=input.retrieval?.documents||[];assert.ok(documents.reduce((n,d)=>n+[...d.text].length,0)<=4000);}
});

test('Planner记录版本验证并只给下游对应计划，禁止自动改跳过',async t=>{
 const plan={questions:[{id:'q',question:'活跃覆盖',stageIds:['activity'],metricIds:['dau'],priority:'must',status:'planned'}],steps:[{id:'s',stageId:'activity',purpose:'核对活跃',dependsOn:[],expectedOutput:'活跃概况',optional:false}],evidenceRequirements:[],confirmations:[]};
 const env=await fixture(t,{v2:true,modelResult:b=>b.model==='plan'?plan:{}});await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'completed',task.error);assert.equal(task.artifacts.plan.planVersion,1);assert.equal(task.artifacts.plan.validation.status,'verified');
 const input=model=>JSON.parse(env.calls.find(c=>c.model===model).messages.find(m=>m.role==='user').content);
 assert.equal(input('activity').plan.questions[0].id,'q');assert.equal(input('monetization').plan.questions.length,0);
 assert.equal(JSON.stringify(input('monetization').previous.find(p=>p.id==='plan')).includes('活跃覆盖'),false);
 assert.deepEqual(task.skippedSteps||[],[]);
 assert.equal(canReuseArtifact(task.artifacts.plan,task.artifacts.plan.fingerprint),true,'结构化计划须兼容原产物复用门禁');
 const upstream={quality:task.artifacts.quality,plan:task.artifacts.plan};
 assert.equal(task.artifacts.preprocess.fingerprint.upstreamHash,artifactFingerprint({upstream}).upstreamHash,'模型投影不得替换原始上游指纹');
});
test('无效Planner只修复一次，仍失败不保存无效产物',async t=>{
 const env=await fixture(t,{v2:true,modelResult:b=>b.model==='plan'?{questions:[{id:'q',question:'非法',stageIds:['shell'],metricIds:[],priority:'must',status:'planned'}]}:{}});await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'failed');assert.equal(env.calls.filter(c=>c.model==='plan').length,2);assert.equal(task.artifacts.plan?.deliverable,undefined);
 const input=JSON.parse(env.calls.filter(c=>c.model==='plan')[1].messages.find(m=>m.role==='user').content);assert.ok(input.revision.planValidationErrors.length);
});

test('Planner结构修复成功后只保存有效计划并保留两次调用账本',async t=>{
 let count=0;
 const env=await fixture(t,{v2:true,modelResult:body=>body.model==='plan'&&++count===1?{steps:[{id:'bad',stageId:'unknown'}]}:{}});
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'completed',task.error);assert.equal(count,2);
 assert.deepEqual(task.artifacts.plan.deliverable.steps,[]);assert.equal(task.artifacts.plan.calls.length,2);
 assert.equal(env.store.list('model-call').filter(entry=>entry.stageId==='plan').length,2);
 assert.ok(task.artifacts.plan.createdAt);assert.equal(task.artifacts.plan.validation.errors.length,0);
});

test('必需问题阻塞自动重规划最多一次，协作只等待审批且保持用户范围',async t=>{
 const blocked={questions:[{id:'blocked',question:'确认必要范围',stageIds:['activity'],metricIds:['dau'],priority:'must',status:'blocked'}]};
 const auto=await fixture(t,{v2:true,modelResult:b=>b.model==='plan'?blocked:{}});
 await auto.workflow.run(auto.task.id);const done=auto.store.get('task',auto.task.id);
 assert.equal(done.status,'completed',done.error);assert.equal(auto.calls.filter(c=>c.model==='plan').length,2);
 assert.equal(done.artifacts.plan.planVersion,2);assert.equal(done.artifacts.plan.validation.blocked.length,1);assert.deepEqual(done.skippedSteps||[],[]);
 assert.equal(auto.store.list('model-call').length,auto.calls.length);
 const collab=await fixture(t,{v2:true,mode:'collaborative',modelResult:b=>b.model==='plan'?blocked:{}});
 await collab.workflow.run(collab.task.id);const waiting=collab.store.get('task',collab.task.id);
 assert.equal(waiting.status,'awaiting_approval');assert.equal(collab.calls.filter(c=>c.model==='plan').length,1);
 assert.match(waiting.messages.at(-1).content,/必需问题/);
});

test('旧版仅摘要计划兼容为空结构且保留legacy验证',async t=>{
 const env=await fixture(t);await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(task.status,'completed',task.error);assert.equal(task.artifacts.plan.validation.status,'legacy');assert.deepEqual(task.artifacts.plan.deliverable.questions,[]);
});

test('Planner返回后任务停止或范围改变时不发送旧范围修复',async t=>{
 for(const change of ['stop','scope']) {
  let env,count=0;
  env=await fixture(t,{v2:true,fetchImpl:async body=>{
   if(body.model==='plan'&&++count===1){const current=env.store.get('task',env.task.id);if(change==='stop')current.status='awaiting_approval';else current.skippedSteps=['channel'];env.store.put('task',current);}
  },modelResult:body=>body.model==='plan'&&count===1?{questions:[{}]}:{}});
  await env.workflow.run(env.task.id);
  const calls=env.calls.filter(call=>call.model==='plan');
  if(change==='stop')assert.equal(calls.length,1);
  else {assert.equal(calls.length,2);const input=JSON.parse(calls[1].messages.find(m=>m.role==='user').content);assert.equal(input.revision,undefined);assert.equal(env.store.get('task',env.task.id).status,'completed');}
 }
});

test('Planner已有报告产物或报告步骤完成时禁止重规划',async t=>{
 for(const marker of ['artifact','step']) {
  const env=await fixture(t,{v2:true,modelResult:body=>body.model==='plan'?{questions:[{id:'b',question:'缺数据',stageIds:['activity'],metricIds:['dau'],priority:'must',status:'blocked'}]}:{}});
  if(marker==='artifact')env.task.artifacts.report={status:'completed'};else env.task.steps.find(s=>s.id==='report').status='completed';
  env.store.put('task',env.task);await env.workflow.run(env.task.id);
  assert.equal(env.calls.filter(call=>call.model==='plan').length,1);
 }
});

test('Planner修复和重规划各自一次预算不因组合而重置',async t=>{
 let count=0;
 const env=await fixture(t,{v2:true,modelResult:body=>{
  if(body.model!=='plan')return {};
  count++;return count===2?{questions:[{id:'b',question:'缺数据',stageIds:['activity'],metricIds:['dau'],priority:'must',status:'blocked'}]}:{questions:[{}]};
 }});
 await env.workflow.run(env.task.id);
 assert.equal(count,3);assert.equal(env.store.get('task',env.task.id).status,'failed');assert.equal(env.store.get('task',env.task.id).artifacts.plan?.deliverable,undefined);
});

test('非取消预算失败保留最小trace但不伪造已完成产物',async t=>{
 const env=await fixture(t,{modelResult:body=>body.model==='activity'?{operations:[{tool:'describe',input:{columns:['amount']}}]}:{}});
 env.task.workflowSnapshot.stages.activity.agentLoop={maxRounds:1};env.store.put('task',env.task);
 await env.workflow.run(env.task.id);const current=env.store.get('task',env.task.id);
 assert.equal(current.status,'failed');assert.equal(current.artifacts.activity.trace.stopReason,'round_budget');assert.equal(current.artifacts.activity.status,undefined);assert.equal(current.artifacts.activity.deliverable,undefined);
 assert.doesNotMatch(JSON.stringify(current.artifacts.activity.trace),/messages|prompt|fake-key|amount|user_id/);
});

test('逐工具超时信号抵达执行层且剩余轮可修正', {timeout:10000},async t=>{
 let toolAborted=false;
 const env=await fixture(t,{modelResult:body=>body.model==='activity'&&!body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults'))?{operations:[{tool:'describe',input:{table:'payments',columns:['amount']}}]}:{},runTool:async(name,_input,options)=>{
  if(name!=='describe')return {rows:1};
  return new Promise((resolve,reject)=>{const abort=()=>{toolAborted=true;reject(options.signal.reason);};if(options.signal.aborted)abort();else options.signal.addEventListener('abort',abort,{once:true});});
 }});
 env.task.workflowSnapshot.stages.activity.agentLoop={toolTimeoutMs:10};env.store.put('task',env.task);
 await env.workflow.run(env.task.id);const task=env.store.get('task',env.task.id);
 assert.equal(toolAborted,true);assert.equal(task.status,'completed',task.error);
 assert.equal(task.artifacts.activity.trace.stopReason,'completed');
 const second=env.calls.filter(c=>c.model==='activity')[1];assert.ok(second);assert.match(JSON.stringify(second.messages),/ANALYSIS_TOOL_TIMEOUT/);
});

test('阶段工具轨迹保存在产物且评审裁判保持原调用账本',async t=>{
 const {store,workflow,task,calls}=await fixture(t,{panel:true,modelResult:body=>body.model==='activity'&&!body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults'))?{operations:[{tool:'describe',input:{table:'payments',columns:['amount']}}]}:{},runTool:async()=>({rows:1})});
 await workflow.run(task.id);const current=store.get('task',task.id);
 assert.equal(current.status,'completed',current.error);
 assert.equal(current.artifacts.activity.trace.stopReason,'completed');
 assert.equal(current.artifacts.activity.trace.round,2);
 assert.equal(current.artifacts.activity.trace.actions.length,1);
 assert.equal(current.artifacts.activity.trace.actions[0].tool,'describe');
 assert.equal(current.artifacts.insights.trace.stopReason,'completed');
 assert.equal(current.artifacts.insights.panel.reviewers.length,2);
 assert.equal(store.list('model-call').length,calls.length);
 assert.doesNotMatch(JSON.stringify(current.artifacts.activity.trace),/user_id|order_id|fake-key|PRIVATE|核验数据范围|messages|prompt/);
});

test('模型调用账本覆盖裁判与评审且不重复累计产物',async t=>{
 const {store,workflow,task,calls}=await fixture(t,{panel:true});
 await workflow.run(task.id);
 const entries=store.list('model-call');
 assert.equal(entries.length,calls.length);
 assert.equal(new Set(entries.map(e=>e.id)).size,entries.length);
 assert.equal(entries.filter(e=>e.kind==='reviewer').length,2);
 assert.deepEqual(entries.filter(e=>e.kind==='reviewer').map(e=>e.lens).sort(),['growth','revenue']);
 assert.equal(entries.filter(e=>e.stageId==='insights'&&e.kind==='stage').length,1);
 assert.equal(entries.every(e=>e.totalTokens===null),true);
});
test('账本写入失败不使分析失败，取消保留已完成调用',async t=>{
 const env=await fixture(t);const put=env.store.put.bind(env.store);
 env.store.put=(kind,item)=>{if(kind==='model-call')throw Error('disk');return put(kind,item);};
 await env.workflow.run(env.task.id);assert.equal(env.store.get('task',env.task.id).status,'completed');
 let stop;let cancelled=false;
 stop=await fixture(t,{fetchImpl:async body=>{if(body.model==='insights'&&!cancelled){cancelled=true;stop.workflow.cancel(stop.store.get('task',stop.task.id));}}});
 await stop.workflow.run(stop.task.id);
 assert.equal(stop.store.get('task',stop.task.id).status,'cancelled');
 assert.equal(stop.store.list('model-call').length,stop.calls.length);
 assert.ok(stop.calls.length>0);
});

async function fixture(t, { mode = 'automatic', fetchImpl, modelResult, runTool, records, v2 = false, panel = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dataagent-multi-regression-'));
  const store = new Store(dir); const calls = [];
  const workflow = new Workflow(store, {
    hub: { context: stage => ({ settings: { model: stage.id, provider: 'mock', baseUrl: 'https://test.example/v1' }, key: 'fake-key' }), reviewerContext: (stage,index) => ({ settings:{model:stage.reviewers[index].model,provider:'mock',baseUrl:'https://test.example/v1'},key:'review-key' }) },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body);
      if (fetchImpl) await fetchImpl(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: body.model === 'plan' ? '实际计划：先核对日期覆盖，再核验可用指标。' : '依据聚合证据完成', operations: [], approved: true, issues: [], ...(v2 ? Object.fromEntries(Object.entries(STAGE_FIELDS[body.model]?.fields || {}).map(([key,type]) => [key, type === 'array' ? [] : type === 'object' ? {} : type === 'boolean' ? true : 'value'])) : {}), ...modelResult?.(body) }) } }] }));
    }, runTool: runTool || (async () => ({})), createPdf: async () => ({ ready: true }),
  });
  // Tests explicitly resume through run(), with no scheduler races or background work.
  workflow.schedule = () => {};
  t.after(async () => { workflow.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const dataset = createDataset(records || {
    users: [{ user_id: 'u1', registered_at: '2026-10-01', channel: '自然' }],
    activity: [{ user_id: 'u1', event_time: '2026-10-01' }, { user_id: 'u1', event_time: '2026-10-02' }],
    payments: [{ order_id: 'p1', user_id: 'u1', paid_at: '2026-10-01', amount: 20, currency: 'CNY', status: 'success' }],
  });
  store.put('dataset', dataset);
  const task = createTask({ title: '协作回归', goal: '核验数据范围', mode, useAI: true }, dataset);
  multi.configureMultiTask(task, { stages: Object.fromEntries([...task.steps.map(step => step.id), 'preprocess', 'charts'].map(id => [id, { id, skill: { id, content: `实际Skill:${id}`, version: v2 ? 2 : 1, builtin: v2 }, timeoutMs: 1000 }])) });
  store.createTask(task);
  if(panel){task.workflowSnapshot.stages.insights.reviewers=[{model:'review-growth'},{model:'review-revenue'}];store.put('task',task);}
  return { store, workflow, task, calls };
}

test('洞察评审并行调用后裁判收到有效证据摘要，单评审失败可降级',async t=>{
 const {store,workflow,task,calls}=await fixture(t,{panel:true,fetchImpl:async body=>{if(body.model==='review-revenue')throw Error('private-key');},modelResult:body=>body.model==='review-growth'?{findings:[{title:'观察',detail:'聚合证据',evidenceRefs:['quality:summary']}],recommendations:['核对覆盖']}:{} });
 await workflow.run(task.id);const current=store.get('task',task.id);
 assert.equal(current.status,'completed');assert.equal(calls.filter(c=>c.model.startsWith('review-')).length,2);assert.equal(calls.filter(c=>c.model==='insights').length,1);
 const input=JSON.parse(calls.find(c=>c.model==='insights').messages.find(m=>m.role==='user').content);assert.ok(input.previous.some(p=>p.id==='panel:growth'&&p.deliverable.findings.length));assert.equal(current.artifacts.insights.panel.degraded,true);assert.equal(current.artifacts.insights.panel.reviewers[1].status,'failed');assert.doesNotMatch(JSON.stringify(current.artifacts.insights.panel),/private-key/);
});

test('全部评审失败回退原裁判且禁用评审调用数不变',async t=>{
 const {store,workflow,task,calls}=await fixture(t,{panel:true,fetchImpl:async body=>{if(body.model.startsWith('review-'))throw Error('failed');}});
 await workflow.run(task.id);const current=store.get('task',task.id);assert.equal(current.status,'completed');assert.equal(current.artifacts.insights.panel.degraded,true);assert.equal(current.artifacts.insights.panel.participants,1);
 const input=JSON.parse(calls.find(c=>c.model==='insights').messages.find(m=>m.role==='user').content);assert.equal(input.previous.some(p=>p.id.startsWith('panel:')),false);
 const disabled=await fixture(t);await disabled.workflow.run(disabled.task.id);assert.equal(disabled.calls.some(c=>c.model.startsWith('review-')),false);assert.equal(disabled.store.get('task',disabled.task.id).artifacts.insights.panel,undefined);
});

test('评审数值变换仅留在独立副本且不进入裁判证据',async t=>{
 let transformedRef;
 const {store,workflow,task,calls}=await fixture(t,{panel:true,modelResult:body=>{
  if(!body.model.startsWith('review-'))return {};
  const toolMessage=body.messages.find(m=>m.role==='user'&&m.content.includes('toolResults'));
  if(!toolMessage)return {operations:[{tool:'numeric-transform',input:{name:'round',inputRefs:['metric:revenue'],parameters:{digits:0}}}]};
  transformedRef=JSON.parse(toolMessage.content).toolResults[0].output.evidence.id;
  return {findings:[{title:'派生观察',detail:'派生证据',evidenceRefs:[transformedRef]}]};
 }});
 await workflow.run(task.id);const current=store.get('task',task.id);assert.equal(current.status,'completed');assert.ok(transformedRef);assert.equal(current.report.facts.some(f=>f.id===transformedRef),false);const judge=calls.find(c=>c.model==='insights');assert.equal(judge.messages.some(m=>m.content.includes(transformedRef)),false);
});

test('评审运行期间取消不得应用结论或生成评审artifact',async t=>{
 let env;let stopped=false;
 env=await fixture(t,{panel:true,fetchImpl:async body=>{if(body.model.startsWith('review-')&&!stopped){stopped=true;env.workflow.cancel(env.store.get('task',env.task.id));}}});
 await env.workflow.run(env.task.id);const current=env.store.get('task',env.task.id);assert.equal(current.status,'cancelled');assert.equal(current.artifacts.insights,undefined);assert.equal(env.calls.some(c=>c.model==='insights'),false);
});

test('协作模式先运行并保存实际计划再请求确认，批准后不重复调用计划模型', async t => {
  const { store, workflow, task, calls } = await fixture(t, { mode: 'collaborative' });
  await workflow.run(task.id);
  let current = store.get('task', task.id);
  assert.equal(current.status, 'awaiting_approval');
  assert.equal(current.steps[current.currentStep].id, 'plan');
  assert.equal(calls.filter(call => call.model === 'plan').length, 1, '确认前必须已执行实际计划 Skill');
  assert.equal(current.artifacts.plan.summary, '实际计划：先核对日期覆盖，再核验可用指标。');
  assert.match(current.messages.at(-1).content, /实际计划：先核对日期覆盖/);
  assert.equal(calls.some(call => call.model === 'preprocess'), false);
  assert.equal(store.wallet().spent, 0);

  await workflow.run(task.id);
  assert.equal(calls.filter(call => call.model === 'plan').length, 1);
  const staleSnapshot = publicTask(current).approvalSnapshot;
  workflow.skip(current, 'retention');
  current = store.get('task', task.id);
  const beforeApprovalCalls = calls.length;
  assert.throws(() => workflow.approve(current, '', 'plan', staleSnapshot), error => error.status === 409);
  await workflow.run(task.id);
  assert.equal(calls.length, beforeApprovalCalls, '过期确认不得调用后续模型');
  const approvedSnapshot = publicTask(current).approvalSnapshot;
  workflow.approve(current, '按此计划继续', 'plan', approvedSnapshot);
  await workflow.run(task.id);
  current = store.get('task', task.id);
  assert.equal(current.status, 'awaiting_approval');
  assert.equal(current.steps[current.currentStep].id, 'report');
  assert.equal(current.steps.find(step => step.id === 'plan').status, 'completed');
  assert.equal(calls.filter(call => call.model === 'plan').length, 1, '批准后复用计划产物');
  assert.equal(calls.some(call => call.model === 'report'), false, '报告仍在生成前确认');
  assert.equal(current.artifacts.preprocess !== undefined, true);
  workflow.approve(current, '按此计划继续', 'plan', approvedSnapshot);
  assert.equal(current.status, 'awaiting_approval', '旧请求重试不得确认报告阶段');
  workflow.approve(current, '', 'report', publicTask(current).approvalSnapshot);
  await workflow.run(task.id);
  assert.equal(store.get('task', task.id).status, 'completed');
  assert.equal(calls.filter(call => call.model === 'plan').length, 1);
  assert.equal(store.wallet().spent, 20);
});

test('模型运行中跳过后续分支保留跳过状态，并立即从后续模型输入排除该分支', async t => {
  let started; const entered = new Promise(resolve => { started = resolve; });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const { store, workflow, task, calls } = await fixture(t, { fetchImpl: async body => {
    if (body.model === 'quality') { started(); await blocked; }
  } });
  const running = workflow.run(task.id);
  await entered;
  workflow.skip(store.get('task', task.id), 'retention');
  workflow.skip(store.get('task', task.id), 'monetization');
  release(); await running;
  const current = store.get('task', task.id);
  assert.equal(current.status, 'completed', current.error);
  assert.ok(current.skippedSteps.includes('retention'));
  assert.equal(current.steps.find(step => step.id === 'retention').status, 'skipped');
  assert.equal(calls.some(call => call.model === 'retention'), false);
  const plan = calls.find(call => call.model === 'plan');
  const facts = JSON.parse(plan.messages[1].content).facts;
  assert.deepEqual(facts.retention, [], '跳过状态不能被运行中的旧 report 带入下一阶段');
  assert.ok(facts.metrics.filter(metric => /retention/.test(metric.id)).every(metric => metric.value === null));
  assert.equal(facts.metrics.find(metric => metric.id === 'revenue').value, null);
  assert.equal(facts.facts.some(fact => fact.id === 'metric:revenue' && !/无数据/.test(fact.text)), false, '不能残留跳过前的收入证据');
  assert.ok(facts.daily.every(day => day.revenue === null));
});

test('核验模型通过仍拒绝存在未核验发现的报告且不调用PDF', async t => {
  const { store, workflow, task } = await fixture(t, { modelResult: body => ['insights', 'report'].includes(body.model) ? { findings: [{ title: '待核验断言', detail: '没有证据的变化。', evidence: '模型猜测', evidenceRefs: [] }] } : {} });
  let pdfCalls = 0; workflow.createPdf = async () => { pdfCalls++; return { ready: true }; };
  await workflow.run(task.id);
  const current = store.get('task', task.id);
  assert.equal(current.status, 'failed');
  assert.match(current.error, /核验|证据/);
  assert.equal(pdfCalls, 0);
  assert.equal(store.wallet().spent, 0);
});

test('跳过支付后计划工具只能收到移除支付明细的数据范围', async t => {
  let paymentToolCalls = 0;
  const { store, workflow, task } = await fixture(t, {
    modelResult: body => body.model === 'plan' && body.messages.length === 2 ? { operations: [{ tool: 'describe', input: { table: 'payments', columns: ['amount'] } }] } : {},
    runTool: async (name, input, options) => {
      if (name === 'describe' && input.table === 'payments') {
        paymentToolCalls++;
        assert.equal(options.dataset.records.payments, undefined, '不能通过工具重新取得已跳过的支付记录');
        return { unavailable: true, summary: '支付分支已跳过，未提供支付数值' };
      }
      return {};
    },
  });
  workflow.skip(store.get('task', task.id), 'monetization');
  await workflow.run(task.id);
  const current = store.get('task', task.id);
  assert.equal(current.status, 'completed', current.error);
  assert.equal(paymentToolCalls, 1);
});

test('预置工具等待期间跳过支付，在首次模型请求前刷新范围', async t => {
  let enter; const entered = new Promise(resolve => { enter = resolve; });
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let first = true;
  const { store, workflow, task, calls } = await fixture(t, { runTool: async name => {
    if (name === 'profile' && first) { first = false; enter(); await blocked; }
    return {};
  } });
  const running = workflow.run(task.id);
  await entered; workflow.skip(store.get('task', task.id), 'monetization'); release(); await running;
  assert.equal(store.get('task', task.id).status, 'completed');
  const quality = JSON.parse(calls.find(call => call.model === 'quality').messages[1].content);
  assert.equal(quality.facts.metrics.find(metric => metric.id === 'revenue').value, null);
});

test('图表兜底使用真实工具schema并在无活跃时选择可用聚合指标', async t => {
  const toolCalls = [];
  const { store, workflow, task } = await fixture(t, {
    records: { users: [{ user_id: 'u1', registered_at: '2026-10-01' }] },
    runTool: async (name, input) => {
      toolCalls.push({ name, input });
      if (name === 'chart') {
        assert.equal(input.kind, 'line'); assert.equal(input.source, 'daily'); assert.equal(input.x, 'date'); assert.equal(input.y, 'newUsers');
        return { id: 'chart-mock', mimeType: 'image/svg+xml', svg: '<svg/>', data: [] };
      }
      return {};
    },
  });
  await workflow.run(task.id);
  const current = store.get('task', task.id);
  assert.equal(current.status, 'completed', current.error);
  assert.equal(toolCalls.filter(call => call.name === 'chart').length, 1);
  assert.equal(current.report.charts[0].id, 'chart-mock');
});

test('缺少可绘聚合值时记录原因并继续核验报告', async t => {
  const toolCalls = [];
  const { store, workflow, task } = await fixture(t, {
    records: { payments: [{ order_id: 'p1', user_id: 'u1', paid_at: '2026-10-01', amount: 20, currency: 'CNY', status: 'success' }] },
    runTool: async (name, input) => { toolCalls.push({ name, input }); return {}; },
  });
  workflow.skip(store.get('task', task.id), 'monetization');
  await workflow.run(task.id);
  const current = store.get('task', task.id);
  assert.equal(current.status, 'completed', current.error);
  assert.equal(toolCalls.some(call => call.name === 'chart'), false);
  assert.match(current.artifacts.charts.summary, /无.*绘|没有.*绘/);
});

test('分阶段真实选择模型、读取 Skill，PDF成功后仅结算一次', async t => {
  assert.equal(typeof multi.configureMultiTask, 'function');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dataagent-multi-'));
  const store = new Store(dir); const calls = []; let pdfCalls = 0;
  const hub = { context: stage => ({ settings: { baseUrl: 'https://test.example/v1', model: `${stage.id}-model`, provider: 'mock', effort: stage.effort }, key: 'fake-secret' }) };
  const workflow = new Workflow(store, { hub, fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); calls.push(body); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '基于聚合证据完成', operations: [], approved: true, issues: [] }) } }] })); }, runTool: async () => ({ rows: 2 }), createPdf: async task => { pdfCalls++; assert.equal(task.artifacts.verify.verified, true); return { ready: true, bytes: 10 }; } });
  t.after(async () => { workflow.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const dataset = createDataset({ users: [{ user_id: 'PRIVATE-ID', registered_at: '2026-10-01', channel: '自然' }] }); store.put('dataset', dataset);
  const task = createTask({ title: '多模型', goal: '检查质量', mode: 'automatic', useAI: true }, dataset);
  const stageIds = [...task.steps.map(s => s.id), 'preprocess', 'charts'];
  multi.configureMultiTask(task, { version: 1, stages: Object.fromEntries(stageIds.map(id => [id, { id, skill: { id, content: `专属Skill:${id}`, version: '1' }, effort: 'default', maxTokens: 1024, timeoutMs: 1000 }])) });
  store.createTask(task); await workflow.run(task.id);
  const result = store.get('task', task.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(pdfCalls, 1); assert.equal(store.wallet().spent, 20); assert.equal(store.wallet().frozen, 0);
  assert.ok(calls.some(call => call.model === 'quality-model')); assert.ok(calls.some(call => call.model === 'plan-model'));
  assert.match(calls[0].messages[0].content, /专属Skill:quality/);
  assert.equal(JSON.stringify(calls).includes('PRIVATE-ID'), false);
  assert.equal(JSON.stringify(result).includes('fake-secret'), false);
  assert.equal(result.steps.at(-1).id, 'pdf'); assert.ok(result.artifacts.preprocess);
  await workflow.run(task.id); assert.equal(pdfCalls, 1); assert.equal(store.wallet().spent, 20);
});

test('首次PDF失败保留已核验报告并释放冻结额度', async t => {
  assert.equal(typeof multi.configureMultiTask, 'function');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dataagent-pdf-fail-')); const store = new Store(dir);
  const workflow = new Workflow(store, { hub: { context: stage => ({ settings: { model: stage.id, provider: 'mock', baseUrl: 'https://test.example/v1' }, key: 'fake' }) }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"核对完成","operations":[],"approved":true}' } }] })), runTool: async () => ({}), createPdf: async () => { throw new Error('PDF运行环境不可用'); } });
  t.after(async () => { workflow.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const dataset = createDataset({ users: [{ user_id: 'u', registered_at: '2026-10-01' }] }); store.put('dataset', dataset);
  const task = createTask({ title: 'PDF失败', goal: '检查', mode: 'automatic', useAI: true }, dataset);
  multi.configureMultiTask(task, { stages: Object.fromEntries([...task.steps.map(s => s.id), 'preprocess', 'charts'].map(id => [id, { id, skill: { content: '核对' } }])) }); store.createTask(task);
  await workflow.run(task.id); const result = store.get('task', task.id);
  assert.equal(result.status, 'failed'); assert.match(result.error, /PDF/); assert.ok(result.report); assert.equal(result.artifacts.verify.verified, true); assert.equal(store.wallet().spent, 0); assert.equal(store.wallet().frozen, 0);
});


test('新版核验只修订报告两次，保留合同用量历史且不重跑分析', async t => {
 let reviews = 0;
 const { store, workflow, task, calls } = await fixture(t, { v2: true, modelResult: body => body.model === 'verify' ? { approved: ++reviews >= 3, issues: reviews < 3 ? ['修正报告表达'] : [] } : {} });
 await workflow.run(task.id);
 const current = store.get('task',task.id);
 assert.equal(current.status,'completed',current.error);
 assert.equal(calls.filter(call=>call.model==='report').length,3);
 assert.equal(calls.filter(call=>call.model==='activity').length,1);
 assert.equal(current.artifacts.verify.revisions.length,2);
 assert.equal(current.artifacts.verify.validation.status,'verified');
 assert.equal(current.artifacts.verify.trace.stopReason,'completed');
 assert.equal(current.artifacts.report.trace.stopReason,'completed');
 assert.ok(current.artifacts.verify.revisions.every(item=>item.review.trace?.stopReason==='completed'&&item.revision.trace?.stopReason==='completed'));
 const ledger=store.list('model-call');
 assert.equal(ledger.length,calls.length);
 assert.equal(ledger.filter(entry=>entry.stageId==='report').length,3,'原始报告与两次修订均逐次保留');
 assert.equal(ledger.filter(entry=>entry.stageId==='verify').length,3,'原始核验与两次复核均逐次保留');
 assert.equal(new Set(ledger.map(entry=>entry.id)).size,ledger.length);
});

test('新版preprocess持久化派生数据供下游工具使用并保留原数据', async t => {
 const seen = [];
 const { store, workflow, task } = await fixture(t, { v2:true,
  records: { users:[{user_id:' u1 ',registered_at:'2026-10-01',channel:'自然'}],activity:[{user_id:' u1 ',event_time:'2026-10-01'}] },
  modelResult: body => body.model === 'preprocess' ? { transformOperations:['trim_strings'] } : {},
  runTool: async (_name,_input,options) => { seen.push(options.dataset.records.users[0].user_id); return {}; }
 });
 const original = store.get('dataset',task.datasetId);
 original.records.users[0].user_id=' u1 '; original.records.activity[0].user_id=' u1 '; store.put('dataset', original);
 await workflow.run(task.id);
 const current = store.get('task',task.id);
 assert.equal(current.status,'completed',current.error);
 assert.ok(current.derivedDatasetId);
 assert.equal(store.get('derived-dataset',current.derivedDatasetId).records.users[0].user_id,'u1');
 assert.equal(store.get('dataset',task.datasetId).records.users[0].user_id,' u1 ');
 assert.equal(current.artifacts.preprocess.deliverable.receipts[0].changedCells,2);
 assert.ok(seen.includes('u1'));
});

test('新版核验持续失败只修订两轮且不调用PDF、不结算', async t => {
 const { store, workflow, task, calls } = await fixture(t, { v2:true, modelResult: body => body.model==='verify' ? {approved:false,issues:['无法解决']} : {} });
 await workflow.run(task.id);
 const current = store.get('task',task.id);
 assert.equal(current.status,'failed');
 assert.equal(calls.filter(call=>call.model==='report').length,3);
 assert.equal(current.artifacts.verify.revisions.length,3);
 assert.equal(current.artifacts.pdf,undefined);
 assert.equal(store.wallet().spent,0);
});

test('团队完成时将脱敏任务树和事件持久化到task.artifacts.team', async t => {
  const env = await fixture(t, {
    modelResult: body => body.model === 'insights' && body.messages.length === 2
      ? { operations: [{ tool: 'delegate', input: { subagentId: 'reader', question: '核对持久化契约' } }] }
      : {}
  });
  env.task.workflowSnapshot.stages.insights.team = { enabled: true };
  env.task.workflowSnapshot.stages.insights.subagents = [{ id: 'reader', name: '核查', role: '只读核查', model: 'reader', maxTokens: 1024 }];
  env.workflow.modelHub.subagentContext = () => ({ settings: { model: 'reader', provider: 'mock', baseUrl: 'https://test.example/v1' }, key: 'fake' });
  env.store.put('task', env.task);

  await env.workflow.run(env.task.id);
  const current = env.store.get('task', env.task.id);
  assert.equal(current.status, 'completed', current.error);
  const artifact = current.artifacts.team;
  assert.ok(artifact, 'task.artifacts.team 必须存在');
  assert.equal(artifact.summary, '团队任务状态');
  assert.ok(Number.isSafeInteger(artifact.revision) && artifact.revision > 0);
  assert.equal(Number.isNaN(Date.parse(artifact.updatedAt)), false);
  assert.ok(Array.isArray(artifact.events) && artifact.events.length > 0);
  assert.ok(artifact.events.length <= 100);
  assert.ok(artifact.events.some(event => event.type === 'node.created'));
  assert.ok(artifact.events.some(event => event.type === 'node.updated' && event.status === 'completed'));
  const seqs = artifact.events.map(event => event.seq).filter(Number.isSafeInteger);
  assert.deepEqual(seqs, [...seqs].sort((left, right) => left - right));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(artifact.team.nodes.some(node => node.parentId === null));
  assert.ok(artifact.team.nodes.some(node => node.name === '核查'));
  assert.equal(current.artifacts.insights.team.nodes.length, artifact.team.nodes.length);
  assert.doesNotMatch(JSON.stringify(artifact), /PRIVATE|privatePrompt|privateRows|fake-key/);
});