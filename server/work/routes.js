import express from 'express';
import path from 'node:path';
import { createWorkEngine } from './engine.js';
import { createBackupService } from './backup.js';
import { scanHistoricalUsage } from './session-usage.js';
import { workEvents } from './effects.js';
import { mergeRuns, planToRun, taggedRun } from './run-projection.js';
import { registerMobileWorkRoutes } from '../mobile-gateway.js';
import { registerMcpRoutes } from './mcp.js';
import { createMcpTokenService } from './mcp-tokens.js';
import { createRoutineService, ROUTINE_KINDS } from './routines.js';
import { createMcpBridge, loadMcpServers, normalizeMcpServers } from './mcp-client.js';
import { createImNotifier } from './im-notify.js';
import { createLiveService, SENSITIVE_TITLE } from './live-session.js';
import { PROJECT_FILE_CSP, PROJECT_IMAGE_CSP } from './project-files.js';

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

export function registerWork(app,store,executor,{isSessionValid,onConnect,mobileGateway,mobileOwnerId,onMobileEventConnect,planner,windowBridge,providerRegistry,workspace,brain,ownerId='local',allowFilesystemBrowser=false,mcpTokenIndex=null}={}) {
  const events=workEvents({ store });
  let imNotifier=null;
  const publish=event=>{
    events.publish(event);
    if(mobileGateway)mobileGateway.publish(mobileOwnerId,event);
    if(imNotifier&&(event.type==='ticket'||event.type==='usage-alert'))imNotifier.onEvent(event).catch(()=>{});
  };
  const engine=createWorkEngine(store,executor,publish,{planner,windowBridge,workspace,brain,outboxEnabled:process.env.LAGENT_WORK_OUTBOX==='1'});
  // cloud-app 的空闲回收要靠它判断「这个 workspace 里还有没有活」，否则长任务会被当成空闲关掉。
  app.locals.workBusy = () => engine.hasActiveWork();
  imNotifier=createImNotifier({store,engine,ownerId,env:process.env});
  enginesByWorkspace.set(typeof workspace==='string'?workspace:'', engine);
  fallbackEngine = engine;
  app.get('/api/work/bootstrap',(_req,res)=>res.json(engine.bootstrap()));
  app.get('/api/work/projects',(_req,res)=>res.json({projects:engine.listProjects()}));
  if(allowFilesystemBrowser)app.get('/api/work/files',(req,res)=>res.json(engine.listDirectory({path:req.query?.path})));
  app.post('/api/work/projects',(req,res)=>{const result=engine.importProject(req.body);res.status(result.created?201:200).json(result);});
  app.get('/api/work/projects/:id',(req,res)=>res.json({project:engine.getProject(req.params.id)}));
  // 项目文件：列表与搜索只读元数据；预览按格式返回文本/表格/幻灯片，原始文件走 file 接口。
  app.get('/api/work/projects/:id/files',(req,res)=>res.json(engine.projectFiles(req.params.id,req.query?.path)));
  app.get('/api/work/projects/:id/files/search',(req,res)=>res.json(engine.searchProjectFiles(req.params.id,req.query?.q)));
  app.get('/api/work/projects/:id/file/preview',async(req,res)=>res.json(await engine.projectFilePreview(req.params.id,req.query?.path)));
  app.get('/api/work/projects/:id/file',(req,res)=>{
    const file=engine.projectFileSource(req.params.id,req.query?.path);
    const download=req.query?.download==='1';
    const encoded=encodeURIComponent(file.name).replace(/['()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Disposition',`${download?'attachment':'inline'}; filename="preview"; filename*=UTF-8''${encoded}`);
    if(file.mime.startsWith('text/html'))res.setHeader('Content-Security-Policy',PROJECT_FILE_CSP);
    if(file.mime==='image/svg+xml')res.setHeader('Content-Security-Policy',PROJECT_IMAGE_CSP);
    res.setHeader('Content-Type',file.mime);
    res.sendFile(file.absolute);
  });
  app.delete('/api/work/projects/:id',(req,res)=>res.json(engine.deleteProject(req.params.id)));
  app.patch('/api/work/projects/:id',(req,res)=>res.json({project:engine.renameProject(req.params.id,req.body)}));
  app.get('/api/work/projects/:id/sessions',(req,res)=>res.json({sessions:engine.scanProjectSessions(req.params.id,req.query?.executor)}));
  app.post('/api/work/projects/:id/sessions',(req,res)=>res.status(201).json(engine.importProjectSession(req.params.id,req.body)));
  app.post('/api/work/projects/:id/chats',(req,res)=>res.status(201).json(engine.createProjectChat(req.params.id,req.body)));
  app.post('/api/work/projects/:id/dispatch',async(req,res)=>res.status(201).json(await engine.projectDispatch(req.params.id,req.body)));
  app.post('/api/work/projects/:id/teamwork',(req,res)=>res.status(201).json(engine.teamworkStart(req.params.id,req.body)));
  app.get('/api/work/projects/:id/teamworks',(req,res)=>res.json({teamworks:engine.teamworkList(req.params.id)}));
  app.get('/api/work/teamworks/:id',(req,res)=>res.json({teamwork:engine.teamworkGet(req.params.id)}));
  // 团队房间：聚合计划步骤、工单状态、报告、消息、认领与决定日志。
  app.get('/api/work/projects/:id/rooms',(req,res)=>res.json({rooms:engine.listTeamRooms(req.params.id)}));
  app.post('/api/work/projects/:id/rooms',(req,res)=>res.status(201).json({room:engine.createTeamRoom({...req.body,projectId:req.params.id})}));
  app.get('/api/work/rooms/:id',(req,res)=>res.json({room:engine.getTeamRoom(req.params.id)}));
  app.patch('/api/work/rooms/:id',(req,res)=>res.json({room:engine.updateTeamRoom(req.params.id,req.body)}));
  app.delete('/api/work/rooms/:id',(req,res)=>res.json(engine.deleteTeamRoom(req.params.id)));
  app.post('/api/work/rooms/:id/messages',(req,res)=>res.status(201).json(engine.postTeamRoomMessage(req.params.id,req.body)));
  app.post('/api/work/rooms/:id/claims',(req,res)=>res.json({room:engine.claimTeamRoomTicket(req.params.id,req.body)}));
  app.post('/api/work/rooms/:id/decisions',(req,res)=>res.status(201).json(engine.decideTeamRoom(req.params.id,req.body)));
  // IM 通知：Webhook 只用于推送，审批必须走带签名的链接；GET 只展示确认页，不执行动作。
  const actionPage=(title,body)=>`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:520px;margin:10vh auto;padding:0 20px;line-height:1.6"><h2>${title}</h2>${body}</body>`;
  const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  app.get('/api/work/im/config',(_req,res)=>res.json(imNotifier.list()));
  app.post('/api/work/im/channels',(req,res)=>res.status(201).json(imNotifier.saveChannel(req.body)));
  app.patch('/api/work/im/channels/:id',(req,res)=>res.json(imNotifier.saveChannel({...req.body,id:req.params.id})));
  app.delete('/api/work/im/channels/:id',(req,res)=>res.json(imNotifier.removeChannel(req.params.id)));
  app.post('/api/work/im/channels/:id/test',async(req,res)=>res.json(await imNotifier.testChannel(req.params.id)));
  app.get('/api/work/im/actions/:token',(req,res)=>{
    const verified=imNotifier.verifyAction(req.params.token);
    const label=verified.action==='approve'?'批准':'拒绝';
    res.type('html').send(actionPage('确认远程审批',`<p>将对工单 <code>${escapeHtml(verified.ticketId)}</code> 执行「${label}」。</p><form method="post"><button type="submit" style="padding:10px 20px;font-size:16px">确认${label}</button></form><p style="color:#666">链接仅可使用一次，过期或不匹配时会被拒绝。</p>`));
  });
  app.post('/api/work/im/actions/:token',(req,res)=>{
    const result=imNotifier.executeAction(req.params.token);
    if(String(req.headers.accept||'').includes('text/html'))return res.type('html').send(actionPage('审批已提交',`<p>工单 <code>${escapeHtml(result.ticket.id)}</code> 已执行「${escapeHtml(result.action)}」，当前状态：${escapeHtml(result.ticket.status)}。</p>`));
    res.json(result);
  });
  app.post('/api/work/teamworks/:id/assemble',(req,res)=>res.json(engine.teamworkAssemble(req.params.id)));
  app.post('/api/work/teamworks/:id/retry',(req,res)=>res.status(201).json(engine.teamworkRetry(req.params.id,req.body?.partId)));
  app.delete('/api/work/chats/:id',(req,res)=>res.json(engine.deleteProjectChat(req.params.id)));
  app.patch('/api/work/chats/:id',(req,res)=>{
    // 一个 PATCH 兼容三种改法：标题、这条会话自己的权限档位、协作 Agent 名单。
    if(req.body&&Object.hasOwn(req.body,'permission'))return res.json({chat:engine.setProjectChatPermission(req.params.id,req.body)});
    if(req.body&&Object.hasOwn(req.body,'collaborators'))return res.json({chat:engine.setProjectChatCollaborators(req.params.id,req.body)});
    return res.json({chat:engine.renameProjectChat(req.params.id,req.body)});
  });
  // 旧入口保留为受管回合的包装：项目对话会先惰性转成 Lagent 会话，再走同一套主控流程。
  app.post('/api/work/chats/:id/messages',(req,res)=>{
    const tickets=engine.projectChatMessages(req.params.id,req.body);
    res.status(201).json({ticket:tickets[0],tickets,conversationId:tickets[0]?.conversationId||null});
  });
  app.post('/api/work/chats/:id/materialize',(req,res)=>res.json(engine.materializeProjectChat(req.params.id)));
  app.get('/api/work/chats/:id/tickets',(req,res)=>res.json({tickets:engine.projectChatTickets(req.params.id)}));
  // 会话：用户可见的唯一对话容器。每个被选中的 Agent 只是会话里的一次 run。
  app.get('/api/work/conversations',(req,res)=>res.json(engine.listConversations(Number(req.query?.limit)||60)));
  app.post('/api/work/conversations',(req,res)=>res.status(201).json(engine.createConversation(req.body||{})));
  app.post('/api/work/conversations/import',(req,res)=>res.json(engine.importConversations(req.body||{})));
  app.get('/api/work/conversations/:id',(req,res)=>res.json(engine.getConversation(req.params.id)));
  app.patch('/api/work/conversations/:id',(req,res)=>res.json(engine.renameConversation(req.params.id,req.body||{})));
  app.delete('/api/work/conversations/:id',(req,res)=>res.json(engine.deleteConversation(req.params.id)));
  app.post('/api/work/conversations/:id/messages',async(req,res)=>res.status(201).json(await engine.conversationMessage(req.params.id,req.body||{})));
  app.post('/api/work/conversations/:id/turns/:turnId/synthesize',(req,res)=>res.status(201).json(engine.conversationSynthesize(req.params.id,req.params.turnId,req.body||{})));
  // 报告中心：默认按会话聚合最近结论；工单页仍是执行记录索引。
  app.get('/api/work/reports',(req,res)=>res.json(engine.listReports(req.query||{})));
  app.get('/api/work/reports/:id',(req,res)=>res.json(engine.getReport(req.params.id)));
  app.get('/api/work/reports/:id/markdown',(req,res)=>res.type('text/markdown; charset=utf-8').send(engine.reportMarkdown(req.params.id)));
  app.get('/api/work/projects/:id/brief',(req,res)=>res.json({brief:engine.projectBrief(req.params.id)}));
  app.put('/api/work/projects/:id/brief',(req,res)=>res.json({brief:engine.saveProjectBrief(req.params.id,req.body)}));
  app.get('/api/work/projects/:id/brief.md',(req,res)=>res.json(engine.projectBriefMarkdown(req.params.id)));
  // Library 同步：先预览托管块差异，确认后写文件并备份，可随时回滚。
  app.get('/api/work/projects/:id/library/preview',(req,res)=>{
    const targets=typeof req.query?.targets==='string'&&req.query.targets.trim()?req.query.targets.split(',').map(item=>item.trim()).filter(Boolean):undefined;
    res.json(engine.libraryPreview(req.params.id,{targets,mcpUrl:req.query?.mcpUrl}));
  });
  app.post('/api/work/projects/:id/library/apply',(req,res)=>res.json(engine.libraryApply(req.params.id,req.body||{})));
  app.get('/api/work/projects/:id/library/syncs',(req,res)=>res.json({syncs:engine.librarySyncs(req.params.id)}));
  app.post('/api/work/projects/:id/library/rollback',(req,res)=>res.json(engine.libraryRollback(req.params.id,req.body?.syncId)));
  // 技能中心：推荐清单、预览、安装与生命周期；插件交给本机 Claude Code CLI。
  app.get('/api/work/skills',(_req,res)=>res.json(engine.listSkills()));
  app.post('/api/work/skills/preview',async(req,res)=>{res.json(await engine.previewSkill(req.body||{}));});
  app.post('/api/work/skills/install',(req,res)=>res.json(engine.installSkill(req.body||{})));
  app.post('/api/work/skills/:id/update',async(req,res)=>{res.json(await engine.updateSkill(req.params.id));});
  app.post('/api/work/skills/:id/enable',(req,res)=>res.json(engine.enableSkill(req.params.id)));
  app.post('/api/work/skills/:id/disable',(req,res)=>res.json(engine.disableSkill(req.params.id)));
  app.delete('/api/work/skills/:id',(req,res)=>res.json(engine.removeSkill(req.params.id)));
  app.get('/api/work/plugins',async(req,res)=>{res.json(await engine.listPlugins({refresh:req.query?.refresh==='1'}));});
  app.post('/api/work/plugins/preview',async(req,res)=>{res.json(await engine.pluginDetails(req.body?.name));});
  app.post('/api/work/plugins/marketplaces',async(req,res)=>{res.json(await engine.addPluginMarketplace(req.body?.source,{scope:req.body?.scope}));});
  app.delete('/api/work/plugins/marketplaces/:name',async(req,res)=>{res.json(await engine.removePluginMarketplace(req.params.name));});
  app.post('/api/work/plugins/install',async(req,res)=>{res.json(await engine.installPlugin(req.body?.name,{marketplace:req.body?.marketplace,scope:req.body?.scope,acceptCommand:req.body?.acceptCommand}));});
  app.post('/api/work/plugins/:id/enable',async(req,res)=>{res.json(await engine.enablePlugin(req.params.id,{scope:req.body?.scope}));});
  app.post('/api/work/plugins/:id/disable',async(req,res)=>{res.json(await engine.disablePlugin(req.params.id,{scope:req.body?.scope}));});
  app.post('/api/work/plugins/:id/update',async(req,res)=>{res.json(await engine.updatePlugin(req.params.id));});
  app.delete('/api/work/plugins/:id',async(req,res)=>{res.json(await engine.uninstallPlugin(req.params.id));});
  app.get('/api/work/projects/:id/changes',(req,res)=>res.json({changes:engine.projectChanges(req.params.id)}));
  app.post('/api/work/projects/:id/changes',(req,res)=>res.status(201).json({change:engine.recordProjectChange(req.params.id,req.body)}));
  app.delete('/api/work/projects/:id/changes/:changeId',(req,res)=>res.json(engine.deleteProjectChange(req.params.id,req.params.changeId)));
  app.get('/api/work/projects/:id/memory',(req,res)=>res.json(engine.projectMemoryDigest(req.params.id,{query:req.query?.query,scope:req.query?.scope,limit:Number(req.query?.limit)||undefined})));
  app.delete('/api/work/projects/:id/memory/:memoryId',(req,res)=>res.json(engine.deleteProjectMemory(req.params.id,req.params.memoryId)));
  // 例行任务：默认只创建建议工单；Webhook 令牌只在创建/轮换时返回一次，数据库只存哈希。
  const routines=createRoutineService({store,engine,env:process.env});
  app.get('/api/work/routines',(_req,res)=>res.json({routines:routines.list(),kinds:[...ROUTINE_KINDS]}));
  app.post('/api/work/routines',(req,res)=>res.status(201).json(routines.save(req.body)));
  app.patch('/api/work/routines/:id',(req,res)=>res.json(routines.save({...req.body,id:req.params.id})));
  app.delete('/api/work/routines/:id',(req,res)=>res.json(routines.remove(req.params.id)));
  app.post('/api/work/routines/:id/run',(req,res)=>res.json(routines.runNow(req.params.id,{manual:true})));
  app.post('/api/work/hooks/:token',(req,res)=>res.json(routines.triggerWebhook(req.params.token,req.body)));
  // 实时观察：仅内存保留最近一帧，敏感标题自动暂停；接管后停止截图。
  const live=createLiveService({
    // 画面帧只给桌面端事件流；手机端不需要，也不能把 base64 图片写进通知通道。
    emit:event=>events.publish(event),
    env:process.env,
    capture:windowBridge?.captureWindow
      ? input=>windowBridge.captureWindow(input.handle,{process:input.process})
      : async()=>{throw Object.assign(new Error('当前环境不支持实时观察（需要桌面窗口桥）'),{status:409});}
  });
  app.get('/api/work/live',(_req,res)=>res.json({sessions:live.list(),sensitivePattern:SENSITIVE_TITLE.source}));
  app.post('/api/work/live',async(req,res)=>res.status(201).json({session:await live.start(req.body||{})}));
  app.get('/api/work/live/:id',(req,res)=>res.json({session:live.get(req.params.id)}));
  app.get('/api/work/live/:id/frame',(req,res)=>res.json({frame:live.frame(req.params.id)}));
  app.post('/api/work/live/:id/pause',(req,res)=>res.json({session:live.pause(req.params.id,req.body?.reason)}));
  app.post('/api/work/live/:id/resume',(req,res)=>res.json({session:live.resume(req.params.id)}));
  app.post('/api/work/live/:id/takeover',(req,res)=>res.json({session:live.takeover(req.params.id)}));
  app.post('/api/work/live/:id/stop',(req,res)=>res.json(live.stop(req.params.id)));
  // MCP 客户端配置：只保存显式添加的服务器；env 值写库但不回显，只返回键名。
  const mcpConfigKey=`mcp-servers-v1:${ownerId}`;
  const mcpRows=()=>store.config(mcpConfigKey)||[];
  const publicMcp=row=>({id:row.id,name:row.name,command:row.command,args:row.args||[],enabled:row.enabled!==false,tools:row.tools||[],envKeys:Object.keys(row.env||{}),cwd:row.cwd||''});
  app.get('/api/work/mcp/servers',(_req,res)=>res.json({servers:mcpRows().map(publicMcp),projectConfig:process.env.LAGENT_MCP_PROJECT_CONFIG==='1'}));
  app.post('/api/work/mcp/servers',(req,res)=>{
    const body=req.body||{};
    const [row]=normalizeMcpServers([{...body,id:body.name}],{workspace:workspace||undefined,env:process.env});
    if(!row)throw Object.assign(new Error('MCP 服务器配置无效：需要名称、允许的命令（node/npx/python/uvx 等）和参数'),{status:400});
    const next={...(body.env&&typeof body.env==='object'?{env:row.env}:{}),id:row.id,name:row.name,command:row.command,args:row.args,enabled:row.enabled,tools:row.tools||[],...(row.cwd?{cwd:row.cwd}:{})};
    const rows=mcpRows().filter(item=>item.id!==next.id);
    if(rows.length>=10)throw Object.assign(new Error('最多配置 10 个 MCP 服务器'),{status:429});
    store.config(mcpConfigKey,[...rows,next]);
    res.status(201).json({server:publicMcp(next)});
  });
  app.delete('/api/work/mcp/servers/:id',(req,res)=>{
    const rows=mcpRows();
    if(!rows.some(row=>row.id===req.params.id))throw Object.assign(new Error('MCP 服务器不存在'),{status:404});
    store.config(mcpConfigKey,rows.filter(row=>row.id!==req.params.id));
    res.json({ok:true,id:req.params.id});
  });
  app.post('/api/work/mcp/test',async(req,res)=>{
    const input=req.body||{};
    let configs;
    if(typeof input.name==='string'&&input.name.trim()){
      // 测试未保存的草稿：与保存走同一套白名单与路径校验。
      const [row]=normalizeMcpServers([{...input,id:input.name}],{workspace:workspace||undefined,env:process.env});
      if(!row)throw Object.assign(new Error('MCP 服务器配置无效：需要名称、允许的命令（node/npx/python/uvx 等）和参数'),{status:400});
      configs=[row];
    }else{
      configs=loadMcpServers({store,ownerId,workspace:workspace||undefined,env:process.env});
    }
    if(!configs.length)return res.json({ok:true,servers:[],tools:0,schemas:[],message:'尚未配置 MCP 服务器'});
    const bridge=createMcpBridge({servers:configs});
    try{const result=await bridge.connect();res.json({ok:result.health.every(row=>row.ok),servers:result.health,tools:result.tools,schemas:bridge.schemas().map(row=>row.function.name)});}
    finally{await bridge.close().catch(()=>{});}
  });
  app.get('/api/work/policy',(_req,res)=>res.json({policy:engine.policy()}));
  app.get('/api/work/agents/roster',(_req,res)=>res.json({agents:engine.agentRoster()}));
  app.get('/api/work/team-templates',(req,res)=>res.json({templates:engine.listTeamTemplates(req.query?.projectId)}));
  app.post('/api/work/team-templates',(req,res)=>res.status(201).json({template:engine.saveTeamTemplate(req.body)}));
  app.delete('/api/work/team-templates/:id',(req,res)=>res.json(engine.deleteTeamTemplate(req.params.id)));
  app.put('/api/work/policy',(req,res)=>res.json({policy:engine.updatePolicy(req.body)}));
  // 配置档：模型 + 思考强度 + 权限 + 预算 + 执行器 + Library 的命名快照。
  app.get('/api/work/profiles',(req,res)=>res.json({profiles:engine.listProfiles(),active:engine.profilesActive(req.query?.projectId)}));
  app.post('/api/work/profiles',(req,res)=>res.status(201).json({profile:engine.saveProfile(req.body)}));
  app.patch('/api/work/profiles/:id',(req,res)=>res.json({profile:engine.updateProfile(req.params.id,req.body)}));
  app.delete('/api/work/profiles/:id',(req,res)=>res.json(engine.deleteProfile(req.params.id)));
  app.post('/api/work/profiles/:id/apply',(req,res)=>res.json(engine.applyProfile(req.params.id,req.body)));
  app.post('/api/work/profiles/reset',(req,res)=>res.json(engine.resetProfile(req.body)));
  app.post('/api/work/plans',(req,res)=>res.status(201).json({plan:engine.plan(req.body)}));
  app.post('/api/work/plans/suggest',async(req,res)=>res.json(await engine.suggestPlan(req.body)));
  app.post('/api/work/commander',async(req,res)=>res.status(201).json(await engine.commander(req.body)));
  app.post('/api/work/analyze',async(req,res)=>res.json(await engine.analyze(req.body)));
  // 派单前把用户的话改写成几份任务书：前端让用户挑一份再开始协作。
  app.post('/api/work/prompts',async(req,res)=>res.json(await engine.suggestPrompts(req.body)));
  app.post('/api/work/collaborate',async(req,res)=>res.status(201).json(await engine.collaborate(req.body)));
  app.get('/api/work/commander/:id/report',(req,res)=>res.json(engine.commanderReport(req.params.id)));
  app.get('/api/work/plans/:id',(req,res)=>res.json({plan:engine.getPlan(req.params.id)}));
  app.get('/api/work/plans/:id/sheet',(req,res)=>res.json(engine.planSheet(req.params.id)));
  app.post('/api/work/plans/:id/cancel',(req,res)=>res.json({plan:engine.cancelPlan(req.params.id)}));
  app.get('/api/work/plans/:id/compensations',(req,res)=>res.json({compensations:engine.planCompensations(req.params.id)}));
  app.post('/api/work/plans/:id/rollback',async(req,res)=>res.json(await engine.rollbackPlan(req.params.id)));
  app.post('/api/work/command',(req,res)=>res.status(201).json({ticket:engine.command(req.body)}));
  app.get('/api/work/tickets/:id',(req,res)=>res.json(engine.detail(req.params.id)));
  app.get('/api/work/tickets/:id/trace',(req,res)=>res.json(engine.ticketTrace(req.params.id)));
  app.delete('/api/work/tickets/:id',(req,res)=>res.json(engine.deleteTicket(req.params.id)));
  // 编排器：默认开启；LAGENT_ORCHESTRATOR=legacy 退回单工单流程。
  // 关闭时这些路由返回 503，前端据此隐藏入口，而不是报错。
  const orchestratorOn = () => (process.env.LAGENT_ORCHESTRATOR || '').trim().toLowerCase() !== 'legacy';
  let orchestratorPromise = null;
  const orchestrator = async () => {
    if (!orchestratorOn()) {
      const error = new Error('编排器未启用：去掉 LAGENT_ORCHESTRATOR=legacy 并重启服务');
      error.status = 503;
      throw error;
    }
    if (!orchestratorPromise) {
      orchestratorPromise = import('./orchestrator/index.js')
        .then(module => {
          const created = module.createOrchestrator({ engine, store, emit: publish });
          created.markPaused();
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
    const limit = Number(req.query?.limit) || 20;
    const includePlans = req.query?.include === 'plans' || req.query?.include === 'all';
    let runs = [];
    if (orchestratorOn()) {
      try { runs = (await orchestrator()).list(limit); }
      catch (error) { if (!includePlans) throw error; }
    } else if (!includePlans) {
      const error = new Error('编排器未启用：去掉 LAGENT_ORCHESTRATOR=legacy 并重启服务');
      error.status = 503;
      throw error;
    }
    const plans = includePlans ? engine.listPlans(limit) : [];
    return { runs: mergeRuns(runs, plans, limit) };
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
    // 计划 id 直接命中计划投影，不需要拉起编排器（也可能根本没启用）。
    const plan = engine.findPlan(req.params.id);
    if (plan) return { run: planToRun(plan) };
    const started = await orchestrator();
    return { run: taggedRun(started.get(req.params.id)) };
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
  app.post('/api/work/runs/:id/resume', runRoute(async req => {
    const started = await orchestrator();
    return { run: await started.resume(req.params.id) };
  }));
  app.post('/api/work/tickets/:id/permissions/:requestId',(req,res)=>res.json({ticket:engine.permissionDecision(req.params.id,req.params.requestId,req.body?.decision)}));
  app.post('/api/work/tickets/:id/actions',(req,res)=>{
    if(req.body?.action==='handoff'){
      const result=engine.handoff(req.params.id,req.body?.input);
      return res.status(result.created?201:200).json({ticket:result.ticket});
    }
    return res.json({ticket:engine.action(req.params.id,req.body?.action,req.body?.input)});
  });
  app.post('/api/work/tickets/:id/verify',async(req,res)=>{
    try{res.json(await engine.verifyTicket(req.params.id));}
    catch(error){res.status(error?.status||500).json({error:error?.message||'验收失败'});}
  });
  app.post('/api/work/tickets/:id/team/:nodeId/review',(req,res)=>res.json({team:engine.reviewTeamNode(req.params.id,req.params.nodeId,req.body?.decision)}));
  app.post('/api/work/tickets/:id/team/:nodeId/proposals/:proposalId',(req,res)=>res.json({team:engine.decideTeamProposal(req.params.id,req.params.nodeId,req.params.proposalId,req.body?.decision)}));
  app.get('/api/work/events',(req,res)=>{onConnect?.(req,res);events.connect(req,res,isSessionValid);});
  const usageHistory=include=>include?scanHistoricalUsage({home:process.env.LAGENT_HOME||undefined}):{entries:[],scanned:{files:0,claudeFiles:0,codexFiles:0},note:''};
  app.get('/api/work/usage',(req,res)=>{
    const includeHistory=req.query?.includeHistory==='1';
    const history=usageHistory(includeHistory);
    const report=engine.usageSummary({projectId:req.query?.projectId,executorId:req.query?.executorId,from:req.query?.from,to:req.query?.to,days:req.query?.days==='all'?'all':Number(req.query?.days)||30,extraRows:history.entries});
    res.json({...report,history:{count:history.entries.length,scanned:history.scanned,note:history.note}});
  });
  // CSV 导出：按原始用量行导出，方便团队在表格里按项目/执行器/天透视。
  app.get('/api/work/usage.csv',(req,res)=>{
    const includeHistory=req.query?.includeHistory==='1';
    const day=value=>new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10);
    const from=req.query?.from||null,to=req.query?.to||null;
    const projects=new Map(engine.listProjects().map(project=>[project.id,project.name]));
    const rows=[...store.list('work-usage'),...usageHistory(includeHistory).entries]
      .filter(row=>(!req.query?.projectId||row.projectId===req.query.projectId)&&(!req.query?.executorId||row.executorId===req.query.executorId))
      .filter(row=>{const date=row.recordedAt?day(row.recordedAt):'';return (!from||date>=from)&&(!to||date<=to);})
      .sort((left,right)=>String(right.recordedAt).localeCompare(String(left.recordedAt)))
      .slice(0,50000);
    const escape=value=>{const text=String(value??'');return /[",\n]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;};
    const lines=[['日期','项目','项目名称','执行器','模型','来源','调用','输入Token','输出Token','缓存读取','缓存写入','合计Token','耗时毫秒','费用估算USD']];
    for(const row of rows)lines.push([row.recordedAt?day(row.recordedAt):'',row.projectId||'',projects.get(row.projectId)||'',row.executorId||'',row.model||'',row.source||'ticket',row.calls||0,row.tokensIn||0,row.tokensOut||0,row.cacheReadTokens||0,row.cacheWriteTokens||0,row.totalTokens||0,row.durationMs||0,Number(row.costEstimate||0).toFixed(6)]);
    res.setHeader('Content-Disposition',`attachment; filename="lagent-usage-${new Date().toISOString().slice(0,10)}.csv"`);
    // 显式 BOM：Excel 直接打开时按 UTF-8 识别中文表头。
    res.type('text/csv; charset=utf-8').send(`﻿${lines.map(line=>line.map(escape).join(',')).join('\n')}`);
  });
  // 加密备份、恢复与脱敏诊断包。备份文件只包含当前工作区的 SQLite 快照，
  // 凭据本身仍是工作区主密钥加密后的密文。
  const backup=createBackupService({store,engine,dataDir:path.dirname(store.dbPath)});
  app.post('/api/work/backup/export',async(req,res)=>{
    const result=await backup.exportBundle({passphrase:req.body?.passphrase,includeCredentials:req.body?.includeCredentials!==false});
    res.setHeader('Content-Disposition',`attachment; filename="${result.filename}"`);
    res.type('application/octet-stream').send(result.bytes);
  });
  app.post('/api/work/backup/restore',express.raw({type:['application/octet-stream','application/zip','binary/octet-stream'],limit:'512mb'}),async(req,res)=>{
    if(!Buffer.isBuffer(req.body)||!req.body.length)throw Object.assign(new Error('请上传备份文件'),{status:400});
    // 前端会把口令 URL 编码后放进请求头，避免非 ASCII 字符被 HTTP 头拒绝。
    let passphrase=req.get('x-backup-passphrase')||'';
    try{passphrase=decodeURIComponent(passphrase);}catch{/* 兼容旧的未编码请求头。 */}
    res.json(await backup.restoreBundle(req.body,{passphrase}));
  });
  app.get('/api/work/backup/status',(_req,res)=>res.json({backups:backup.listBackups()}));
  app.get('/api/work/diagnostics',(_req,res)=>res.json({diagnostics:backup.diagnostics()}));
  const stopBackups=backup.startScheduledBackups({
    hours:process.env.LAGENT_BACKUP_INTERVAL_HOURS,
    targetDir:process.env.LAGENT_BACKUP_DIR,
    passphrase:process.env.LAGENT_BACKUP_PASSPHRASE,
    keep:Number(process.env.LAGENT_BACKUP_KEEP)||14
  });
  // 测试或按需部署可以关闭调度，仍可手动运行。
  const stopRoutines=process.env.LAGENT_WORK_ROUTINES==='0'?()=>{}:routines.start();
  app.get('/api/work/effects',(req,res)=>res.json({effects:engine.listEffects({ticketId:req.query?.ticketId,kind:req.query?.kind,status:req.query?.status,limit:Number(req.query?.limit)||200})}));
  app.post('/api/work/effects/:id/retry',(req,res)=>{try{res.json({effect:engine.retryEffect(req.params.id)});}catch(error){res.status(error?.status||500).json({error:error?.message||'重试失败'});}});
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
  if(mobileGateway){
    const mcpTokens=createMcpTokenService({store,engine,onIssue:mcpTokenIndex?.onIssue,onRevoke:mcpTokenIndex?.onRevoke});
    registerMcpRoutes(app,{engine,gateway:mobileGateway,ownerId:mobileOwnerId,windowBridge,mcpTokens});
  }
  engine.recover();
  return ()=>{live.close();stopRoutines();stopBackups();engine.close();events.close();enginesByWorkspace.delete(typeof workspace==='string'?workspace:'');};
}
