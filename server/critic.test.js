import test from 'node:test';import assert from 'node:assert/strict';
const api=await import('./critic.js').catch(()=>({}));
test('方向冲突须同口径数值比较，关键词或不同窗口不误报',()=>{
 const claim={metricId:'revenue',period:{start:'a',end:'b'},comparisonPeriod:{start:'c',end:'d'},unit:'元',change:2};
 const report={findings:[{title:'下降字样只是背景',claims:[claim]},{title:'增长观察',claims:[{...claim,change:-2}]}]};
 assert.ok(api.critiqueResult(report).issues.some(i=>i.code==='CRITIC_DIRECTION_CONFLICT'));
 report.findings[1].claims[0].comparisonPeriod={start:'x',end:'y'};assert.ok(!api.critiqueResult(report).issues.some(i=>i.code==='CRITIC_DIRECTION_CONFLICT'));
 delete report.findings[1].claims[0].change;assert.ok(!api.critiqueResult(report).issues.some(i=>i.code==='CRITIC_DIRECTION_CONFLICT'));
});
test('异常或无法评审必须unreviewed，不能伪造pass',()=>{
 assert.equal(api.critiqueResult({findings:{}}).verdict,'unreviewed');
 assert.equal(api.critiqueResult(undefined).verdict,'unreviewed');
 assert.equal(api.critiqueResult({get findings(){throw Error('PRIVATE');}}).verdict,'unreviewed');
});
test('确定性Critic通过、证据阻断与空建议警告',()=>{
 assert.equal(api.critiqueResult({findings:[],recommendations:[]},{}).verdict,'pass');
 const bad=api.critiqueResult({findings:[{title:'发现',evidenceRefs:[]}]},{});assert.equal(bad.verdict,'reject');assert.equal(bad.issues[0].code,'CRITIC_EVIDENCE');
 assert.equal(api.critiqueResult({findings:[],recommendations:['']},{}).verdict,'revise');
});
test('legacy不阻断，unverified阻断；metrics冲突与期间稳定键序',()=>{
 assert.notEqual(api.critiqueResult({findings:[{title:'确定性发现'}]}).verdict,'reject');
 assert.equal(api.critiqueResult({findings:[{title:'未核验',unverified:true}]}).verdict,'reject');
 const report={metrics:[{id:'revenue',value:2,unit:'元',period:{start:'a',end:'b'}}],findings:[{title:'结果',claims:[{metricId:'revenue',value:3,unit:'元',period:{end:'b',start:'a'}}]}]};
 assert.equal(api.critiqueResult(report).verdict,'reject');report.findings[0].claims[0].value=2;assert.notEqual(api.critiqueResult(report).verdict,'reject');
});
test('图表、覆盖、建议与计划排除回归',()=>{
 assert.equal(api.critiqueResult({figureRefs:['missing']}).verdict,'reject');
 assert.equal(api.critiqueResult({coverage:{daily:{truncated:true}}}).verdict,'revise');
 assert.equal(api.critiqueResult({coverage:{daily:{truncated:true}},limitations:['样本截断']}).verdict,'pass');
 assert.equal(api.critiqueResult({recommendations:['待补充']}).verdict,'revise');
 const p={questions:[],steps:[{id:'s',stageId:'activity',purpose:'核对',expectedOutput:'结果',dependsOn:[],optional:true}],evidenceRequirements:[],confirmations:[]};assert.equal(api.critiquePlan(p,{task:{skippedSteps:['activity']}}).verdict,'revise');
});
test('计划阻塞、排除阶段与待确认事项不能伪造通过',()=>{
 const plan={questions:[{id:'q',question:'核对活跃',stageIds:['activity'],metricIds:['dau'],priority:'must',status:'blocked'}],steps:[],evidenceRequirements:[],confirmations:[{id:'c',topic:'范围',question:'确认范围',blocking:true}]};
 const verdict=api.critiquePlan(plan,{task:{skippedSteps:['activity']}});assert.equal(verdict.verdict,'reject');assert.ok(verdict.issues.some(i=>i.code==='CRITIC_CONFIRMATION'));
});
