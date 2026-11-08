import { ANALYSIS_TOOL_NAMES, ANALYSIS_INPUT_SCHEMAS, validateAnalysisTool, isAnalysisOutputField } from './analysis-tools.js';
import { STAGE_DEFINITIONS } from './workflow-config.js';

const invalid = message => Object.assign(new Error(message), {code:'ANALYSIS_TOOL_INVALID'});
const names=[...ANALYSIS_TOOL_NAMES,'numeric-transform','delegate'];
export const AGENT_TOOLS=Object.freeze(Object.fromEntries(names.map(name=>[name,Object.freeze({name,description:`受限聚合分析工具 ${name}`,inputSchema:{type:'object',properties:Object.fromEntries((ANALYSIS_INPUT_SCHEMAS[name]||['name','inputRefs','parameters']).map(key=>[key,{}])),additionalProperties:false},allowedStages:Object.freeze(STAGE_DEFINITIONS.map(([id])=>id)),sideEffects:['clean','numeric-transform'].includes(name),timeout:name==='numeric-transform'?5000:30000,resultProjection:'registered-aggregate-fields-v1'})])));

export function validateAgentAction(operation,stage) {
 if(operation?.tool==='delegate')return validateDelegateAction(operation,stage.subagents,stage.id,stage.team?.enabled);
 if(!operation||typeof operation!=='object'||Array.isArray(operation)||!Object.hasOwn(AGENT_TOOLS,operation.tool))throw invalid('未知或不允许的工具');
 if(!AGENT_TOOLS[operation.tool].allowedStages.includes(stage?.id))throw invalid('不允许的阶段工具请求');
 if(operation.tool!=='numeric-transform'&&Array.isArray(stage?.skill?.allowedTools)&&!stage.skill.allowedTools.includes(operation.tool))throw invalid('此阶段不允许调用该工具');
 if(!operation.input||typeof operation.input!=='object'||Array.isArray(operation.input)||Buffer.byteLength(JSON.stringify(operation.input))>12000)throw invalid('工具参数结构或长度无效');
 if(operation.tool!=='numeric-transform')validateAnalysisTool(operation.tool,operation.input);
 else {
  const input=operation.input, keys=Object.keys(AGENT_TOOLS['numeric-transform'].inputSchema.properties);
  if(Object.keys(input).some(key=>!keys.includes(key)))throw invalid('包含未注册的数值变换参数');
  if(keys.some(key=>!Object.hasOwn(input,key)))throw Object.assign(new Error('数值变换缺少必需参数'),{code:'ANALYSIS_TOOL_MISSING_PARAMETER'});
  if(typeof input.name!=='string'||!input.name.trim()||!Array.isArray(input.inputRefs)||!input.inputRefs.length||input.inputRefs.some(ref=>typeof ref!=='string'||!ref)||!input.parameters||typeof input.parameters!=='object'||Array.isArray(input.parameters))throw invalid('数值变换参数结构无效');
 }
 return operation;
}
export function validateDelegateAction(operation,subagents,stageId,teamEnabled=false){
 const input=operation?.input;
 if(!['insights','report'].includes(stageId)||!subagents?.length||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!(teamEnabled?['subagentId','question','focus','dependsOn','resultId','decision']:['subagentId','question','focus']).includes(k))||!subagents.some(s=>s.id===input.subagentId)||typeof input.question!=='string'||!input.question.trim()||input.question.length>1000||input.focus!==undefined&&(typeof input.focus!=='string'||input.focus.length>300))throw invalid('子智能体委派参数或权限无效');
 if(input.dependsOn!==undefined&&(!Array.isArray(input.dependsOn)||input.dependsOn.length>3||input.dependsOn.some(id=>typeof id!=='string')))throw invalid('团队依赖无效');
 if(input.decision!==undefined&&(!['accept','reject'].includes(input.decision)||typeof input.resultId!=='string'))throw invalid('团队验收无效');
 return operation;
}
const recoverable={ANALYSIS_TOOL_MISSING_PARAMETER:'缺少必需参数，请补充后重试。',ANALYSIS_TOOL_FIELD_NOT_FOUND:'所需字段无覆盖，请选择已提供的字段。',ANALYSIS_TOOL_EMPTY_RESULT:'当前范围没有可用结果，请调整已授权参数。',ANALYSIS_TOOL_TIMEOUT:'工具执行超时，可缩小范围后重试。'};
export function classifyToolError(error) {
 if(error?.name==='AbortError')throw error;
 const code=Object.hasOwn(recoverable,error?.code)?error.code:'ANALYSIS_TOOL_INVALID';
 return {recoverable:code!=='ANALYSIS_TOOL_INVALID',code,message:recoverable[code]||'工具请求无效或超出授权范围。'};
}
const metadata=new Set(['fields','distinct','tables','users','activity','payments','table','columns','rows','rowsBefore','rowsAfter','changedCells','operations','mode','requiresConfirmation','summary','privacy','count','mean','std','min','max','median','q1','q3','missing','missingRate','unique','dtype','type','nonNull','nulls','totalGroups','truncated','data','date','name','label','kind','title','source','x','y','unit','caption','method','n','statistic','pValue','note','evidence','receipt','id','value','metricId','denominator','period','start','end','datasetVersion','text','transformName','inputRefs','name','parameters','toUnit','digits','outputRef','output','ruleVersion','status','inputs','coverage','providedRows','totalRows']);
export function projectToolResult(tool,result,{scope='当前任务已授权聚合范围'}={}) {
 const wire=JSON.stringify(result);if(!wire||Buffer.byteLength(wire)>1024*1024)throw invalid('工具结果超过允许大小');
 if(Array.isArray(result?.data)&&!result.data.length)throw Object.assign(new Error('没有可用聚合结果'),{code:'ANALYSIS_TOOL_EMPTY_RESULT'});
 let truncated=false;
 const visit=(value,depth=0,fieldsOnly=false)=>{
  if(depth>12){truncated=true;return null;}
  if(Array.isArray(value)){if(value.length>100)truncated=true;return value.slice(0,100).map(v=>visit(v,depth+1,fieldsOnly));}
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>isAnalysisOutputField(key)||fieldsOnly&&tool==='chart'&&['lower','upper','count'].includes(key)||!fieldsOnly&&metadata.has(key)).map(([key,v])=>[key,visit(key==='fields'&&Array.isArray(v)?v.filter(f=>f&&isAnalysisOutputField(f.name)):v,depth+1,key==='data'||key==='columns'||key==='rows'&&Array.isArray(v))]));
  if(typeof value==='string'){if(value.length>1200)truncated=true;return value.slice(0,1200);}
  return typeof value==='number'&&!Number.isFinite(value)?null:value;
 };
 const safe=visit(result);const totalRows=Number.isSafeInteger(result?.totalGroups)?result.totalGroups:Array.isArray(result?.data)?result.data.length:Number.isSafeInteger(result?.rows)?result.rows:0;
 const output={...(safe&&typeof safe==='object'&&!Array.isArray(safe)?safe:{result:safe}),truncated:truncated||result?.truncated===true||totalRows>(safe?.data?.length??totalRows),totalRows,scope:typeof scope==='string'?scope.slice(0,300):'当前任务已授权聚合范围'};
 if(Buffer.byteLength(JSON.stringify(output))>80000)throw invalid('工具投影超过允许大小');
 return output;
}
