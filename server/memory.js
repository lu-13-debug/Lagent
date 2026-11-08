import { randomUUID } from 'node:crypto';
const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'INVALID_MEMORY'});};
const allowed=['scope','type','key','value','sourceTaskId','evidenceRefs','confidence','status','enabled','expiresAt','sensitivity'];
export function saveMemory(input,{ownerId='local',memories=[],existing,now=new Date().toISOString()}={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail('记忆字段无效');
 if(existing&&existing.ownerId!==ownerId)fail('记忆不存在');
 const candidate={scope:'user',status:'candidate',enabled:true,sensitivity:'private',...existing,...input};
 for(const [key,values] of Object.entries({scope:['user','project'],type:['preference','glossary','decision','finding','constraint'],status:['candidate','confirmed','rejected'],sensitivity:['public','internal','private']}))if(!values.includes(candidate[key]))fail('记忆枚举无效');
 if(typeof candidate.enabled!=='boolean')fail('启用状态无效');
 for(const [key,max] of [['key',120],['value',2000]])if(typeof candidate[key]!=='string'||!candidate[key].trim()||[...candidate[key]].length>max)fail('记忆文本长度无效');
 candidate.key=candidate.key.trim();candidate.value=candidate.value.trim();
 if(/user[_ -]?id|order[_ -]?id|订单号|api[_ -]?key|sk-[a-z0-9]|Bearer\s|BEGIN.*PRIVATE KEY|提示词|system\s*prompt|"records"\s*:|"sections"\s*:/i.test(candidate.value+' '+candidate.key))fail('记忆含敏感标识、凭据或禁止的原始内容');
 if(candidate.confidence!==undefined&&(!Number.isFinite(candidate.confidence)||candidate.confidence<0||candidate.confidence>1))fail('置信度无效');
 if(candidate.sourceTaskId!==undefined&&(typeof candidate.sourceTaskId!=='string'||candidate.sourceTaskId.length>120))fail('来源任务无效');
 if(candidate.evidenceRefs!==undefined&&(!Array.isArray(candidate.evidenceRefs)||candidate.evidenceRefs.length>20||candidate.evidenceRefs.some(r=>typeof r!=='string'||r.length>160)))fail('证据引用无效');
 const prior=existing||memories.find(m=>m.ownerId===ownerId&&m.scope===candidate.scope&&m.type===candidate.type&&m.key===candidate.key);
 if(!prior&&memories.filter(m=>m.ownerId===ownerId).length>=500)fail('每个用户最多500条记忆');
 const expiresAt=candidate.expiresAt??new Date(Date.parse(now)+180*86400000).toISOString();
 if(!Number.isFinite(Date.parse(expiresAt))||!Number.isFinite(Date.parse(now)))fail('记忆日期无效');
 return {...candidate,id:prior?.id||randomUUID(),ownerId,version:(prior?.version||0)+1,createdAt:prior?.createdAt||now,updatedAt:now,expiresAt};
}
export function visibleMemories(memories,{ownerId='local',scope,type,status,includeExpired=false,now=Date.now()}={}){
 return memories.filter(m=>m.ownerId===ownerId&&(!scope||m.scope===scope)&&(!type||m.type===type)&&(!status||m.status===status)&&(includeExpired||Date.parse(m.expiresAt)>Number(now)));
}
