import { createWorkEngine } from './engine.js';
import { workEvents } from './effects.js';
import { registerMobileWorkRoutes } from '../mobile-gateway.js';
import { registerMcpRoutes } from './mcp.js';

export function registerWork(app,store,executor,{isSessionValid,onConnect,mobileGateway,mobileOwnerId,onMobileEventConnect,planner,windowBridge,providerRegistry,workspace,brain,allowFilesystemBrowser=false}={}) {
  const events=workEvents();
  const publish=event=>{
    events.publish(event);
    if(mobileGateway)mobileGateway.publish(mobileOwnerId,event);
  };
  const engine=createWorkEngine(store,executor,publish,{planner,windowBridge,workspace,brain});
  app.get('/api/work/bootstrap',(_req,res)=>res.json(engine.bootstrap()));
  app.get('/api/work/projects',(_req,res)=>res.json({projects:engine.listProjects()}));
  if(allowFilesystemBrowser)app.get('/api/work/files',(req,res)=>res.json(engine.listDirectory({path:req.query?.path})));
  app.post('/api/work/projects',(req,res)=>{const result=engine.importProject(req.body);res.status(result.created?201:200).json(result);});
  app.get('/api/work/projects/:id',(req,res)=>res.json({project:engine.getProject(req.params.id)}));
  app.delete('/api/work/projects/:id',(req,res)=>res.json(engine.deleteProject(req.params.id)));
  app.patch('/api/work/projects/:id',(req,res)=>res.json({project:engine.renameProject(req.params.id,req.body)}));
  app.get('/api/work/projects/:id/sessions',(req,res)=>res.json({sessions:engine.scanProjectSessions(req.params.id,req.query?.executor)}));
  app.post('/api/work/projects/:id/sessions',(req,res)=>res.status(201).json(engine.importProjectSession(req.params.id,req.body)));
  app.post('/api/work/projects/:id/chats',(req,res)=>res.status(201).json(engine.createProjectChat(req.params.id,req.body)));
  app.post('/api/work/projects/:id/dispatch',(req,res)=>res.status(201).json(engine.projectDispatch(req.params.id,req.body)));
  app.post('/api/work/projects/:id/teamwork',(req,res)=>res.status(201).json(engine.teamworkStart(req.params.id,req.body)));
  app.get('/api/work/projects/:id/teamworks',(req,res)=>res.json({teamworks:engine.teamworkList(req.params.id)}));
  app.get('/api/work/teamworks/:id',(req,res)=>res.json({teamwork:engine.teamworkGet(req.params.id)}));
  app.post('/api/work/teamworks/:id/assemble',(req,res)=>res.json(engine.teamworkAssemble(req.params.id)));
  app.post('/api/work/teamworks/:id/retry',(req,res)=>res.status(201).json(engine.teamworkRetry(req.params.id,req.body?.partId)));
  app.delete('/api/work/chats/:id',(req,res)=>res.json(engine.deleteProjectChat(req.params.id)));
  app.patch('/api/work/chats/:id',(req,res)=>res.json({chat:engine.renameProjectChat(req.params.id,req.body)}));
  app.post('/api/work/chats/:id/messages',(req,res)=>res.status(201).json({ticket:engine.projectChatMessage(req.params.id,req.body)}));
  app.get('/api/work/chats/:id/tickets',(req,res)=>res.json({tickets:engine.projectChatTickets(req.params.id)}));
  app.get('/api/work/projects/:id/brief',(req,res)=>res.json({brief:engine.projectBrief(req.params.id)}));
  app.put('/api/work/projects/:id/brief',(req,res)=>res.json({brief:engine.saveProjectBrief(req.params.id,req.body)}));
  app.get('/api/work/projects/:id/brief.md',(req,res)=>res.json(engine.projectBriefMarkdown(req.params.id)));
  app.get('/api/work/projects/:id/changes',(req,res)=>res.json({changes:engine.projectChanges(req.params.id)}));
  app.post('/api/work/projects/:id/changes',(req,res)=>res.status(201).json({change:engine.recordProjectChange(req.params.id,req.body)}));
  app.delete('/api/work/projects/:id/changes/:changeId',(req,res)=>res.json(engine.deleteProjectChange(req.params.id,req.params.changeId)));
  app.get('/api/work/projects/:id/memory',(req,res)=>res.json(engine.projectMemoryDigest(req.params.id)));
  app.delete('/api/work/projects/:id/memory/:memoryId',(req,res)=>res.json(engine.deleteProjectMemory(req.params.id,req.params.memoryId)));
  app.get('/api/work/policy',(_req,res)=>res.json({policy:engine.policy()}));
  app.put('/api/work/policy',(req,res)=>res.json({policy:engine.updatePolicy(req.body)}));
  app.post('/api/work/plans',(req,res)=>res.status(201).json({plan:engine.plan(req.body)}));
  app.post('/api/work/plans/suggest',async(req,res)=>res.json(await engine.suggestPlan(req.body)));
  app.post('/api/work/commander',async(req,res)=>res.status(201).json(await engine.commander(req.body)));
  app.post('/api/work/analyze',async(req,res)=>res.json(await engine.analyze(req.body)));
  app.post('/api/work/collaborate',async(req,res)=>res.status(201).json(await engine.collaborate(req.body)));
  app.get('/api/work/commander/:id/report',(req,res)=>res.json(engine.commanderReport(req.params.id)));
  app.get('/api/work/plans/:id',(req,res)=>res.json({plan:engine.getPlan(req.params.id)}));
  app.post('/api/work/plans/:id/cancel',(req,res)=>res.json({plan:engine.cancelPlan(req.params.id)}));
  app.post('/api/work/command',(req,res)=>res.status(201).json({ticket:engine.command(req.body)}));
  app.get('/api/work/tickets/:id',(req,res)=>res.json(engine.detail(req.params.id)));
  app.delete('/api/work/tickets/:id',(req,res)=>res.json(engine.deleteTicket(req.params.id)));
  app.post('/api/work/tickets/:id/actions',(req,res)=>{
    if(req.body?.action==='handoff'){
      const result=engine.handoff(req.params.id,req.body?.input);
      return res.status(result.created?201:200).json({ticket:result.ticket});
    }
    return res.json({ticket:engine.action(req.params.id,req.body?.action,req.body?.input)});
  });
  app.post('/api/work/tickets/:id/team/:nodeId/review',(req,res)=>res.json({team:engine.reviewTeamNode(req.params.id,req.params.nodeId,req.body?.decision)}));
  app.post('/api/work/tickets/:id/team/:nodeId/proposals/:proposalId',(req,res)=>res.json({team:engine.decideTeamProposal(req.params.id,req.params.nodeId,req.params.proposalId,req.body?.decision)}));
  app.get('/api/work/events',(req,res)=>{onConnect?.(req,res);events.connect(req,res,isSessionValid);});
  if(providerRegistry)app.get('/api/work/providers',async(req,res)=>res.json({providers:await providerRegistry.snapshots({force:req.query?.refresh==='1'})}));
  if(windowBridge){
    const findWindow=async id=>{
      const windows=await windowBridge.listWindows().catch(()=>[]);
      return windows.find(window=>window.id===String(id)||String(window.handle)===String(id))||null;
    };
    app.get('/api/work/windows',async(_req,res)=>res.json({windows:await windowBridge.listWindows()}));
    app.get('/api/work/windows/:id/text',async(req,res)=>{
      const target=await findWindow(req.params.id);
      res.json(await windowBridge.readWindow(target?.handle??req.params.id,{...(target?{process:target.process,title:target.title}:{})}));
    });
    app.post('/api/work/windows/:id/send',async(req,res)=>{
      const target=await findWindow(req.params.id);
      const result=await windowBridge.sendToWindow(target?.handle??req.params.id,req.body?.text,{submit:req.body?.submit===true,...(target?{process:target.process,title:target.title}:{})});
      engine.auditExternal('window/send','window',result.relocated?'relocated':'sent');
      res.json(result);
    });
  }
  if(mobileGateway)registerMobileWorkRoutes(app,mobileGateway,{engine,ownerId:mobileOwnerId,onConnect:onMobileEventConnect});
  if(mobileGateway)registerMcpRoutes(app,{engine,gateway:mobileGateway,ownerId:mobileOwnerId,windowBridge});
  engine.recover();
  return ()=>{engine.close();events.close();};
}
