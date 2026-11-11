import { createWorkEngine } from './engine.js';
import { workEvents } from './effects.js';
import { registerMobileWorkRoutes } from '../mobile-gateway.js';
import { registerMcpRoutes } from './mcp.js';

// 执行器（特别是模型 Agent）需要知道「这个工作目录属于哪个项目、最近改了什么」。
// 执行器比引擎先创建，所以这里按 workspace 登记引擎，事后反查。
const enginesByWorkspace = new Map();
// 项目工作目录和引擎的默认工作目录通常不是同一个：项目可能在任何路径下导入。
// 所以除了精确匹配，还要留一个「任意引擎」兜底，由它按路径反查项目。
let fallbackEngine = null;

/** 给执行器用：按工作目录拿到项目现状摘要（最近改动 + 项目记忆）。 */
export function projectStateOf(workspace) {
  const key = typeof workspace === 'string' ? workspace : '';
  const engine = enginesByWorkspace.get(key) || fallbackEngine;
  if (!engine) return '';
  try {
    return engine.projectStateBrief(key);
  } catch {
    return '';
  }
}

export function registerWork(app,store,executor,{isSessionValid,onConnect,mobileGateway,mobileOwnerId,onMobileEventConnect,planner,windowBridge,providerRegistry,workspace,brain,allowFilesystemBrowser=false}={}) {
  const events=workEvents();
  const publish=event=>{
    events.publish(event);
    if(mobileGateway)mobileGateway.publish(mobileOwnerId,event);
  };
  const engine=createWorkEngine(store,executor,publish,{planner,windowBridge,workspace,brain});
  enginesByWorkspace.set(typeof workspace==='string'?workspace:'', engine);
  fallbackEngine = engine;
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
  app.patch('/api/work/chats/:id',(req,res)=>{
    // 一个 PATCH 兼容三种改法：标题、这条会话自己的权限档位、协作 Agent 名单。
    if(req.body&&Object.hasOwn(req.body,'permission'))return res.json({chat:engine.setProjectChatPermission(req.params.id,req.body)});
    if(req.body&&Object.hasOwn(req.body,'collaborators'))return res.json({chat:engine.setProjectChatCollaborators(req.params.id,req.body)});
    return res.json({chat:engine.renameProjectChat(req.params.id,req.body)});
  });
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
  // 派单前把用户的话改写成几份任务书：前端让用户挑一份再开始协作。
  app.post('/api/work/prompts',async(req,res)=>res.json(await engine.suggestPrompts(req.body)));
  app.post('/api/work/collaborate',async(req,res)=>res.status(201).json(await engine.collaborate(req.body)));
  app.get('/api/work/commander/:id/report',(req,res)=>res.json(engine.commanderReport(req.params.id)));
  app.get('/api/work/plans/:id',(req,res)=>res.json({plan:engine.getPlan(req.params.id)}));
  app.post('/api/work/plans/:id/cancel',(req,res)=>res.json({plan:engine.cancelPlan(req.params.id)}));
  app.post('/api/work/command',(req,res)=>res.status(201).json({ticket:engine.command(req.body)}));
  app.get('/api/work/tickets/:id',(req,res)=>res.json(engine.detail(req.params.id)));
  app.delete('/api/work/tickets/:id',(req,res)=>res.json(engine.deleteTicket(req.params.id)));
  // 编排器：默认开启；DATAAGENT_ORCHESTRATOR=legacy 退回单工单流程。
  // 关闭时这些路由返回 503，前端据此隐藏入口，而不是报错。
  const orchestratorOn = () => (process.env.DATAAGENT_ORCHESTRATOR || '').trim().toLowerCase() !== 'legacy';
  let orchestratorPromise = null;
  const orchestrator = async () => {
    if (!orchestratorOn()) {
      const error = new Error('编排器未启用：去掉 DATAAGENT_ORCHESTRATOR=legacy 并重启服务');
      error.status = 503;
      throw error;
    }
    if (!orchestratorPromise) {
      orchestratorPromise = import('./orchestrator/index.js')
        .then(module => {
          const created = module.createOrchestrator({ engine, store, emit: publish });
          created.markInterrupted();
          return created;
        })
        .catch(error => { orchestratorPromise = null; throw error; });
    }
    return orchestratorPromise;
  };
  const runRoute = handler => async (req, res) => {
    try {
      res.json(await handler(req, res));
    } catch (error) {
      res.status(error?.status || 500).json({ error: error?.message || '编排器出错了' });
    }
  };
  app.get('/api/work/orchestrator', (_req, res) => res.json({ enabled: orchestratorOn() }));
  app.get('/api/work/runs', runRoute(async req => {
    const started = await orchestrator();
    return { runs: started.list(Number(req.query?.limit) || 20) };
  }));
  app.post('/api/work/runs', runRoute(async req => {
    const started = await orchestrator();
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    // 派单前的任务书可能比一句话长得多（三份版本里最细的那份常常上千字），
    // 这里放宽到与对话消息一致的上限，否则选完版本反而发不出去。
    if (!goal || goal.length > 4000) {
      const error = new Error('目标须为 1–4000 字');
      error.status = 400;
      throw error;
    }
    return { run: await started.start({
      goal,
      projectId: req.body?.projectId || null,
      chatId: req.body?.chatId || null,
      templateId: typeof req.body?.templateId === 'string' && req.body.templateId ? req.body.templateId : null
    }) };
  }));
  app.get('/api/work/runs/:id', runRoute(async req => {
    const started = await orchestrator();
    return { run: started.get(req.params.id) };
  }));
  app.post('/api/work/runs/:id/approve', runRoute(async req => {
    const started = await orchestrator();
    const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';
    return { run: await started.approve(req.params.id, decision) };
  }));
  app.post('/api/work/runs/:id/cancel', runRoute(async req => {
    const started = await orchestrator();
    return { run: await started.cancel(req.params.id) };
  }));
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
  return ()=>{engine.close();events.close();enginesByWorkspace.delete(typeof workspace==='string'?workspace:'');};
}
