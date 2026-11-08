import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('./numeric-transforms.js').catch(()=>({}));
const evidence=[{id:'a',metricId:'revenue',value:12345,unit:'元',denominator:'orders',period:'month',datasetVersion:1,text:'收入12345元'},{id:'b',metricId:'rate',value:25,unit:'%',denominator:'users',period:'month',datasetVersion:1},{id:'c',metricId:'rate',value:20,unit:'%',denominator:'users',period:'month',datasetVersion:1}];
test('命名确定性变换记录输入参数结果且拒绝任意换算',()=>{
 assert.equal(typeof api.applyNumericTransform,'function');
 const request={name:'unit-conversion',inputRefs:['a'],parameters:{toUnit:'万元'}};const result=api.applyNumericTransform(request,evidence);
 assert.equal(result.evidence.value,1.2345);assert.equal(result.evidence.unit,'万元');assert.deepEqual(result.receipt.inputRefs,['a']);assert.equal(result.receipt.outputRef,result.evidence.id);assert.deepEqual(api.applyNumericTransform(request,evidence),result);
 assert.equal(api.applyNumericTransform({name:'round',inputRefs:['a'],parameters:{digits:0}},evidence).evidence.value,12345);
 assert.equal(api.applyNumericTransform({name:'percentage-point-difference',inputRefs:['b','c'],parameters:{}},evidence).evidence.value,5);
 for(const request of [{name:'free text',inputRefs:['a'],parameters:{}},{name:'unit-conversion',inputRefs:['a'],parameters:{toUnit:'美元',factor:2}},{name:'round',inputRefs:['missing'],parameters:{digits:2}}]) assert.throws(()=>api.applyNumericTransform(request,evidence));
});
