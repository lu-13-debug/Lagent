const fail=message=>{throw Object.assign(new Error(message),{status:400,code:'INVALID_SUBAGENT'});};
const ROLE_TOOLS=new Set(['profile','describe','group','statistics','chart','clean']);
export function validateSubagents(rows,{stageId,profiles=[],judgeId,effort,skills=[]}={}){
 if(rows===undefined)return undefined;
 if(!['insights','report'].includes(stageId)||!Array.isArray(rows)||rows.length>3)fail('仅洞察或报告阶段允许最多3个子智能体');
 const seen=new Set();return rows.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['id','profileId','name','role','maxTokens','timeoutMs','skillId','effort','allowedTools'].includes(k)))fail('子智能体配置字段无效，不允许递归');
  for(const [key,max] of [['id',100],['name',100],['role',300]])if(typeof row[key]!=='string'||!row[key].trim()||[...row[key]].length>max)fail('子智能体名称、职责或ID无效');
  if(seen.has(row.id))fail('子智能体ID不得重复');seen.add(row.id);
  const profile=profiles.find(p=>p.id===row.profileId);if(!profile||profile.unavailable||row.profileId===judgeId)fail('子智能体模型不存在、不可用或与主模型相同');
  if(row.skillId!==undefined&&!skills.some(s=>s.id===row.skillId&&s.enabled&&s.stageId===stageId))fail('子智能体Skill不存在、已禁用或不适用');
  if(row.allowedTools!==undefined){
    if(!Array.isArray(row.allowedTools)||new Set(row.allowedTools).size!==row.allowedTools.length||row.allowedTools.some(name=>!ROLE_TOOLS.has(name)))fail('子智能体工具权限无效');
  }
  const effectiveEffort=row.effort??effort;
  if(effectiveEffort&&profile.capabilities?.efforts&&!profile.capabilities.efforts.includes(effectiveEffort))fail('子智能体模型不支持阶段思考强度');
  for(const [key,min,max] of [['maxTokens',256,32768],['timeoutMs',1000,300000]])if(row[key]!==undefined&&(!Number.isInteger(row[key])||row[key]<min||row[key]>max))fail('子智能体Token或超时预算越界');
  return {...row, ...(row.allowedTools ? {allowedTools:[...row.allowedTools]} : {})};
 });
}
const text=(v,max)=>typeof v==='string'?[...v].slice(0,max).join(''):'';
export function projectSubagentResult(result,validRefs=new Set()){
 return {summary:text(result?.summary,1000),findings:(Array.isArray(result?.findings)?result.findings:[]).filter(f=>f&&typeof f.title==='string'&&f.title.trim()&&Array.isArray(f.evidenceRefs)&&f.evidenceRefs.length&&f.evidenceRefs.every(id=>validRefs.has(id))).slice(0,8).map(f=>({title:text(f.title,100),detail:text(f.detail,400),evidenceRefs:[...f.evidenceRefs]})),recommendations:(Array.isArray(result?.recommendations)?result.recommendations:[]).filter(v=>typeof v==='string').slice(0,8).map(v=>text(v,300))};
}
