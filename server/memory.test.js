import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('./memory.js').catch(()=>({}));
const input={scope:'user',type:'preference',key:'报告语言',value:'使用中文',status:'confirmed',enabled:true};
test('500条上限及owner和scope去重边界',()=>{
 const memories=Array.from({length:500},(_,i)=>({...input,id:String(i),ownerId:'a',key:String(i),version:1}));
 assert.throws(()=>api.saveMemory(input,{ownerId:'a',memories}));
 assert.equal(api.saveMemory({...input,key:'0'},{ownerId:'a',memories}).version,2);
 assert.equal(api.saveMemory(input,{ownerId:'b',memories}).ownerId,'b');
 assert.throws(()=>api.saveMemory({value:'改写'},{ownerId:'b',existing:memories[0]}));
});
test('显式记忆校验、默认TTL、版本和归属隔离',()=>{
 const first=api.saveMemory(input,{ownerId:'a',now:'2026-11-05T00:00:00.000Z',memories:[]});
 assert.equal(first.version,1);assert.equal(first.ownerId,'a');assert.equal(Date.parse(first.expiresAt)-Date.parse(first.createdAt),180*86400000);
 const next=api.saveMemory({...input,value:'简体中文'},{ownerId:'a',memories:[first]});assert.equal(next.id,first.id);assert.equal(next.version,2);
 assert.deepEqual(api.visibleMemories([first],{ownerId:'b'}),[]);
});
test('拒绝越界和敏感内容，软删除可恢复、过期隐藏',()=>{
 for(const patch of [{scope:'global'},{value:'x'.repeat(2001)},{value:'user_id: 123'},{value:'api_key=secret'},{expiresAt:'invalid'}])assert.throws(()=>api.saveMemory({...input,...patch},{ownerId:'a'}));
 const first=api.saveMemory(input,{ownerId:'a'});const deleted=api.saveMemory({enabled:false},{ownerId:'a',existing:first});assert.equal(deleted.enabled,false);
 assert.equal(api.saveMemory({enabled:true},{ownerId:'a',existing:deleted}).enabled,true);
 assert.deepEqual(api.visibleMemories([{...first,expiresAt:'2020-01-01'}],{ownerId:'a'}),[]);
});
