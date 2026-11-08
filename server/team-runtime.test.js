import test from 'node:test';import assert from 'node:assert/strict';
const api=await import('./team-runtime.js').catch(()=>({}));
test('多分支共享预留准确且失败分支释放槽不重置预算',async()=>{
 const team=api.createTeamRuntime({maxConcurrent:1,maxTokens:100,maxCalls:3});const root=team.createNode(null,{}),a=team.createNode(root.id,{}),b=team.createNode(root.id,{});
 const release=await team.acquire(a.id);team.reserveCall(a.id,60);assert.throws(()=>team.reserveCall(b.id,50),/预算/);team.completeCall(a.id,{totalTokens:10});team.updateNode(a.id,'failed');release();const releaseB=await team.acquire(b.id);team.reserveCall(b.id,50);team.completeCall(b.id,{totalTokens:20});releaseB();assert.equal(team.snapshot().usage.calls,2);assert.equal(team.snapshot().usage.reservedTokens,0);assert.equal(team.snapshot().nodes.find(n=>n.id===a.id).status,'failed');
});
test('依赖仅同层或父子、无环；父验收拒绝最多重试一次且预算不重置',()=>{
 const team=api.createTeamRuntime();const root=team.createNode(null,{}),a=team.createNode(root.id,{}),b=team.createNode(root.id,{dependsOn:[a.id]});
 assert.equal(team.ready(b.id),false);team.updateNode(a.id,'completed');team.review(root.id,a.id,'accept');assert.equal(team.ready(b.id),true);
 assert.throws(()=>team.setDependencies(a.id,[b.id]),/环/);
 assert.throws(()=>team.review(b.id,a.id,'accept'),/父/);
 team.reserveCall(b.id,10);team.completeCall(b.id,{totalTokens:5});team.updateNode(b.id,'completed');team.review(root.id,b.id,'reject');assert.equal(team.snapshot().usage.calls,1);team.updateNode(b.id,'completed');assert.throws(()=>team.review(root.id,b.id,'reject'),/重试/);
 const grand=team.createNode(a.id,{});assert.throws(()=>team.setDependencies(grand.id,[b.id]),/层/);
});
test('根节点不占12子任务配额，保留maxNodes别名与深度限制',()=>{
 const team=api.createTeamRuntime();const root=team.createNode(null,{});for(let i=0;i<12;i++)team.createNode(root.id,{});
 assert.equal(team.snapshot().nodes.length,13);assert.equal(team.snapshot().limits.maxSubtasks,12);assert.equal(team.snapshot().limits.maxNodes,12);assert.throws(()=>team.createNode(root.id,{}),/数量/);
});
test('执行槽只限制模型请求，父节点等待子任务不占槽且取消唤醒队列',async()=>{
 const team=api.createTeamRuntime({maxConcurrent:1});const a=team.createNode(null,{}),b=team.createNode(a.id,{});
 const release=await team.acquire(a.id);let entered=false;const pending=team.acquire(b.id).then(done=>{entered=true;done();});await Promise.resolve();assert.equal(entered,false);release();await pending;assert.equal(entered,true);
 const held=await team.acquire(a.id);const blocked=team.acquire(b.id);team.cancel();await assert.rejects(blocked,{name:'AbortError'});held();
});
test('任务树限制深度及累计节点，不能绕过共享调用预算',()=>{
 const team=api.createTeamRuntime({maxDepth:3,maxNodes:3,maxCalls:2,maxTokens:100});
 const a=team.createNode(null,{name:'分析'}),b=team.createNode(a.id,{name:'留存'}),c=team.createNode(b.id,{name:'队列'});
 assert.equal(c.depth,3);assert.throws(()=>team.createNode(c.id,{name:'更深'}),/层级|数量/);
 team.reserveCall(a.id,60);assert.throws(()=>team.reserveCall(b.id,60),/预算/);team.completeCall(a.id,{totalTokens:10});team.reserveCall(b.id,60);team.completeCall(b.id,{totalTokens:20});assert.throws(()=>team.reserveCall(c.id,1),/预算/);
 assert.equal(team.snapshot().usage.totalTokens,30);
});
test('取消共享信号与任务树，拒绝未知父节点且快照不能改写内部状态',()=>{
 const controller=new AbortController(),team=api.createTeamRuntime({},controller.signal);assert.throws(()=>team.createNode('missing',{}),/父/);const node=team.createNode(null,{name:'执行'});const snapshot=team.snapshot();snapshot.nodes[0].name='篡改';assert.equal(team.snapshot().nodes[0].name,'执行');controller.abort();assert.throws(()=>team.reserveCall(node.id,1),{name:'AbortError'});
});

