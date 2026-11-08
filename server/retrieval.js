import { getMetricCatalog } from './metric-catalog.js';
import { isAnalysisOutputField } from './analysis-tools.js';
const clip=(v,n=400)=>[...String(v??'')].slice(0,n).join('');
export function tokenize(value){const text=String(value).normalize('NFKC').toLowerCase();return [...(text.match(/[a-z0-9_]+/g)||[]),...(text.match(/[\p{Script=Han}]+/gu)||[]).flatMap(s=>s.length===1?[s]:Array.from({length:s.length-1},(_,i)=>s.slice(i,i+2)))];}
export function buildRetrievalCorpus({tasks=[],metrics,memory=[],ownerId='local',now=Date.now(),dataset={},domain='game',limit=60,currentTaskId=dataset.currentTaskId}){
 const docs=(metrics||getMetricCatalog(domain)).map(m=>({id:`metric:${m.id}`,kind:'metric',sourceId:m.id,text:clip([m.label,m.definition,(m.source?.tables||[]).join(' '),m.definitionStatus].filter(Boolean).join(' ')),stageIds:[],metricIds:[m.id],tags:m.source?.tables||[],authority:'authoritative',updatedAt:''}));
 for(const table of ['users','activity','payments']){
  const fields=new Map();for(const row of (dataset.records?.[table]||[]).slice(0,20))for(const [key,value] of Object.entries(row))if(isAnalysisOutputField(key))fields.set(key,typeof value);
  if(fields.size)docs.push({id:`field:${table}`,kind:'field',sourceId:table,text:[...fields].map(([k,t])=>`${k}:${t}`).join(' '),stageIds:[],metricIds:docs.filter(d=>d.tags.includes(table)).flatMap(d=>d.metricIds),tags:[table],authority:'authoritative',updatedAt:''});
 }
 for(const task of tasks.filter(t=>t.id!==currentTaskId&&t.domain===domain&&t.status==='completed').sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))||String(a.id).localeCompare(String(b.id))).slice(0,Math.max(0,Math.min(60,limit))))docs.push({id:`task:${task.id}`,kind:'task',sourceId:task.id,text:JSON.stringify({title:clip(task.title),goal:clip(task.goal),summary:clip(task.report?.summary),findings:(task.report?.findings||[]).slice(0,3).map(f=>clip(f.title,100)),skippedSteps:task.skippedSteps||[],datasetName:clip(task.datasetName)}),stageIds:[],metricIds:[],tags:[],authority:'historical',updatedAt:task.updatedAt||''});
 for(const m of memory.filter(m=>m.ownerId===ownerId&&m.enabled&&m.status==='confirmed'&&Date.parse(m.expiresAt)>now))docs.push({id:`memory:${m.id}`,kind:'memory',sourceId:m.id,text:`${m.key}: ${m.value}`,stageIds:[],metricIds:[],tags:[m.type,m.scope],authority:m.type==='preference'?'authoritative':'historical',updatedAt:m.updatedAt});
 return docs;
}
export function retrievalQuery({task={},stage={},plan={},report={}}){return {mode:'lexical',text:[stage.id,clip(task.goal,1000),...(plan.questions||[]).map(q=>q.question),JSON.stringify(report.coverage||{})].join(' '),metricIds:[...new Set([...(plan.metricIds||[]),...(plan.questions||[]).flatMap(q=>q.metricIds||[]),...(plan.evidenceRequirements||[]).map(e=>e.metricId).filter(Boolean)])]};}
export function retrieveDocuments({corpus=[],query='',stageId,limit=8,maxChars=4000}){
 const words=tokenize(typeof query==='string'?query:query.text);const ids=query.metricIds||[];const seen=new Set();const candidates=[];let preferences=0;
 for(const doc of corpus){if(seen.has(doc.id)||doc.stageIds?.length&&!doc.stageIds.includes(stageId))continue;seen.add(doc.id);const tokens=tokenize(doc.text);let score=0;
  for(const word of new Set(words)){const frequency=tokens.filter(t=>t===word).length;if(frequency)score+=(1+Math.log(frequency))*Math.log(1+corpus.length/(1+corpus.filter(d=>tokenize(d.text).includes(word)).length));}
  const preference=doc.kind==='memory'&&doc.tags.includes('preference');if(preference&&preferences++>=3)continue;
  const pinned=preference||doc.authority==='authoritative'&&doc.metricIds?.some(id=>ids.includes(id));if(!score&&!pinned)continue;score+=(preference?10000:pinned?100:0)+(doc.authority==='authoritative'?.1:0);candidates.push({...doc,score,reason:pinned?'计划指标或用户表达偏好':'词法匹配'});
 }
 let remaining=Math.max(0,Math.min(4000,maxChars));return candidates.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,Math.max(0,Math.min(8,limit))).flatMap(({id,kind,sourceId,text,score,reason})=>{if(!remaining)return [];text=clip(text,remaining);remaining-=[...text].length;return [{id,kind,sourceId,text,score,reason}];});
}
