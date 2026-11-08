import test from 'node:test';import assert from 'node:assert/strict';
const m=await import('./model-usage.ts').catch(()=>({}));
test('价格按账号服务隔离',()=>{assert.notEqual(m.modelRateKey('cloud','a','x'),m.modelRateKey('cloud','b','x'));assert.notEqual(m.modelRateKey('local',null,'x'),m.modelRateKey('local',null,'y'));});
test('损坏及禁用存储回退',()=>{assert.deepEqual(m.readModelRates({getItem:()=>'{bad'},'k'),{});assert.deepEqual(m.readModelRates({getItem(){throw Error()}},'k'),{});});
test('单价仅保留有限非负数',()=>{let saved; m.writeModelRates({setItem:(k,v)=>saved=v},'k',{ok:{input:0,output:2},bad:{input:-1,output:1}});assert.deepEqual(JSON.parse(saved),{ok:{input:0,output:2}});});
test('同模型不同协议保留明细',()=>{const rows=m.mergeUsageRows({byModel:[{provider:'p',model:'m',protocol:'x',calls:1,inputTokens:10,outputTokens:20,totalTokens:30},{provider:'p',model:'m',protocol:'y',calls:2,inputTokens:5,outputTokens:4,totalTokens:9}]});assert.equal(rows.length,1);assert.equal(rows[0].calls,3);assert.equal(rows[0].protocolRows.length,2);});
test('无单价或缺用量无法估算',()=>{assert.equal(m.estimateUsageCost({provider:'p',model:'m',inputTokens:1,outputTokens:2},{}),null);assert.equal(m.estimateUsageCost({provider:'p',model:'m',inputTokens:null,outputTokens:2},{['p\0m']:{input:1,output:2}}),null);});
test('格式化不将零视为缺失',()=>{assert.equal(m.formatTokens(null),'未返回');assert.equal(m.formatTokens(0),'0');assert.equal(m.formatUsageMissing(null),'未返回');});
test('部分字段未返回不按零估算',()=>{assert.equal(m.estimateUsageCost({provider:'p',model:'m',protocol:'x',inputTokens:0,outputTokens:1,inputMissing:1},{['p\0m']:{input:1,output:1}}),null);});
test('多协议逐行计算且保留Anthropic缓存输入',()=>{
 const rows=m.mergeUsageRows({byModel:[{provider:'p',model:'m',protocol:'chat-completions',calls:1,inputTokens:1000000,outputTokens:0,totalTokens:1000000},{provider:'p',model:'m',protocol:'anthropic',calls:1,inputTokens:1000000,outputTokens:500000,totalTokens:1500000,cacheReadInputTokens:500000,cacheCreationInputTokens:500000}]});
 assert.equal(m.estimateUsageCost(rows[0],{['p\0m']:{input:2,output:4}}),8);
});
