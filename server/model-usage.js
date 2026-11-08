import { randomUUID } from 'node:crypto';

const fields=['inputTokens','outputTokens','totalTokens','cacheReadInputTokens','cacheCreationInputTokens','reasoningTokens'];
const text=value=>typeof value==='string'?value.replace(/[\r\n]/g,'').slice(0,200):'';
const token=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const instant=value=>{const d=new Date(typeof value==='function'?value():value??Date.now());return Number.isFinite(d.getTime())?d.toISOString():null;};
const day=value=>{if(value==null)return null;const iso=instant(value);return iso?new Date(Date.parse(iso)+8*3600000).toISOString().slice(0,10):null;};
export function modelCallEntry({call={},taskId,stage={},kind='stage',lens=null,now}={}) {
  return {id:randomUUID(),taskId:text(taskId),stageId:text(stage.id??stage.stageId),stageName:text(stage.name??stage.stageName),kind:['stage','reviewer','subagent','planner','legacy'].includes(kind)?kind:'stage',lens:kind==='reviewer'?text(lens)||null:null,
    provider:text(call?.provider),model:text(call?.model),effort:text(call?.effort),protocol:text(call?.protocol),...Object.fromEntries(fields.map(f=>[f,token(call?.usage?.[f])])),recordedAt:instant(now)};
}
export function legacyUsageEntry(task) {
  if(!task?.report?.aiUsage||task.workflowSnapshot)return null;
  const entry=modelCallEntry({taskId:task.id,stage:{id:'legacy',name:'历史单模型'},kind:'legacy',now:task.report.generatedAt??task.completedAt??task.updatedAt??task.createdAt,call:{...task.report.aiUsage,usage:task.report.aiUsage}});
  return {...entry,id:`legacy-${task.id}`,source:'legacy'};
}
const counters=()=>({calls:0,withUsage:0,missingUsage:0,...Object.fromEntries(fields.map(f=>[f,0])),inputMissing:0,outputMissing:0});
function add(row,call){row.calls++;const available=fields.some(f=>token(call[f])!==null);row[available?'withUsage':'missingUsage']++;for(const f of fields)row[f]+=token(call[f])??0;row.inputMissing+=token(call.inputTokens)===null?1:0;row.outputMissing+=token(call.outputTokens)===null?1:0;}
export function summarizeModelUsage({calls=[],tasks=[],days=30,now}={}) {
  const to=day(now??Date.now()),from=days==='all'?null:new Date(Date.parse(`${to}T00:00:00Z`)-(Number(days)-1)*86400000).toISOString().slice(0,10);
  const inRange=date=>date&&date<=to&&(!from||date>=from);
  const ids=new Set(tasks.map(t=>t.id)),ledger=calls.filter(c=>ids.has(c.taskId)||c.kind==='planner'),recorded=new Set(ledger.map(c=>c.taskId));
  const entries=[...ledger];let unledgeredTasks=0;
  for(const task of tasks)if(!recorded.has(task.id)) {
    if(task.workflowSnapshot){if(task.status==='completed'&&inRange(day(task.report?.generatedAt??task.completedAt??task.updatedAt??task.createdAt)))unledgeredTasks++;}
    else {const fallback=legacyUsageEntry(task);if(fallback)entries.push(fallback);}
  }
  const totals=counters(),taskIds=new Set(),maps={byModel:new Map(),byStage:new Map(),byDay:new Map(),byTask:new Map()},review={calls:0,withUsage:0,missingUsage:0,tokens:0};
  for(const raw of entries.sort((a,b)=>(Date.parse(b.recordedAt)||0)-(Date.parse(a.recordedAt)||0))){const date=day(raw.recordedAt);if(!inRange(date))continue;
    const c={...raw,provider:text(raw.provider),model:text(raw.model),protocol:text(raw.protocol),stageId:text(raw.stageId),stageName:text(raw.stageName)};
    add(totals,c);if(c.taskId)taskIds.add(c.taskId);
    const keys={byModel:JSON.stringify([c.provider,c.model,c.protocol]),byStage:c.stageId,byDay:date,byTask:c.taskId};
    const labels={byModel:{provider:c.provider,model:c.model,protocol:c.protocol},byStage:{stageId:c.stageId,stageName:c.stageName},byDay:{date},byTask:{taskId:c.taskId}};
    for(const kind of Object.keys(maps)){if(kind==='byTask'&&!c.taskId)continue;const map=maps[kind],key=keys[kind];if(!map.has(key))map.set(key,{...labels[kind],...counters(),_tasks:new Set()});const row=map.get(key);add(row,c);row._tasks.add(c.taskId);}
    if(c.kind==='reviewer'){review.calls++;review[fields.some(f=>token(c[f])!==null)?'withUsage':'missingUsage']++;review.tokens+=token(c.totalTokens)??0;}
  }
  totals.tasks=taskIds.size;
  const result={range:{days,from,to,timeZone:'Asia/Shanghai'},totals,review,unledgeredTasks};
  for(const [kind,map]of Object.entries(maps))result[kind]=[...map.values()].map(({_tasks,...row})=>({...row,...(kind==='byModel'?{tasks:_tasks.size}:{})}));
  result.byDay.sort((a,b)=>b.date.localeCompare(a.date));
  return result;
}
