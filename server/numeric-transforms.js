import {createHash} from 'node:crypto';
export const NUMERIC_TRANSFORM_VERSION='numeric-1';
const fail=message=>{throw Object.assign(new Error(message),{code:'INVALID_REPORT',modelFailure:true});};
const scales={'元':{group:'cny',scale:1},'万元':{group:'cny',scale:10000},'亿元':{group:'cny',scale:100000000},'人':{group:'people',scale:1},'万人':{group:'people',scale:10000},'%':{group:'ratio',scale:0.01},'比例':{group:'ratio',scale:1}};
export function applyNumericTransform(request={},evidence=[]) {
 const {name,inputRefs,parameters={}}=request;
 if(!Array.isArray(inputRefs)||!inputRefs.length||!parameters||typeof parameters!=='object'||Array.isArray(parameters))fail('变换缺少输入证据或参数');
 const inputs=inputRefs.map(id=>evidence.find(e=>e.id===id));
 if(inputs.some(e=>!e||typeof e.value!=='number'||!Number.isFinite(e.value)))fail('变换输入必须是有限数值证据');
 const first=inputs[0];let value,unit=first.unit;
 if(name==='unit-conversion') {
  if(inputs.length!==1||Object.keys(parameters).some(k=>k!=='toUnit'))fail('单位换算参数无效');
  const from=scales[first.unit],to=scales[parameters.toUnit];
  if(!from||!to||from.group!==to.group)fail('不支持的单位换算');
  value=first.value*from.scale/to.scale;unit=parameters.toUnit;
 } else if(name==='round') {
  if(inputs.length!==1||Object.keys(parameters).some(k=>k!=='digits')||!Number.isInteger(parameters.digits)||parameters.digits<0||parameters.digits>10)fail('舍入参数无效');
  value=Number(first.value.toFixed(parameters.digits));
 } else if(name==='percentage-point-difference') {
  if(inputs.length!==2||Object.keys(parameters).length||inputs.some(e=>e.unit!=='%'))fail('百分点差要求两个百分比证据');
  for(const key of ['metricId','denominator','period','datasetVersion'])if(JSON.stringify(inputs[0][key])!==JSON.stringify(inputs[1][key]))fail('百分点差输入口径不匹配');
  value=Number((inputs[0].value-inputs[1].value).toPrecision(15));unit='百分点';
 } else fail('未知命名数值变换');
 if(!Number.isFinite(value))fail('变换结果不是有限数值');
 const params=Object.fromEntries(Object.entries(parameters).sort(([a],[b])=>a.localeCompare(b)));
 const signature=JSON.stringify({name,inputs,parameters:params,ruleVersion:NUMERIC_TRANSFORM_VERSION});
 const id=`transform:${createHash('sha256').update(signature).digest('hex')}`;
 const output={...first,id,value,unit,source:'numeric-transform',text:`${first.metricId}：${value} ${unit}`,transformName:name,inputRefs:[...inputRefs]};
 const receipt={id:`receipt:${id}`,name,inputRefs:[...inputRefs],inputs:structuredClone(inputs),parameters:params,outputRef:id,output:{value,unit},ruleVersion:NUMERIC_TRANSFORM_VERSION,status:'pass'};
 return {evidence:output,receipt};
}
