const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:0;
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const array=(v:unknown)=>Array.isArray(v)?v:[];
const labels:Record<string,string>={completed:'完成',round_budget:'轮次预算耗尽',tool_budget:'工具预算耗尽',invalid_action:'操作无效',tool_error:'工具失败',cancelled:'已取消',failed:'失败',running:'进行中',success:'成功',recoverable_error:'可修复错误',pass:'通过',revise:'需修订',reject:'未通过',unreviewed:'未审查'};
export function traceLabel(status:unknown){return typeof status==='string'?labels[status]||'未知':'未知';}
export function summarizeAgentTrace(artifact:unknown){
 const a=obj(artifact),trace=obj(a.trace),usage=obj(trace.usage),retrieval=obj(a.retrieval),critic=obj(a.critic),issues=array(critic.issues);
 const tools=new Set(['profile','clean','describe','group','statistics','chart','numeric-transform']);
 return {recorded:!!(a.trace||a.retrieval||a.critic),rounds:number(trace.round),actions:array(trace.actions).map(value=>{const action=obj(value);return {tool:tools.has(String(action.tool))?String(action.tool):'未知工具',status:typeof action.status==='string'&&labels[action.status]?action.status:'unknown',durationMs:number(action.durationMs),resultBytes:number(action.resultBytes)};}),usage:{calls:number(usage.calls),totalTokens:number(usage.totalTokens)},stopReason:typeof trace.stopReason==='string'&&labels[trace.stopReason]?trace.stopReason:'unknown',retrieval:{count:number(retrieval.count),ids:array(retrieval.ids).filter((id):id is string=>typeof id==='string'&&id.length<=160&&/^[\w:.-]+$/.test(id))},critic:{verdict:['pass','revise','reject','unreviewed'].includes(String(critic.verdict))?String(critic.verdict):'unknown',blocking:issues.filter(i=>obj(i).severity==='blocking').length,warning:issues.filter(i=>obj(i).severity==='warning').length}};
}
export function budgetView(trace:{rounds:number;actions:unknown[];usage:{calls:number;totalTokens:number};stopReason:string},limits?:{maxRounds?:number;maxToolCalls?:number;maxTokens?:number}){
 const rounds=limits?.maxRounds,tools=limits?.maxToolCalls,tokens=limits?.maxTokens;
 return {rounds:`${trace.rounds} / ${rounds??'未记录'}`,tools:`${trace.actions.length} / ${tools??'未记录'}`,tokens:`${trace.usage.totalTokens} / ${tokens??'未记录'}`,exceeded:!!((rounds!==undefined&&trace.rounds>rounds)||(tools!==undefined&&trace.actions.length>tools)||(tokens!==undefined&&trace.usage.totalTokens>tokens)),stopReason:traceLabel(trace.stopReason)};
}
