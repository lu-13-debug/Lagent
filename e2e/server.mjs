import express from 'express';
import { stageReply } from '../server/stage-reply-fixture.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCloudApp } from '../server/cloud-app.js';
const dir=await mkdtemp(path.join(tmpdir(),'lagent-e2e-'));let calls=0; const stageCalls=[];
const cloud=createCloudApp({dataDir:dir,credentialMasterKey:Buffer.alloc(32,4).toString('base64'),production:false,now:()=>Date.parse('2026-10-30T12:00:00Z'),fetchImpl:async(_url,init)=>{
 const body=JSON.parse(init.body);calls++;
 if(body.model==='mock-401') return Response.json({}, {status:401});
 const payload=JSON.parse(body.messages.find(m=>m.role==='user').content);
 if(!Array.isArray(payload.facts)) {
   stageCalls.push({model:body.model,effort:body.reasoning_effort});
   const first=body.messages[0]?.content||'';
   const drawn=body.messages.some(m=>m.role==='user'&&m.content.includes('toolResults'));
   return Response.json({choices:[{message:{content:JSON.stringify(stageReply(body, {operations:first.includes('阶段：charts')&&!drawn?[{tool:'chart',input:{kind:'line',source:'daily',x:'date',y:'revenue',title:'每日收入趋势',unit:'CNY'}}]:[]}))}}],usage:{prompt_tokens:40,completion_tokens:20,total_tokens:60}});
 }
 const fact=payload.facts.find(f=>f.id==='metric:dau') || payload.facts[0];
 return Response.json({choices:[{message:{content:JSON.stringify({summary:'仅根据聚合事实分析。',findings:[{title:'活跃事实',detail:fact.text,severity:'neutral',evidence:fact.text,kind:'fact',evidenceRefs:[fact.id]}],recommendations:['结合完整覆盖范围核对数据。']})}}]});
}});
const app=express();app.get('/__e2e/stats',(_req,res)=>res.json({calls,stageCalls}));app.use(cloud);
const server=app.listen(3199,'127.0.0.1',()=>console.log('e2e ready'));
let stopped=false;async function stop(){if(stopped)return;stopped=true;server.closeAllConnections();await new Promise(r=>server.close(r));cloud.locals.close();await rm(dir,{recursive:true,force:true});process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