test('提案审计只保留安全摘要且取消后不可追加',()=>{
 const controller=new AbortController(),team=api.createTeamRuntime({},controller.signal);const root=team.createNode(null,{name:'洞察'});
 assert.deepEqual(root.proposals,[]);
 const stored=team.recordProposals(root.id,[{id:'proposal-1',kind:'chart',status:'proposed',summary:'图表：留存趋势',chart:{data:[{date:'2026-10-01',d1:0.4}]},prompt:'PRIVATE-PROMPT',rows:[{user_id:'PRIVATE-ID'}]}]);
 assert.deepEqual(stored,[{id:'proposal-1',kind:'chart',status:'proposed',summary:'图表：留存趋势'}]);
 const snapshot=team.snapshot();assert.deepEqual(snapshot.nodes[0].proposals,stored);assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE|prompt|raw|rows/i);
 controller.abort();assert.throws(()=>team.recordProposals(root.id,[{id:'proposal-2',kind:'clean',status:'needsApproval',summary:'清理' }]),{name:'AbortError'});
 assert.equal(team.snapshot().nodes[0].proposals.length,1);
 assert.throws(()=>team.recordProposals(root.id,[{id:'bad',kind:'shell',status:'proposed',summary:'越权'}]),{name:'AbortError'});
});
test('团队事件顺序稳定、字段脱敏且观察者异常不影响执行',()=>{
 const events=[];const team=api.createTeamRuntime({onEvent:event=>{events.push(event);throw Error('observer-failure');}});
 const root=team.createNode(null,{name:'根\n节点'}),child=team.createNode(root.id,{name:'子节点'});
 team.updateNode(child.id,'completed');
 const stored=team.recordProposals(child.id,[{id:'proposal-1',kind:'chart',status:'needsApproval',summary:'图表提案',prompt:'PRIVATE-PROMPT',rows:[{user_id:'PRIVATE-ID'}]}]);
 team.review(root.id,child.id,'accept');
 assert.deepEqual(events.map(event=>event.type),['node.created','node.created','node.updated','proposal.recorded','node.reviewed']);
 assert.deepEqual(Object.keys(events[0]).sort(),['createdAt','nodeId','seq','status','type']);
 assert.deepEqual(Object.keys(events[3]).sort(),['createdAt','nodeId','proposal','seq','status','type']);
 assert.deepEqual(stored,[{id:'proposal-1',kind:'chart',status:'needsApproval',summary:'图表提案'}]);
 assert.doesNotMatch(JSON.stringify(events),/PRIVATE|prompt|rows/);
 assert.deepEqual(team.snapshot().nodes[1].proposals,stored);
});
test('团队安全事件与提案拒绝未知类型及控制字段',()=>{
 assert.equal(api.safeTeamEvent({type:'shell',nodeId:'n',status:'running'}),null);
 const event=api.safeTeamEvent({type:'proposal.updated',nodeId:'n',status:'completed',proposal:{id:'p',kind:'clean',status:'accepted',summary:'清理提案',prompt:'PRIVATE'},prompt:'PRIVATE',rows:[1],seq:2,createdAt:'2026-11-05T00:00:00.000Z'});
 assert.deepEqual(event,{type:'proposal.updated',nodeId:'n',status:'completed',proposal:{id:'p',kind:'clean',status:'accepted',summary:'清理提案'},seq:2,createdAt:'2026-11-05T00:00:00.000Z'});
 assert.deepEqual(api.safeTeamProposal({id:'p',kind:'chart',status:'accepted',summary:'图表提案',data:{private:true}}),{id:'p',kind:'chart',status:'accepted',summary:'图表提案'});
});
test('团队提案最多保留20条且取消后不再追加',()=>{
 const controller=new AbortController(),team=api.createTeamRuntime({},controller.signal),root=team.createNode(null,{name:'根'});
 const stored=team.recordProposals(root.id,Array.from({length:25},(_,index)=>({id:`proposal-${index}`,kind:'chart',status:'proposed',summary:`提案${index}`,prompt:'PRIVATE'})));
 assert.equal(stored.length,20);assert.equal(stored[0].id,'proposal-5');assert.equal(stored.at(-1).id,'proposal-24');
 controller.abort();assert.throws(()=>team.recordProposals(root.id,[{id:'after-abort',kind:'clean',status:'proposed',summary:'越权追加'}]),{name:'AbortError'});
 assert.equal(team.snapshot().nodes[0].proposals.length,20);
});
