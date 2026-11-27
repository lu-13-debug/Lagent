import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWorkAction, workError } from './domain.js';
import { publicTicket } from '../application/ticket/projection.js';
import { publicPlan as planProjection } from '../application/plan/projection.js';
import { manualTrigger } from './sources/manual.js';
import { defaultPolicy, EXTERNAL_EXECUTORS, externalExecutorAllowed, externalExecutorsEnabled, normalizePolicy, PERMISSIONS, WORK_POLICY_ID } from './policy.js';
import { appendWorkEvent, workStore } from './store.js';
import { executorRegistry } from './executors/index.js';
import { cliDefaultMaxTurns } from './executors/cli.js';
import { decideTeamProposal, projectTeamTask, reviewTeamNode, teamEventKey } from './team.js';
import { cancelTicketEffects, claimDue, complete, effectForLaunch, enqueue, fail as failOutbox, listEffects, recoverRunningEffects, retryEffect, sanitizeOutboxError, WORK_EFFECT_KIND } from './outbox.js';
import { PROJECT_CHAT_EXECUTORS, projectService } from './projects.js';
import { createProjectFiles } from './project-files.js';
import { createProjectMemory, deriveFailureLesson, summarizeExecution } from './project-memory.js';
import { isKeyChange, normalizePrompts, refineLocal } from './prompt-refiner.js';
import { buildPreview, previewQuestion } from './risk.js';
import { normalizeVerify, runVerify } from './verify.js';
import { critiqueResult } from '../critic.js';
import { contractBrief, missingDeliverables, normalizeContract } from './contract.js';
import { buildRoster } from './roster.js';
import { teamTemplateService } from './team-templates.js';
import { createWorkProfiles } from './profiles.js';
import { createAgentMarket } from './agent-market.js';
import { createLibrarySync } from './library-sync.js';
import { createSkillService } from './skills/service.js';
import { createPluginService } from './skills/plugins.js';
import { createTeamRoomService } from './team-room.js';
import { conversationStatus, createConversationService } from './conversations.js';
import { agentEffort, isEffort, normalizeEfforts } from './efforts.js';
import { reportTextOfReport } from './report-text.js';
import { createReportCenter } from './report-center.js';
import { CONVERSATION_ROLES, isExecutorAllowed, LAGENT_EXECUTOR_ID, lagentReadiness, managedTurnShape, normalizeManagedAgents } from '../application/conversation/model.js';
import { handoffBrief, normalizeHandoff } from './handoff.js';
import { buildSheetMarkdown } from './sheet.js';
import { isExternalSource, wrapUntrusted } from './untrusted.js';
import { compensationPlan, listCompensations, markCompensation, normalizeCompensation, recordCheckpoint, rememberCompensations } from './transaction.js';
import { analyzeTask } from './task-analyzer.js';
import { buildLibraryContext, forAgent } from './agent-context.js';
import { recordTicketUsage, summarizeUsage, checkTokenBudget, ticketTokensUsed } from './usage.js';
import * as teamwork from './teamwork.js';

const now = () => new Date().toISOString();
// 汇总提示词可能超过执行器上限；按字符截断，保留尾部说明。
const sliceText = (value, max) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
};
const review = (question, approveLabel = '批准', rejectLabel = '退回') => ({question,createdAt:now(),options:[{id:'approve',label:approveLabel,action:'approve'},{id:'reject',label:rejectLabel,action:'reject'}]});
// 越权访问的确认文案：命令类的 path 其实是命令本身。
const ACCESS_VERBS = { read: '读取', write: '写入', delete: '删除', command: '执行命令' };
const accessPrompt = request => `Lagent 请求${ACCESS_VERBS[request.mode] || '访问'}：${String(request.path || '').slice(0, 240)}`;
const accessReview = request => ({...review(accessPrompt(request), `允许这次${ACCESS_VERBS[request.mode] || '访问'}`, '拒绝'),kind:'access',accessMode:request.mode,accessPath:String(request.path || '').slice(0,240)});
const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
// 对话级设置：模型、思考强度、工作权限。只允许这三个键，避免把任意输入塞进执行器。
const normalizeCommandSettings = value => {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workError('settings 必须是对象', 400);
  const unknown = Object.keys(value).filter(key => !['profileId', 'model', 'effort', 'permission'].includes(key));
  if (unknown.length) throw workError(`settings 包含未知字段：${unknown.join('、')}`, 400);
  const profileId = typeof value.profileId === 'string' ? value.profileId.trim() : '';
  if (profileId && !/^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) throw workError('settings.profileId 无效', 400);
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (model && !/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) throw workError('settings.model 无效', 400);
  const effort = typeof value.effort === 'string' ? value.effort.trim() : '';
  if (effort && !/^[a-z]{2,10}$/.test(effort)) throw workError('settings.effort 无效', 400);
  if (value.permission !== undefined && !PERMISSIONS.includes(value.permission)) throw workError('settings.permission 仅支持 read/workspace/full', 400);
  const settings = {
    ...(profileId ? { profileId } : {}),
    ...(model ? { model } : {}),
    ...(effort && effort !== 'default' ? { effort } : {}),
    ...(value.permission ? { permission: value.permission } : {})
  };
  return Object.keys(settings).length ? settings : null;
};

export function createWorkEngine(store, executor, publish = () => {}, options = {}) {
  const db = workStore(store, publish, { runEvents: options.runEvents || null });
  // 检查点：执行前给项目工作区拍一张可回滚的存档，未注入时整段跳过。
  const checkpoints = options.checkpoints || null;
  // 隔离工作树：项目显式开启 worktree 模式时，任务在独立工作树里跑，主工作区不动。
  const worktrees = options.worktrees || null;
  // P0.2：审批中心按开关注入。没有注入时所有审批逻辑整段跳过，旧路径完全不变。
  const approvals = options.approvals || null;
  const requestApproval = input => {
    if (!approvals) return null;
    try { return approvals.request(input); }
    catch { return null; }
  };
  const executors = executorRegistry(executor);
  const savedPolicy = store.get('work-policy', WORK_POLICY_ID);
  const savedPolicyBody = savedPolicy ? Object.fromEntries(Object.entries(savedPolicy).filter(([key]) => key !== 'id')) : null;
  let policy = normalizePolicy(options.policy || savedPolicyBody || defaultPolicy());
  // 策略里的并发数要能真正落到执行器：执行器自己的默认值只是兜底。
  const applyExecutorConcurrency = () => {
    try { executors.setConcurrency?.(policy.budgets.maxConcurrent); } catch { /* 执行器拒绝时保持自身限制。 */ }
  };
  applyExecutorConcurrency();
  const env = options.env || process.env;
  const outboxEnabled = options.outboxEnabled === true;
  // 心跳阈值：执行器还在写 task/activity 时更新 assignment.heartbeatAt；超过阈值没更新视为 stalled。
  const heartbeatStaleMs = Number.isSafeInteger(options.heartbeatStaleMs) && options.heartbeatStaleMs > 0
    ? options.heartbeatStaleMs
    : (Number(env.LAGENT_HEARTBEAT_STALE_MS) > 0 ? Number(env.LAGENT_HEARTBEAT_STALE_MS) : 5 * 60 * 1000);
  const heartbeatWriteMs = Math.max(20, Math.min(Math.floor(heartbeatStaleMs / 2), 30000));
  // 完成即验收：有 verify 的工单完成后自动在 Lagent 侧跑一次；LAGENT_AUTO_VERIFY=0 可关闭。
  const autoVerify = options.autoVerify === false ? false : (options.autoVerify === true || env.LAGENT_AUTO_VERIFY !== '0');
  const verifyingTickets = new Set();
  const windowBridge = options.windowBridge || null;
  const projects = projectService(db, { environment: env, home: options.home });
  // 项目文件预览：路径始终相对项目根目录解析，越界与敏感文件在服务层直接拒绝。
  const projectFileService = createProjectFiles({ getProject: id => projects.getProject(id) });
  // 会话是用户可见的唯一对话容器；ticket 只是会话里的一次 run。
  const conversations = createConversationService(db);
  const reportCenter = createReportCenter({ store });
  const profiles = createWorkProfiles(db, { store });
  // P4：Agent 市场。安装动作落地为配置档，不下载代码。
  const agentMarket = createAgentMarket({ store, profiles, listExecutors: () => { try { return executors.list().map(item => item.id); } catch { return []; } } });
  const memory = createProjectMemory(db);
  const library = createLibrarySync(db, { projects, memory });
  const skillService = options.skills || createSkillService(db, { projects, home: options.home, env });
  const pluginService = options.plugins || createPluginService({ environment: env });
  const brain = options.brain || null;
  // 受管项目对话默认开启；没有 brain 的嵌入式/测试环境退回旧派单，
  // 显式 LAGENT_MANAGED_CONVERSATIONS=0 可临时回滚。
  const managedProjectChats = options.managedProjectChats !== false
    && env.LAGENT_MANAGED_CONVERSATIONS !== '0'
    && (Boolean(brain) || options.managedProjectChats === true);
  const workspace = typeof options.workspace === 'string' && options.workspace ? options.workspace : null;
  // 模型 Agent 只有在配置了可用模型时才真正能干活，否则界面上应显示为待配置。
  const modelReady = () => {
    if (brain) { try { return Boolean(brain.availability?.().ok); } catch { return false; } }
    // 没有注入 brain 的测试/嵌入式场景：以执行器注册表为准，模型 Agent 可用即视为已配置。
    try { return Boolean(executors.list().find(agent => agent.id === 'model' && agent.available)); } catch { return false; }
  };
  const agentUsable = agent => Boolean(agent?.available) && (agent.id !== 'model' || modelReady());
  // 主控是否就绪：只看模型配置与可用性。策略白名单不再能关掉 Lagent。
  const lagentState = () => {
    let configured = false;
    let available = false;
    if (brain) {
      try {
        const state = brain.availability?.();
        available = Boolean(state?.ok);
        configured = available || state?.configured === true || Boolean(state?.model);
      } catch { /* 配置读取失败按未配置处理。 */ }
    } else {
      available = modelReady();
      configured = available;
    }
    return lagentReadiness({ configured, available });
  };
  const assertLagentReady = () => {
    const state = lagentState();
    if (state.ready) return state;
    const error = workError(state.reason, 409);
    error.code = state.code;
    throw error;
  };
  // 兼容旧调用：externalExecutorAllowed 对非外部执行器恒为 true，但模型仍要经过主控判定。
  const executorAllowed = executorId => isExecutorAllowed(policy, executorId) && externalExecutorAllowed(executorId, policy, env);
  // 被拒时给出可执行的原因：是白名单没勾，还是服务级总开关没开。
  // 这两种情况原来都提示「未获当前策略允许」，用户照着设置页勾选也修不好。
  const executorDenial = executorId => {
    if (!isExecutorAllowed(policy, executorId)) {
      return { code: 'EXECUTOR_DISABLED', reason: `执行器「${executorId}」未启用：请在「设置 → 执行器策略」中勾选后重试` };
    }
    if (!externalExecutorAllowed(executorId, policy, env)) {
      return { code: 'EXTERNAL_EXECUTORS_DISABLED', reason: `外部执行器「${executorId}」被服务级开关关闭：请设置 LAGENT_ALLOW_EXTERNAL_EXECUTORS=1 后重启 Lagent 服务（用「启动 Lagent.cmd」或 npm run dev 启动会自动开启）` };
    }
    return null;
  };
  // 只在真实服务进程里提醒，避免测试注入的 env 触发噪音。
  if (env === process.env) {
    const enabledButBlocked = policy.allowedExecutors.filter(id => EXTERNAL_EXECUTORS.includes(id));
    if (enabledButBlocked.length && !externalExecutorsEnabled(env)) {
      console.warn(`[lagent] 执行器策略已勾选 ${enabledButBlocked.join('、')}，但 LAGENT_ALLOW_EXTERNAL_EXECUTORS 未开启，这些执行器会被拒绝。设置 LAGENT_ALLOW_EXTERNAL_EXECUTORS=1 后重启服务，或改用「启动 Lagent.cmd」/ npm run dev。`);
    }
  }
  const planSuggestionTimes = [];
  let drainingOutbox = false;
  let outboxTimer = null;
  const audit = (ticketId, action, executorId, result, reason = '') => {
    store.put('work-audit', { id: randomUUID(), ticketId: ticketId || null, action: String(action).slice(0, 40), executor: String(executorId || '').slice(0, 40), at: now(), result: String(result).slice(0, 20), reason: String(reason).slice(0, 200) });
    for (const row of store.list('work-audit').slice(2000)) store.delete('work-audit', row.id);
  };
  const teamTemplates = teamTemplateService(db, { now, audit });
  const guard = (executorId, ticketId, action) => {
    const denial = executorDenial(executorId);
    if (denial) {
      audit(ticketId, action, executorId, 'denied', denial.reason);
      const error = workError(denial.reason, 403);
      error.code = denial.code;
      throw error;
    }
  };
  // 配置档的「工作方式」默认值：只透传当前执行器认识的字段。
  // 例如内置模型 Agent 用 profileId，CLI 用 model/effort；终端/分析不需要模型设置。
  // 项目对话的权限由 chat.permission 或项目配置档覆盖统一处理，这里不再塞 permission。
  const profileDefaultsFor = (activeId, active, project) => {
    const source = profiles.settingsFor(project?.project?.id);
    const result = {};
    // 只有内置模型与外部 CLI 认识 permission；分析/终端执行器传了会被校验拒绝。
    if (!project && source.permission && (activeId === 'model' || active?.kind === 'cli')) result.permission = source.permission;
    if (activeId === 'model') {
      if (source.profileId) result.profileId = source.profileId;
      if (source.effort) result.effort = source.effort;
    } else if (active?.kind === 'cli') {
      if (source.model) result.model = source.model;
      if (source.effort) result.effort = source.effort;
    }
    return Object.keys(result).length ? result : null;
  };
  const get = id => {const ticket=db.get('ticket',id);if(!ticket)throw workError('工单不存在',404);return publicTicket(ticket);};
  const related = (kind,id) => db.list(kind).filter(row=>row.ticketId===id);
  // 删掉某几个对话名下的全部工单。删除工作文件夹或对话时必须跟着清，
  // 否则这些工单会以「待确认」的身份永远留在提醒里，点开却已经找不到项目。
  const purgeChatTickets = chatIds => {
    const owners = new Set(chatIds.filter(Boolean));
    if (!owners.size) return 0;
    const rows = db.list('ticket').filter(ticket => owners.has(store.get('work-control', ticket.id)?.projectChatId));
    for (const ticket of rows) {
      for (const row of related('assignment', ticket.id)) {
        if (row.sessionId) try { store.delete('task', row.sessionId); } catch { /* 任务已不存在。 */ }
        db.delete('assignment', row.id);
      }
      for (const row of related('report', ticket.id)) db.delete('report', row.id);
      for (const row of store.list('work-event').filter(item => item.ticketId === ticket.id)) store.delete('work-event', row.id);
      try { store.delete('work-control', ticket.id); } catch { /* 控制记录可能已不存在。 */ }
      try { store.delete('git-snapshot', ticket.id); } catch { /* 快照可能已不存在。 */ }
      db.delete('ticket', ticket.id);
    }
    return rows.length;
  };
  // 项目/对话删除时一并清掉计划、检查点、补偿、团队房间与项目记忆；
  // 只清工单会留下永远到不了也删不掉的「僵尸计划」。
  const purgeProjectData = ({ projectId = '', chatIds = [] } = {}) => {
    const chats = new Set(chatIds.filter(Boolean));
    const plans = db.list('plan').filter(plan => (projectId && plan.projectId === projectId) || (plan.projectChatId && chats.has(plan.projectChatId)));
    const planIds = new Set(plans.map(plan => plan.id));
    for (const plan of plans) db.delete('plan', plan.id);
    for (const kind of ['checkpoint', 'compensation']) {
      for (const row of db.list(kind)) if (planIds.has(row.planId)) db.delete(kind, row.id);
    }
    for (const room of db.list('team-room')) {
      if ((projectId && room.projectId === projectId) || (room.planId && planIds.has(room.planId))) db.delete('team-room', room.id);
    }
    if (projectId) for (const row of db.list('project-memory')) if (row.projectId === projectId) db.delete('project-memory', row.id);
    return planIds.size;
  };
  // 删掉文件夹或对话时，挂在它上面的编排记录也要一起清掉：
  // 留着这些记录只会在界面上变成「点一下就报项目不存在」的僵尸卡片。
  const purgeRuns = ({ projectId = '', chatIds = [] } = {}) => {
    const owners = new Set(chatIds.filter(Boolean));
    if (!projectId && !owners.size) return 0;
    const rows = db.list('run').filter(run => (projectId && run.projectId === projectId) || owners.has(run.chatId));
    for (const run of rows) db.delete('run', run.id);
    return rows.length;
  };
  // 浏览器「允许域名」以前只被存进策略、执行器从不读取，等于摆设；这里真正拦下来。
  const enforceBrowserHost = (id, executorInput, hosts) => {
    if (id !== 'browser') return;
    const url = executorInput && typeof executorInput.url === 'string' ? executorInput.url : '';
    if (!url) return;
    const list = (Array.isArray(hosts) ? hosts : []).filter(item => typeof item === 'string' && item.trim());
    if (!list.length) return;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
    const allowed = list.some(entry => {
      const value = entry.trim().toLowerCase();
      return host === value || host.endsWith(`.${value}`);
    });
    if (!allowed) throw workError(`浏览器只允许访问 ${list.join('、')}`, 403);
  };
  const executorId = value => {
    if(value===undefined||value===null)return 'terminal';
    if(typeof value!=='string'||!value.trim())throw workError('executorId 必须是非空字符串');
    return value.trim();
  };
  const executorFor = assignment => executors.resolve(assignment?.executor || 'terminal');  const assignmentExecutorId = (ticket, assignment) => assignment?.executor || ticket?.executor || 'terminal';
  const normalizeExecutorInput = (id, target, input, fallbackText) => {
    let value = input;
    if (value === undefined && typeof target.defaultInput === 'function' && typeof fallbackText === 'string' && fallbackText.trim()) value = target.defaultInput(fallbackText);
    if (typeof target.validateInput === 'function') return target.validateInput(value);
    if (value !== undefined) throw workError('该执行器不接受 executorInput');
    return null;
  };
  const projectContext = (projectChatId, { required = false } = {}) => {
    const id = typeof projectChatId === 'string' ? projectChatId.trim() : '';
    if (!id) {
      if (required) throw workError('项目对话 id 无效', 400);
      return null;
    }
    const chat = db.get('project-chat', id);
    if (!chat) throw workError('项目对话不存在', 404);
    const project = db.get('project', chat.projectId);
    if (!project) throw workError('项目文件夹已不存在，请重新导入', 409);
    return { chat, project };
  };
  const projectMemoryContext = (project, options = {}) => {
    try {
      const digest = memory.digest(project.id, { limit: 6, ...(options.goal ? { goal: options.goal } : {}), ...(options.scopes ? { scopes: options.scopes } : {}) });
      // 同执行器的失败教训优先于泛化历史：上次怎么失败的，下次先避开。
      const lessons = memory.playbookDigest(project.id, {
        executorId: options.executorId,
        goal: options.goal,
        scopes: options.scopes,
        limit: 3,
      });
      return [
        digest ? `【项目关键改动 · 之前会话留下的结论与待办】\n${digest}` : '',
        lessons,
      ].filter(Boolean).join('\n\n');
    } catch {
      return '';
    }
  };
  // 当前生效的配置档 Library：项目级优先，没有就回退全局。
  // 之前它只被存进配置档，没有任何执行器读取；现在统一从这里取，注入提示词与 Library 同步。
  const activeLibrary = projectId => {
    let base = null;
    try {
      base = profiles.active(projectId).effective?.library || profiles.active().effective?.library || null;
    } catch {
      base = null;
    }
    // 技能中心装好的技能也进入 Library 清单，其他 CLI 至少能从上下文里知道它们存在。
    let installed = [];
    try {
      installed = skillService.enabledForProject(projectId).map(skill => skill.name);
    } catch {
      installed = [];
    }
    if (!installed.length) return base;
    const skills = [...new Set([...(Array.isArray(base?.skills) ? base.skills : []), ...installed])];
    return { instructions: [], mcpServers: [], ...(base || {}), skills };
  };
  // 内置模型只拿索引，正文由 read_skill 按需读取；控制数量，避免系统提示被技能撑爆。
  const modelSkillIndex = projectId => {
    try {
      return skillService.enabledForProject(projectId).slice(0, 20).map(skill => ({
        name: skill.name,
        description: String(skill.description || '').slice(0, 240),
        path: skill.path,
      }));
    } catch {
      return [];
    }
  };
  // 按工作目录反查项目：执行器只知道自己的 workspace。
  const projectByPath = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    let target = null;
    try { target = path.resolve(value); } catch { return null; }
    for (const row of db.list('project')) {
      try { if (path.resolve(row.path) === target) return row; } catch { /* 路径坏掉的记录跳过 */ }
    }
    return null;
  };
  /**
   * 项目现状：让任何 Agent 先看「别人改过什么」，而不是把整个文件重读一遍。
   * 顺序按有用程度排：最近谁改了什么（含文件清单）→ 记忆里的结论/待办 → 当前还没提交的改动。
   */
  const projectStateBrief = workspace => {
    try {
      const project = projectByPath(workspace);
      if (!project) return '';
      const lines = ['【项目现状 · 由 Lagent 维护】', `项目：${project.name}（${project.path}）`];
      const changes = typeof projects.listChanges === 'function' ? projects.listChanges(project.id) : [];
      const recent = changes.slice(0, 6);
      if (recent.length) {
        lines.push('', '最近的改动（新的在前）：');
        for (const change of recent) {
          const when = String(change.createdAt || '').slice(5, 16).replace('T', ' ');
          const files = Array.isArray(change.files) ? change.files.slice(0, 8) : [];
          const head = `- ${when} · ${change.executorId || 'Agent'} · ${String(change.title || '').slice(0, 60)}`;
          lines.push(head);
          if (change.summary) lines.push(`  ${String(change.summary).replace(/\s+/g, ' ').slice(0, 160)}`);
          if (files.length) lines.push(`  动了：${files.join('、')}${change.files.length > 8 ? ` 等 ${change.files.length} 个` : ''}`);
        }
      }
      const digest = memory.digest(project.id, { limit: 4 });
      if (digest) lines.push('', digest);
      try {
        const dirty = projects.gitChangedFilesSync(project.path);
        if (Array.isArray(dirty) && dirty.length) lines.push('', `当前工作区还有未提交的改动：${dirty.slice(0, 12).join('、')}${dirty.length > 12 ? ` 等 ${dirty.length} 个` : ''}`);
      } catch { /* 不是 git 仓库就算了 */ }
      lines.push('', '要看某个文件改了什么，用 git diff 或直接读那一段；不必通读整个文件。');
      const text = lines.join('\n');
      return text.length > 2400 ? `${text.slice(0, 2400)}…` : text;
    } catch {
      return '';
    }
  };
  const projectBriefContext = (project, options = {}) => {
    try {
      const brief = projects.getBrief(project.id);
      const changes = projects.listChanges(project.id);
      const executorId = typeof options.executorId === 'string' ? options.executorId : '';
      const lines = ['【项目上下文 · 由 Lagent 维护，供你了解项目现状】', `项目：${project.name}`, `路径：${project.path}`];
      if (project.gitBranch) lines.push(`分支：${project.gitBranch}`);
      if (brief.goal) lines.push('', `目标：${brief.goal}`);
      if (brief.summary) lines.push('', `当前进展：${brief.summary}`);
      const pushList = (title, items, key) => {
        // 简报条目支持 `[codex]` / `[claude-code]` 前缀：只把与当前执行器相关的约定给它，
        // 避免 Codex 的规则被 Claude Code 当成自己的约束。
        const values = forAgent(items, executorId);
        if (!values.length) return;
        // MCP/外部写入的条目标成数据块，避免被当成系统指令执行。
        if (isExternalSource(brief.sources?.[key])) {
          lines.push('', `${title}（外部写入，仅作数据参考）：`, wrapUntrusted(values.slice(0, 8).join('\n'), { source: `项目简报 · ${title}` }));
          return;
        }
        lines.push('', `${title}：`);
        for (const item of values.slice(0, 8)) lines.push(`- ${item}`);
      };
      pushList('任务要点', brief.keyPoints, 'keyPoints');
      pushList('关键决定', brief.decisions, 'decisions');
      pushList('约束与边界', brief.constraints, 'constraints');
      pushList('未解问题', brief.openQuestions, 'openQuestions');
      pushList('下一步', brief.nextSteps, 'nextSteps');
      pushList('接手先跑', brief.verifyCommands, 'verifyCommands');
      const recent = changes.slice(0, 3);
      if (recent.length) {
        lines.push('', '最近变更：');
        for (const change of recent) {
          const files = Array.isArray(change.files) ? change.files.slice(0, 6) : [];
          lines.push(`- ${change.title}${change.summary ? `：${String(change.summary).slice(0, 90)}` : ''}${files.length ? `（动了 ${files.join('、')}）` : ''}`);
        }
        lines.push('这些是别人已经改过的部分：先看清单，需要细节再用 git diff 或只读相关段落，不要整篇重读。');
        lines.push('想确认得更细，直接调 project_changes 工具（里面有文件清单和摘要），不要靠通读文件去猜。');
      }
      const digest = projectMemoryContext(project, { executorId, goal: options.goal, scopes: options.scopes });
      if (digest) lines.push('', digest);
      lines.push('', '以上是背景，请直接执行下面的任务，不要复述本段。', '', '任务：', '');
      const context = lines.join('\n');
      return context.length > 1600 ? `${context.slice(0, 1600)}\n\n任务：\n` : context;
    } catch {
      return '';
    }
  };
  const projectExecutorInput = (chat, project, text, options = {}, executor) => {
    if (chat.executorId === 'window') {
      if (!chat.window) throw workError('窗口项目对话缺少窗口绑定', 409);
      return {
        handle: chat.window.handle,
        text,
        process: chat.window.process || undefined,
        ...(chat.window.title ? { title: chat.window.title } : {}),
        submit: true
      };
    }
    if (!executor || !['cli', 'model'].includes(executor.kind)) throw workError('该执行器暂不支持项目对话', 400);
    const requestedTurns = Number(options?.maxTurns);
    // 项目内的一次真实改动常常要读十来个文件、改几处、再验证一次；
    // 12 个回合会在「刚开始动手」时就被 error_max_turns 掐断。默认值和 CLI 执行器共用一套，
    // 否则这里写死 24 会让执行器里的默认值失效，大型项目仍会在收尾前被截断。
    // Claude Code 与内置模型都用 60：模型的一步就是一次工具调用，30 步写不完一套作业文件。
    // 其它 CLI 仍按各自的保守默认值（Codex 30）。
    const maxTurns = Number.isInteger(requestedTurns) && requestedTurns >= 1 && requestedTurns <= 120
      ? requestedTurns
      : (executor?.id === 'claude-code' || executor?.id === 'model' ? 60 : cliDefaultMaxTurns(env));
    // 单步超时：项目工作区走 projectExecutorInput，必须在这里透传，否则计划里的 timeoutMs 会被静默丢掉。
    const requestedTimeout = Number(options?.timeoutMs);
    const timeoutMs = Number.isSafeInteger(requestedTimeout) && requestedTimeout >= 60_000 && requestedTimeout <= 7_200_000 ? requestedTimeout : 0;
    const executorId = executor?.id || chat.executorId;
    // 同一个项目对话允许每条任务换执行器：会话续接按执行器分开存，
    // 否则把 Claude 的 sessionId 塞给 Codex 会直接续接失败。
    const sessionId = (chat.sessions && typeof chat.sessions[executorId] === 'string' ? chat.sessions[executorId] : '')
      || (executorId === chat.executorId && typeof chat.sessionId === 'string' ? chat.sessionId : '');
    const resuming = Boolean(sessionId);
    // 首条消息给完整项目简报；后续消息只带记忆摘录，避免每轮都塞大段背景。
    // 两者都按「当前执行器 + 这一步的范围 + 任务目标」做裁剪：不同 Agent 拿到不同的上下文。
    const scopes = Array.isArray(options?.scope) ? options.scope : (typeof options?.scope === 'string' && options.scope.trim() ? [options.scope] : []);
    const contextOptions = { executorId, goal: typeof options?.goal === 'string' && options.goal.trim() ? options.goal : text, ...(scopes.length ? { scopes } : {}) };
    const context = resuming ? projectMemoryContext(project, contextOptions) : projectBriefContext(project, contextOptions);
    // 权限模式决定能不能写：会话自己设了档位就用它，否则跟随全局策略；仅查看一律只读。
    const chatPermission = PERMISSIONS.includes(chat.permission) ? chat.permission : '';
    // 会话自己的档位 > 项目配置档 > 全局策略。
    const profilePermission = profiles.permissionForProject(project.id);
    const permission = chatPermission || (PERMISSIONS.includes(profilePermission) ? profilePermission : (PERMISSIONS.includes(policy.permission) ? policy.permission : 'workspace'));
    const isAcp = Array.isArray(executor.capabilities) && executor.capabilities.includes('acp');
    const isModel = executor?.id === 'model';
    const write = chat.writable !== false && permission !== 'read';
    // 计划步骤可以带一份已经写好的任务书（协作派单就是这么给的）；
    // 有就用它当正文，别再退回到一句标题。
    const body = typeof options?.prompt === 'string' && options.prompt.trim() ? options.prompt.trim() : text;
    // 配置档 Library 以前只存不读；现在每次任务都按执行器过滤后注入，instructions 是真规则，
    // skills/mcpServers 只作为清单提示（它们目前没有可生成的内容）。
    const libraryBlock = buildLibraryContext(activeLibrary(project.id), { executorId });
    const prompt = [context, libraryBlock, body].filter(Boolean).join('\n');
    const skillIndex = isModel ? modelSkillIndex(project.id) : [];
    return {
      prompt,
      maxTurns,
      ...(timeoutMs ? { timeoutMs } : {}),
      workspace: project.path,
      write,
      // CLI 执行器按档位决定确认策略：full 才完全放行，read/workspace 保持各自限制。
      ...(['cli', 'model'].includes(executor.kind) ? { permission } : {}),
      // 模型 Agent 的会话级模型与思考强度：只在模型执行器上透传，其它 CLI 不认识这些键。
      ...(isModel && typeof options?.profileId === 'string' && options.profileId.trim() ? { profileId: options.profileId.trim().slice(0, 100) } : {}),
      ...(isModel && typeof options?.effort === 'string' && options.effort.trim() ? { effort: options.effort.trim().slice(0, 10) } : {}),
      // 协作角色要跟着模型走进项目上下文：汇总/验收写「不通过」是结论，不是这份报告失败。
      ...(isModel && ['coordination', 'verify', 'synthesis'].includes(options?.role) ? { role: options.role } : {}),
      ...(isModel && Number.isInteger(options?.maxSteps) && options.maxSteps >= 1 && options.maxSteps <= 60 ? { maxSteps: options.maxSteps } : {}),
      // 外部 CLI：model/effort 由各 CLI 自己决定是否拼进参数（Codex/Claude Code 已支持）。
      ...(!isModel && typeof options?.model === 'string' && options.model.trim() ? { model: options.model.trim().slice(0, 120) } : {}),
      ...(!isModel && typeof options?.effort === 'string' && options.effort.trim() && options.effort !== 'default' ? { effort: options.effort.trim().slice(0, 10) } : {}),
      // 跨目录读写：策略里登记的额外目录直接放行，其余路径按权限模式处理（工作区模式下逐次弹窗）。
      ...(isModel && Array.isArray(policy.limits?.extraRoots) && policy.limits.extraRoots.length ? { roots: [...policy.limits.extraRoots] } : {}),
      ...(isModel ? { permission, confirmDanger: permission === 'workspace' && policy.limits?.confirmDanger !== false } : {}),
      // 内置模型：只传已启用技能的索引，正文由 read_skill 工具按需读取。
      ...(skillIndex.length ? { skills: skillIndex } : {}),
      ...(resuming ? { resume: sessionId } : {})
    };
  };
  // 执行前给项目工单拍一张 git 快照，执行完成后据此算出「本次真正改动的文件」。
  const takeGitSnapshot = (ticketId, projectPath, projectId = '') => {
    try {
      db.put('git-snapshot', { id: ticketId, files: projects.gitChangedFilesSync(projectPath), at: now() });
    } catch { /* 快照失败不影响工单创建。 */ }
    if (!checkpoints) return null;
    try {
      const ticket = db.get('work-ticket', ticketId);
      return checkpoints.capture({
        projectPath,
        projectId,
        threadId: ticket?.conversationId || ticket?.projectChatId || '',
        ticketId,
        reason: 'ticket'
      });
    } catch { return null; /* 检查点失败同样不影响工单。 */ }
  };
  const changedSinceSnapshot = (ticketId, projectPath) => {
    try {
      const snapshot = db.get('git-snapshot', ticketId);
      const after = projects.gitChangedFilesSync(projectPath);
      const before = snapshot && Array.isArray(snapshot.files) ? snapshot.files : [];
      return after.filter(file => !before.includes(file));
    } catch { return []; }
    finally { try { db.delete('git-snapshot', ticketId); } catch { /* 清理失败可忽略。 */ } }
  };
  // 计划步骤的完整产出落盘：工单报告会截断到几千字，下游步骤要靠文件才能读到完整材料。
  const planRunDir = project => {
    const base = project && typeof project.path === 'string' && project.path
      ? path.join(project.path, '.lagent', 'runs')
      : path.join(os.tmpdir(), 'lagent-runs');
    return base;
  };
  const writeStepArtifact = (ticket, body) => {
    try {
      const chat = ticket.projectChatId ? db.get('project-chat', ticket.projectChatId) : null;
      const plan = ticket.planId ? db.get('plan', ticket.planId) : null;
      const project = chat ? db.get('project', chat.projectId) : (plan && plan.projectId ? db.get('project', plan.projectId) : null);
      const dir = path.join(planRunDir(project), String(ticket.planId));
      fs.mkdirSync(dir, { recursive: true });
      const index = Number.isSafeInteger(ticket.planStep) ? ticket.planStep + 1 : 0;
      const file = path.join(dir, `${String(index).padStart(2, '0')}-${ticket.executor}.md`);
      fs.writeFileSync(file, body, 'utf8');
      return file;
    } catch { return null; }
  };
  const stepContext = (plan, upTo, executor = null) => {
    const lines = [];
    // 汇总类步骤要带上前面几步的产出。外部 CLI 的输入上限已放宽到 64KB，
    // 但内置模型执行器仍只有 16KB，所以两者用不同的截断预算。
    const modelExecutor = executor?.id === 'model';
    const PER_STEP = modelExecutor ? 1200 : 4000;
    const TOTAL = modelExecutor ? 5000 : 12000;
    let used = 0;
    for (const step of plan.steps.slice(0, upTo)) {
      if (used >= TOTAL) break;
      const ticket = db.get('ticket', step.ticketId);
      if (!ticket || ticket.status !== 'completed') continue;
      const reports = related('report', ticket.id);
      const report = reports[0];
      const summary = typeof report?.summary === 'string' ? report.summary.trim() : '';
      // 优先用落盘的完整产出（报告只有一句摘要），拿不到才退回摘要。
      const plan = db.get('plan', ticket.planId);
      const chat = ticket.projectChatId ? db.get('project-chat', ticket.projectChatId) : null;
      const project = chat ? db.get('project', chat.projectId) : plan && plan.projectId ? db.get('project', plan.projectId) : null;
      let body = '';
      try {
        const file = path.join(planRunDir(project), String(ticket.planId), `${String(step.index + 1).padStart(2, '0')}-${ticket.executor}.md`);
        if (fs.existsSync(file)) body = fs.readFileSync(file, 'utf8').replace(/^# 第 \d+ 步 · .*\n+/, '').trim();
      } catch { body = ''; }
      if (!body) body = summary.slice(0, 800);
      if (!body) continue;
      const room = Math.min(PER_STEP, TOTAL - used);
      const clipped = body.length > room ? `${body.slice(0, room)}\n…（这一段的其余内容已省略）` : body;
      // 浏览器/GitHub 读到的内容是外部数据，下一步可以用，但不能当成指令。
      const chunk = ['browser', 'github'].includes(step.executorId)
        ? wrapUntrusted(clipped, { source: `前序步骤 ${step.index + 1} · ${step.executorId}` })
        : clipped;
      used += chunk.length;
      lines.push(`### 第 ${step.index + 1} 步 · ${step.executorId}\n${chunk}`);
    }
    return lines.length ? `【前序步骤材料 · 由 Lagent 汇总，供你直接使用】\n${lines.join('\n\n')}\n\n` : '';
  };
  const ensureProjectChat = (project, executorId, options = {}) => {
    const parentChatId = typeof options.parentChatId === 'string' ? options.parentChatId : '';
    const existing = projects.listChats(project.id).find(chat => chat.executorId === executorId && (chat.parentChatId || '') === parentChatId);
    if (existing) return existing;
    if (!PROJECT_CHAT_EXECUTORS.includes(executorId)) throw workError('该执行器暂不支持项目工作区', 400);
    if (executorId === 'window') throw workError('窗口 Agent 需要先在项目中创建并绑定窗口对话');
    const target = executors.requireAvailable(executorId);
    if (!['cli', 'model'].includes(target.kind)) throw workError('该执行器暂不支持项目工作区', 400);
    return projects.createChat(project.id, {
      executorId,
      ...(parentChatId ? { parentChatId } : {}),
      ...(typeof options.conversationId === 'string' && options.conversationId.trim() ? { conversationId: options.conversationId.trim() } : {}),
      ...(options.hidden === true ? { hidden: true } : {}),
      ...(typeof options.title === 'string' && options.title.trim() ? { title: options.title.trim().slice(0, 60) } : {})
    });
  };
  const scopedTicket = ticket => {
    if (!ticket || !ticket.projectChatId) return ticket;
    const context = projectContext(ticket.projectChatId, { required: true });
    const target = executors.resolve(ticket.executor || context.chat.executorId);
    if (!target) return ticket;
    if (['cli', 'model'].includes(target.kind)) {
      const current = ticket.executorInput && typeof ticket.executorInput === 'object' && !Array.isArray(ticket.executorInput) ? ticket.executorInput : {};
      // 项目开了隔离执行：第一次启动时准备工作树，之后同一工单复用；
      // 准备失败退回主工作区，不阻断任务。
      let isolated = null;
      if (worktrees && context.project.isolation === 'worktree') {
        try {
          isolated = worktrees.byTicket(ticket.id) || worktrees.prepare({
            projectPath: context.project.path,
            ticketId: ticket.id,
            threadId: ticket.conversationId || ticket.projectChatId || ''
          });
        } catch { isolated = null; }
      }
      return {
        ...ticket,
        ...(isolated ? { worktreeId: isolated.id, worktreeBranch: isolated.branch } : {}),
        executorInput: {
          ...current,
          prompt: typeof current.prompt === 'string' && current.prompt.trim() ? current.prompt : String(ticket.command || ''),
          workspace: isolated?.path || context.project.path,
          write: current.write === undefined ? context.chat.writable !== false : current.write === true,
          ...(context.chat.sessionId && !current.resume ? { resume: context.chat.sessionId } : {})
        }
      };
    }
    if ((ticket.executor || context.chat.executorId) === 'window' && context.chat.window) {
      return { ...ticket, executorInput: { ...(ticket.executorInput || {}), ...context.chat.window } };
    }
    return ticket;
  };
  const touchProjectChat = (chat, patch = {}) => {
    if (!chat) return;
    const current = db.get('project-chat', chat.id);
    if (!current) return;
    db.put('project-chat', { ...current, ...patch, id: current.id, projectId: current.projectId, updatedAt: now() });
  };
  const reviewQuestion = (id, projectMode) => projectMode === 'window' ? '请确认在该窗口的 Agent 会话中发送指令'
    : projectMode === 'write' ? '请确认让 Agent 读取并修改项目文件'
    : id === 'terminal' ? '请确认受控终端命令'
    : id === 'codex' || id === 'claude-code' || id === 'opencode' || id.endsWith('-acp') ? '请确认只读 CLI 任务'
    : id === 'browser' ? '请确认受控浏览器读取'
    : id === 'github' ? '请确认 GitHub 只读查询'
    : '请确认执行此任务';
  // Control fields stay in the workspace, outside the event payload and API projection.
  const controlOf = ticket => {
    const {clientRequestId, command, lastAction, approvalSnapshot, executor, executorInput, projectChatId}=ticket;
    return {id:ticket.id,clientRequestId,command,lastAction,approvalSnapshot,executor,executorInput,projectChatId:projectChatId??null,origin:ticket.origin==='mcp'?'mcp':'ui'};
  };
  const write = (ticket,...entries) => {
    db.write([['ticket',publicTicket(ticket)],...entries],controlOf(ticket));
    return publicTicket(ticket);
  };
  const privateTicket = id => ({...get(id),...store.get('work-control',id)});
  const assignments = id => related('assignment',id);
  const latest = id => assignments(id)[0];
  const taskFor = id => {
    const assignment=latest(id);
    if(!assignment?.sessionId) return null;
    const live = executorFor(assignment)?.get?.(assignment.sessionId);
    if(live) return live;
    // 进程重启后执行器内存里的任务没了，过程流还留在库里：读回来，历史工单仍能看到当时做了什么
    try {
      const stored = db.get('task', assignment.sessionId);
      return stored && stored.ticketId === id ? stored : null;
    } catch { return null; }
  };
  const lastTeamKeys = new Map();
  const announceTeam = (ticketId, task, team = projectTeamTask(task)) => {
    const key = teamEventKey(task, team);
    if(!key || lastTeamKeys.get(ticketId) === key) return team;
    lastTeamKeys.set(ticketId, key);
    publish({type:'team',ticketId,payload:team});
    return team;
  };
  const mutateTeam = (ticketId, operation) => {
    get(ticketId);
    const assignment = latest(ticketId);
    if(!assignment?.sessionId) throw workError('团队尚未开始或快照不可用', 409);
    if(!projectTeamTask(executorFor(assignment)?.get?.(assignment.sessionId))) throw workError('该执行器不提供团队能力', 409);
    const outcome = store.atomic(() => {
      const task = executorFor(assignment)?.get?.(assignment.sessionId);
      if(!task) throw workError('团队尚未开始或快照不可用', 409);
      const team = operation(task);
      if(!team) throw workError('团队尚未开始或快照不可用', 409);
      store.put('task', task);
      return {task, team};
    });
    announceTeam(ticketId, outcome.task, outcome.team);
    return outcome.team;
  };
  // 报告的归属信息在写入时固化，报告中心不必每次回溯工单；旧报告仍可按 ticketId 回查。
  const makeReport = (ticket,assignment,kind,summary,artifacts) => ({
    id:randomUUID(),
    ticketId:ticket.id,
    assignmentId:assignment?.id,
    kind,
    summary,
    artifacts,
    createdAt:now(),
    ...(ticket.conversationId?{conversationId:ticket.conversationId}:{}),
    ...(ticket.turnId?{turnId:ticket.turnId}:{}),
    ...(ticket.role?{role:ticket.role}:{}),
    ...(ticket.executor||assignment?.executor?{executorId:ticket.executor||assignment.executor}:{})
  });
  const launchKey = assignment => `launch:${assignment.ticketId}:${assignment.id}`;
  const launchStage = (activeId, active) => activeId==='terminal'?'terminal':['cli','model'].includes(active.kind)?'cli':['tool','window'].includes(active.kind)?'tool':'terminal';
  const launchLabel = (activeId, active) => activeId==='terminal'?'终端命令':activeId==='workbuddy'?'WorkBuddy':activeId==='model'?'Lagent':active.kind==='cli'?'只读 CLI':['tool','window'].includes(active.kind)?(activeId==='browser'?'浏览器':activeId==='github'?'GitHub':active.name):'Agent';
  const queuedSummary = (activeId, active) => `${launchLabel(activeId, active)}等待启动`;
  const launchInput = ticket => ({
    ...(ticket.executorInput!==undefined?{executorInput:ticket.executorInput}:{})
  });
  function markEffectFailed(effect, error) {
    const lastError=sanitizeOutboxError(error);
    const failed={...effect,status:'failed',lastError,updatedAt:now()};
    store.atomic(()=>store.put('work-effect',failed));
    return failed;
  }
  function settleLaunchFailure(effect, error, forcedStatus) {
    const safe=sanitizeOutboxError(error);
    const ticket=db.get('ticket',effect.ticketId);
    if(!ticket)return;
    const assignment=db.get('assignment',effect.payload?.assignmentId);
    const activeId=assignment?.executor||ticket.executor||'terminal';
    const active=executors.resolve(activeId);
    const status=forcedStatus||'failed';
    const summary=status==='blocked'?'执行器启动受阻，未进入执行':`${launchLabel(activeId,active||{name:'执行器',kind:'terminal'})}启动失败，已停止重试`;
    const next={...privateTicket(ticket.id),status,stage:status==='blocked'?'launch':'result',attention:undefined,summary,updatedAt:now()};
    const run=assignment?{...assignment,status,endedAt:now(),error:safe}:null;
    write(next,...(run?[['assignment',run],['report',makeReport(next,run,status,summary)]]:[]));
    if(next.planId&&Number.isSafeInteger(next.planStep))advancePlan(next.planId);
    audit(ticket.id,'launch',activeId,status,safe);
  }
  function requeueLaunch(effect, error) {
    const safe=sanitizeOutboxError(error);
    const ticket=db.get('ticket',effect.ticketId);
    const assignment=db.get('assignment',effect.payload?.assignmentId);
    if(!ticket||!assignment)return;
    const activeId=assignment.executor||ticket.executor||'terminal';
    const active=executors.resolve(activeId)||{name:'执行器',kind:'terminal'};
    const queued={...privateTicket(ticket.id),status:'queued',stage:'launch',attention:undefined,summary:queuedSummary(activeId,active),updatedAt:now()};
    write(queued,['assignment',{...assignment,status:'queued',error:safe}]);
    audit(ticket.id,'launch-retry',activeId,'queued',safe);
  }
  function handleLaunchFailure(effect, error) {
    const permanent=[400,401,403,404,409,422].includes(error?.status);
    if(permanent){
      markEffectFailed(effect,error);
      settleLaunchFailure(effect,error,error.status===400?'blocked':'failed');
      return;
    }
    const next=failOutbox(store,effect.id,error);
    if(next?.status==='failed')settleLaunchFailure(effect,error,'failed');
    else requeueLaunch(effect,error);
  }
  function launchEffect(effect) {
    const ticket=db.get('ticket',effect.ticketId);
    const assignment=db.get('assignment',effect.payload?.assignmentId);
    if(!ticket||!assignment||assignment.ticketId!==ticket.id||!['queued','working'].includes(ticket.status)||!['queued','working'].includes(assignment.status)){
      complete(store,effect.id);
      return effect;
    }
    const activeId=assignment.executor||ticket.executor||'terminal';
    let active;
    try {
      active=executors.requireAvailable(activeId);
      guard(activeId,ticket.id,'launch');
    } catch(error) {
      handleLaunchFailure(effect,error);
      return effect;
    }
    const privateState=scopedTicket(privateTicket(ticket.id));
    const startedAt=assignment.startedAt||now();
    const working={...privateState,executor:activeId,status:'working',stage:launchStage(activeId,active),attention:undefined,summary:`${launchLabel(activeId,active)}执行中`,updatedAt:now()};
    const run={...assignment,status:'working',startedAt,endedAt:undefined,error:undefined};
    try {
      write(working,['assignment',run]);
      const task=active.start(working,run,launchInput(privateState));
      complete(store,effect.id);
      audit(ticket.id,'launch',activeId,'started');
      sync(working,run,task);active.resume?.(task);
    } catch(error) {
      handleLaunchFailure(effect,error);
    }
    return effect;
  }
  function drainOutbox(drainOptions={}) {
    if(!outboxEnabled||closed||drainingOutbox)return [];
    drainingOutbox=true;
    try {
      const running=db.list('assignment').filter(row=>row.status==='working').length;
      const free=Math.max(0,policy.budgets.maxConcurrent-running);
      const requested=Number.isSafeInteger(drainOptions.limit)?Math.max(0,drainOptions.limit):free;
      const limit=Math.min(free,requested);
      if(!limit)return [];
      const claimed=claimDue(store,{limit,now:drainOptions.now});
      for(const effect of claimed)launchEffect(effect);
      return claimed;
    } finally {
      drainingOutbox=false;
    }
  }
  /** 执行器自己报告的产出文件：不是 git 仓库时，变更档案就靠它。 */
  function reportedFiles(task) {
    const names = [];
    const push = value => {
      if (typeof value !== 'string') return;
      const name = value.replace(/（[^）]*）$/, '').trim();
      if (name && !names.includes(name)) names.push(name);
    };
    const cli = task?.artifacts?.cli;
    if (Array.isArray(cli?.artifacts)) for (const item of cli.artifacts) push(item);
    if (Array.isArray(cli?.files)) for (const item of cli.files) push(item);
    if (Array.isArray(task?.artifacts?.files)) for (const item of task.artifacts.files) push(item);
    return names.slice(0, 40);
  }
  // 项目记忆一变，已经托管的 CLAUDE.md / AGENTS.md 就会过期。
  // 只在用户手动同步过之后自动刷新（不新增文件、不制造意外写入），并做 15 秒去抖。
  const libraryAutoSyncAt = new Map();
  function autoSyncLibrary(project) {
    try {
      if (!project?.id || !library.shouldAutoSync(project.id)) return;
      const last = libraryAutoSyncAt.get(project.id) || 0;
      if (Date.now() - last < 15000) return;
      libraryAutoSyncAt.set(project.id, Date.now());
      library.autoApply(project.id, { library: activeLibrary(project.id) });
    } catch { /* 自动刷新失败不能影响工单本身。 */ }
  }
  /** 把一次完成/失败的执行写成项目记忆；有模型时异步换成更好的总结。 */
  function recordProjectMemory(project, { ticket, status, summary, files, executorId, projectChatId }) {
    // 失败反思独立于「关键改动」：失败本身就是可复用信息，哪怕没留下文件也要记。
    // 成功时只给同目录的反思记正例，不改正文，保证 playbook 条目只增、只合并、只淘汰。
    try {
      if (status === 'failed' || status === 'blocked') {
        memory.reflect(project.id, {
          ticketId: ticket.id,
          projectChatId,
          executorId,
          title: ticket.title,
          status,
          failureCode: status,
          summary: deriveFailureLesson({ summary, status }),
          files,
        });
      } else if (status === 'completed') {
        const scopes = [...new Set((Array.isArray(files) ? files : [])
          .map(file => String(file).replaceAll('\\', '/').split('/').slice(0, -1).join('/'))
          .filter(Boolean))];
        if (scopes.length) memory.reinforce(project.id, { executorId, success: true, scopes });
      }
    } catch { /* 反思写入失败不影响工单。 */ }
    // 记忆只留「关键改动」：真的动了文件，或者留下了能复用的结论。
    // 只读排查、纯问答不写，否则同一个项目的其他对话会被这些过程噪声淹没。
    if (!isKeyChange({ summary, files, status })) return null;
    let entry = null;
    try {
      const base = summarizeExecution({
        ticket: { title: ticket.title, command: ticket.command },
        report: { summary },
        files,
        status
      });
      entry = memory.add(project.id, {
        ...base,
        // 有文件变化记成 change，只有结论记成 note：摘要里分开显示，读的人一眼能分清。
        kind: Array.isArray(files) && files.length ? 'change' : 'note',
        ticketId: ticket.id,
        projectChatId: projectChatId || null,
        executorId,
        tags: [executorId, status].filter(Boolean),
        source: 'local'
      });
    } catch { /* 记忆写入失败不影响工单。 */ }
    if (entry) autoSyncLibrary(project);
    if (!entry || !brain) return entry;
    const availability = brain.availability?.();
    if (!availability?.ok) return entry;
    void brain
      .summarize({ goal: ticket.command, project, executorId, summary, files, kind: 'ticket' })
      .then(result => {
        if (!result?.summary) return;
        memory.update(entry.id, { ...result, source: 'model' });
        autoSyncLibrary(project);
      })
      .catch(() => { /* 模型总结失败就保留本地总结。 */ });
    return entry;
  }
  // 模型 Agent 每走一步都会改写 task.activity；这里把它推给界面，让过程像 CLI 一样可见。
  const activitySeen = new Map();
  function announceActivity(ticketId, task) {
    const list = Array.isArray(task?.activity) ? task.activity : [];
    if (!list.length) return;
    const last = list[list.length - 1];
    const signature = `${list.length}:${last?.at || ''}`;
    if (activitySeen.get(ticketId) === signature) return;
    activitySeen.set(ticketId, signature);
    publish({ type: 'activity', ticketId, payload: { activity: list.slice(-40), status: task.status || null } });
  }
  // CLI 执行器在项目里的对话是否可写：决定摘要说「CLI」还是「只读 CLI」。
  // 编排器给写步骤建的是可写子对话，摘要却一直写「只读」，看起来像没生效。
  function cliWritable(ticket) {
    if (ticket?.executorInput?.write === true) return true;
    if (!ticket?.projectChatId) return false;
    const chat = db.get('project-chat', ticket.projectChatId);
    return chat?.writable === true;
  }

  function sync(ticket, assignment, task) {
    if(!task)return;
    announceActivity(ticket.id, task);
    const activeId=assignmentExecutorId(ticket, assignment);
    const active=executors.resolve(activeId);
    if(!active)return;
    const team=projectTeamTask(task);
    if(team)announceTeam(ticket.id, task, team);
    // P0.2：执行器在 running 中挂起的文件授权（ACP）也要进审批收件箱；
    // 这里每轮 sync 都会走，approvals.request 按 fingerprint 去重。
    if(approvals&&Array.isArray(task.activity)){
      for(const row of task.activity.filter(item=>item.kind==='permission'&&item.requestId&&!item.decided).slice(-3)){
        requestApproval({
          threadId:ticket.conversationId||ticket.id,
          ticketId:ticket.id,
          requestId:String(row.requestId).slice(0,120),
          kind:'tool',
          executor:activeId,
          title:ticket.title,
          summary:String(row.text||'等待授权').slice(0,600),
          options:['allow_once','deny'],
          risk:'medium',
          input:{text:String(row.text||'').slice(0,600),detail:String(row.detail||'').slice(0,600)}
        });
      }
    }
    if(!['working','awaiting_review'].includes(ticket.status))return;
    // 只要执行器还在被轮询到，就记一次心跳；节流避免每次 store 变更都写盘。
    if (assignment && assignment.status === 'working' && ['running', 'awaiting_approval'].includes(task.status)) {
      const lastBeat = assignment.heartbeatAt ? Date.parse(assignment.heartbeatAt) : 0;
      if (!lastBeat || Date.now() - lastBeat > heartbeatWriteMs) {
        assignment = { ...assignment, heartbeatAt: now() };
        db.put('assignment', assignment);
      }
    }
    let status = {running:'working',awaiting_approval:'awaiting_review',completed:'completed',failed:'failed',cancelled:'cancelled'}[task.status];
    const approvalSnapshot=status==='awaiting_review'?active.approval?.(task):undefined;
    if(!status || (ticket.status===status&&assignment.sessionId===task.id&&JSON.stringify(approvalSnapshot)===JSON.stringify(ticket.approvalSnapshot)))return;
    // 完成不等于交付：契约里写了「必须落盘」的文件，缺一个就不能对外报完成。
    // 这条检查只对声明了 deliverables 的任务生效，旧工单行为不变。
    const missing = status === 'completed' ? missingDeliverables(ticket.contract, projectPathForTicket(ticket)) : [];
    if (missing.length) status = 'failed';
    const terminal=activeId==='terminal';
    const cli=['cli','model'].includes(active.kind);
    const tool=['tool','window'].includes(active.kind);
    const label=terminal?'终端命令':cli?(activeId==='model'?'Lagent':activeId==='workbuddy'?'WorkBuddy':cliWritable(ticket)?'CLI':'只读 CLI'):tool?(activeId==='browser'?'浏览器':activeId==='github'?'GitHub':active.name):'分析';
    const toolInfo=tool?(task.artifacts?.[activeId]||{}):null;
    const toolSummary=activeId==='github'
      ? (toolInfo?.action==='search'
        ? `GitHub 搜索「${toolInfo.query||''}」命中 ${toolInfo.total??0} 个仓库`
        : toolInfo?.action==='file' ? `读取 GitHub 文件 ${toolInfo.path||''}` : 'GitHub 查询完成')
      : activeId==='browser'
        ? (toolInfo?.title ? `浏览器读取完成：${String(toolInfo.title).slice(0,60)}` : '浏览器读取完成')
        : `${label}执行完成`;
    const toolDetail=(() => {
      if(!tool)return '';
      const info=toolInfo||{};
      if(activeId==='github'){
        if(info.action==='search'&&Array.isArray(info.items)){
          return [`搜索：${info.query||''}`, `命中：${info.total??info.items.length} 个仓库`, '',
            ...info.items.map(item=>`- ${item.fullName}（${item.stars??0}★${item.language?` · ${item.language}`:''}）${item.description?`— ${item.description}`:''}\n  ${item.url}`)].join('\n');
        }
        if(info.action==='file'&&typeof info.content==='string')return [`文件：${info.path||''}`, `大小：${info.size??0} 字节`, '', String(info.content).slice(0,8000)].join('\n');
        if(Array.isArray(info.items))return info.items.map(item=>`- ${item.title||item.fullName||item.number||item.id}${item.state?`（${item.state}）`:''}`).join('\n');
        return '';
      }
      if(activeId==='browser'){
        return [`页面：${info.title||''}`, `地址：${info.url||''}`, '', String(info.text||'').slice(0,4000)].join('\n');
      }
      return '';
    })();
    const failureSummary = missing.length
      ? `缺少交付文件：${missing.slice(0, 6).join('、')}${missing.length > 6 ? ` 等 ${missing.length} 个` : ''}`
      : String(task.error||`${label}执行失败`);
    const summary=status==='failed'?failureSummary.slice(0,400):{
      working:`${label}执行中`,
      awaiting_review:task.accessRequest?accessPrompt(task.accessRequest):`${label}等待确认`,
      completed:activeId==='window'?(typeof task.report?.summary==='string'&&task.report.summary.trim()?task.report.summary.trim():'窗口指令已发送'):tool?toolSummary:terminal?'终端命令执行完成':activeId==='model'?(typeof task.artifacts?.cli?.summary==='string'&&task.artifacts.cli.summary.trim()?task.artifacts.cli.summary.trim().slice(0,200):'模型 Agent 执行完成'):cli?(typeof task.artifacts?.cli?.summary==='string'&&task.artifacts.cli.summary.trim()?task.artifacts.cli.summary.trim().slice(0,300):typeof task.report?.summary==='string'&&task.report.summary.trim()?task.report.summary.trim().slice(0,300):`${label}执行完成`):'分析报告已生成',
      cancelled:`${label}已停止`
    }[status];
    // P0.2：工单停在任何等待确认的节点，都对应一条审批；越权访问带 requestId，
    // 旧按钮仍可走 permissionDecision / action，审批只是同一事实的另一个入口。
    let approvalId=ticket.approvalId;
    if(approvals&&status==='awaiting_review'){
      const access=task.accessRequest;
      const created=requestApproval({
        threadId:ticket.conversationId||ticket.id,
        ticketId:ticket.id,
        kind:access?'access':'ticket',
        ...(access?.id?{requestId:String(access.id).slice(0,120)}:{}),
        executor:activeId,
        title:ticket.title,
        summary,
        options:['allow_once','deny'],
        risk:'medium',
        ...(access?{input:{path:String(access.path||'').slice(0,300),mode:access.mode},scope:{path:String(access.path||'').slice(0,300)}}:{})
      });
      if(created?.id)approvalId=created.id;
    }
    const finished=['completed','failed','cancelled'].includes(status);
    const next={...ticket,status,...(approvalId?{approvalId}:{}),stage:status==='awaiting_review'?(task.steps?.[task.currentStep]?.id||(terminal||cli||tool?'approval':'plan')):finished?'result':terminal?'terminal':cli?'cli':tool?'tool':'terminal',summary,updatedAt:now(),approvalSnapshot,attention:status==='awaiting_review'?(task.accessRequest?accessReview(task.accessRequest):review(summary)):undefined};
    const run={...assignment,status,sessionId:task.id,...(status==='working'?{heartbeatAt:now()}:{}),...(finished?{endedAt:now()}: {})};
    const kind={awaiting_review:'waiting',completed:'ready',failed:'failed',cancelled:'dropped'}[status];
    const artifacts={taskId:task.id,...(status==='completed'&&task.report?{report:task.report}:{}),...(terminal&&task.artifacts?.terminal?{terminal:task.artifacts.terminal}:{}),...(cli&&task.artifacts?.cli?{cli:task.artifacts.cli}:{}),...(tool&&task.artifacts?.[activeId]?{[activeId]:task.artifacts[activeId]}:{})};
    write(next,['assignment',run],...(kind?[['report',makeReport(next,run,kind,summary,artifacts)]]:[]));
    if (finished && next.planId && Number.isSafeInteger(next.planStep)) {
      // ticket 的 summary 往往被压到 300 字，直接写进产物会让下一步只拿到开头。
      // 取执行器报告、CLI 摘要、工具产出里最长的一份，别让短摘要覆盖完整审查意见。
      const detail = status === 'failed'
        ? String(task.error || summary || '执行失败')
        : [
            task.report && typeof task.report.summary === 'string' ? task.report.summary.trim() : '',
            cli && typeof task.artifacts?.cli?.detail === 'string' ? task.artifacts.cli.detail.trim() : '',
            cli && typeof task.artifacts?.cli?.summary === 'string' ? task.artifacts.cli.summary.trim() : '',
            toolDetail || '',
            summary || ''
          ].reduce((longest, value) => (String(value || '').length > longest.length ? String(value) : longest), '');
      const body = [
        `# 第 ${next.planStep + 1} 步 · ${next.executor}`,
        '',
        `- 工单：${next.id}`,
        `- 状态：${status}`,
        `- 更新时间：${next.updatedAt}`,
        '',
        '## 产出',
        '',
        String(detail || '').slice(0, 20000) || '_没有产出说明_',
        ''
      ].join('\n');
      writeStepArtifact(next, body);
    }
    if (next.projectChatId) {
      const chat = db.get('project-chat', next.projectChatId);
      if (chat) {
        // 失败也保存会话 id：回合上限、超时这类失败最需要从原会话继续，
        // 否则用户只能在新会话里重做一遍。只有完成时才写摘要，失败原因仍以报告为准。
        const sessionId = ['completed', 'failed'].includes(status) ? task.artifacts?.cli?.sessionId : '';
        const cliSummary = status === 'completed' && typeof task.artifacts?.cli?.summary === 'string' && task.artifacts.cli.summary.trim() ? task.artifacts.cli.summary.trim() : String(summary);
        // 同一会话里换过 Agent 时，续接 id 要按执行器分开存；chat.sessionId 仍保留给会话默认执行器。
        const sessions = { ...(chat.sessions || {}) };
        if (typeof sessionId === 'string' && sessionId) sessions[activeId] = sessionId;
        const keepsDefaultSession = activeId === chat.executorId;
        db.put('project-chat', {
          ...chat,
          lastTicketId: ticket.id,
          ...(keepsDefaultSession && typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
          ...(Object.keys(sessions).length ? { sessions } : {}),
          ...(finished ? { lastSummary: cliSummary.slice(0, 200) } : {}),
          updatedAt: now()
        });
        if (finished) {
          const project = db.get('project', chat.projectId);
          // 文件清单优先用 git 前后差集；目录不是 git 仓库时退回执行器自己报告的产出
          // （model 的 artifacts.cli.artifacts、CLI 的 files），否则变更档案里永远是空的。
          // 失败也要记：文件确实被改过，这件事跟这次任务算不算成功无关。
          const reported = reportedFiles(task);
          // 隔离执行时改动发生在工作树里：按基线差集取文件，主工作区的快照不适用。
          const isolated = worktrees?.byTicket(ticket.id) || null;
          const gitFiles = isolated
            ? worktrees.changedSince(isolated.id)
            : (status === 'completed' ? changedSinceSnapshot(ticket.id, project.path) : []);
          // 非 Git 项目没有 diff 可用：按执行开始时间扫 mtime，否则产物页永远只有执行器主动报告的少数文件。
          const scanStart = Date.parse(assignment?.startedAt || ticket.startedAt || ticket.createdAt || '') || 0;
          const touched = project && !projects.isGitRepo(project.path) && scanStart
            ? projects.filesModifiedSince(project.path, scanStart)
            : [];
          const changedFiles = project
            ? [...new Set([...gitFiles, ...reported, ...touched])].slice(0, 100)
            : [];
          if (project && status !== 'cancelled') {
            try {
              projects.recordChange(project.id, {
                ticketId: ticket.id,
                projectChatId: chat.id,
                executorId: activeId,
                title: ticket.title,
                summary: cliSummary,
                sessionId: typeof sessionId === 'string' ? sessionId : '',
                status,
                files: changedFiles
              }, { source: 'auto' });
            } catch { /* 变更档案写入失败不影响工单状态。 */ }
          }
          if (project && status !== 'completed') changedSinceSnapshot(ticket.id, project.path);
          // 工作树里的改动提交到独立分支 lagent/<短 id>，然后释放目录；不合回、不推送。
          // 提交失败就保留工作树，让人能看到现场。
          if (isolated) {
            try {
              worktrees.commit(isolated.id, `lagent: ${String(ticket.title || '').slice(0, 120)}`);
              worktrees.release(isolated.id);
            } catch { /* 保留工作树待人工处理。 */ }
          }
          if (project) {
            recordProjectMemory(project, {
              ticket,
              status,
              summary: cliSummary,
              files: changedFiles,
              executorId: activeId,
              projectChatId: chat.id
            });
          }
        }
      }
    }
    if (next.planId && Number.isSafeInteger(next.planStep)) {
      advancePlan(next.planId);
      // 一步结束会腾出执行器名额，但别的计划里因「并发已满」退回 waiting 的步骤
      // 没有事件可等，会一直排队。这里统一踢一脚，让多计划并行时后面的计划自己接上。
      for (const plan of db.list('plan')) {
        if (plan.status !== 'active' || plan.id === next.planId) continue;
        if (plan.steps.some(step => db.get('ticket', step.ticketId)?.status === 'waiting')) advancePlan(plan.id);
      }
    }
    // 回合用尽、服务重启、超时、交付文件缺失都可续跑：计划步骤不该因为一次中断就整条作废。
    if (finished && status === 'failed' && next.planId && Number.isSafeInteger(next.planStep)) {
      scheduleAutoContinue(next, summary);
    }
    if (finished) {
      const projectId = next.projectChatId ? db.get('project-chat', next.projectChatId)?.projectId : '';
      try {
        recordTicketUsage(store, { ticket: next, assignment: run, task, executorId: activeId, projectId: projectId || '', now: new Date().toISOString() });
        // 单工单用量达到 80% 时发一条预算告警：桌面端走事件流，移动端落通知列表。
        const budget = policy.budgets?.maxTokensPerTicket;
        if (Number.isSafeInteger(budget) && budget > 0) {
          const used = ticketTokensUsed(store, next.id);
          const alerted = store.list('work-event').some(event => event.type === 'usage-alert' && event.ticketId === next.id);
          if (!alerted && used >= budget * 0.8) {
            publish(appendWorkEvent(store, 'usage-alert', {
              ticketId: next.id,
              status: 'budget_warning',
              title: 'Token 预算告警',
              summary: `工单「${String(next.title || next.id).slice(0, 60)}」已用 ${used.toLocaleString()} / ${budget.toLocaleString()} tokens（${Math.round(used / budget * 100)}%）。`
            }));
          }
        }
      } catch { /* 用量记录失败不影响工单状态。 */ }
      if (status === 'completed') scheduleAutoVerify(next);
    }
  }
  // 验收命令在 Lagent 侧执行，项目目录优先取工单绑定的工作文件夹。
  function projectPathForTicket(ticket) {
    // 没有绑定项目的计划也必须安全返回：db.get('project', undefined) 会抛「无效的资源 ID」。
    const planProjectId = ticket?.planId ? db.get('plan', ticket.planId)?.projectId : '';
    const project = projectContext(ticket?.projectChatId)?.project
      || (planProjectId ? db.get('project', planProjectId) : null)
      || null;
    return project?.path || workspace;
  }
  // 证据链顺序：执行验收 > 结构评审 > 模型评审。验收失败时，评审不能单独放行。
  function reviewAcceptance(ticket, acceptance) {
    return critiqueResult(
      { findings: [], recommendations: [], limitations: [] },
      { task: ticket, verification: acceptance }
    );
  }
  function scheduleAutoVerify(ticket) {
    if (!autoVerify || !ticket?.verify || verifyingTickets.has(ticket.id) || ticket.acceptance) return;
    verifyingTickets.add(ticket.id);
    void runVerify({ verify: ticket.verify, projectPath: projectPathForTicket(ticket) })
      .then(acceptance => {
        const stored = db.get('ticket', ticket.id);
        // 验收跑完时工单可能已被停止、删除或重试，只处理仍然 completed 的那一条。
        if (!stored || stored.status !== 'completed') return;
        // db.get 是脱敏投影；必须并回 control 再写，否则自动验收会清空冻结输入等控制字段。
        const current = { ...stored, ...store.get('work-control', ticket.id) };
        const evidence = reviewAcceptance(current, acceptance);
        const failed = acceptance.status !== 'passed' || evidence.verdict === 'reject';
        const summary = acceptance.status !== 'passed'
          ? `验收未通过：${acceptance.command}`
          : evidence.verdict === 'reject'
            ? `评审未通过：${evidence.issues[0]?.message || acceptance.command}`
            : `验收通过：${acceptance.command}`;
        const next = { ...current, acceptance, review: evidence, stage: 'verify', summary, updatedAt: now(), ...(failed ? { status: 'blocked', attention: review(summary) } : { attention: undefined }) };
        const assignment = latest(ticket.id);
        const report = assignment ? [['report', makeReport(next, assignment, failed ? 'failed' : 'ready', summary, { acceptance, review: evidence })]] : [];
        write(next, ...report);
        audit(ticket.id, 'verify:auto', ticket.executor, failed ? 'failed' : 'passed', acceptance.command);
        if (failed && next.planId && Number.isSafeInteger(next.planStep)) advancePlan(next.planId);
      })
      .catch(() => { /* 自动验收失败不改变工单状态，用户仍可手动验收。 */ })
      .finally(() => verifyingTickets.delete(ticket.id));
  }
  // 可续跑的失败：回合/步数用尽、超时、服务重启、交付文件缺失。
  // 模型说「没做完」但原因是需求冲突之类，不会命中这些词，仍然直接失败，避免白烧预算。
  const AUTO_CONTINUE_RE = /步数|回合|max[_-]?turns|中断|超时|中止|缺少交付文件/i;
  const autoContinueEnabled = () => options.autoContinue !== false && env.LAGENT_AUTO_CONTINUE !== '0';
  function scheduleAutoContinue(ticket, reason) {
    if (!autoContinueEnabled()) return;
    if (!AUTO_CONTINUE_RE.test(String(reason || ''))) return;
    if (ticket.interrupted) return;
    const attempts = Number(ticket.continuations || 0);
    if (!Number.isSafeInteger(attempts) || attempts >= 2) return;
    const note = `【续跑 ${attempts + 1}/2】上一次执行因为「${String(reason || '中断').slice(0, 120)}」结束。先检查项目里已经落盘的文件和已有改动，不要重做完成的部分；只补缺失的文件、修未通过的验证，完成后给出 final。`;
    // 只有本来就带 executorInput 的执行器才能改预算；分析/终端这类执行器传了会直接 400。
    const original = ticket.executorInput && typeof ticket.executorInput === 'object' && !Array.isArray(ticket.executorInput)
      ? { ...ticket.executorInput }
      : null;
    let patch;
    if (original) {
      // 内置模型经过校验后存的是 maxSteps，外部 CLI 存的是 maxTurns；两种预算都要补。
      if (original.maxSteps !== undefined) {
        const previousSteps = Number(original.maxSteps) || 0;
        original.maxSteps = Math.min(60, Math.max(previousSteps + 20, 60));
      } else {
        const previousTurns = Number(original.maxTurns) || 0;
        original.maxTurns = Math.min(120, Math.max(previousTurns + 20, 60));
      }
      if (typeof original.prompt === 'string') {
        original.prompt = `${original.prompt}\n\n${note}`;
        patch = { executorInput: original };
      } else {
        patch = { executorInput: original, command: `${ticket.command}\n\n${note}` };
      }
    } else {
      patch = { command: `${ticket.command}\n\n${note}` };
    }
    // 等这一轮 sync 写完失败记录并推进完计划再续跑，避免在事务中间重入 start。
    setTimeout(() => {
      try {
        const current = privateTicket(ticket.id);
        if (!current || !['failed', 'blocked'].includes(current.status)) return;
        const plan = current.planId ? db.get('plan', current.planId) : null;
        if (plan && plan.status === 'failed') revivePlan(plan.id, current.planStep);
        const waiting = { ...current, ...patch, status: 'waiting', attention: undefined, summary: `自动续跑（${attempts + 1}/2）：${String(reason).slice(0, 120)}`, continuations: attempts + 1, updatedAt: now() };
        write(waiting);
        start(privateTicket(ticket.id), {}, undefined);
      } catch (error) {
        const current = privateTicket(ticket.id);
        if (!current) return;
        write({ ...current, status: 'failed', summary: `自动续跑失败：${String(error?.message || error).slice(0, 300)}`, updatedAt: now() });
        if (current.planId) advancePlan(current.planId);
      }
    }, 0);
  }
  function start(ticket,input,existing) {
    ticket = scopedTicket(ticket);
    const activeId=assignmentExecutorId(ticket, existing);
    const active=executors.requireAvailable(activeId);
    const attempts=related('assignment',ticket.id);
    if(attempts.length>=policy.budgets.maxCallsPerTicket){audit(ticket.id,'start',activeId,'denied','工单执行次数达到策略上限');throw workError('工单执行次数达到策略上限',429);}
    if(!outboxEnabled&&!existing&&db.list('assignment').filter(row=>row.status==='working').length>=policy.budgets.maxConcurrent){audit(ticket.id,'start',activeId,'denied','并发执行达到策略上限');throw workError('并发执行达到策略上限',429);}
    if(existing?.startedAt&&Date.now()-Date.parse(existing.startedAt)>policy.budgets.maxRuntimeMs){audit(ticket.id,'start',activeId,'denied','执行时长达到策略上限');throw workError('执行时长达到策略上限',429);}
    const budgetCheck=checkTokenBudget(store,ticket.id,policy.budgets.maxTokensPerTicket);
    if(!budgetCheck.ok){audit(ticket.id,'start',activeId,'denied',`Token 预算已用 ${budgetCheck.used}/${budgetCheck.budget}`);throw workError(`Token 预算已用尽（已用 ${budgetCheck.used} / 上限 ${budgetCheck.budget}）`,429);}
    const assignment=existing||{id:randomUUID(),ticketId:ticket.id,executor:activeId,status:outboxEnabled?'queued':'working',...(outboxEnabled?{queuedAt:now()}:{startedAt:now(),heartbeatAt:now()})};
    if(outboxEnabled){
      const queued={...ticket,executor:activeId,status:'queued',stage:'launch',attention:undefined,summary:queuedSummary(activeId,active),updatedAt:now()};
      write(queued,['assignment',{...assignment,status:'queued'}]);
      enqueue(store,{kind:WORK_EFFECT_KIND,key:launchKey(assignment),ticketId:ticket.id,priority:ticket.origin==='mcp'?1:0,payload:{assignmentId:assignment.id}},{now:Date.now()});
      audit(ticket.id,'enqueue',activeId,'queued');
      return get(ticket.id);
    }
    const terminal=activeId==='terminal';
    const cli=['cli','model'].includes(active.kind);
    const tool=['tool','window'].includes(active.kind);
    const toolLabel=activeId==='browser'?'浏览器':activeId==='github'?'GitHub':active.name;
    const working={...ticket,executor:activeId,status:'working',stage:terminal?'terminal':cli?'cli':tool?'tool':'terminal',attention:undefined,summary:terminal?'终端命令执行中':activeId==='workbuddy'?'WorkBuddy 执行中':activeId==='model'?'Lagent 执行中':cli?'只读 CLI 执行中':tool?`${toolLabel}执行中`:'执行中',updatedAt:now()};
    write(working,['assignment',assignment]);
    try {
      const task=active.start(working,assignment,launchInput(working));
      sync(working,assignment,task);active.resume?.(task);
    } catch(error) {
      const status=error.status===400?'blocked':'failed';
      const summary=error.status===400?error.message:(terminal?'终端命令启动失败':activeId==='workbuddy'?'WorkBuddy 启动失败':cli?'只读 CLI 启动失败':tool?`${toolLabel}启动失败`:'分析启动失败');
      const failed={...working,status,summary,updatedAt:now()};
      write(failed,['assignment',{...assignment,status,endedAt:now(),error:summary}],['report',makeReport(failed,assignment,status,summary)]);
      if(failed.planId&&Number.isSafeInteger(failed.planStep))advancePlan(failed.planId);
    }
    return get(ticket.id);
  }
  const publicPlan = plan => planProjection(plan, id => db.get('ticket', id));
  function startPlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('计划参数必须为对象');
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal || goal.length > 4000) throw workError('计划目标须为 1–4000 字');
    // 受管回合要在执行步骤前后各加 Lagent 步骤，多 Agent 模式还要为每一路加交叉验收，
    // 3 个协作方时最多 1 分工 + 3 执行 + 3 验收 + 1 汇总 = 8 步；手动计划仍是 2–5 步。
    const maxSteps = input.managed === true ? 10 : 5;
    if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > maxSteps) throw workError(`计划必须包含 2–${maxSteps} 个步骤`);
    // 会话里的受管回合：每个 Agent 都复用会话自己的隐藏执行对话，避免跨会话串 session。
    const managedConversation = typeof input.conversationId === 'string' && input.conversationId.trim()
      ? conversations.getRaw(input.conversationId.trim())
      : null;
    const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId.trim() : '';
    // 显式传 autoRun 时以它为准；否则「先批准再执行」模式下逐步等确认，其余模式一路跑完。
    const autoRun = input.origin === 'mcp' ? false : (typeof input.autoRun === 'boolean' ? input.autoRun : policy.requireApproval !== true);
    const projectChat = projectContext(input.projectChatId);
    if (projectChat && !PROJECT_CHAT_EXECUTORS.includes(projectChat.chat.executorId)) throw workError('该执行器暂不支持项目拆解', 400);
    // 计划可以直接绑定「工作文件夹」：每一步都在这个目录里读写，未指定对话时按执行器自动建会话。
    let projectRecord = projectChat ? projectChat.project : null;
    if (!projectChat && typeof input.projectId === 'string' && input.projectId.trim()) {
      projectRecord = db.get('project', input.projectId.trim());
      if (!projectRecord) throw workError('工作文件夹不存在', 404);
      if (!fs.existsSync(projectRecord.path)) throw workError('工作文件夹已不在本机，请重新导入', 409);
    }
    if (clientRequestId.length > 120) throw workError('clientRequestId 最长 120 字');
    // 团队协作：所有步骤共用一个上级对话，其它执行器作为从属会话挂上去，侧栏只显示这一条。
    const parentChatId = typeof input.parentChatId === 'string' ? input.parentChatId.trim() : '';
    const parentChat = parentChatId ? db.get('project-chat', parentChatId) : null;
    if (parentChatId) {
      if (!parentChat) throw workError('上级对话不存在', 404);
      if (!projectRecord) projectRecord = db.get('project', parentChat.projectId);
    }
    if (clientRequestId) {
      const prior = store.list('plan').find(plan => plan.clientRequestId === clientRequestId);
      if (prior) return publicPlan(prior);
    }
    const prepared = input.steps.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) throw workError(`第 ${index + 1} 步参数无效`);
      if (typeof step.executorId !== 'string' || !step.executorId.trim()) throw workError(`第 ${index + 1} 步必须指定 executorId`);
      const targetId = executorId(step.executorId);
      const target = executors.requireAvailable(targetId);
      guard(targetId, null, 'plan');
      let chat = null;
      if (managedConversation) {
        // 会话内部执行：每个 Agent 一条隐藏执行对话，按 conversationId 隔离 session。
        if (managedConversation.projectId) {
          chat = conversationChat(managedConversation, targetId, input.permission);
        } else if (targetId === LAGENT_EXECUTOR_ID) {
          chat = null;
        }
      } else if (projectChat || projectRecord) {
        const holder = projectChat ? projectChat.chat : null;
        const owner = (projectRecord || projectChat.project);
        if (parentChat) {
          // 主会话自己的执行器直接复用主会话，其余执行器挂一条从属会话。
          chat = targetId === parentChat.executorId
            ? parentChat
            : projects.listChats(owner.id).find(row => row.executorId === targetId && row.parentChatId === parentChat.id) || null;
        } else {
          chat = holder && targetId === holder.executorId
            ? holder
            : projects.listChats(owner.id).find(row => row.executorId === targetId && !row.parentChatId) || null;
        }
        if (!chat && targetId === 'window') throw workError(`第 ${index + 1} 步的窗口 Agent 需要先在项目中绑定窗口对话`);
        if (!chat && ['cli', 'model'].includes(target.kind) && !PROJECT_CHAT_EXECUTORS.includes(targetId)) throw workError(`第 ${index + 1} 步的执行器不支持项目工作区`);
      }
      const text = typeof step.text === 'string' ? step.text.trim() : '';
      if (!text || text.length > 3000) throw workError(`第 ${index + 1} 步说明须为 1–3000 字`);
      const dependsOn = step.dependsOn === undefined ? [] : step.dependsOn;
      if (!Array.isArray(dependsOn) || dependsOn.length > 3) throw workError(`第 ${index + 1} 步依赖必须是最多 3 项的数组`);
      if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some(item => !Number.isInteger(item) || item < 0 || item >= index)) throw workError(`第 ${index + 1} 步依赖必须引用更早步骤`);
      const scope = Array.isArray(step.scope) ? step.scope.filter(item => typeof item === 'string' && item.trim() && item.length <= 120).slice(0, 6) : [];
      const verify = normalizeVerify(step.verify);
      const contract = normalizeContract(step.contract);
      // 补偿动作随步骤声明：失败或人工回滚时按逆序执行，不猜用户想回滚什么。
      const compensate = normalizeCompensation(step.compensate);
      // 受管回合用 role 标出「分工/协作/汇总」，会话投影据此决定展示位置。
      const role = typeof step.role === 'string' && CONVERSATION_ROLES.includes(step.role) ? step.role : '';
      // 契约以前只存不用：执行器根本看不到验收标准和交付清单。
      // 现在把它拼进步骤正文，内置模型、Claude Code、Codex 都能直接读到。
      const brief = contractBrief(contract);
      return { targetId, target, text: brief ? `${text}\n\n${brief}` : text, rawInput: step.executorInput, dependsOn: [...dependsOn], chat, scope, verify, contract, compensate, role };
    });
    for (const step of prepared) {
      if (projectRecord && !step.chat && PROJECT_CHAT_EXECUTORS.includes(step.targetId)) {
        const headline = step.text.split('\n').map(line => line.trim()).find(Boolean) || step.text;
        step.chat = ensureProjectChat(projectRecord, step.targetId, {
          ...(parentChat ? { parentChatId: parentChat.id } : {}),
          // 团队协作挂在主对话下的执行对话：只用于执行与续接，不作为独立对话出现。
          ...(parentChat ? { hidden: true } : {}),
          title: parentChat ? headline.slice(0, 60) : ''
        });
      }
      // 计划里的每一步都只负责自己那一块。内置 Agent 容易把「整件事没做完」当成自己的失败，
      // 于是在别的步骤还没跑的时候就把自己判成未完成，整条计划跟着塌。这里把范围写清楚。
      if (step.targetId === 'model' || step.chat?.executorId === 'model') {
        step.text = `${step.text}\n\n【范围】这一步只做你负责的部分：你该写的文件都写好了，就写 done:true。别的 Agent 负责任务里的文件还没出现，不算你这一步没完成。`;
      }
      step.executorInput = step.chat
        ? normalizeExecutorInput(step.targetId, step.target, projectExecutorInput(step.chat, projectRecord, step.text, {
            ...(step.rawInput && typeof step.rawInput === 'object' && !Array.isArray(step.rawInput) ? step.rawInput : {}),
            goal: step.text,
            ...(step.scope.length ? { scope: step.scope } : {})
          }, step.target), step.text)
        : normalizeExecutorInput(step.targetId, step.target, step.rawInput, step.text);
      step.preview = buildPreview({ executor: step.target, executorInput: step.executorInput, project: projectRecord, fallbackText: step.text });
    }
    const planId = randomUUID();
    const stamp = now();
    const tickets = prepared.map((step, index) => {
      const ready = step.dependsOn.length === 0;
      const autoStart = autoRun && step.preview?.risk !== 'high';
      // 标题只取第一行：step.text 里可能追加了范围说明，整段塞进标题会在侧栏变成一大坨。
      const headline = step.text.split('\n').map(line => line.trim()).find(Boolean) || step.text;
      return {
        id: randomUUID(),
        title: headline.slice(0, 60),
        status: ready ? (autoStart ? 'queued' : 'awaiting_review') : 'waiting',
        stage: 'approval',
        source: 'plan',
        executor: step.targetId,
        summary: ready ? (autoStart ? '自动计划待启动' : `请确认${step.target.name}计划步骤`) : `计划第 ${index + 1} 步，等待依赖步骤完成`,
        ...(ready && !autoStart ? { attention: review(step.preview?.risk === 'high' ? previewQuestion(step.target.name, step.preview) : reviewQuestion(step.targetId, step.chat ? (step.chat.executorId === 'window' ? 'window' : 'write') : undefined)) } : {}),
        createdAt: stamp,
        updatedAt: stamp,
        command: step.text,
        executorInput: step.executorInput,
        preview: step.preview,
        ...(step.verify ? { verify: step.verify } : {}),
        ...(step.contract ? { contract: step.contract } : {}),
        ...(step.chat ? { projectChatId: step.chat.id } : {}),
        ...(step.role ? { role: step.role } : {}),
        planId,
        planStep: index,
        planTotal: prepared.length
      };
    });
    const plan = {
      id: planId,
      goal,
      status: 'active',
      autoRun,
      ...(projectChat ? { projectChatId: projectChat.chat.id } : {}),
      ...(projectRecord ? { projectId: projectRecord.id } : {}),
      currentStep: prepared.findIndex(step => step.dependsOn.length === 0) ?? 0,
      steps: tickets.map((ticket, index) => ({ index, ticketId: ticket.id, executorId: ticket.executor, title: ticket.title, dependsOn: prepared[index].dependsOn, ...(prepared[index].role ? { role: prepared[index].role } : {}), ...(prepared[index].scope.length ? { scope: prepared[index].scope } : {}), ...(prepared[index].compensate ? { compensate: prepared[index].compensate } : {}), ...(ticket.projectChatId ? { projectChatId: ticket.projectChatId } : {}) })),
      ...(clientRequestId ? { clientRequestId } : {}),
      createdAt: stamp,
      updatedAt: stamp
    };
    const created = db.transaction(transaction => {
      if (clientRequestId) {
        const prior = transaction.list('plan').find(item => item.clientRequestId === clientRequestId);
        if (prior) return publicPlan(prior);
      }
      for (const ticket of tickets) {
        transaction.put('ticket', publicTicket(ticket));
        transaction.put('control', controlOf(ticket));
      }
      transaction.put('plan', plan);
      for (const ticket of tickets) if (ticket.status === 'awaiting_review' || ticket.status === 'queued') transaction.event('ticket', publicTicket(ticket));
      audit(planId, 'plan/create', 'plan', 'created');
      return publicPlan(plan);
    });
    // 受管回合要先把握手信息（conversationId/turnId）写到工单上，再启动执行；
    // 否则执行器第一次写工单时会把还没挂上的会话字段覆盖掉。
    if (autoRun && created?.id === planId && input.deferLaunch !== true) {
      for (const ticket of tickets.filter(item => item.status === 'queued')) launchStep(ticket.id);
    }
    return created;
  }
  // 启动计划里的某一步。执行器并发满、命令被限流等都会让 start 抛错；
  // 早先这里直接吞掉异常，步骤就永远停在「排队中」，整条计划卡死。
  // 现在退回 waiting 并写清原因，下一次推进还会再试。
  function launchStep(ticketId) {
    try {
      start(privateTicket(ticketId), {}, undefined);
      return true;
    } catch (error) {
      // 必须用 privateTicket：db.get('ticket') 是脱敏投影，直接回写会把
      // command / executorInput 抹掉，下一次重试就只剩空 prompt。
      const ticket = privateTicket(ticketId);
      const message = String(error?.message || '启动失败');
      if (ticket && ['queued', 'working'].includes(ticket.status)) {
        const waiting = { ...ticket, status: 'waiting', attention: undefined, summary: `等待执行器空闲：${message.slice(0, 80)}`, updatedAt: now() };
        write(waiting);
      } else if (ticket?.status === 'blocked' && ticket.summary !== `这一步没能启动：${message.slice(0, 120)}`) {
        // 启动时就失败了（比如输入超过执行器上限）：把原因写在票面上，别让它只留一句旧的「待确认」。
        write({ ...ticket, summary: `这一步没能启动：${message.slice(0, 120)}`, updatedAt: now() });
      }
      return false;
    }
  }
  function advancePlan(planId) {
    const plan = db.get('plan', planId);
    if (!plan || plan.status !== 'active') return;
    const autoReady = [];
    // 推进前先落检查点：崩溃恢复时至少知道哪些步骤已经完成。
    try {
      recordCheckpoint(store, {
        planId,
        step: plan.currentStep,
        tickets: plan.steps.map(step => db.get('ticket', step.ticketId))
      });
    } catch { /* 检查点写失败不阻塞推进 */ }
    let compensationRows = null;
    db.transaction(transaction => {
      const stored = transaction.get('plan', planId);
      if (!stored || stored.status !== 'active') return;
      const autoRun = stored.autoRun === true;
      const tickets = stored.steps.map(step => transaction.get('ticket', step.ticketId));
      let changed = false;
      for (const step of stored.steps) {
        const ticket = tickets[step.index];
        if (!ticket) continue;
        // 被阻塞的步骤只有在「依赖后来补齐了」时才值得再试一次。
        // 早先这里对任何 blocked 步骤都重新推进，启动失败又落回 blocked，
        // store 订阅再触发一轮 —— 一秒内重试十几次，直到撞上调用预算上限。
        // 现在限制自动重试次数，并留一点冷却时间，把决定权交回用户。
        const recoveries = Number(ticket.recoveries || 0);
        const cooling = Date.now() - Date.parse(ticket.updatedAt || 0) < 4000;
        const blockedRecovery = ticket.status === 'blocked'
          && (step.dependsOn || []).length > 0
          && recoveries < 2
          && !cooling;
        if (ticket.status !== 'waiting' && !blockedRecovery) continue;
        const deps = (step.dependsOn || []).map(index => tickets[index]);
        const failedDep = deps.findIndex(dep => dep && ['failed', 'blocked', 'cancelled'].includes(dep.status));
        if (failedDep >= 0) {
          const summary = `依赖步骤 ${(step.dependsOn[failedDep] ?? 0) + 1} 未完成`;
          if (ticket.status === 'blocked' && ticket.summary === summary) continue;
          const blocked = { ...ticket, status: 'blocked', attention: undefined, summary, updatedAt: now() };
          transaction.put('ticket', blocked); tickets[step.index] = blocked; changed = true;
          transaction.event('ticket', blocked);
          audit(planId, 'plan/block', ticket.executor, 'blocked');
          continue;
        }
        if (!deps.every(dep => dep?.status === 'completed')) continue;
        // 冲突控制：要改同一批文件的步骤，等前一个写文件的步骤跑完再上，避免互相覆盖。
        const scope = Array.isArray(step.scope) ? step.scope : [];
        if (scope.length) {
          const busy = stored.steps.find(other => other.index !== step.index
            && Array.isArray(other.scope) && other.scope.length
            && ['working', 'awaiting_review', 'queued'].includes(tickets[other.index]?.status)
            && other.scope.some(one => scope.some(two => one === two || one.startsWith(`${two}/`) || two.startsWith(`${one}/`) || one.split('/')[0] === two.split('/')[0])));
          if (busy) continue;
        }
        let target = null;
        try { target = executors.requireAvailable(ticket.executor); } catch { /* 执行器已不可用。 */ }
        const denial = target ? executorDenial(ticket.executor) : null;
        if (!target || denial) {
          const summary = target ? denial.reason : '目标执行器不可用';
          const blocked = { ...ticket, status: 'blocked', attention: undefined, summary, updatedAt: now() };
          transaction.put('ticket', blocked); tickets[step.index] = blocked; changed = true;
          transaction.event('ticket', blocked);
          audit(planId, 'plan/block', ticket.executor, 'blocked');
          continue;
        }
        const context = stepContext(stored, step.index, target);
        // 前序材料要写进 control（执行器真正读取的输入），票面 publicTicket 不保留 executorInput。
        const control = transaction.get('control', ticket.id);
        const baseInput = control?.executorInput;
        if (context && typeof baseInput?.prompt === 'string' && !baseInput.prompt.includes('【前序步骤材料')) {
          transaction.put('control', { ...control, executorInput: { ...baseInput, prompt: context + baseInput.prompt } });
        }
        const preview = ticket.preview && typeof ticket.preview === 'object'
          ? ticket.preview
          : buildPreview({ executor: target, executorInput: control?.executorInput, project: stored.projectId ? transaction.get('project', stored.projectId) : null, fallbackText: ticket.title });
        const needsReview = !autoRun || preview?.risk === 'high';
        const ready = {
          ...ticket,
          status: needsReview ? 'awaiting_review' : 'queued',
          stage: 'approval',
          summary: needsReview ? `计划第 ${step.index + 1}/${stored.steps.length} 步，依赖已满足，等待确认` : '自动计划执行中',
          ...(preview ? { preview } : {}),
          ...(needsReview ? { attention: review(preview?.risk === 'high' ? previewQuestion(target.name, preview) : reviewQuestion(ticket.executor)) } : { attention: undefined }),
          ...(blockedRecovery ? { recoveries: recoveries + 1 } : {}),
          updatedAt: now()
        };
        transaction.put('ticket', ready); tickets[step.index] = ready; changed = true;
        transaction.event('ticket', ready);
        if (!needsReview) autoReady.push(ticket.id);
        audit(planId, 'plan/advance', ticket.executor, 'advanced');
      }
      const activeStatuses = ['awaiting_review', 'working', 'queued', 'waiting'];
      const anyActive = tickets.some(ticket => activeStatuses.includes(ticket?.status));
      const allCompleted = tickets.every(ticket => ticket?.status === 'completed');
      const anyCancelled = tickets.some(ticket => ticket?.status === 'cancelled');
      let status = stored.status;
      if (allCompleted) status = 'completed';
      else if (!anyActive) {
        const hasFailed = tickets.some(ticket => ticket?.status === 'failed');
        const blockedSteps = stored.steps.filter(step => tickets[step.index]?.status === 'blocked');
        const blockedByCancelled = blockedSteps.every(step => (step.dependsOn || []).length > 0 && (step.dependsOn || []).some(index => tickets[index]?.status === 'cancelled'));
        status = anyCancelled && !hasFailed && blockedByCancelled ? 'cancelled' : 'failed';
      }
      const activeIndex = tickets.findIndex(ticket => activeStatuses.includes(ticket?.status));
      const currentStep = activeIndex >= 0 ? activeIndex : Math.max(0, stored.steps.length - 1);
      if (changed || status !== stored.status || currentStep !== stored.currentStep) {
        transaction.put('plan', { ...stored, status, currentStep, updatedAt: now() });
        if (status === 'completed') audit(planId, 'plan/complete', 'plan', 'completed');
        else if (status === 'failed') audit(planId, 'plan/fail', 'plan', 'failed');
      }
      // 计划终止时把已完成步骤的补偿动作按逆序记下来，等人确认后再执行。
      if (status !== stored.status && ['failed', 'cancelled'].includes(status)) {
        compensationRows = compensationPlan(stored, tickets);
      }
    });
    if (compensationRows?.length) rememberCompensations(store, planId, compensationRows);
    for (const id of autoReady) launchStep(id);
  }
  function revivePlan(planId, stepIndex) {
    const plan = db.get('plan', planId);
    if (!plan || plan.status !== 'failed') return;
    db.transaction(transaction => {
      const stored = transaction.get('plan', planId);
      if (!stored || stored.status !== 'failed') return;
      for (const step of stored.steps) {
        const ticket = transaction.get('ticket', step.ticketId);
        if (ticket?.status === 'blocked') {
          const waiting = { ...ticket, status: 'waiting', attention: undefined, summary: '等待依赖步骤完成', updatedAt: now() };
          transaction.put('ticket', waiting);
          transaction.event('ticket', waiting);
        }
      }
      transaction.put('plan', { ...stored, status: 'active', currentStep: Number.isSafeInteger(stepIndex) ? stepIndex : stored.currentStep, updatedAt: now() });
      audit(planId, 'plan/retry', 'plan', 'active');
    });
  }
  function readPlan(id) {
    const plan = db.get('plan', id);
    if (!plan) throw workError('计划不存在', 404);
    return publicPlan(plan);
  }
  function stopPlan(id) {
    const plan = db.get('plan', id);
    if (!plan) throw workError('计划不存在', 404);
    if (plan.status !== 'active') return publicPlan(plan);
    for (const step of plan.steps) {
      const ticket = db.get('ticket', step.ticketId);
      if (!ticket || !['working', 'queued', 'awaiting_review'].includes(ticket.status)) continue;
      const assignment = latest(ticket.id);
      const task = taskFor(ticket.id);
      if (task && ['running', 'awaiting_approval'].includes(task.status)) executorFor(assignment)?.stop?.(task, assignment);
      if (outboxEnabled) cancelTicketEffects(store, ticket.id, { now: Date.now() });
    }
    const compensationRows = compensationPlan(plan, plan.steps.map(step => db.get('ticket', step.ticketId)));
    db.transaction(transaction => {
      const stored = transaction.get('plan', id);
      if (!stored || stored.status !== 'active') return;
      for (const step of stored.steps) {
        const ticket = transaction.get('ticket', step.ticketId);
        if (ticket && ['working', 'queued', 'awaiting_review', 'waiting', 'blocked'].includes(ticket.status)) {
          const cancelled = { ...ticket, status: 'cancelled', attention: undefined, summary: '计划已取消', updatedAt: now() };
          transaction.put('ticket', cancelled);
          transaction.event('ticket', cancelled);
        }
      }
      for (const assignment of transaction.list('assignment')) {
        if (stored.steps.some(step => step.ticketId === assignment.ticketId) && !['completed', 'failed', 'cancelled', 'blocked'].includes(assignment.status)) {
          transaction.put('assignment', { ...assignment, status: 'cancelled', endedAt: now() });
        }
      }
      transaction.put('plan', { ...stored, status: 'cancelled', updatedAt: now() });
      audit(id, 'plan/cancel', 'plan', 'cancelled');
    });
    if (compensationRows.length) rememberCompensations(store, id, compensationRows);
    return readPlan(id);
  }
  function recoverPlans() {
    for (const plan of db.list('plan').filter(item => item.status === 'active')) advancePlan(plan.id);
  }
  function reconcile() {
    for(const ticket of db.list('ticket').filter(t=>['working','awaiting_review'].includes(t.status))) {
      const assignment=latest(ticket.id);if(!assignment)continue;
      const task=executorFor(assignment)?.get?.(assignment.sessionId);if(task)sync(privateTicket(ticket.id),assignment,task);
    }
    // 排队中的工单必须有对应的 outbox 记录，否则会永远停在「排队中」。
    // 服务重启、数据清理或旧版本遗留都可能让 effect 丢失；这里补建，
    // 已有 failed effect 的工单则按启动失败收尾，避免无限重试。
    if(outboxEnabled) for(const ticket of db.list('ticket').filter(t=>t.status==='queued')){
      const assignment=latest(ticket.id);
      if(!assignment||!['queued','working'].includes(assignment.status))continue;
      const key=launchKey(assignment);
      const effects=store.list('work-effect').filter(effect=>effect.kind===WORK_EFFECT_KIND&&effect.key===key);
      if(effects.some(effect=>['pending','running'].includes(effect.status)))continue;
      const failed=effects.find(effect=>effect.status==='failed');
      if(failed){settleLaunchFailure(failed,{code:'LAUNCH_LOST'},'failed');continue;}
      enqueue(store,{kind:WORK_EFFECT_KIND,key,ticketId:ticket.id,priority:ticket.origin==='mcp'?1:0,payload:{assignmentId:assignment.id}},{now:Date.now()});
      audit(ticket.id,'launch-reenqueue',assignment.executor||ticket.executor||'terminal','queued');
    }
  }
  // 协作任务：把 record 与工单状态、文件是否落盘拼成前端直接能渲染的视图。
  const teamworkView=record=>{
    const project=projects.getProject(record.projectId);
    const tickets=db.list('ticket');
    const parts=record.parts.map(part=>{
      const ticket=tickets.find(item=>item.id===part.ticketId)||null;
      const file=teamwork.readPart(project.path,part);
      return {...part,status:ticket?.status||'missing',summary:ticket?.summary||'',fileExists:file.exists,fileSize:file.size};
    });
    const terminal=parts.every(part=>['completed','failed','blocked','cancelled','missing'].includes(part.status));
    return {...record,parts,allSettled:terminal,projectName:project.name,projectPath:project.path};
  };
  const teamworkRecords=projectId=>db.list('teamwork')
    .filter(record=>!projectId||record.projectId===projectId)
    .sort((left,right)=>String(right.createdAt).localeCompare(String(left.createdAt)));

  const COMMANDER_STATUS={awaiting_review:'待确认',working:'执行中',queued:'排队中',waiting:'等待依赖',completed:'已完成',failed:'失败',blocked:'受阻',cancelled:'已停止',missing:'缺失'};
  // 一次编排结束后的交接单：谁做了什么、验收过没过、改了哪些文件、下一步是什么。
  // 只聚合已有数据（计划/工单/验收/变更/用量/简报），不新增存储。
  function planSheet(planId){
    const plan=db.get('plan',planId);
    if(!plan)throw workError('计划不存在',404);
    const names=new Map(executors.list().map(agent=>[agent.id,agent.name]));
    const changes=db.list('project-change');
    const usageRows=store.list('work-usage');
    const rows=plan.steps.map(step=>{
      const ticket=db.get('ticket',step.ticketId)||null;
      const reports=related('report',step.ticketId);
      const latestReport=reports[0]||null;
      // 工单投影（publicTicket）已剥离 artifacts，文件清单统一以项目变更记录为准。
      const files=[...new Set(
        changes.filter(change=>change.ticketId===step.ticketId).flatMap(change=>Array.isArray(change.files)?change.files:[])
      )].filter(item=>typeof item==='string'&&item.trim()).slice(0,200);
      const usage=usageRows.filter(row=>row.ticketId===step.ticketId);
      const tokens=usage.reduce((sum,row)=>sum+(Number.isFinite(row.totalTokens)?row.totalTokens:0),0);
      const cost=usage.reduce((sum,row)=>sum+(Number.isFinite(row.costEstimate)?row.costEstimate:0),0);
      return {
        index:step.index,
        title:step.title,
        ticketId:step.ticketId,
        executorId:step.executorId,
        executorName:names.get(step.executorId)||step.executorId,
        status:ticket?.status||'missing',
        summary:String(latestReport?.summary||ticket?.summary||'').trim().slice(0,2000),
        verify:ticket?.verify||null,
        acceptance:ticket?.acceptance||null,
        files,
        tokens,
        cost
      };
    });
    let brief=null;
    if(typeof plan.projectId==='string'&&plan.projectId){
      try{brief=projects.getBrief(plan.projectId);}catch{brief=null;}
    }
    return {plan:publicPlan(plan),rows,brief,markdown:buildSheetMarkdown({plan,rows,brief})};
  }

  function commanderReport(planId){
    const plan=db.get('plan',planId);
    if(!plan)throw workError('计划不存在',404);
    const names=new Map(executors.list().map(agent=>[agent.id,agent.name]));
    const rows=plan.steps.map(step=>{
      const ticket=db.get('ticket',step.ticketId);
      const reports=related('report',step.ticketId);
      const latest=reports[0]||null;
      return {
        index:step.index,
        title:step.title,
        executorId:step.executorId,
        executorName:names.get(step.executorId)||step.executorId,
        status:ticket?.status||'missing',
        ticketId:step.ticketId,
        summary:String(latest?.summary||ticket?.summary||'').trim().slice(0,1500)
      };
    });
    const completed=rows.filter(row=>row.status==='completed').length;
    const open=rows.filter(row=>!['completed','cancelled'].includes(row.status));
    const lines=[`# 指挥汇总：${plan.goal}`,'',`- 进度：${completed}/${rows.length} 步已完成`,`- 计划：${plan.id}`,`- 生成时间：${now()}`,''];
    if(open.length)lines.push(`- 待处理：${open.map(row=>`第 ${row.index+1} 步`).join('、')}`,'');
    lines.push('## 各步结果');
    for(const row of rows){
      lines.push('',`### ${row.index+1}. ${row.title}`,'',`- 执行：${row.executorName}`,`- 状态：${COMMANDER_STATUS[row.status]||row.status}`,'');
      lines.push(row.summary||'_没有产出说明_');
    }
    if(open.length){
      lines.push('','## 需要你处理');
      for(const row of open)lines.push(`- 第 ${row.index+1} 步（${row.executorName}）：${COMMANDER_STATUS[row.status]||row.status}`);
    }
    return {plan:{id:plan.id,goal:plan.goal,status:plan.status},rows,completed,total:rows.length,markdown:lines.join('\n')};
  }

  let closed=false;
  const unsubscribe=store.subscribe(()=>queueMicrotask(()=>{if(!closed)reconcile();}));
  if(outboxEnabled){
    const pollMs=Number.isSafeInteger(options.outboxPollMs)&&options.outboxPollMs>=10?options.outboxPollMs:200;
    outboxTimer=setInterval(()=>{try{drainOutbox();}catch(error){audit(null,'outbox-drain','engine','failed',sanitizeOutboxError(error));}},pollMs);
    outboxTimer.unref?.();
  }
  // ── 会话投影 ────────────────────────────────────────────────
  // 会话列表只需要状态与最后一句，不把每轮完整 runs 都塞进 bootstrap。
  const conversationStatusMap = () => new Map(db.list('ticket').map(ticket => [ticket.id, ticket.status]));

  function conversationSummary(row, statusMap = conversationStatusMap()) {
    const ticketIds = conversations.ticketIdsOf(row);
    const statuses = ticketIds.map(id => statusMap.get(id)).filter(Boolean);
    const turns = Array.isArray(row.turns) ? row.turns : [];
    const last = turns[turns.length - 1];
    return {
      id: row.id,
      title: row.title,
      goal: row.goal || '',
      host: row.host || 'lagent',
      projectId: row.projectId || null,
      participants: Array.isArray(row.participants) ? row.participants : [],
      ticketIds,
      turnCount: turns.length,
      lastPrompt: last?.prompt || '',
      lastMode: last?.mode || 'auto',
      status: conversationStatus(statuses),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  function listConversationSummaries(limit = 60) {
    const statusMap = conversationStatusMap();
    return db.list('conversation')
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 60)))
      .map(row => conversationSummary(row, statusMap));
  }

  function conversationTickets(row) {
    const result = [];
    for (const id of conversations.ticketIdsOf(row)) {
      try { result.push(get(id)); } catch { /* 工单被删掉时忽略，会话还能打开。 */ }
    }
    return result;
  }

  function conversationRunReport(ticketId) {
    try {
      const detail = api.detail(ticketId);
      const reports = detail.reports || [];
      // Store.list 按写入倒序返回，reports[0] 是最新一份；重试/续跑后以它为准。
      for (let index = 0; index < reports.length; index += 1) {
        const value = reportTextOfReport(reports[index]);
        if (value) return value;
      }
      return String(reports[0]?.summary || detail.ticket.summary || '').trim();
    } catch { return ''; }
  }

  // 会话内部的执行对话：每个 Agent 仍需要自己的项目对话来保存会话、权限与作用域，
  // 但它被标成 hidden，侧栏与项目页只显示 Lagent 会话本身。
  function conversationChat(conversation, agentId, permission) {
    const project = projects.getProject(conversation.projectId);
    if (!PROJECT_CHAT_EXECUTORS.includes(agentId)) throw workError(`执行器「${agentId}」不支持在项目里执行`, 400);
    const active = executors.requireAvailable(agentId);
    if (agentId === 'window' && !windowBridge) throw workError('窗口桥未启用', 503);
    guard(agentId, null, 'conversation');
    const chats = projects.listChats(project.id);
    const existing = chats.find(chat => chat.conversationId === conversation.id && chat.executorId === agentId);
    if (existing) {
      if (PERMISSIONS.includes(permission) && !existing.permission) {
        const next = { ...existing, permission, updatedAt: now() };
        db.put('project-chat', next);
        return next;
      }
      return existing;
    }
    return projects.createChat(project.id, {
      executorId: agentId,
      conversationId: conversation.id,
      hidden: true,
      title: `${conversation.title || '会话'} · ${active.name || agentId}`,
      ...(PERMISSIONS.includes(permission) ? { permission } : {})
    }).chat;
  }

  function dispatchConversationRun(conversation, agentId, text, { turnId, settings = null, role = 'answer', clientRequestId, executorInput } = {}) {
    const shared = {
      ...(clientRequestId ? { clientRequestId } : {}),
      conversationId: conversation.id,
      ...(turnId ? { turnId } : {}),
      agentId,
      ...(role === 'synthesis' || role === 'step' || role === 'verify' ? { role } : {})
    };
    if (conversation.projectId) {
      const chat = conversationChat(conversation, agentId, settings?.permission);
      // 直接落到执行对话的底层派单：不能再走 projectChatMessages，
      // 否则每个内部步骤都会被当成新的受管回合，递归造出协调/汇总工单。
      return api.command({
        text,
        executorId: agentId,
        projectChatId: chat.id,
        ...shared,
        ...(settings ? { settings } : {}),
        ...(settings?.profileId ? { profileId: settings.profileId } : {}),
        ...(settings?.model ? { model: settings.model } : {}),
        ...(settings?.effort ? { effort: settings.effort } : {}),
        ...(executorInput && typeof executorInput === 'object' ? { executorInput } : {})
      });
    }
    const active = executors.requireAvailable(agentId);
    guard(agentId, null, 'conversation');
    return api.command({
      text,
      executorId: agentId,
      ...(settings ? { settings } : {}),
      ...(executorInput && typeof executorInput === 'object' ? { executorInput } : {}),
      ...shared
    });
  }

  function linkConversationTicket(ticket, conversationId, turnId, agentId, role) {
    // 调用方有时传工单对象，有时传 turn.run（只有 ticketId）；两种都接受。
    const ticketId = ticket?.id || ticket?.ticketId;
    if (!ticketId) return;
    const stored = db.get('ticket', ticketId);
    if (!stored) return;
    db.put('ticket', conversations.linkTicket(stored, { conversationId, turnId, agentId, role }));
  }

  // 目标里明确要求只读时，团队分工不能安排写文件或造交付物；这条判断优先于项目模板。
  const readOnlyGoal = text => /(只读|不要修改|不许修改|不得修改|不要改动|禁止修改|不要写文件|不要创建文件|不运行构建|不要运行构建|不跑构建|不要跑构建|不执行构建|不要执行构建|不跑测试|不要运行测试|不要跑测试)/.test(String(text || ''));
  // 协调者的任务书：只分工，不下场改文件，避免把步数烧光。
  function coordinatorPrompt(goal, collaborators) {
    const others = collaborators.map(id => `${id}（协作 Agent）`).join('、');
    return [
      '你是 Lagent，多 Agent 团队的主控，负责先把任务想清楚再分派。这一步不要修改任何文件。',
      `目标：${goal}`,
      `接下来会交给：${others}。`,
      '原始目标里的限制优先于任何分工建议：目标要求只读、不要修改文件或不要构建时，分工里就不许安排写文件，也不要把创建脚本、报告当成交付物；此时每个协作 Agent 的产出就是检查结论。',
      '请先用两三句话说明你如何理解这个任务，再逐条写清每个协作 Agent 要做什么、交付什么、验收标准是什么。',
      '每个协作 Agent 都要独立完成一份实际执行工作，不能把其中某个人只安排成验收方；交叉验收由后续单独的步骤完成。',
      '需要写文件时才写清每个人负责的文件，避免两个人抢同一个文件；简单任务不要硬拆成多份。',
      '给每个协作 Agent 留一条可被另一位 Agent 独立验收的标准（能跑什么命令、该看到什么结果）。',
      '这一步只做分工：最多翻目录、看一两个关键文件确认结构，工具调用不要超过 4 次，然后直接写结论。'
    ].join('\n\n');
  }

  function synthesisPrompt(goal, collaborators, { crossTested = false } = {}) {
    return [
      '你是 Lagent，这次协作的主控。前面几位协作 Agent 已经把结果交回给你（见上方材料）。',
      `原始目标：${goal}`,
      `参与者：${collaborators.join('、')}。`,
      crossTested
        ? '材料里包含执行结果和交叉验收记录：先看验收方指出的问题，判断哪些必须修、哪些只是建议。'
        : '',
      '请写一份团队汇总：每个人做了什么、结果是否达成目标、还有什么没做完或不可靠。',
      crossTested
        ? '明确写出每一路验收的结论（通过 / 有条件通过 / 不通过），以及仍未解决的冲突和风险。'
        : '',
      '这一步是汇总，不要重新执行整个任务：材料已经足够，只在必须核对关键事实时做一两次只读检查；不要为了凑齐格式反复翻目录。',
      '如果原始目标要求只读、不要修改文件，就不要因为“没有生成脚本/报告文件”判失败，结论本身就是交付物。',
      '如果目标里点名了具体文件，先列目录确认它们都在，缺了必须写明缺哪个，不要笼统说“完成了”。',
      '最后明确「下一步建议交给谁、做什么」。只依据给定材料，不要编造。'
    ].filter(Boolean).join('\n');
  }

  // 交叉验收：让执行者去检查另一位执行者的产出，而不是再独立答一遍题。
  function crossTestPrompt(goal, reviewer, target) {
    return [
      `你是 ${reviewer}，这次协作里的交叉验收方。你要验收 ${target} 的工作，不要重写他的产出。`,
      `原始目标：${goal}`,
      `你负责验收：${target} 的交付。`,
      '先在前序材料里找到对方做了什么、声称怎么验证的；能跑就跑一遍测试或构建，能看就看一遍关键文件。',
      '重点核对：是否满足 Lagent 分工里的验收标准、有没有把没做完的部分说成完成。原始目标要求只读时，不要以“没有生成文件”为由判不通过。',
      '只有原始目标或分工明确要求产出文件时，才检查交付文件是否真实存在；分工里的文件清单与原始目标冲突时，以原始目标为准。',
      '不要替对方改文件；发现问题时写清文件、复现方式、期望结果和建议修法。',
      '最后给出明确结论：「通过」「有条件通过」或「不通过」，并列出必须修的问题。'
    ].join('\n\n');
  }

  // 把模型/权限设置翻译成单个步骤的 executorInput；不同执行器只认识自己的字段。
  // efforts 是按 Agent 的强度映射：没有映射时沿用全局 effort，保持桌面旧行为。
  function managedExecutorInput(executorId, { settings, models, efforts, executorInputs, prompt, maxSteps = 6, role = '' }) {
    const base = executorInputs?.[executorId] && typeof executorInputs[executorId] === 'object' && !Array.isArray(executorInputs[executorId])
      ? { ...executorInputs[executorId] }
      : {};
    const mapped = efforts && typeof efforts === 'object' && !Array.isArray(efforts);
    const effort = mapped
      ? agentEffort(efforts, executorId, executorId === LAGENT_EXECUTOR_ID ? (settings?.effort || 'default') : 'default')
      : (settings?.effort || '');
    if (executorId === LAGENT_EXECUTOR_ID) {
      return {
        ...base,
        ...(settings?.profileId ? { profileId: settings.profileId } : {}),
        ...(effort ? { effort } : {}),
        ...(settings?.permission ? { permission: settings.permission } : {}),
        ...(prompt ? { prompt } : {}),
        ...(role ? { role } : {}),
        maxSteps
      };
    }
    const active = executors.list().find(agent => agent.id === executorId);
    if (active?.kind === 'cli') {
      const model = typeof models?.[executorId] === 'string' ? models[executorId].trim() : '';
      return {
        ...base,
        ...(model ? { model } : {}),
        ...(effort && effort !== 'default' ? { effort } : {}),
        ...(prompt ? { prompt } : {})
      };
    }
    return { ...base, ...(prompt ? { prompt } : {}) };
  }

  /**
   * 受管回合：Lagent 必须在场。
   * - 只有 Lagent：直接一张工单，不再多造协调/汇总；
   * - 有协作 Agent：Lagent 分工 → 协作方并行 → Lagent 汇总；
   * - 计划模式：Lagent 先拆步骤，再把整体收进同一轮会话。
   */
  function buildManagedSteps({ goal, collaborators, mode, settings, models, efforts, executorInputs, suggestedSteps = [] }) {
    // 多 Agent 模式：Lagent 拆解分发 → 各自执行 → 互相验收 → Lagent 汇总。
    if (mode === 'multi') {
      const others = collaborators.filter(id => id !== LAGENT_EXECUTOR_ID);
      if (others.length) {
        const steps = [{
          executorId: LAGENT_EXECUTOR_ID,
          text: `理解并拆解：${goal}`,
          role: 'coordination',
          executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, { settings, models, efforts, executorInputs, prompt: coordinatorPrompt(goal, others), maxSteps: 8, role: 'coordination' })
        }];
        const workIndices = [];
        others.forEach((executorId, index) => {
          const workIndex = steps.length;
          workIndices.push(workIndex);
          steps.push({
            executorId,
            text: `执行任务第 ${index + 1} 部分`,
            role: 'answer',
            dependsOn: [0],
            executorInput: managedExecutorInput(executorId, {
              settings,
              models,
              efforts,
              executorInputs,
              prompt: [
                '你是这次协作里的执行者之一，负责其中一部分。',
                `整个任务：${goal}`,
                '原始目标里的限制优先于分工：目标要求只读、不要修改文件或不要构建时，绝对不要创建文件，也不要按分工里冲突的文件清单落盘。',
                '先看前序材料里 Lagent 的分工，只做分给你的部分；分工没有点名你时，按你的能力补位并说明理由。分工把你安排成“验收别人”时，仍然先独立完成自己那份检查，不要只复述对方的结论。',
                `同时参与的还有：${others.filter(id => id !== executorId).join('、') || '无'}。不要替别人改他要负责的文件。`,
                '做完后写清：检查或改动了哪些文件、怎么验证的、还有什么没做完。后面会有另一位 Agent 按 Lagent 的验收标准检查你的产出。'
              ].join('\n\n')
            })
          });
        });
        const testIndices = [];
        // 只有一个协作方时没有「对方」可测，交给 Lagent 在汇总时验收。
        if (others.length >= 2) {
          others.forEach((executorId, index) => {
            const targetIndex = (index + 1) % others.length;
            const target = others[targetIndex];
            const testIndex = steps.length;
            testIndices.push(testIndex);
            steps.push({
              executorId,
              text: `交叉验收：${target} 的工作`,
              role: 'verify',
              dependsOn: [0, workIndices[targetIndex]],
              executorInput: managedExecutorInput(executorId, {
                settings,
                models,
                efforts,
                executorInputs,
                prompt: crossTestPrompt(goal, executorId, target),
                role: 'verify'
              })
            });
          });
        }
        steps.push({
          executorId: LAGENT_EXECUTOR_ID,
          text: '汇总结果与下一步',
          role: 'synthesis',
          dependsOn: testIndices.length ? testIndices : workIndices,
          executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, {
            settings,
            models,
            efforts,
            executorInputs,
            prompt: synthesisPrompt(goal, others, { crossTested: testIndices.length > 0 }),
            maxSteps: 10,
            role: 'synthesis'
          })
        });
        return steps;
      }
    }
    if (mode === 'plan' && suggestedSteps.length) {
      const body = suggestedSteps
        .filter(step => step && step.executorId && step.executorId !== LAGENT_EXECUTOR_ID)
        .slice(0, 5);
      if (body.length) {
        const steps = [{ executorId: LAGENT_EXECUTOR_ID, text: `理解并拆解：${goal}`, role: 'coordination', executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, { settings, models, efforts, executorInputs, prompt: coordinatorPrompt(goal, body.map(step => step.executorId)), maxSteps: 8, role: 'coordination' }) }];
        body.forEach((step, index) => {
          const dependsOn = Array.isArray(step.dependsOn) && step.dependsOn.length
            ? [...new Set([0, ...step.dependsOn.map(item => Number(item) + 1).filter(item => item > 0 && item <= body.length)])]
            : [0];
          steps.push({
            executorId: step.executorId,
            text: typeof step.text === 'string' ? step.text : `执行任务第 ${index + 1} 部分`,
            role: 'step',
            dependsOn,
            ...(Array.isArray(step.scope) && step.scope.length ? { scope: step.scope } : {}),
            executorInput: managedExecutorInput(step.executorId, {
              settings,
              models,
              efforts,
              executorInputs,
              prompt: [
                `整个任务：${goal}`,
                `你负责的部分：${typeof step.text === 'string' ? step.text : '执行任务'}`,
                '只做你这一部分，不要替别人改他要负责的文件。做完用几句话说清改了哪些文件、怎么验证的、还有什么没做完。'
              ].join('\n\n')
            })
          });
        });
        steps.push({
          executorId: LAGENT_EXECUTOR_ID,
          text: '汇总结果与下一步',
          role: 'synthesis',
          dependsOn: body.map((_, index) => index + 1),
          executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, { settings, models, efforts, executorInputs, prompt: synthesisPrompt(goal, body.map(step => step.executorId)), maxSteps: 10, role: 'synthesis' })
        });
        return steps;
      }
    }
    const others = collaborators.filter(id => id !== LAGENT_EXECUTOR_ID);
    if (!others.length) return [{ executorId: LAGENT_EXECUTOR_ID, text: goal, role: 'answer', executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, { settings, models, efforts, executorInputs }) }];
    const steps = [{
      executorId: LAGENT_EXECUTOR_ID,
      text: `理解并拆解：${goal}`,
      role: 'coordination',
      executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, { settings, models, efforts, executorInputs, prompt: coordinatorPrompt(goal, others), maxSteps: 8, role: 'coordination' })
    }];
    others.forEach((executorId, index) => {
      steps.push({
        executorId,
        text: `执行任务第 ${index + 1} 部分`,
        role: 'answer',
        dependsOn: [0],
        executorInput: managedExecutorInput(executorId, {
          settings,
          models,
          efforts,
          executorInputs,
          prompt: [
            '你是这次协作里的执行者之一，负责其中一部分。',
            `整个任务：${goal}`,
            `同时参与的还有：${others.filter(id => id !== executorId).join('、') || '无'}。只做你这一部分，不要替别人改他要负责的文件。`,
            '先看现状再动手；改完确认真的生效；最后说清改了哪些文件、怎么验证的、还有什么没做完。'
          ].join('\n\n')
        })
      });
    });
    steps.push({
      executorId: LAGENT_EXECUTOR_ID,
      text: '汇总结果与下一步',
      role: 'synthesis',
      dependsOn: others.map((_, index) => index + 1),
      executorInput: managedExecutorInput(LAGENT_EXECUTOR_ID, { settings, models, efforts, executorInputs, prompt: synthesisPrompt(goal, others), maxSteps: 10, role: 'synthesis' })
    });
    return steps;
  }

  function startManagedTurn(conversation, { text, mode = 'auto', agentIds = [], settings = null, efforts = null, models = {}, executorInputs = {}, clientRequestId = '', autoRun = true, suggestedSteps = [] } = {}) {
    // 轮次级幂等：同一个 clientRequestId 已经落过轮次时直接复用，弱网重试不重复派活。
    const replay = clientRequestId ? conversations.turnByClientRequestId(conversation.id, clientRequestId) : null;
    if (replay) {
      const row = conversations.getRaw(conversation.id);
      const tickets = (replay.runs || []).map(run => { try { return get(run.ticketId); } catch { return { id: run.ticketId }; } });
      return { conversation: conversationSummary(row), turn: replay, tickets, replayed: true };
    }
    assertLagentReady();
    const collaborators = normalizeManagedAgents(agentIds).filter(id => id !== LAGENT_EXECUTOR_ID);
    const onlyLagent = collaborators.length === 0;
    const turnId = randomUUID();
    if (onlyLagent) {
      // Lagent 的强度优先取按 Agent 的映射；没有映射时保留旧的 settings.effort。
      const lagentSettings = efforts && typeof efforts === 'object' && isEffort(efforts[LAGENT_EXECUTOR_ID])
        ? { ...(settings || {}), effort: efforts[LAGENT_EXECUTOR_ID] }
        : settings;
      const ticket = dispatchConversationRun(conversation, LAGENT_EXECUTOR_ID, text, {
        turnId,
        settings: lagentSettings,
        role: 'answer',
        clientRequestId: clientRequestId ? `${clientRequestId}-model`.slice(0, 120) : undefined
      });
      const runs = [{ ticketId: ticket.id, agentId: LAGENT_EXECUTOR_ID, role: 'answer' }];
      const { turn } = conversations.addTurn(conversation.id, { id: turnId, prompt: text, mode: 'auto', agentIds: [LAGENT_EXECUTOR_ID], runs, clientRequestId });
      for (const run of runs) linkConversationTicket(run, conversation.id, turnId, run.agentId, run.role);
      return { conversation: conversationSummary(conversations.getRaw(conversation.id)), turn, tickets: [get(ticket.id)] };
    }
    const steps = buildManagedSteps({ goal: text, collaborators, mode, settings, models, efforts, executorInputs, suggestedSteps });
    const plan = startPlan({
      goal: text,
      steps,
      managed: true,
      conversationId: conversation.id,
      ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
      autoRun: autoRun !== false,
      deferLaunch: true,
      ...(clientRequestId ? { clientRequestId: `${clientRequestId}-managed`.slice(0, 120) } : {})
    });
    const planSteps = Array.isArray(plan?.steps) ? plan.steps : [];
    const runs = planSteps
      .filter(step => step.ticketId)
      .map(step => ({ ticketId: step.ticketId, agentId: step.executorId || LAGENT_EXECUTOR_ID, role: CONVERSATION_ROLES.includes(step.role) ? step.role : 'step' }));
    if (!runs.length) throw workError('受管回合没有生成可执行的步骤', 500);
    const turnMode = mode === 'plan' ? 'plan' : mode === 'multi' ? 'multi' : 'review';
    const { turn } = conversations.addTurn(conversation.id, { id: turnId, prompt: text, mode: turnMode, agentIds: [LAGENT_EXECUTOR_ID, ...collaborators], runs, clientRequestId });
    for (const run of runs) linkConversationTicket(run, conversation.id, turnId, run.agentId, run.role);
    const synthesis = planSteps.filter(step => step.role === 'synthesis' && step.ticketId).at(-1);
    if (synthesis) conversations.setSynthesis(conversation.id, turnId, { ticketId: synthesis.ticketId, agentId: LAGENT_EXECUTOR_ID });
    // 挂好会话归属后再启动：执行器的第一次写入不会把 conversationId/turnId 冲掉。
    if (autoRun !== false) {
      for (const step of planSteps) {
        const stored = db.get('ticket', step.ticketId);
        if (stored?.status === 'queued') launchStep(step.ticketId);
      }
    }
    const tickets = runs.map(run => { try { return get(run.ticketId); } catch { return { id: run.ticketId }; } });
    return { conversation: conversationSummary(conversations.getRaw(conversation.id)), turn: conversations.getRaw(conversation.id).turns.find(item => item.id === turnId), tickets, plan };
  }

  // 早期迁移把每个工单各开了一条会话；同一任务的多 Agent 因此散成好几条。
  // 这里按「同题、60 秒内、不同执行器」把单工单会话合回一条，并优先保留已有的分组会话。
  function mergeMigratedConversations() {
    const isPlaceholder = conv => conv.id.startsWith('conv-ticket-');
    const rankOf = conv => (isPlaceholder(conv) ? 0 : conv.id.startsWith('conv-chat-') ? 2 : 3);
    const all = conversations.list(500);
    const owner = new Map();
    for (const conv of all) {
      for (const ticketId of conv.ticketIds) {
        const previous = owner.get(ticketId);
        if (!previous || rankOf(conv) > rankOf(previous)) owner.set(ticketId, conv);
      }
    }
    // 已有分组会话的工单：把 ticket 挂到分组会话，再删掉单工单占位会话。
    for (const conv of all) {
      if (!isPlaceholder(conv) || conv.ticketIds.length !== 1) continue;
      const [ticketId] = conv.ticketIds;
      const better = owner.get(ticketId);
      if (!better || better.id === conv.id) continue;
      const turn = (better.turns || []).find(row => (row.runs || []).some(run => run.ticketId === ticketId)) || better.turns?.[0];
      if (!turn) continue;
      const stored = db.get('ticket', ticketId);
      linkConversationTicket({ id: ticketId }, better.id, turn.id, stored?.executor || 'lagent', 'answer');
      try { conversations.remove(conv.id); } catch { /* 已删过。*/ }
    }
    // 剩下的占位会话：同题且相邻创建时间在 60 秒内的，合成一条多 Agent 会话。
    const remaining = conversations.list(500)
      .filter(conv => isPlaceholder(conv) && conv.ticketIds.length === 1)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    const groups = [];
    for (const conv of remaining) {
      const stamp = Date.parse(conv.createdAt) || 0;
      const group = groups.find(item => item.title === conv.title && stamp - item.lastStamp <= 60000 && item.rows.length < 8);
      if (group) { group.rows.push(conv); group.lastStamp = stamp; }
      else groups.push({ title: conv.title, lastStamp: stamp, rows: [conv] });
    }
    for (const group of groups) {
      if (group.rows.length < 2) continue;
      const rows = group.rows.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      const target = `conv-group-${rows[0].ticketIds[0]}`.slice(0, 120);
      const agentIds = [...new Set(rows.map(conv => db.get('ticket', conv.ticketIds[0])?.executor).filter(Boolean))];
      let conversation;
      try { conversation = conversations.getRaw(target); } catch { conversation = null; }
      if (!conversation) {
        try {
          const created = conversations.create({ id: target, title: group.title, goal: group.title, agentIds });
          conversation = conversations.getRaw(created.id);
        } catch { continue; }
      }
      const turnId = `turn-group-${rows[0].ticketIds[0]}`.slice(0, 120);
      const hasTurn = (conversation.turns || []).some(turn => turn.id === turnId);
      if (!hasTurn) {
        try {
          conversations.addTurn(target, {
            id: turnId,
            prompt: group.title,
            mode: 'review',
            agentIds,
            runs: rows.map(conv => ({ ticketId: conv.ticketIds[0], agentId: db.get('ticket', conv.ticketIds[0])?.executor || 'lagent', role: 'answer' }))
          });
        } catch { continue; }
      }
      for (const conv of rows) {
        const ticketId = conv.ticketIds[0];
        linkConversationTicket({ id: ticketId }, target, turnId, db.get('ticket', ticketId)?.executor || 'lagent', 'answer');
        try { conversations.remove(conv.id); } catch { /* 已删过。*/ }
      }
      const stored = conversations.getRaw(target);
      if (stored && stored.createdAt !== rows[0].createdAt) db.put('conversation', { ...stored, createdAt: rows[0].createdAt });
    }
  }

  // 历史数据归并：项目里同一主对话下的从属对话、以及没有归属的历史工单，
  // 一次性收进会话；重复执行不会产生重复会话。
  function migrateConversations() {
    // 旧任务可能在同一对话里跑了很多轮；会话里每个 Agent 只保留最新一张工单作为代表，
    // 避免一张轮次被 8 条同 Agent 记录占满，把别的 Agent 挤出去。
    const latestPerExecutor = list => {
      const byExecutor = new Map();
      for (const ticket of [...list].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
        byExecutor.set(ticket.executor || 'lagent', ticket);
      }
      return [...byExecutor.values()].slice(0, 8);
    };
    // 上一版迁移可能是从「同 Agent 的 8 张工单」里截断的，导致会话里只剩一个 Agent。
    // 这里按 turnId 找回该轮全部工单，重新按 Agent 各取最新一张，把挤掉的 Agent 补回来。
    const repairMigratedTurns = () => {
      const byTurn = new Map();
      for (const ticket of db.list('ticket')) {
        if (!ticket.conversationId || !ticket.turnId) continue;
        const key = `${ticket.conversationId}|${ticket.turnId}`;
        const rows = byTurn.get(key);
        if (rows) rows.push(ticket);
        else byTurn.set(key, [ticket]);
      }
      for (const conversation of db.list('conversation')) {
        const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
        let changed = false;
        const nextTurns = turns.map(turn => {
          if (!/^turn-(project|migrate|ticket)-/.test(String(turn.id)) || turn.synthesisTicketId) return turn;
          const linked = byTurn.get(`${conversation.id}|${turn.id}`) || [];
          if (!linked.length) return turn;
          const represented = latestPerExecutor(linked);
          const wanted = represented.map(ticket => ticket.executor || 'lagent');
          const current = new Set((turn.runs || []).map(run => run.agentId));
          const stale = (turn.runs || []).length !== represented.length
            || new Set(wanted).size !== wanted.length
            || wanted.some(agent => !current.has(agent));
          if (!stale) return turn;
          changed = true;
          return {
            ...turn,
            agentIds: [...new Set(wanted)],
            runs: represented.map(ticket => ({ ticketId: ticket.id, agentId: ticket.executor || 'lagent', role: 'answer' }))
          };
        });
        if (!changed) continue;
        const participants = [...new Set(nextTurns.flatMap(turn => turn.agentIds || []))];
        db.put('conversation', { ...conversation, turns: nextTurns, participants });
      }
    };
    const tickets = db.list('ticket');
    const byChat = new Map();
    for (const ticket of tickets) {
      if (typeof ticket.projectChatId !== 'string' || !ticket.projectChatId) continue;
      const rows = byChat.get(ticket.projectChatId);
      if (rows) rows.push(ticket);
      else byChat.set(ticket.projectChatId, [ticket]);
    }
    for (const project of db.list('project')) {
      const chats = projects.listChats(project.id);
      // 旧的分派会给每个 Agent 各建一条顶层对话；它们其实是同一个任务的几路执行。
      // 创建时间相邻（60 秒内）的顶层对话归为一组，合成一条 Lagent 会话，只留一条可见入口。
      const roots = chats
        .filter(chat => !chat.parentChatId && chat.hidden !== true)
        .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
      const groups = [];
      for (const root of roots) {
        const stamp = Date.parse(root.createdAt) || 0;
        // 按创建时间相邻归组；同一个默认标题、十几分钟内又派了一次的，也算同一任务
        // （旧版重试会再建一轮对话），继续并进同一条会话。
        const group = groups.find(item => {
          if (stamp < item.stamp || item.chats.length >= 8) return false;
          if (stamp - item.stamp <= 60000) return true;
          const sameTitle = item.chats[0]?.title && item.chats[0].title === root.title;
          return Boolean(sameTitle) && stamp - item.stamp <= 15 * 60000;
        });
        if (group) group.chats.push(root);
        else groups.push({ stamp, chats: [root] });
      }
      for (const group of groups) {
        const members = group.chats;
        const memberIds = new Set(members.map(chat => chat.id));
        const children = chats.filter(chat => chat.parentChatId && memberIds.has(chat.parentChatId));
        const related = [...members, ...children].flatMap(chat => byChat.get(chat.id) || []);
        // 已经归属某个会话（例如浏览器导入的旧分组）时优先沿用它，避免重复造会话。
        const preferred = related.map(ticket => ticket.conversationId).find(id => id && !id.startsWith('conv-chat-')) || '';
        if (members.length === 1) {
          const host = members[0];
          if (!host.conversationId) {
            if (!related.length) continue;
            const conversationId = preferred || `conv-chat-${host.id}`;
            let conversation;
            try { conversation = conversations.getRaw(conversationId); } catch { conversation = null; }
            const represented = latestPerExecutor(related);
            const agentIds = [...new Set(represented.map(ticket => ticket.executor).filter(Boolean))];
            if (!conversation) {
              try {
                const created = conversations.create({ id: conversationId, title: host.title, goal: host.title, projectId: project.id, agentIds });
                conversation = conversations.getRaw(created.id);
              } catch { continue; }
            }
            const turnId = `turn-migrate-${host.id}`;
            const hasTurn = (conversation.turns || []).some(turn => turn.id === turnId);
            if (!hasTurn) {
              conversations.addTurn(conversation.id, {
                id: turnId,
                prompt: conversation.title || host.title || '历史任务',
                mode: 'review',
                agentIds,
                runs: represented.map(ticket => ({ ticketId: ticket.id, agentId: ticket.executor || 'lagent', role: 'answer' }))
              });
            }
            for (const ticket of related) linkConversationTicket(ticket, conversation.id, turnId, ticket.executor || 'lagent', 'answer');
            db.put('project-chat', { ...host, conversationId: conversation.id, updatedAt: now() });
          }
          for (const child of children) if (child.hidden !== true) db.put('project-chat', { ...child, hidden: true, updatedAt: now() });
          continue;
        }
        // 同组多条顶层对话：建一条会话，把每条对话（含其从属对话）的工单都收进同一轮。
        if (!related.length) {
          for (const member of members.slice(1)) if (member.hidden !== true) db.put('project-chat', { ...member, hidden: true, updatedAt: now() });
          continue;
        }
        const target = preferred || `conv-project-${members[0].id}`;
        const represented = latestPerExecutor(related);
        const agentIds = [...new Set(represented.map(ticket => ticket.executor).filter(Boolean))];
        let conversation;
        try { conversation = conversations.getRaw(target); } catch { conversation = null; }
        if (!conversation) {
          try {
            const created = conversations.create({ id: target, title: members[0].title, goal: members[0].title, projectId: project.id, agentIds });
            conversation = conversations.getRaw(created.id);
          } catch { continue; }
        }
        // 上一轮迁移已经把两条对话各自收成了会话：把被合并的那条会话的轮次整体接过来，
        // 追问历史一起保留，不能只留下最新一轮。
        const absorbed = [...new Set(related.map(ticket => ticket.conversationId)
          .filter(id => id && id.startsWith('conv-project-') && id !== target))];
        const relinked = new Set();
        for (const otherId of absorbed) {
          let other;
          try { other = conversations.getRaw(otherId); } catch { continue; }
          const current = conversations.getRaw(target);
          const seen = new Set((current.turns || []).map(turn => turn.id));
          const extra = (other.turns || []).filter(turn => !seen.has(turn.id));
          if (extra.length) {
            const turns = [...(current.turns || []), ...extra].map((turn, index) => ({ ...turn, index }));
            const participants = [...new Set([...(current.participants || []), ...turns.flatMap(turn => turn.agentIds || [])])];
            db.put('conversation', { ...current, turns, participants, updatedAt: now() });
          }
          for (const ticket of tickets) {
            if (ticket.conversationId !== otherId) continue;
            linkConversationTicket(ticket, target, ticket.turnId, ticket.agentId || ticket.executor, ticket.role || 'answer');
            relinked.add(ticket.id);
          }
          try { conversations.remove(otherId); } catch { /* 已经删过。*/ }
        }
        conversation = conversations.getRaw(target);
        const known = new Set(conversation.ticketIds || []);
        const knownAgents = new Set((conversation.turns || []).flatMap(turn => (turn.runs || []).map(run => run.agentId)));
        const turnId = `turn-project-${members[0].id}`;
        const fresh = represented.filter(ticket => !known.has(ticket.id) && !knownAgents.has(ticket.executor || 'lagent'));
        const hasTurn = (conversation.turns || []).some(turn => turn.id === turnId);
        if (!hasTurn && fresh.length) {
          conversations.addTurn(target, {
            id: turnId,
            prompt: conversation.title || members[0].title || '历史任务',
            mode: 'review',
            agentIds,
            runs: fresh.map(ticket => ({ ticketId: ticket.id, agentId: ticket.executor || 'lagent', role: 'answer' }))
          });
        }
        const turn = (conversations.getRaw(target).turns || []).find(item => item.id === turnId);
        for (const ticket of related) {
          // 已经接进目标会话轮次的工单保留原 turnId；只给还没归属这一轮的补挂。
          if (relinked.has(ticket.id) || (ticket.conversationId === target && ticket.turnId)) continue;
          linkConversationTicket(ticket, target, turn?.id || turnId, ticket.executor || 'lagent', 'answer');
        }
        // 每条 Agent 对话各自的旧占位会话不再出现。
        for (const member of members) {
          const old = `conv-chat-${member.id}`;
          if (old === target) continue;
          try { conversations.remove(old); } catch { /* 没有就跳过。*/ }
        }
        // 保留工单最多的一条可见入口，其余标成隐藏；项目页只显示这一条。
        const countOf = chat => (byChat.get(chat.id) || []).length;
        const host = [...members].sort((left, right) => countOf(right) - countOf(left) || String(left.createdAt).localeCompare(String(right.createdAt)))[0];
        for (const member of members) {
          db.put('project-chat', { ...member, conversationId: target, hidden: member.id !== host.id, updatedAt: now() });
        }
        for (const child of children) db.put('project-chat', { ...child, conversationId: target, hidden: true, updatedAt: now() });
        const earliest = related.map(ticket => ticket.createdAt).filter(Boolean).sort()[0];
        const stored = conversations.getRaw(target);
        if (stored && earliest && stored.createdAt !== earliest) db.put('conversation', { ...stored, createdAt: earliest });
      }
    }
    // 没有项目归属的历史单工单：各建一条会话，只处理最近的，避免一次生成几百条。
    const orphans = tickets
      .filter(ticket => !ticket.projectChatId && !ticket.conversationId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, 120);
    for (const ticket of orphans) {
      const conversationId = `conv-ticket-${ticket.id}`;
      let conversation;
      try { conversation = conversations.getRaw(conversationId); } catch { conversation = null; }
      const stamp = ticket.createdAt || now();
      if (!conversation) {
        try {
          conversations.create({ id: conversationId, title: ticket.title, goal: ticket.title, agentIds: ticket.executor ? [ticket.executor] : [] });
          conversation = conversations.getRaw(conversationId);
          conversations.addTurn(conversation.id, {
            id: `turn-ticket-${ticket.id}`,
            prompt: ticket.title,
            mode: 'auto',
            agentIds: ticket.executor ? [ticket.executor] : ['lagent'],
            runs: [{ ticketId: ticket.id, agentId: ticket.executor || 'lagent', role: 'answer' }]
          });
        } catch { continue; }
      }
      linkConversationTicket(ticket, conversation.id, `turn-ticket-${ticket.id}`, ticket.executor || 'lagent', 'answer');
      // 保持历史顺序：迁移出来的会话按原工单时间排。
      const stored = conversations.getRaw(conversation.id);
      if (stored && stored.createdAt !== stamp) db.put('conversation', { ...stored, createdAt: stamp });
    }
    // 受管模式下的旧项目对话：只把已有结论、没有在跑任务的可见对话收成 Lagent 宿主；
    // 运行中的对话等它结束后由打开时的惰性物化接手，避免迁移中途打断执行。
    if (managedProjectChats) {
      const activeStatuses = new Set(['queued', 'waiting', 'working', 'awaiting_review']);
      for (const chat of db.list('project-chat')) {
        if (chat.hidden === true || chat.parentChatId) continue;
        if (chat.executorId === LAGENT_EXECUTOR_ID && chat.role === 'host') continue;
        const related = byChat.get(chat.id) || [];
        if (!related.length) continue;
        if (related.some(ticket => activeStatuses.has(ticket.status))) continue;
        try {
          materializeConversationForChat(chat.id);
        } catch (error) {
          audit(chat.id, 'conversation-materialize', 'project-chat', 'failed', String(error?.message || error).slice(0, 200));
        }
      }
    }
    try { repairMigratedTurns(); } catch (error) { audit(null, 'conversation-repair', '', 'failed', String(error?.message || error)); }
    try { mergeMigratedConversations(); } catch (error) { audit(null, 'conversation-merge', '', 'failed', String(error?.message || error)); }
  }

  // 把旧的项目对话转成「Lagent 会话 + 执行绑定」：
  // 用户看到的那条对话变成会话宿主，原执行器退到隐藏执行对话里，session/窗口继续可用。
  function materializeConversationForChat(chatId) {
    const chat = projects.getChat(chatId);
    const existingConversationId = chat.conversationId || '';
    // 已归属会话但宿主仍是外部 Agent 的旧数据，也要顺手改成 Lagent 宿主。
    if (existingConversationId && chat.executorId === LAGENT_EXECUTOR_ID && chat.role === 'host') {
      return { conversation: conversations.getRaw(existingConversationId), chat, created: false };
    }
    const originalExecutor = chat.executorId;
    const conversationId = existingConversationId || `conv-chat-${chat.id}`.slice(0, 120);
    let conversation;
    try { conversation = conversations.getRaw(conversationId); } catch { conversation = null; }
    if (!conversation) {
      const created = conversations.create({
        id: conversationId,
        title: chat.title || '项目对话',
        goal: chat.title || '',
        projectId: chat.projectId,
        agentIds: originalExecutor === LAGENT_EXECUTOR_ID ? [LAGENT_EXECUTOR_ID] : [originalExecutor]
      });
      conversation = conversations.getRaw(created.id);
    }
    let collaborators = normalizeManagedAgents(conversation.collaborators || []).filter(id => id !== LAGENT_EXECUTOR_ID);
    if (originalExecutor !== LAGENT_EXECUTOR_ID && !collaborators.includes(originalExecutor)) collaborators = [...collaborators, originalExecutor].slice(0, 3);
    // 原执行器不是 Lagent 时，把 session/窗口挪到一条隐藏执行对话；宿主只保留会话归属。
    if (originalExecutor !== LAGENT_EXECUTOR_ID) {
      const existing = projects.listChats(chat.projectId).find(row => row.conversationId === conversationId && row.executorId === originalExecutor && row.id !== chat.id);
      let hidden = existing;
      if (!hidden) {
        hidden = projects.createChat(chat.projectId, {
          executorId: originalExecutor,
          conversationId,
          hidden: true,
          title: `${chat.title || '会话'} · ${executors.list().find(agent => agent.id === originalExecutor)?.name || originalExecutor}`
        });
      }
      const moved = { ...hidden, updatedAt: now() };
      for (const key of ['sessionId', 'sessions', 'window', 'writable', 'permission']) {
        if (chat[key] !== undefined) moved[key] = chat[key];
      }
      db.put('project-chat', moved);
    }
    const host = { ...chat, conversationId, executorId: LAGENT_EXECUTOR_ID, role: 'host', managedBy: 'lagent', updatedAt: now() };
    delete host.sessionId;
    delete host.sessions;
    delete host.window;
    if (originalExecutor !== LAGENT_EXECUTOR_ID) host.originalExecutorId = originalExecutor;
    db.put('project-chat', host);
    db.put('conversation', {
      ...conversations.getRaw(conversationId),
      collaborators,
      ...(chat.permission ? { permission: chat.permission } : {}),
      updatedAt: now()
    });
    return { conversation: conversations.getRaw(conversationId), chat: host, created: true };
  }

  const api = {
    bootstrap(){
      const tickets=db.list('ticket').map(publicTicket);
      const running=db.list('assignment').filter(row=>row.status==='working').length;
      return {
        capabilities:{work:true},
        // 服务级总开关：为 false 时，策略里勾选外部执行器也不会生效，界面据此给出提示。
        externalExecutors:externalExecutorsEnabled(env),
        // 并发占用：工单显示「排队中」时，界面要能说清楚是在等空位，而不是卡住了。
        queue:{maxConcurrent:policy.budgets.maxConcurrent,running,queued:tickets.filter(ticket=>ticket.status==='queued').length,full:running>=policy.budgets.maxConcurrent},
        // 未绑定工作文件夹的对话，Agent 就在这个目录里读写。
        workspace,
        tickets,
        // 执行器已下线的历史待办（例如旧数据分析）不再进收件箱，避免点了批准才发现无法执行。
        attention:tickets.filter(t=>t.attention&&executors.resolve(t.executor)).map(t=>({ticketId:t.id,title:t.title,...t.attention})),
        projects:projects.listProjects(),
        agents:executors.list().map(({id,name,kind,available,capabilities})=>({id,name,kind,status:(id==='model'?(available&&modelReady()?'available':'needs_setup'):(available?'available':'unavailable')),capabilities})),
        tools:[
          {id:'terminal',name:'受控终端',kind:'terminal',status:'connected',permissions:['git','npm','ls','pwd']},
          ...executors.list().filter(agent=>['browser','github'].includes(agent.id)).map(agent=>({id:agent.id,name:agent.name,kind:agent.kind,status:agent.available?'connected':'needs_setup',permissions:agent.capabilities||[]}))
        ],
        policy:JSON.parse(JSON.stringify(policy)),
        // 主控状态：前端据此在未配置模型时禁用发送并给出设置入口。
        lagent:{...lagentState(),name:'Lagent',executorId:LAGENT_EXECUTOR_ID},
        profiles:profiles.list(),
        activeProfile:profiles.active(),
        plans:db.list('plan').filter(plan=>!plan.projectId||Boolean(db.get('project',plan.projectId))).sort((left,right)=>String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0,20).map(plan=>({id:plan.id,goal:plan.goal,status:plan.status,autoRun:plan.autoRun===true,currentStep:plan.currentStep,totalSteps:plan.steps.length,projectChatId:typeof plan.projectChatId==='string'?plan.projectChatId:null,updatedAt:plan.updatedAt})),
        // 会话列表：侧栏「最近的对话」只认这个，不再按 Agent 拆成多条。
        conversations:listConversationSummaries(60),
        // P0.2：统一审批收件箱；旧 attention 字段保留，旧客户端继续可用。
        ...(approvals?{approvals:approvals.list({status:'pending',limit:100})}:{})
      };
    },
    policy(){return JSON.parse(JSON.stringify(policy));},
    auditExternal(action,executor,result,reason=''){audit(null,action,executor,result,reason);},
    updatePolicy(input){
      // 与当前策略合并：只改传进来的字段，不再把其它设置重置成默认值。
      const next=normalizePolicy(input,policy);
      policy=next;
      applyExecutorConcurrency();
      store.put('work-policy',{id:WORK_POLICY_ID,...next});
      audit(null,'policy','policy','allowed','策略更新');
      return JSON.parse(JSON.stringify(policy));
    },
    listProjects(){return projects.listProjects();},
    // 配置档：保存、改名、删除、一键应用与恢复默认。
    listProfiles(){return profiles.list();},
    agentMarket(){return {listings:agentMarket.list()};},
    // source=remote/all 时把远程清单一起返回；远程读取失败只降级，不影响本地市场。
    async agentMarketCatalog({source='all'}={}){
      const listings=agentMarket.list();
      if(source==='local')return {listings,remote:{configured:agentMarket.remoteConfigured(),url:'',listings:[]}};
      const remote=await agentMarket.remoteList();
      return {listings:source==='remote'?remote.listings:[...listings,...remote.listings],remote};
    },
    marketManifest(){return agentMarket.manifest();},
    publishAgentBundle(input){return agentMarket.publish(input);},
    removeAgentBundle(id){return agentMarket.remove(id);},
    async installAgentBundle(id){const result=await agentMarket.installAny(id);audit(null,'market','market','allowed',`安装配置 ${result.listing?.name||''}`);return result;},
    profilesActive(projectId){return profiles.active(projectId||undefined);},
    saveProfile(input){const profile=profiles.save(input);audit(null,'profile','profile','allowed',`保存配置档 ${profile.name}`);return profile;},
    updateProfile(id,input){const profile=profiles.update(id,input);audit(null,'profile','profile','allowed',`更新配置档 ${profile.name}`);return profile;},
    deleteProfile(id){const result=profiles.remove(id);audit(null,'profile','profile','allowed','删除配置档');return result;},
    applyProfile(id,input={}){
      const result=profiles.apply(id,{projectId:input?.projectId});
      // 全局应用才更新策略快照；项目级只覆盖模型/强度/权限等对话默认值。
      if(!input?.projectId&&result.profile.policy){
        policy=normalizePolicy(result.profile.policy,policy);
        applyExecutorConcurrency();
        store.put('work-policy',{id:WORK_POLICY_ID,...policy});
      }
      audit(null,'profile','profile','allowed',`应用配置档 ${result.profile.name}`);
      return {...result,policy:api.policy(),active:profiles.active(input?.projectId)};
    },
    resetProfile(input={}){
      const result=profiles.reset({projectId:input?.projectId});
      if(!input?.projectId){
        policy=normalizePolicy(defaultPolicy());
        applyExecutorConcurrency();
        store.put('work-policy',{id:WORK_POLICY_ID,...policy});
      }
      audit(null,'profile','profile','allowed',input?.projectId?'恢复项目默认配置':'恢复默认配置档');
      return {...result,policy:api.policy(),active:profiles.active(input?.projectId)};
    },
    // 外部 MCP 令牌按项目限权时，需要从工单反查所属项目。
    ticketProjectId(id){
      if(typeof id!=='string'||!id)return null;
      const control=store.get('work-control',id);
      const chatId=control?.projectChatId||db.get('ticket',id)?.projectChatId;
      return chatId?db.get('project-chat',chatId)?.projectId||null:null;
    },
    planProjectId(id){
      if(typeof id!=='string'||!id)return null;
      const plan=db.get('plan',id);
      if(!plan)return null;
      if(plan.projectId)return plan.projectId;
      return plan.projectChatId?db.get('project-chat',plan.projectChatId)?.projectId||null:null;
    },
    getProject(id){return projects.getProject(id);},
    setProjectIsolation(id,mode){return projects.setIsolation(id,mode);},
    importProject(input){return projects.importProject(input);},
    deleteProject(id){
      const project=projects.getProject(id);
      const chatIds=projects.listChats(project.id).map(chat=>chat.id);
      const removed=purgeChatTickets(chatIds);
      const plans=purgeProjectData({projectId:project.id,chatIds});
      const runs=purgeRuns({projectId:project.id,chatIds});
      return {...projects.deleteProject(id),removed,plans,runs};
    },
    renameProject(id,input){return projects.renameProject(id,input);},
    listDirectory(input){return projects.listDirectory(input);},
    projectFiles(id,input){return projectFileService.list(id,typeof input==='string'?input:input?.path);},
    searchProjectFiles(id,query){return projectFileService.search(id,query);},
    projectFilePreview(id,file){return projectFileService.preview(id,file);},
    projectFileSource(id,file){return projectFileService.file(id,file);},
    projectBrief(id){return projects.getBrief(id);},
    saveProjectBrief(id,input,meta){return projects.saveBrief(id,input,meta);},
    async verifyTicket(id){
      const ticket=privateTicket(id);
      if(!ticket.verify)throw workError('该工单没有配置验收命令',400);
      if(!['completed','blocked','failed'].includes(ticket.status))throw workError('工单尚未结束，不能验收',409);
      const projectPath=projectPathForTicket(ticket);
      const acceptance=await runVerify({verify:ticket.verify,projectPath});
      const assignment=latest(id);
      const evidence=reviewAcceptance(ticket,acceptance);
      const failed=acceptance.status!=='passed'||evidence.verdict==='reject';
      const summary=acceptance.status!=='passed'
        ? `验收未通过：${acceptance.command}`
        : evidence.verdict==='reject'
          ? `评审未通过：${evidence.issues[0]?.message||acceptance.command}`
          : `验收通过：${acceptance.command}`;
      const next={...ticket,acceptance,review:evidence,stage:'verify',summary,updatedAt:now(),...(failed?{status:'blocked',attention:review(summary)}:{attention:undefined})};
      const report=assignment?[['report',makeReport(next,assignment,failed?'failed':'ready',summary,{acceptance,review:evidence})]]:[];
      const result=write(next,...report);
      audit(id,'verify',ticket.executor,failed?'failed':'passed',acceptance.command);
      if(failed&&ticket.planId&&Number.isSafeInteger(ticket.planStep))advancePlan(ticket.planId);
      return {ticket:result,acceptance,review:evidence};
    },
    projectChanges(id){return projects.listChanges(id);},
    recordProjectChange(id,input,meta){return projects.recordChange(id,input,meta);},
    deleteProjectChange(projectId,changeId){return projects.deleteChange(projectId,changeId);},
    projectBriefMarkdown(id){return projects.briefMarkdown(id);},
    libraryTargets(){return library.targets();},
    libraryPreview(id,options){return library.preview(id,{...(options||{}),library:activeLibrary(id)});},
    libraryApply(id,options){return library.apply(id,{...(options||{}),library:activeLibrary(id)});},
    librarySyncs(id){return library.list(id);},
    libraryRollback(id,syncId){return library.rollback(id,syncId);},
    // 技能中心：来源预览 → 安装 → 启停/更新/卸载；插件交给本机 Claude Code CLI。
    listSkills(){return {skills:skillService.list(),catalog:skillService.catalog()};},
    previewSkill(input){return skillService.preview(input);},
    installSkill(input){const result=skillService.install(input);audit(null,'skill','skill','allowed',`安装技能 ${result.skill?.name||''}`);return result;},
    updateSkill(id){return skillService.update(id);},
    enableSkill(id){const result=skillService.enable(id);audit(null,'skill','skill','allowed',`启用技能 ${result.skill?.name||''}`);return result;},
    disableSkill(id){const result=skillService.disable(id);audit(null,'skill','skill','allowed',`停用技能 ${result.skill?.name||''}`);return result;},
    removeSkill(id){const result=skillService.remove(id);audit(null,'skill','skill','allowed','卸载技能');return result;},
    readSkill(name,projectId){return skillService.read(projectId,name);},
    listPlugins(options){return pluginService.list(options);},
    pluginDetails(name){return pluginService.details(name);},
    addPluginMarketplace(source,options){return pluginService.addMarketplace(source,options);},
    removePluginMarketplace(name){return pluginService.removeMarketplace(name);},
    async installPlugin(name,options){const result=await pluginService.install(name,options);audit(null,'plugin','plugin','allowed',`安装插件 ${name}`);return result;},
    enablePlugin(name,options){return pluginService.enable(name,options);},
    disablePlugin(name,options){return pluginService.disable(name,options);},
    updatePlugin(name){return pluginService.update(name);},
    uninstallPlugin(name){return pluginService.uninstall(name);},
    projectMemory(id,limit){projects.getProject(id);return memory.list(id,limit||20);},
    projectMemorySearch(id,options){projects.getProject(id);return memory.search(id,options||{});},
    projectMemoryDigest(id,options){
      projects.getProject(id);
      const query=typeof options?.query==='string'?options.query.trim():'';
      const scope=typeof options?.scope==='string'?options.scope.trim():'';
      const limit=Number.isSafeInteger(options?.limit)&&options.limit>0?options.limit:30;
      const entries=query||scope?memory.search(id,{query,scope,limit}):memory.list(id,limit);
      return {digest:memory.digest(id,{limit:8}),entries};
    },
    deleteProjectMemory(id,memoryId){projects.getProject(id);return memory.remove(memoryId);},
    // 给执行器（模型 Agent）用：按工作目录拿到「最近改了什么」，不泄露其它项目。
    projectStateBrief(workspace){return projectStateBrief(workspace);},
    createProjectChat(projectId,input){
      const chat=projects.createChat(projectId,input);
      try{
        const target=executors.requireAvailable(chat.executorId);
        if(chat.executorId==='window'&&!windowBridge)throw workError('窗口桥未启用',503);
        guard(chat.executorId,null,'project/chat');
        if(!['cli','model'].includes(target.kind)&&chat.executorId!=='window')throw workError('该执行器暂不支持项目对话',400);
      }catch(error){
        try{projects.deleteChat(chat.id);}catch{/* 回滚失败不掩盖原错误。 */}
        throw error;
      }
      return {chat,project:projects.getProject(projectId)};
    },
    deleteProjectChat(id){
      const removed=purgeChatTickets([id]);
      const plans=purgeProjectData({chatIds:[id]});
      const runs=purgeRuns({chatIds:[id]});
      return {...projects.deleteChat(id),removed,plans,runs};
    },
    // 对话页里删除一条自己发的消息：连同它的执行记录、报告与快照一起清掉。
    // 属于多步计划的一条消息会连整个计划一起删——留下半个计划比删掉更难解释。
    deleteTicket(id){
      const ticket=db.get('ticket',id);
      const control=store.get('work-control',id);
      if(!control?.projectChatId)throw workError('只有项目对话里的消息可以删除',400);
      if(ticket.status==='working'||ticket.status==='awaiting_review')throw workError('这条消息还在执行，先停止再删除',409);
      const chatId=control.projectChatId;
      const targets=[id];
      let planRemoved=false;
      if(ticket.planId){
        const plan=db.get('plan',ticket.planId);
        if(plan)for(const step of plan.steps)if(step.ticketId&&!targets.includes(step.ticketId))targets.push(step.ticketId);
        planRemoved=true;
      }
      for(const ticketId of targets){
        const assignmentRows=related('assignment',ticketId);
        for(const row of assignmentRows){
          if(row.sessionId)try{store.delete('task',row.sessionId);}catch{/* 任务已不存在。 */}
          db.delete('assignment',row.id);
        }
        for(const row of related('report',ticketId))db.delete('report',row.id);
        for(const row of store.list('work-event').filter(item=>item.ticketId===ticketId))store.delete('work-event',row.id);
        try{store.delete('work-control',ticketId);}catch{/* 控制记录可能已不存在。 */}
        try{store.delete('git-snapshot',ticketId);}catch{/* 快照可能已不存在。 */}
        approvals?.cancelForTicket(ticketId,'工单已删除');
        db.delete('ticket',ticketId);
      }
      if(planRemoved)db.delete('plan',ticket.planId);
      const chat=projects.getChat(chatId);
      if(chat?.lastTicketId&&targets.includes(chat.lastTicketId)){
        const rest=db.list('ticket').filter(row=>store.get('work-control',row.id)?.projectChatId===chatId).sort((left,right)=>String(right.createdAt).localeCompare(String(left.createdAt)));
        db.put('project-chat',{...chat,lastTicketId:rest[0]?.id||null,updatedAt:now()});
      }
      audit(id,'delete','project/chat','allowed',planRemoved?'删除计划与全部步骤':'删除单条消息');
      // 删完推一条事件，让所有打开的窗口（含手机）立刻丢掉这条消息，而不是等下次轮询。
      publish({type:'delete',ticketId:id,payload:{ids:targets,chatId,planRemoved}});
      return {id,removed:targets.length,ids:targets,planRemoved};
    },
    renameProjectChat(id,input){return projects.renameChat(id,input);},
    // 单条会话的权限档位：留空表示回到「跟随全局策略」。
    setProjectChatPermission(id,input){return projects.setChatPermission(id,input);},
    setProjectChatCollaborators(id,input){return projects.setChatCollaborators(id,input);},
    scanProjectSessions(projectId,executorId){return projects.scanSessions(projectId,executorId);},
    importProjectSession(projectId,input){return projects.importSession(projectId,input);},
    // 兼容/回滚路径：直接按执行器派单，不再额外造协调与汇总步骤。
    legacyProjectChatMessages(chatId,input){
      const chat=projects.getChat(chatId);
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      const listed=Array.isArray(input?.executorIds)?input.executorIds:[];
      const requested=[...new Set(listed.map(item=>typeof item==='string'?item.trim():'').filter(Boolean))];
      const single=typeof input?.executorId==='string'?input.executorId.trim():'';
      const targets=requested.length?requested:(single?[single]:[chat.executorId]);
      if(targets.length>4)throw workError('一条任务最多交给 4 个 Agent',400);
      for(const executorId of targets){
        if(!PROJECT_CHAT_EXECUTORS.includes(executorId))throw workError('这条消息指定的执行器不支持项目对话',400);
        if(executorId==='window'&&chat.executorId!=='window')throw workError('窗口 Agent 需要先在项目中绑定窗口对话',400);
        executors.requireAvailable(executorId);
        const denial=executorDenial(executorId);if(denial)throw workError(denial.reason,403);
      }
      if(targets.length>1&&targets.includes('window'))throw workError('窗口 Agent 不能和其它 Agent 并行执行同一条任务',400);
      const executorInput={};
      if(typeof input?.profileId==='string'&&input.profileId.trim())executorInput.profileId=input.profileId.trim();
      if(typeof input?.model==='string'&&input.model.trim())executorInput.model=input.model.trim();
      if(typeof input?.effort==='string'&&input.effort.trim())executorInput.effort=input.effort.trim();
      const conversation={...(typeof input?.conversationId==='string'&&input.conversationId.trim()?{conversationId:input.conversationId.trim()}:{}),...(typeof input?.turnId==='string'&&input.turnId.trim()?{turnId:input.turnId.trim()}:{}),...(typeof input?.agentId==='string'&&input.agentId.trim()?{agentId:input.agentId.trim()}:{}),...(['synthesis','step','verify'].includes(input?.role)?{role:input.role}:{})};
      const baseRequest=typeof input?.clientRequestId==='string'&&input.clientRequestId.trim()?input.clientRequestId.trim():'';
      const tickets=targets.map(executorId=>api.command({
        text,
        executorId,
        projectChatId:chat.id,
        clientRequestId:baseRequest?(targets.length>1?`${baseRequest}-${executorId}`:baseRequest):undefined,
        ...(executorId!==chat.executorId?{executorSwitch:true}:{}),
        ...(targets.length>1?{...conversation,agentId:executorId}:conversation),
        ...(Object.keys(executorInput).length?{executorInput}:{})
      }));
      try{projects.adoptTitle(chat.id,text);}catch{/* 改名失败不影响已提交的工单。 */}
      return tickets;
    },
    // 同一条消息可以交给多个协作 Agent：它们都在 Lagent 主控下执行，结果收进同一条会话。
    projectChatMessages(chatId,input){
      if (!managedProjectChats) return api.legacyProjectChatMessages(chatId, input);
      const chat=projects.getChat(chatId);
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      assertLagentReady();
      // 前端多选的 executorIds 现在表示「本轮协作 Agent」；Lagent 始终是主控。
      const listed=Array.isArray(input?.executorIds)?input.executorIds:[];
      const requested=[...new Set(listed.map(item=>typeof item==='string'?item.trim():'').filter(Boolean))];
      const single=typeof input?.executorId==='string'?input.executorId.trim():'';
      const original=chat.executorId;
      const candidates=requested.length?requested:(single?[single]:[original]);
      const targets=normalizeManagedAgents(candidates.map(id=>id===LAGENT_EXECUTOR_ID?'':id).filter(Boolean));
      if(requested.length>3)throw workError('一条任务最多交给 3 个协作 Agent',400);
      for(const executorId of targets){
        if(executorId===LAGENT_EXECUTOR_ID)continue;
        if(!PROJECT_CHAT_EXECUTORS.includes(executorId))throw workError('这条消息指定的执行器不支持项目对话',400);
        // 窗口 Agent 不能临时切过去：它需要会话上已经绑定的窗口句柄，也不能和其它人并行。
        if(executorId==='window'&&original!=='window')throw workError('窗口 Agent 需要先在项目中绑定窗口对话',400);
        executors.requireAvailable(executorId);
        const denial=executorDenial(executorId);if(denial)throw workError(denial.reason,403);
      }
      if(targets.length>2&&targets.includes('window'))throw workError('窗口 Agent 不能和其它 Agent 并行执行同一条任务',400);
      const materialized=materializeConversationForChat(chat.id);
      // 会话级模型与思考强度：内置 Agent 用 profileId，外部 CLI 用 model。
      const settings=normalizeCommandSettings({
        ...(typeof input?.profileId==='string'&&input.profileId.trim()?{profileId:input.profileId.trim()}:{}),
        ...(typeof input?.model==='string'&&input.model.trim()?{model:input.model.trim()}:{}),
        ...(typeof input?.effort==='string'&&input.effort.trim()?{effort:input.effort.trim()}:{}),
        ...(typeof input?.permission==='string'?{permission:input.permission}:{})
      });
      const result=startManagedTurn(materialized.conversation,{
        text,
        mode:targets.length>1?'review':'auto',
        agentIds:targets,
        settings,
        clientRequestId:typeof input?.clientRequestId==='string'?input.clientRequestId.trim():'',
        autoRun:input?.autoRun!==false
      });
      try{projects.adoptTitle(chat.id,text);}catch{/* 改名失败不影响已提交的工单。 */}
      return result.tickets.map(ticket=>({...ticket,conversationId:result.conversation.id}));
    },
    projectChatMessage(chatId,input){return api.projectChatMessages(chatId,input)[0];},
    // 前端打开项目对话前先调用：返回会话 id 后直接切到统一线程。
    materializeProjectChat(chatId){
      const result=materializeConversationForChat(chatId);
      return {chat:result.chat,conversation:conversationSummary(result.conversation),created:result.created};
    },
    legacyProjectDispatch(projectId,input){
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      const requested=Array.isArray(input?.executorIds)?input.executorIds:[];
      const wanted=[...new Set(requested.map(item=>String(item??'').trim()).filter(Boolean))];
      if(!wanted.length)throw workError('请选择要分派的执行器',400);
      if(wanted.length>4)throw workError('一次最多分派给 4 个 Agent',400);
      const unsupported=wanted.filter(id=>!PROJECT_CHAT_EXECUTORS.includes(id));
      if(unsupported.length)throw workError(`这些执行器暂不支持项目分派：${unsupported.join('、')}`,400);
      let windowTarget=null;
      if(wanted.includes('window')){
        const handle=Number(input?.window?.handle);
        if(!Number.isSafeInteger(handle)||handle<=0)throw workError('使用窗口 Agent 分派时，请先选择要接管的窗口',400);
        windowTarget={handle,...(typeof input.window.process==='string'&&input.window.process.trim()?{process:input.window.process.trim()}:{}),...(typeof input.window.title==='string'&&input.window.title.trim()?{windowTitle:input.window.title.trim()}:{})};
      }
      const chats=projects.listChats(projectId);
      const stamp=Date.now().toString(36);
      const turnId=`turn-dispatch-${stamp}`;
      let conversationId='';
      try{
        const created=conversations.create({id:`conv-dispatch-${stamp}`,title:text,goal:text,projectId,agentIds:wanted});
        conversationId=created.id;
      }catch{/* 会话数量到上限时不阻塞派活。*/}
      const tickets=[];
      for(const executorId of wanted){
        let chat=conversationId
          ?chats.find(item=>item.conversationId===conversationId&&item.executorId===executorId&&(executorId!=='window'||item.window?.handle===windowTarget?.handle))
          :null;
        if(!chat){
          if(executorId==='window'){
            chat=chats.find(item=>item.hidden!==true&&item.executorId==='window'&&item.window?.handle===windowTarget.handle)
              ||api.createProjectChat(projectId,{executorId,...windowTarget,...(conversationId?{conversationId,hidden:true}:{})}).chat;
          }else{
            const existing=chats.find(item=>item.hidden!==true&&item.executorId===executorId&&item.source!=='imported')||chats.find(item=>item.hidden!==true&&item.executorId===executorId);
            chat=(conversationId?null:existing)||api.createProjectChat(projectId,{executorId,...(conversationId?{conversationId,hidden:true}:{})}).chat;
          }
        }
        tickets.push(api.legacyProjectChatMessages(chat.id,{text,clientRequestId:`dispatch-${stamp}-${executorId}`,...(conversationId?{conversationId,turnId,agentId:executorId,role:'answer'}:{})})[0]);
      }
      if(conversationId){
        try{
          conversations.addTurn(conversationId,{id:turnId,prompt:text,mode:'review',agentIds:wanted,runs:tickets.map((ticket,index)=>({ticketId:ticket.id,agentId:wanted[index],role:'answer'}))});
          for(const ticket of tickets)linkConversationTicket(ticket,conversationId,turnId,ticket.executor||'lagent','answer');
        }catch{/* 会话轮次落库失败不影响已提交的工单。*/}
      }
      return {project:projects.getProject(projectId),tickets,...(conversationId?{conversationId}:{})};
    },
    projectDispatch(projectId,input){
      if (!managedProjectChats) return api.legacyProjectDispatch(projectId, input);
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      assertLagentReady();
      const requested=Array.isArray(input?.executorIds)?input.executorIds:[];
      const wanted=[...new Set(requested.map(item=>String(item??'').trim()).filter(Boolean))].slice(0,3);
      if(!wanted.length)throw workError('请选择要分派的执行器',400);
      const unsupported=wanted.filter(id=>!PROJECT_CHAT_EXECUTORS.includes(id)||id===LAGENT_EXECUTOR_ID);
      if(unsupported.length)throw workError(`这些执行器暂不支持项目分派：${unsupported.join('、')}`,400);
      // 窗口 Agent 不像 CLI 那样在项目目录里跑，它把同一段任务发进你指定的外部窗口；
      // 因此与其它 Agent 一起分派时必须明确目标是哪个窗口。
      let windowTarget=null;
      if(wanted.includes('window')){
        const handle=Number(input?.window?.handle);
        if(!Number.isSafeInteger(handle)||handle<=0)throw workError('使用窗口 Agent 分派时，请先选择要接管的窗口',400);
        windowTarget={
          handle,
          ...(typeof input.window.process==='string'&&input.window.process.trim()?{process:input.window.process.trim()}:{}),
          ...(typeof input.window.title==='string'&&input.window.title.trim()?{windowTitle:input.window.title.trim()}:{})
        };
      }
      if(wanted.length>1&&wanted.includes('window'))throw workError('窗口 Agent 不能和其它 Agent 并行执行同一条任务',400);
      // 一次分派 = 一个 Lagent 会话；宿主对话显示在项目页，各协作 Agent 只留隐藏执行对话。
      const stamp=Date.now().toString(36);
      const created=conversations.create({id:`conv-dispatch-${stamp}`,title:text,goal:text,projectId,agentIds:wanted});
      const conversation=conversations.getRaw(created.id);
      const host=projects.createChat(projectId,{executorId:LAGENT_EXECUTOR_ID,title:text,conversationId:conversation.id}).chat;
      if(windowTarget){
        projects.createChat(projectId,{executorId:'window',...windowTarget,conversationId:conversation.id,hidden:true,title:`${text.slice(0,40)} · 窗口`});
      }
      const result=startManagedTurn(conversation,{
        text,
        mode:'review',
        agentIds:wanted,
        clientRequestId:typeof input?.clientRequestId==='string'?input.clientRequestId.trim():'',
        autoRun:input?.autoRun!==false
      });
      db.put('project-chat',{...projects.getChat(host.id),lastTicketId:result.tickets.at(-1)?.id||null,updatedAt:now()});
      return {project:projects.getProject(projectId),tickets:result.tickets,conversationId:conversation.id,chatId:host.id};
    },
    teamworkStart(projectId,input){
      if (managedProjectChats) assertLagentReady();
      const project=projects.getProject(projectId);
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>600)throw workError('协作目标须为 1–600 字',400);
      const requested=Array.isArray(input?.executorIds)?input.executorIds:[];
      const wanted=[...new Set(requested.map(item=>String(item??'').trim()).filter(Boolean))];
      if(!wanted.length)throw workError('请选择参与协作的 Agent',400);
      if(wanted.length>3)throw workError('一次最多 3 个 Agent 参与协作',400);
      const unsupported=wanted.filter(id=>!PROJECT_CHAT_EXECUTORS.includes(id)||id==='window');
      if(unsupported.length)throw workError(`这些执行器不支持项目内协作：${unsupported.join('、')}`,400);
      teamwork.writeSkeleton(project.path);
      const id=`tw-${Date.now().toString(36)}-${randomUUID().slice(0,6)}`;
      const parts=[];
      const tickets=[];
      teamwork.TEAMWORK_PARTS.forEach((part,index)=>{
        const executorId=wanted[index%wanted.length];
        const existing=projects.listChats(projectId).find(chat=>chat.executorId===executorId&&chat.source!=='imported'&&/^协作 · /.test(chat.title));
        const chat=existing||api.createProjectChat(projectId,{executorId,title:`协作 · ${part.name}`}).chat;
        // 团队协作的每个部件是底层执行，不再各自开一个受管回合；
        // 整个协作任务本身仍要求 Lagent 就绪（入口已校验）。
        const ticket=api.command({
          text:teamwork.teamworkTaskText({part,goal,executorName:executorId}),
          executorId,
          projectChatId:chat.id,
          clientRequestId:`teamwork-${id}-${part.id}`
        });
        parts.push({id:part.id,name:part.name,file:part.file,global:part.global,executorId,chatId:chat.id,ticketId:ticket.id});
        tickets.push(ticket);
      });
      const record={id,projectId,goal,parts,status:'running',outputPath:null,bytes:0,assembledAt:null,problems:[],createdAt:now(),updatedAt:now()};
      db.put('teamwork',record);
      audit(null,'teamwork-start','engine','accepted',`${parts.length} 个部分`);
      return {teamwork:teamworkView(record),tickets};
    },
    teamworkList(projectId){return teamworkRecords(projectId).slice(0,20).map(teamworkView);},
    teamworkGet(id){
      const record=db.get('teamwork',id);
      if(!record)throw workError('协作任务不存在',404);
      return teamworkView(record);
    },
    teamworkAssemble(id){
      const record=db.get('teamwork',id);
      if(!record)throw workError('协作任务不存在',404);
      const project=projects.getProject(record.projectId);
      const {files,problems}=teamwork.inspectParts(project.path);
      if(problems.length){
        const next={...record,problems,status:'blocked',updatedAt:now()};
        db.put('teamwork',next);
        return {ok:false,problems,teamwork:teamworkView(next)};
      }
      const title=`协作游戏 · ${record.goal}`;
      const agents=record.parts.length?new Set(record.parts.map(part=>part.executorId)).size:0;
      const html=teamwork.buildGameHtml({title,files,agents});
      const target=path.join(project.path,teamwork.TEAMWORK_DIR,'index.html');
      fs.writeFileSync(target,html,'utf8');
      const next={...record,status:'assembled',outputPath:`${teamwork.TEAMWORK_DIR}/index.html`,bytes:Buffer.byteLength(html),assembledAt:now(),problems:[],updatedAt:now()};
      db.put('teamwork',next);
      audit(null,'teamwork-assemble','engine','accepted',`${next.bytes} 字节`);
      return {ok:true,outputPath:target,relativePath:next.outputPath,bytes:next.bytes,teamwork:teamworkView(next)};
    },
    teamworkRetry(id,partId){
      const record=db.get('teamwork',id);
      if(!record)throw workError('协作任务不存在',404);
      const index=record.parts.findIndex(part=>part.id===partId);
      if(index<0)throw workError('没有这一份',404);
      const part=record.parts[index];
      const def=teamwork.TEAMWORK_PARTS.find(item=>item.id===part.id);
      if(!def)throw workError('这份职责已不在契约里',400);
      const project=projects.getProject(record.projectId);
      const chat=projects.listChats(record.projectId).find(item=>item.id===part.chatId)
        || projects.listChats(record.projectId).find(item=>item.executorId===part.executorId&&/^协作 · /.test(item.title))
        || api.createProjectChat(record.projectId,{executorId:part.executorId,title:`协作 · ${def.name}`}).chat;
      const attempt=Number(part.attempts||1)+1;
      const ticket=api.command({
        text:teamwork.teamworkTaskText({part:def,goal:record.goal,executorName:part.executorId}),
        executorId:part.executorId,
        projectChatId:chat.id,
        clientRequestId:`teamwork-${id}-${def.id}-r${attempt}`
      });
      const parts=record.parts.map(item=>item.id===part.id?{...item,chatId:chat.id,ticketId:ticket.id,attempts:attempt}:item);
      const next={...record,parts,status:'running',problems:[],updatedAt:now()};
      db.put('teamwork',next);
      audit(null,'teamwork-retry','engine','accepted',`${def.name} 第 ${attempt} 次`);
      return {teamwork:teamworkView(next),ticket};
    },
    projectChatTickets(chatId){
      const chat=projects.getChat(chatId);
      return db.list('ticket')
        .filter(ticket=>ticket.projectChatId===chat.id)
        .sort((left,right)=>String(left.createdAt).localeCompare(String(right.createdAt)));
    },
    // ── 会话 API ───────────────────────────────────────────────
    listConversations(limit){return {conversations:listConversationSummaries(limit)};},
    getConversation(id){
      const row=conversations.getRaw(id);
      const summary=conversationSummary(row);
      const full=conversations.get(id);
      return {conversation:{...summary,turns:full.turns},tickets:conversationTickets(row)};
    },
    createConversation(input={}){
      if(typeof input?.projectId==='string'&&input.projectId.trim())projects.getProject(input.projectId.trim());
      const created=conversations.create(input||{});
      return {conversation:conversationSummary(conversations.getRaw(created.id))};
    },
    // ── 报告中心：结论与产物的聚合投影，工单页仍负责执行记录与审批 ──
    listReports(input={}){return reportCenter.list(input||{});},
    getReport(id){return reportCenter.detail(id);},
    reportMarkdown(id){return reportCenter.markdown(id);},
    // 报告全文：直接读原始报告行，和会话结论共用同一套 artifacts 优先级。
    reportText(id){
      const report=db.get('report',id);
      if(!report)throw workError('报告不存在',404);
      return {ticketId:report.ticketId||null,text:reportTextOfReport(report)};
    },
    renameConversation(id,input){return {conversation:conversationSummary(conversations.getRaw(conversations.rename(id,input).id))};},
    deleteConversation(id){
      const result=conversations.remove(id);
      // 工单不跟着删：解开会话归属后仍可在工单页查到执行记录与证据。
      for(const ticketId of result.ticketIds){
        const stored=db.get('ticket',ticketId);
        if(!stored)continue;
        const next={...stored};
        delete next.conversationId;
        delete next.turnId;
        delete next.agentId;
        delete next.role;
        db.put('ticket',next);
      }
      return {id:result.id,ticketIds:result.ticketIds};
    },
    async conversationMessage(id,input={}){
      const row=conversations.getRaw(id);
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      // multi 是当前界面的「多 Agent」；plan/review 保留给旧调用与历史会话。
      const mode=['auto','plan','review','multi'].includes(input?.mode)?input.mode:'auto';
      // 主控始终在名单里：前端传外部 Agent 时自动补上 Lagent，不能出现「绕过主控」的回合。
      let agentIds=normalizeManagedAgents(Array.isArray(input?.agentIds)?input.agentIds:[]);
      if(!agentIds.length)agentIds=normalizeManagedAgents(row.participants||[]);
      if(!agentIds.length)throw workError('请至少选择一个 Agent',400);
      const settings=normalizeCommandSettings(input?.settings);
      // 按 Agent 的强度映射：键只保留本轮参与者，非法档位直接 400。
      const efforts=normalizeEfforts(input?.efforts,agentIds);
      const executorInputs=input?.executorInputs&&typeof input.executorInputs==='object'&&!Array.isArray(input.executorInputs)?input.executorInputs:{};
      const models=input?.models&&typeof input.models==='object'&&!Array.isArray(input.models)?input.models:{};
      let suggestedSteps=[];
      if(mode==='plan'&&agentIds.some(id=>id!==LAGENT_EXECUTOR_ID)){
        try{
          const suggestion=await api.suggestPlan({goal:text,executors:agentIds,...(row.projectId?{projectId:row.projectId}:{})});
          suggestedSteps=Array.isArray(suggestion?.steps)?suggestion.steps:[];
        }catch{/* 规划器不可用时退回通用分工，不能让主控缺席。 */}
      }
      return startManagedTurn(row,{text,mode,agentIds,settings,efforts,models,executorInputs,suggestedSteps,
        clientRequestId:typeof input?.clientRequestId==='string'?input.clientRequestId.trim():'',
        autoRun:input?.autoRun!==false});
    },
    conversationSynthesize(id,turnId,input={}){
      const row=conversations.getRaw(id);
      const turn=(row.turns||[]).find(item=>item.id===turnId);
      if(!turn)throw workError('轮次不存在',404);
      // 汇总者永远是 Lagent。旧调用可能指定了别的 Agent，这里忽略并记录主控。
      assertLagentReady();
      const agentId=LAGENT_EXECUTOR_ID;
      const sections=(turn.runs||[]).map(run=>{
        const body=conversationRunReport(run.ticketId);
        return `【${run.agentId}】\n${(body||'（没有留下结论）').slice(0,1200)}`;
      }).join('\n\n');
      const prompt=sliceText(`你是 Lagent，交叉验证的汇总者。同一问题由多个 Agent 独立作答。请比较它们的结论：列出一致点、分歧点与各自依据，指出谁遗漏了什么，最后给出你的判断与建议。\n\n问题：\n${turn.prompt}\n\n${sections}`,2900);
      const ticket=dispatchConversationRun(row,agentId,prompt,{turnId,role:'synthesis',clientRequestId:`synth-${turnId}`.slice(0,120)});
      conversations.setSynthesis(row.id,turnId,{ticketId:ticket.id,agentId});
      return {conversation:conversationSummary(conversations.getRaw(row.id)),ticket};
    },
    // 浏览器把旧 localStorage 分组一次性上报，转成服务端会话；重复上报不会重复建。
    importConversations(input={}){
      const groups=Array.isArray(input?.groups)?input.groups.slice(0,50):[];
      let imported=0;
      for(const group of groups){
        if(!group||typeof group.id!=='string'||typeof group.prompt!=='string')continue;
        const conversationId=`conv-${group.id}`.slice(0,120);
        try{conversations.getRaw(conversationId);continue;}catch{/* 不存在才导入。*/}
        try{
          const agentIds=(Array.isArray(group.agentIds)?group.agentIds:[]).filter(id=>typeof id==='string'&&id.trim()).map(id=>id.trim()).slice(0,4);
          const ticketIds=(Array.isArray(group.ticketIds)?group.ticketIds:[]).filter(id=>typeof id==='string'&&id.trim()).map(id=>id.trim()).slice(0,8);
          conversations.create({id:conversationId,title:group.prompt,goal:group.prompt,agentIds});
          const turnId=`turn-import-${group.id}`.slice(0,120);
          const runs=ticketIds.map((ticketId,index)=>({ticketId,agentId:agentIds[index]||'lagent',role:'answer'}));
          if(runs.length)conversations.addTurn(conversationId,{id:turnId,prompt:group.prompt,mode:'review',agentIds,runs});
          if(runs.length&&typeof group.synthesisTicketId==='string'&&group.synthesisTicketId.trim()){
            conversations.setSynthesis(conversationId,turnId,{ticketId:group.synthesisTicketId.trim(),agentId:typeof group.synthesisAgentId==='string'?group.synthesisAgentId.trim():''});
            linkConversationTicket({id:group.synthesisTicketId.trim()},conversationId,turnId,group.synthesisAgentId||'lagent','synthesis');
          }
          for(const run of runs)linkConversationTicket({id:run.ticketId},conversationId,turnId,run.agentId,'answer');
          imported++;
        }catch{/* 单组失败不影响其它组。*/}
      }
      return {imported,conversations:listConversationSummaries(60)};
    },
    command(input){
      const trigger=manualTrigger(input);
      const requestedExecutor=typeof input?.executorId==='string'&&input.executorId.trim()?input.executorId.trim():'';
      // 外部作用域令牌通常只知道项目，不认识具体对话；这里允许只传 projectId，
      // 自动落到该项目最近使用的对话上。没有显式执行器时沿用该对话绑定的执行器。
      let projectChatId=input?.projectChatId;
      let inferredExecutor='';
      if(!projectChatId&&typeof input?.projectId==='string'&&input.projectId.trim()){
        const target=db.get('project',input.projectId.trim());
        if(!target)throw workError('工作文件夹不存在',404);
        // 外部调用通常只知道项目：优先落到 Lagent 主持的用户会话，
        // 不能命中会话内部由系统创建的 hidden 执行子会话。
        const candidates=projects.listChats(target.id).filter(chat=>chat.hidden!==true);
        const chat=(requestedExecutor?candidates.find(item=>item.executorId===requestedExecutor):null)
          ||candidates.find(item=>item.executorId===LAGENT_EXECUTOR_ID)
          ||candidates[0];
        if(!chat)throw workError('该项目还没有可用的对话，请先在项目页创建对话或传入 projectChatId',400);
        projectChatId=chat.id;
        if(!requestedExecutor)inferredExecutor=chat.executorId;
      }
      const activeId=requestedExecutor||inferredExecutor||executorId(input?.executorId);
      const active=executors.requireAvailable(activeId);
      // 旁路收紧：外部 CLI 必须在会话或项目对话里执行，由 Lagent 拆分与汇总。
      // 工具类执行器（分析/终端/浏览器/GitHub）与内置 Lagent 仍保留直连。
      // 自动选中的项目对话同样算受管上下文。
      const hasManagedContext=Boolean(
        (typeof input?.conversationId==='string'&&input.conversationId.trim())
        ||(typeof projectChatId==='string'&&projectChatId.trim())
      );
      if(active.kind==='cli'&&activeId!==LAGENT_EXECUTOR_ID&&!hasManagedContext&&env.LAGENT_ALLOW_UNMANAGED_EXTERNAL!=='1'){
        const error=workError('外部 Agent 必须在 Lagent 会话或项目对话里执行，请先创建会话并由 Lagent 派活',409);
        error.code='LAGENT_REQUIRED';
        throw error;
      }
      guard(activeId,null,'command');
      const project=projectContext(projectChatId);
      // 项目对话默认绑定一个执行器，但项目会话里的每条任务都可以临时换人；
      // 只允许切换到项目白名单里的非窗口执行器，窗口会话仍需原绑定。
      let projectChatView=project?.chat||null;
      if(project&&project.chat.executorId!==activeId){
        if(input?.executorSwitch!==true||activeId==='window'||!PROJECT_CHAT_EXECUTORS.includes(activeId))throw workError('项目对话绑定的执行器不匹配',409);
        projectChatView={...project.chat,executorId:activeId,sessionId:(project.chat.sessions||{})[activeId]||''};
      }
      // 没有显式选择时使用当前配置档的工作方式；显式选择永远优先。
      const settings=normalizeCommandSettings(input?.settings)||profileDefaultsFor(activeId,active,project);
      if(settings&&project&&settings.permission)throw workError('项目对话的权限请在对话设置里修改',400);
      if(settings&&!project&&settings.profileId&&activeId!=='model')throw workError('只有内置 Agent 支持模型配置档案',400);
      if(settings&&!project&&settings.model&&active.kind!=='cli')throw workError('只有外部 CLI 支持 model 参数',400);
      if(settings&&!project&&settings.effort&&activeId!=='model'&&active.kind!=='cli')throw workError('该执行器不支持思考强度',400);
      if(settings&&!project&&settings.permission&&activeId!=='model'&&active.kind!=='cli')throw workError('该执行器不支持设置工作权限',400);
      if(!project&&input?.executorInput&&typeof input.executorInput==='object'){
        for(const key of ['workspace','resume','write'])if(key in input.executorInput)throw workError('只有项目对话可以指定工作目录、续接会话或写入模式',400);
      }
      let projectInput=null;
      let rawInput=input?.executorInput;
      if(project){
        const options=settings?{...(input?.executorInput&&typeof input.executorInput==='object'?input.executorInput:{}),...(settings.profileId?{profileId:settings.profileId}:{}),...(settings.model?{model:settings.model}:{}),...(settings.effort?{effort:settings.effort}:{})}:input?.executorInput;
        projectInput=projectExecutorInput(projectChatView||project.chat,project.project,trigger.text,options,active);
      }else if(settings){
        // 非项目对话：把选择合并成执行器输入，后续重试复用同一份冻结输入。
        const base=input?.executorInput&&typeof input.executorInput==='object'?input.executorInput:{};
        const prompt=typeof base.prompt==='string'&&base.prompt.trim()?base.prompt:trigger.text;
        rawInput=activeId==='model'
          ?{...base,prompt,...(settings.profileId?{profileId:settings.profileId}:{}),...(settings.effort?{effort:settings.effort}:{}),...(settings.permission?{permission:settings.permission}:{})}
          :{...base,prompt,...(settings.model?{model:settings.model}:{}),...(settings.effort?{effort:settings.effort}:{}),...(settings.permission?{write:settings.permission!=='read'}:{})};
      }
      // 非项目对话没有工作目录，但仍要遵守配置档里的工作约定（额度、审查口径、禁止项）。
      if(!project&&(activeId==='model'||['cli','model'].includes(active.kind))){
        const libraryBlock=buildLibraryContext(activeLibrary(),{executorId:activeId});
        // 非项目会话没有工作目录，只带全局技能。
        const globalSkills=activeId==='model'?modelSkillIndex(''):[];
        // 没有要补充的内容时保持原输入不变，让执行器继续用自己的指令文本兜底。
        if(libraryBlock||globalSkills.length){
          let base=rawInput&&typeof rawInput==='object'&&!Array.isArray(rawInput)?rawInput:{};
          if(libraryBlock){
            const prompt=typeof base.prompt==='string'&&base.prompt.trim()?base.prompt:trigger.text;
            base={...base,prompt:`${libraryBlock}\n${prompt}`};
          }
          if(globalSkills.length)base={...base,skills:globalSkills};
          rawInput=base;
        }
      }
      const executorInput=project
        ?normalizeExecutorInput(activeId,active,projectInput,trigger.text)
        :normalizeExecutorInput(activeId,active,rawInput,trigger.text);
      enforceBrowserHost(activeId, executorInput, policy.limits?.browserHosts);
      const verify=normalizeVerify(input?.verify);
      const contract=normalizeContract(input?.contract);
      const origin=input?.origin==='mcp'?'mcp':'ui';
      const preview=buildPreview({executor:active,executorInput,project:project?.project,fallbackText:trigger.text});
      const prior=trigger.clientRequestId&&db.list('ticket').find(t=>store.get('work-control',t.id)?.clientRequestId===trigger.clientRequestId);
      if(prior){
        const control=store.get('work-control',prior.id);
        if((control?.executor||'terminal')!==activeId||control?.command!==trigger.text||(control?.projectChatId??null)!==(project?.chat.id??null)||!sameValue(control?.executorInput,executorInput))throw workError('此请求编号已用于不同指令或执行器，请使用新的 clientRequestId',409);
        return publicTicket(prior);
      }
      const stamp=now();
      const cli=['cli','model'].includes(active.kind);
      // 策略没有要求先批准时直接开跑；高风险动作（窗口键入等）始终先确认。
      const auto=policy.requireApproval!==true&&preview.risk!=='high'&&!(origin==='mcp'&&preview.risk!=='low');
      // 内置模型 Agent 的能力取决于权限模式，文案不能说「只读」。
      const modelCopy=executorInput?.write===true?'执行中（会在项目目录内读写文件）':'执行中（只读项目文件）';
      const confirmCopy=preview.risk==='high'?previewQuestion(active.name,preview):activeId==='browser'?'请确认受控浏览器读取后批准执行':activeId==='github'?'请确认 GitHub 只读查询后批准执行':activeId==='terminal'?'请确认终端命令后批准执行':activeId==='model'?modelCopy:cli?'请确认只读 CLI 任务后批准执行':'请确认执行此任务';
      // 标题只取第一行：把整段多行需求塞进标题会让侧栏和工单卡片变成一大坨。
      const headline=trigger.text.split('\n').map(line=>line.trim()).find(Boolean)||trigger.text;
      // 会话归属：一条命令属于哪个会话、哪一轮、由哪个 Agent 作答。
      // 只做标记，不改变执行链路；没有会话的旧调用保持原样。
      const conversationId=typeof input?.conversationId==='string'&&input.conversationId.trim()?input.conversationId.trim().slice(0,120):'';
      const turnId=typeof input?.turnId==='string'&&input.turnId.trim()?input.turnId.trim().slice(0,120):'';
      const agentId=typeof input?.agentId==='string'&&input.agentId.trim()?input.agentId.trim().slice(0,60):activeId;
      const role=['synthesis','step','verify'].includes(input?.role)?input.role:'answer';
      const record={id:randomUUID(),title:(typeof input?.title==='string'&&input.title.trim()?input.title.trim():headline).slice(0,60),status:auto?'queued':'awaiting_review',stage:auto?'launch':'approval',source:'manual',executor:activeId,summary:auto?(activeId==='model'?modelCopy:activeId==='terminal'?'终端命令执行中':cli?'CLI 执行中':'执行中'):confirmCopy,attention:auto?undefined:review(preview.risk==='high'?previewQuestion(active.name,preview):reviewQuestion(activeId,project?((projectChatView?.executorId||project.chat.executorId)==='window'?'window':'write'):undefined)),createdAt:stamp,updatedAt:stamp,command:trigger.text,clientRequestId:trigger.clientRequestId,origin,executorInput,preview,...(verify?{verify}:{}),...(contract?{contract}:{}),...(project?{projectChatId:project.chat.id}:{}),...(conversationId?{conversationId,turnId:turnId||null,agentId,role}:{})};
      // P0.2：需要人工确认的工单同时生成审批记录；失败不影响工单本身。
      if(!auto){
        const approval=requestApproval({
          threadId:conversationId||record.id,
          ticketId:record.id,
          kind:'ticket',
          executor:activeId,
          title:record.title,
          summary:record.summary,
          options:['allow_once','deny'],
          risk:preview.risk,
          input:{command:trigger.text,executor:activeId,preview},
          ...(project?.project?.path?{scope:{path:project.project.path}}:{})
        });
        if(approval?.id)record.approvalId=approval.id;
      }
      // write() 返回的是 publicTicket（会剥掉 executorInput），直接执行必须用原始记录，否则会写回一份空的执行输入。
      const created=write(record);
      if(project)touchProjectChat(project.chat,{lastTicketId:created.id});
      if(project)takeGitSnapshot(created.id,project.project.path,project.project.id);
      // 直接执行：start() 会把工单推进到 working 并调用执行器；失败时保留现场让用户能看到原因。
      if(auto)try{return start(record);}catch(error){return get(created.id);}
      return created;
    },
    // Routine / 外部触发器创建「建议工单」：一定停在 awaiting_review，由人决定是否执行。
    // 与 command() 不同，这里不自动开跑，也不允许直接指定工作目录等控制字段。
    createSuggestion(input){
      const body=input && typeof input==='object'&&!Array.isArray(input)?input:{};
      const text=typeof body.text==='string'?body.text.trim():'';
      if(!text||text.length>3000)throw workError('建议内容须为 1–3000 字',400);
      const activeId=executorId(body.executorId);
      const active=executors.requireAvailable(activeId);
      guard(activeId,null,'routine');
      let chatId=typeof body.projectChatId==='string'?body.projectChatId.trim():'';
      if(!chatId&&typeof body.projectId==='string'&&body.projectId.trim()){
        const chat=projects.listChats(body.projectId.trim()).find(item=>item.executorId===activeId&&item.source!=='imported')
          ||projects.listChats(body.projectId.trim()).find(item=>item.executorId===activeId);
        if(!chat)throw workError('该项目还没有对应 Agent 的对话，请先创建项目对话',400);
        chatId=chat.id;
      }
      if(!chatId)throw workError('建议工单需要项目对话',400);
      const project=projectContext(chatId);
      if(!project)throw workError('项目对话不存在',404);
      if(project.chat.executorId!==activeId)throw workError('项目对话绑定的执行器不匹配',409);
      const clientRequestId=typeof body.clientRequestId==='string'?body.clientRequestId.trim().slice(0,200):'';
      if(clientRequestId){
        const prior=db.list('ticket').find(ticket=>store.get('work-control',ticket.id)?.clientRequestId===clientRequestId);
        if(prior)return publicTicket(prior);
      }
      const projectInput=projectExecutorInput(project.chat,project.project,text,{},active);
      const executorInput=normalizeExecutorInput(activeId,active,projectInput,text);
      enforceBrowserHost(activeId,executorInput,policy.limits?.browserHosts);
      const preview=buildPreview({executor:active,executorInput,project:project.project,fallbackText:text});
      const title=(typeof body.title==='string'&&body.title.trim()?body.title.trim():text.split('\n')[0]).slice(0,60);
      const question=(typeof body.question==='string'&&body.question.trim()?body.question.trim():`Routine「${title}」建议执行，是否批准？`).slice(0,300);
      const stamp=now();
      const record={
        id:randomUUID(),
        title,
        status:'awaiting_review',
        stage:'approval',
        source:'routine',
        executor:activeId,
        summary:'Routine 建议工单，等待人工确认',
        attention:review(question),
        createdAt:stamp,
        updatedAt:stamp,
        command:text,
        clientRequestId:clientRequestId||undefined,
        origin:'ui',
        executorInput,
        preview,
        projectChatId:project.chat.id,
        ...(typeof body.routineId==='string'&&body.routineId?{routineId:body.routineId.slice(0,100)}:{})
      };
      if(approvals){
        const approval=requestApproval({
          threadId:(typeof project.chat.conversationId==='string'&&project.chat.conversationId)||record.id,
          ticketId:record.id,
          kind:'ticket',
          executor:activeId,
          title:record.title,
          summary:question,
          options:['allow_once','deny'],
          risk:preview.risk,
          input:{command:text,executor:activeId,preview,routineId:body.routineId},
          ...(project.project.path?{scope:{path:project.project.path}}:{})
        });
        if(approval?.id)record.approvalId=approval.id;
      }
      const created=write(record);
      touchProjectChat(project.chat,{lastTicketId:created.id});
      takeGitSnapshot(created.id,project.project.path,project.project.id);
      audit(created.id,'routine-suggest',activeId,'created',clientRequestId||'');
      return created;
    },
    async suggestPlan(input){
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>4000)throw workError('计划目标须为 1–4000 字');
      if(typeof options.planner!=='function')throw workError('请先在模型设置中配置规划模型',503);
      const project=projectContext(input?.projectChatId);
      let projectRow=project?project.project:null;
      if(!project&&typeof input?.projectId==='string'&&input.projectId.trim()){
        projectRow=db.get('project',input.projectId.trim())||null;
        if(!projectRow)throw workError('工作文件夹不存在',404);
      }
      const projectChats=projectRow?projects.listChats(projectRow.id):[];
      const projectWindows=projectChats.filter(chat=>chat.executorId==='window');
      if(project&&!PROJECT_CHAT_EXECUTORS.includes(project.chat.executorId))throw workError('该执行器暂不支持项目拆解',400);
      const requested=Array.isArray(input?.executors)?new Set(input.executors.filter(id=>typeof id==='string'&&id.length<=60)):null;
      // 主控始终是规划候选，即使它不在 allowedExecutors 里；其它执行器仍按策略过滤。
      let allowedExecutors=executors.list().filter(agent=>agentUsable(agent)&&executorAllowed(agent.id)&&(!requested||requested.has(agent.id)||agent.id===LAGENT_EXECUTOR_ID)).map(agent=>agent.id);
      if(projectRow){
        const kinds=new Map(executors.list().map(agent=>[agent.id,agent.kind]));
        allowedExecutors=allowedExecutors.filter(id=>{
          if(id==='window')return projectWindows.length>0||project?.chat.executorId==='window';
          return PROJECT_CHAT_EXECUTORS.includes(id)||kinds.get(id)==='tool';
        });
      }
      if(!allowedExecutors.length)throw workError(projectRow?'项目中没有可用的 Agent':'没有可用于规划的执行器');
      const agentDescriptors=executors.list().filter(agent=>allowedExecutors.includes(agent.id)).map(({id,name,kind,capabilities})=>({id,name,kind,capabilities}));
      const nowMs=Date.now();
      while(planSuggestionTimes.length&&planSuggestionTimes[0]<=nowMs-60000)planSuggestionTimes.shift();
      if(planSuggestionTimes.length>=5)throw workError('规划请求过于频繁，请稍后再试',429);
      // 窗口枚举依赖桌面桥；桥不可用时按「没有可分发窗口」处理，不能让拆解直接 502。
      let windows=[];
      if(windowBridge){try{windows=await windowBridge.listWindows();}catch{/* 忽略窗口桥错误，继续用其余执行器规划。 */}}
      const analysis=analyzeTask({goal,executors:allowedExecutors,...(projectRow?{project:{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch}}:{}),hasWindow:windows.length>0});
      const result=await options.planner({goal,executors:allowedExecutors,agents:agentDescriptors,windows,analysis,...(projectRow?{project:{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch,memory:memory.digest(projectRow.id,{limit:5}),chats:projectChats.map(chat=>({executorId:chat.executorId,title:chat.title,window:chat.window?.process||null}))}}:{})});
      const steps=Array.isArray(result?.steps)?result.steps:[];
      if(steps.length<2||steps.length>5)throw workError('规划模型必须返回 2–5 个步骤',502);
      const allowedSet=new Set(allowedExecutors);
      const kindsOf=new Map(executors.list().map(agent=>[agent.id,agent.kind]));
      const safeSteps=steps.map((step,index)=>{
        const executor=typeof step?.executorId==='string'?step.executorId.trim():'';
        if(!allowedSet.has(executor))throw workError(`规划第 ${index+1} 步使用了不可用执行器`,502);
        if(projectRow&&!PROJECT_CHAT_EXECUTORS.includes(executor)&&kindsOf.get(executor)==='cli')throw workError(`规划第 ${index+1} 步的执行器不支持项目工作区`,502);
        const text=typeof step?.text==='string'?step.text.trim():'';
        if(!text||text.length>500)throw workError(`规划第 ${index+1} 步说明无效`,502);
        const dependsOn=step?.dependsOn===undefined?[]:step.dependsOn;
        if(!Array.isArray(dependsOn)||dependsOn.length>3||new Set(dependsOn).size!==dependsOn.length||dependsOn.some(item=>!Number.isInteger(item)||item<0||item>=index))throw workError(`规划第 ${index+1} 步依赖无效`,502);
        let executorInput;
        if(executor==='window'){
          const handle=Number(step?.executorInput?.handle);
          const target=windows.find(window=>window.handle===handle);
          if(!target)throw workError(`规划第 ${index+1} 步引用了未知窗口`,502);
          executorInput={handle,process:target.process,submit:true,...(target.title?{title:target.title}:{})};
        }else if(step?.executorInput&&typeof step.executorInput==='object'&&!Array.isArray(step.executorInput)){
          const size=JSON.stringify(step.executorInput).length;
          if(size>2000)throw workError(`规划第 ${index+1} 步的输入过大`,502);
          executorInput={...step.executorInput};
        }
        // 每一步声明要改哪些目录：写文件的重叠步骤会被串行调度，只读步骤可以并行。
        const scopeIn=Array.isArray(step?.scope)?step.scope.filter(item=>typeof item==='string'&&item.trim()&&item.length<=120).slice(0,6):[];
        const scope=scopeIn.length?scopeIn:(analysis.steps.find(item=>item.executorId===executor)?.scope||[]);
        let verify;
        if(step?.verify!==undefined){try{verify=normalizeVerify(step.verify);}catch(error){throw workError(`规划第 ${index+1} 步的验收命令无效：${error.message}`,502);}}
        let contract;
        if(step?.contract!==undefined){try{contract=normalizeContract(step.contract);}catch(error){throw workError(`规划第 ${index+1} 步的任务契约无效：${error.message}`,502);}}
        return {executorId:executor,text,...(executorInput?{executorInput}:{}),...(scope.length?{scope}:{}),...(dependsOn.length?{dependsOn:[...dependsOn]}:{}),...(verify?{verify}:{}),...(contract?{contract}:{})};
      });
      planSuggestionTimes.push(nowMs);
      audit(null,'plan/suggest','planner','suggested',`步骤 ${safeSteps.length}`);
      return {steps:safeSteps,analysis};
    },
    async analyze(input){
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>4000)throw workError('任务描述须为 1–4000 字');
      const projectChat=projectContext(input?.projectChatId);
      let projectRow=projectChat?projectChat.project:null;
      if(!projectRow&&typeof input?.projectId==='string'&&input.projectId.trim())projectRow=db.get('project',input.projectId.trim())||null;
      const available=executors.list().filter(agent=>agentUsable(agent)&&executorAllowed(agent.id)).map(agent=>agent.id);
      const requested=Array.isArray(input?.executors)?input.executors.filter(id=>typeof id==='string'):null;
      const scoped=requested&&requested.length?available.filter(id=>requested.includes(id)):available;
      const pool=scoped.length?scoped:available;
      const local=analyzeTask({goal,executors:pool,...(projectRow?{project:{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch}}:{}),hasWindow:input?.hasWindow===true});
      const availability=brain?.availability?.()||{ok:false,reason:'没有配置模型'};
      local.modelAvailable=Boolean(availability.ok);
      if(!availability.ok)return {...local,source:'local'};
      try{
        const digest=projectRow?memory.digest(projectRow.id,{limit:5}):'';
        const thought=await brain.think({goal,executors:pool,project:projectRow?{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch}:null,digest,browserHosts:policy.limits?.browserHosts||[]});
        return {
          ...local,
          source:'model',
          model:thought.model,
          understanding:thought.understanding.length?thought.understanding:local.understanding,
          thoughts:thought.notes.slice(0,4),
          toolCalls:thought.toolCalls.slice(0,8),
          steps:thought.steps
        };
      }catch(error){
        return {...local,source:'local',modelError:error?.message||'模型思考失败，已回退本地分析。'};
      }
    },
    plan(input){return startPlan(input);},
    /**
     * 把用户「说得不够细」的话改写成三份任务书，交给用户挑一份再分发。
     * 只在协作/编排入口调用；普通单 Agent 对话不该多一步确认。
     */
    async suggestPrompts(input){
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>4000)throw workError('任务描述须为 1–4000 字');
      const agentIds=Array.isArray(input?.agentIds)?input.agentIds.filter(id=>typeof id==='string'&&id.trim()).map(id=>id.trim()).slice(0,4):[];
      const projectChat=projectContext(input?.projectChatId);
      let projectRow=projectChat?projectChat.project:null;
      if(!projectRow&&typeof input?.projectId==='string'&&input.projectId.trim())projectRow=db.get('project',input.projectId.trim())||null;
      const memoryBrief=projectRow?memory.digest(projectRow.id,{limit:5}):'';
      const availability=brain?.availability?.()||{ok:false};
      if(availability.ok){
        try{
          const refined=await brain.refine({goal,agents:agentIds,memory:memoryBrief,project:projectRow?{name:projectRow.name,path:projectRow.path}:null});
          return {prompts:normalizePrompts(refined.prompts,{goal,agents:agentIds}),source:'model',model:refined.model};
        }catch(error){
          return {prompts:refineLocal({goal,agents:agentIds,memory:memoryBrief}),source:'local',modelError:error?.message||'模型改写失败，已用本地模板。'};
        }
      }
      return {prompts:refineLocal({goal,agents:agentIds,memory:memoryBrief}),source:'local'};
    },
    getPlan(id){return readPlan(id);},
    findPlan(id){const plan=db.get('plan',id);return plan?publicPlan(plan):null;},
    listPlans(limit){return db.list('plan').sort((left,right)=>String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0,Number.isSafeInteger(limit)&&limit>0?limit:20).map(publicPlan);},
    cancelPlan(id){return stopPlan(id);},
    planCompensations(id){
      if(!db.get('plan',id))throw workError('计划不存在',404);
      return listCompensations(store,id);
    },
    // 回滚不自动发生：用户明确点「回滚」后，才按逆序执行各步骤声明的补偿命令。
    async rollbackPlan(id){
      const plan=db.get('plan',id);
      if(!plan)throw workError('计划不存在',404);
      const project=plan.projectId?db.get('project',plan.projectId):null;
      const pending=listCompensations(store,id).filter(row=>row.status==='pending');
      const results=[];
      for(const row of pending){
        if(!project?.path){
          const skipped=markCompensation(store,id,row.step,'skipped','计划没有绑定项目目录');
          results.push(skipped);continue;
        }
        let result;
        try{
          result=await runVerify({verify:{command:row.command},projectPath:project.path,now});
        }catch(error){
          markCompensation(store,id,row.step,'failed',String(error?.message||'补偿命令执行失败'));
          audit(id,'plan/rollback',row.executor,'failed',row.label);
          results.push(listCompensations(store,id).find(item=>item.step===row.step));
          break; // 前一步回滚失败时停下，避免在未知状态上继续改
        }
        const done=result.status==='passed';
        const next=markCompensation(store,id,row.step,done?'done':'failed',done?'':result.output);
        audit(id,'plan/rollback',row.executor,done?'done':'failed',row.label);
        results.push(next);
        if(!done)break;
      }
      return {planId:id,results,compensations:listCompensations(store,id)};
    },
    async commander(input){
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>300)throw workError('指挥目标须为 1–300 字');
      const projectChatId=typeof input?.projectChatId==='string'?input.projectChatId.trim():'';
      const projectId=typeof input?.projectId==='string'?input.projectId.trim():'';
      const scope={...(projectChatId?{projectChatId}:{}),...(projectId&&!projectChatId?{projectId}:{})};
      const suggestion=await api.suggestPlan({goal,...scope,...(Array.isArray(input?.executors)?{executors:input.executors}:{})});
      const plan=startPlan({goal,steps:suggestion.steps,...scope,autoRun:input?.autoRun===true,clientRequestId:typeof input?.clientRequestId==='string'?input.clientRequestId:''});
      return {plan,steps:plan.steps,analysis:suggestion.analysis||null};
    },
    // 团体协作：内置模型 Agent 先理解与拆解，再把任务并行分派给所选的外部 Agent，
    // 最后由内置 Agent 收拢结果、指出下一步该转交给谁。
    async collaborate(input){
      assertLagentReady();
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>4000)throw workError('协作目标须为 1–4000 字');
      const projectChatId=typeof input?.projectChatId==='string'?input.projectChatId.trim():'';
      const projectId=typeof input?.projectId==='string'?input.projectId.trim():'';
      const scope={...(projectChatId?{projectChatId}:{}),...(projectId&&!projectChatId?{projectId}:{})};
      const profileId=typeof input?.profileId==='string'?input.profileId.trim():'';
      // 与受管会话保持一致：主控之外最多 3 个协作方，交叉验收时恰好 3 个验收依赖。
      const requested=Array.isArray(input?.agentIds)?[...new Set(input.agentIds.filter(id=>typeof id==='string'&&id.trim()&&id.trim()!=='model').map(id=>id.trim()))].slice(0,3):[];
      if(!requested.length)throw workError('团队协作至少选择一个 Agent',400);
      const models=input?.models&&typeof input.models==='object'&&!Array.isArray(input.models)?input.models:{};
      const analysis=await api.analyze({goal,executors:requested.length?requested:undefined,...scope});
      // 一次协作只开一条主对话：内置 Agent 的思考与汇总留在主对话里，其他 Agent 挂成从属会话。
      let projectRecord=null;
      if(projectChatId){const source=db.get('project-chat',projectChatId);if(source)projectRecord=db.get('project',source.projectId);}
      else if(projectId)projectRecord=db.get('project',projectId);
      let parentChatId='';
      if(projectRecord){
        const source=projectChatId?db.get('project-chat',projectChatId):null;
        parentChatId=source&&!source.parentChatId&&source.executorId==='model'
          ? source.id
          : projects.createChat(projectRecord.id,{executorId:'model',title:goal}).id;
      }
      const planned=(analysis.steps||[]).filter(step=>step.executorId&&step.executorId!=='model').slice(0,3);
      // 只给「这一轮真正参与的 Agent」派活：分析结果里可能出现没被选中的执行器
      // （模板或模型按任务猜出来的），照搬会造出「没人负责的契约文件」——
      // duo 那次 index.html 引用了 Codex 负责的 input.js、但这一轮没有 Codex，就是这么来的。
      const analysed=(analysis.steps||[]).filter(step=>step.executorId&&step.executorId!=='model');
      const chosen=requested.map((id,index)=>{
        const match=analysed.find(step=>step.executorId===id);
        return match?{...match,executorId:id}:{executorId:id,title:`执行任务第 ${index+1} 部分`,scope:[]};
      });
      const brief=[goal,...(analysis.understanding||[]).slice(0,4)].join('\n');
      // 项目协作的步骤会走 projectExecutorInput，那里已经按「执行器 + 范围」注入记忆与 Library；
      // 这里只补非项目场景，避免重复。
      const coordinatorLibrary=projectRecord?'':buildLibraryContext(activeLibrary(),{executorId:'model'});
      const others=chosen.map(step=>`${step.executorId}（${step.title}）`).join('、');
      // 项目协作先把要求落成一份「交付清单.md」：后面的 Agent 都读它，而不是各自猜范围。
      // 非项目协作没有安全的落盘位置，仍然只做口头分工。
      const hasProject=Boolean(projectRecord);
      const readOnly=readOnlyGoal(goal);
      // 只读任务即使在项目里也不建交付清单、不要求落盘；结论本身就是交付物。
      const planFiles=hasProject&&!readOnly;
      const checklistFile=planFiles?'交付清单.md':'';
      const steps=[{
        executorId:'model',
        text:`理解并拆解：${goal}`,
        executorInput:{prompt:[
          '你在一个多 Agent 团队里担任协调者，负责先把任务想清楚再分派。',
          `目标：${goal}`,
          brief&&brief!==goal?`我的初步理解：\n${brief}`:'',
          coordinatorLibrary,
          planFiles
            ? '先读项目根目录里的课程/作业要求文档（.md/.txt 直接读；.docx/.pptx 直接用 read_office{path} 读文字，不要用 PowerShell 解压），把要求整理成一份交付清单。'
            : '',
          planFiles
            ? `把清单写到项目根目录的 ${checklistFile}：逐行列出必须产出的文件或目录，并在行尾标出负责的执行器 id。只写这一份清单，不要改代码或其它文档。`
            : '这一步不要修改或创建任何文件。',
          planFiles
            ? '清单必须覆盖要求里出现的全部交付物：需求分析、数据库设计与建表 SQL（含 E-R 图）、后端代码、前端页面与样式、测试脚本与测试用例、实验报告、演示 PPT 等；材料没写清的地方按目标补全并注明假设。'
            : '',
          readOnly
            ? '原始目标要求只读：分工里不许安排写文件、不许造交付清单或报告；每个协作 Agent 的产出就是检查结论。'
            : '',
          `接下来会并行交给：${others}。`,
          '每个协作 Agent 都要独立完成一份实际工作，不能把其中某个人只安排成验收方；交叉验收由后续单独步骤完成。',
          '请先用两三句话说明你如何理解这个任务，再逐条写清每个执行者要做什么、交付什么、验收标准是什么。',
          planFiles ? '分派时把每个人要写的文件写清楚，避免两个 Agent 抢同一个文件。' : '',
          planFiles
            ? '最多读 6 个文件、写 1 份清单；工具调用不超过 10 次，然后直接写结论。'
            // 协调者容易一头扎进去通读代码，把步数烧光还没写出一句分工；给个明确的次数上限。
            : '这一步只做分工：最多翻目录、看一两个关键文件确认结构，工具调用不要超过 4 次，然后直接写结论。',
        ].filter(Boolean).join('\n\n'),...(profileId?{profileId}:{}),maxSteps:planFiles?12:6,role:'coordination'}
      }];
      chosen.forEach(step=>{
        const model=typeof models[step.executorId]==='string'?models[step.executorId].trim():'';
        // 外部 Agent 拿到的是完整任务书：目标、它的分工、别重复别人做过的、交付与证据要求。
        // 以前这里只有一行 step.title，Agent 只能靠猜，写完也不知道算不算完成任务。
        // 记忆和配置档约定按「这个 Agent + 它负责的目录」裁剪，别把别人的约束塞给它。
        const agentLibrary=projectRecord?'':buildLibraryContext(activeLibrary(),{executorId:step.executorId});
        const prompt=[
          `你是这次协作里的执行者之一，负责其中一部分。`,
          `整个任务：${goal}`,
          `你负责的部分：${step.title||'执行任务'}${Array.isArray(step.scope)&&step.scope.length?`（建议改动范围：${step.scope.join('、')}）`:''}${step.output?`\n期望产出：${step.output}`:''}`,
          planFiles
            ? `先读项目根目录的 ${checklistFile}（如果存在），只做清单里标给你的部分；清单把多组文件分给你时，按顺序全部完成。清单与建议范围冲突时，以清单为准。`
            : '',
          readOnly
            ? '原始目标要求只读：不要创建或修改任何文件，也不要按分工里的文件清单落盘；独立完成检查并给出结论即可。'
            : '',
          `同时参与的还有：${others}。只做你这一部分，不要替别人改他要负责的文件。`,
          agentLibrary,
          planFiles
            ? '做事要求：清单里的每个文件都要真实落盘，不要用一份总结文档代替代码、SQL、文档、测试或 PPT；改完确认真的生效（命令能跑通、页面能看到、语法没错）；'
            : '做事要求：先看现状再动手；改完确认真的生效（命令能跑通、页面能看到、语法没错）；',
          '最后用几句话说清：你改了哪些文件、怎么验证的、还有什么没做完。后面会有另一位 Agent 按验收标准检查你的产出。',
        ].filter(Boolean).join('\n\n');
        steps.push({
          executorId:step.executorId,
          text:step.title||'执行任务',
          ...(Array.isArray(step.scope)&&step.scope.length?{scope:step.scope}:{}),
          dependsOn:[0],
          ...(model?{executorInput:{prompt,model}}:{executorInput:{prompt}}),
        });
      });
      const workStepIndices=chosen.map((_,index)=>index+1);
      const verifyStepIndices=[];
      // 交叉验收按环状互测：每位执行者检查下一位的产出，最后由 Lagent 汇总验收结论。
      if(chosen.length>=2){
        chosen.forEach((step,index)=>{
          const target=chosen[(index+1)%chosen.length];
          const model=typeof models[step.executorId]==='string'?models[step.executorId].trim():'';
          const library=projectRecord?'':buildLibraryContext(activeLibrary(),{executorId:step.executorId});
          const prompt=[crossTestPrompt(goal,step.executorId,target.executorId),library].filter(Boolean).join('\n\n');
          verifyStepIndices.push(steps.length);
          steps.push({
            executorId:step.executorId,
            text:`交叉验收：${target.executorId} 的工作`,
            role:'verify',
            dependsOn:[0,workStepIndices[(index+1)%chosen.length]],
            ...(model?{executorInput:{prompt,model}}:{executorInput:{prompt}}),
          });
        });
      }
      const crossTested=verifyStepIndices.length>0;
      steps.push({
        executorId:'model',
        text:'汇总结果与下一步',
        dependsOn:crossTested?verifyStepIndices:workStepIndices,
        executorInput:{prompt:[
          '你是团队的协调者。前面几位 Agent 已经把结果交回给你（见上方材料）。',
          crossTested
            ? '材料里包含执行结果和交叉验收记录：先看验收方指出的问题，判断哪些必须修、哪些只是建议。'
            : '',
          planFiles
            ? `先读项目根目录的 ${checklistFile}，并用 list_files 核对清单里的文件是否都存在。`
            : '如果目标里点名了具体文件（比如 index.html、game.js），先列目录确认它们都在；只读任务不要求落盘。',
          readOnly
            ? '原始目标要求只读：不要因为“没有生成脚本/报告文件”判失败，结论本身就是交付物；也不要重新执行整个任务，基于材料汇总即可。'
            : '',
          planFiles
            ? '不要逐份通读已经存在的文档或代码：列一次目录、确认缺哪些文件后，直接把缺的写出来，把步数留给落盘。'
            : '',
          planFiles
            ? '缺 README.md、实验报告、演示 PPT 时优先补这三样：README 写部署与演示步骤；实验报告按课程格式写完整正文；PPT 写 10~12 页逐页大纲，本机有 python-pptx 就生成 .pptx。'
            : '',
          planFiles
            ? '属于你的汇总职责之外、但清单里缺失且你能补的文件，直接补写；补不了的逐条列出，不要笼统说"完成了"。'
            : '缺了必须写明缺哪个，不要笼统说"完成了"；没有要求落盘时不要创建文件。',
          crossTested
            ? '逐路写出验收结论（通过 / 有条件通过 / 不通过），把仍未解决的冲突和风险单列出来。'
            : '这一轮只有一位协作 Agent，没有交叉验收；请你顺便按分工里的验收标准复核它的产出。',
          '请写一份团队汇总：每个人做了什么、结果是否达成目标、还有什么没做完或不可靠，',
          '并明确「下一步建议交给谁、做什么」，方便继续分派。只依据给定材料，不要编造。',
        ].filter(Boolean).join('\n'),...(profileId?{profileId}:{}),...(planFiles?{maxSteps:60}:{maxSteps:10}),role:'synthesis'}
      });
      const plan=startPlan({goal,steps,managed:true,...scope,...(parentChatId?{parentChatId}:{}),autoRun:input?.autoRun===true,clientRequestId:typeof input?.clientRequestId==='string'?input.clientRequestId:''});
      // 一次协作只对应一个 Lagent 会话：所有步骤（含协调者与各 Agent）都挂在这一轮里。
      let conversationId='';
      try{
        const turnId=`turn-collab-${plan.id}`;
        const created=conversations.create({id:`conv-collab-${plan.id}`,title:goal,goal,...(projectRecord?{projectId:projectRecord.id}:{}),agentIds:requested});
        conversationId=created.id;
        const runs=(plan.steps||[]).filter(step=>step.ticketId).map(step=>({ticketId:step.ticketId,agentId:step.executorId||'lagent',role:step.role||'step'}));
        if(runs.length)conversations.addTurn(conversationId,{id:turnId,prompt:goal,mode:'multi',agentIds:requested,runs});
        for(const run of runs)linkConversationTicket(run,conversationId,turnId,run.agentId,run.role);
        // 主对话就是这个会话的入口：项目页只显示它，从属对话已被标成隐藏。
        if(parentChatId){
          const host=db.get('project-chat',parentChatId);
          if(host&&!host.conversationId)db.put('project-chat',{...host,conversationId,updatedAt:now()});
        }
      }catch{/* 会话落库失败不影响已创建的计划。*/}
      return {plan,steps:plan.steps,analysis,mainChatId:parentChatId||null,conversationId:conversationId||null};
    },
    commanderReport(id){return commanderReport(id);},    planSheet(id){return planSheet(id);},
    // 交互授权：界面点了「允许一次 / 拒绝」后，把决定转给当前执行器的挂起请求。
    permissionDecision(ticketId,requestId,decision){
      if(decision!=='allow'&&decision!=='deny')throw workError('授权决定只能是 allow 或 deny',400);
      const ticket=db.get('ticket',ticketId);
      if(!ticket)throw workError('工单不存在',404);
      const assignment=latest(ticket.id);
      if(!assignment)throw workError('这条工单还没有执行记录',409);
      const active=executorFor(assignment);
      if(typeof active?.resolvePermission!=='function')throw workError('当前执行器不支持交互授权',400);
      const task=active.get?.(assignment.sessionId)||taskFor(ticket.id);
      if(!task)throw workError('执行任务已经结束',409);
      const resolved=active.resolvePermission(task,String(requestId||''),decision);
      if(!resolved){
        // P0.2：底层请求已经失效（执行器重启/超时）时，审批也不能停在 pending 假装可处理。
        const pending=approvals?.findByRequest({ticketId:ticket.id,requestId});
        if(pending)approvals.expire(pending.id,'执行器已重启或授权请求已超时');
        throw workError('授权请求已过期',409);
      }
      const approval=approvals?.resolveByRequest({ticketId:ticket.id,requestId,decision:decision==='allow'?'allow_once':'deny',by:'desktop'})||null;
      audit(ticket.id,'permission',ticket.executor,decision,String(requestId||'').slice(0,120));
      return {ticket:get(ticket.id),...(approval?{approval}:{})};
    },
    detail(id){
      const ticket=get(id);
      const assignment=latest(id);
      const activeId=assignmentExecutorId(ticket,assignment);
      const projectChat=ticket.projectChatId?db.get('project-chat',ticket.projectChatId):null;
      const project=projectChat?db.get('project',projectChat.projectId):null;
      // 模型 Agent 的逐步过程：只有真的走过步骤时才带这个字段，普通工单的投影键集合保持不变。
      const liveTask=taskFor(id);
      const activity=Array.isArray(liveTask?.activity)?liveTask.activity.slice(-40):[];
      // 有心跳但太久没更新：界面要能区分「在跑」与「卡死」。
      const nowMs=Date.now();
      const rows=assignments(id).map(row=>{
        if(row.status!=='working')return row;
        const beat=row.heartbeatAt?Date.parse(row.heartbeatAt):0;
        return {...row,...(beat&&nowMs-beat>heartbeatStaleMs?{stalled:true}:{})};
      });
      const stalled=rows.some(row=>row.stalled);
      return {ticket:stalled?{...ticket,stalled:true}:ticket,assignments:rows,reports:related('report',id),team:projectTeamTask(taskFor(id)),...(activity.length?{activity}:{}),...(project?{project:{id:project.id,name:project.name,path:project.path,gitBranch:project.gitBranch||''},projectChat:projectChat?{id:projectChat.id,title:projectChat.title,executorId:projectChat.executorId}:null}:{})};
    },
    reviewTeamNode(id,nodeId,decision){return mutateTeam(id,task=>reviewTeamNode(task,nodeId,decision));},
    // 一条工单的完整时间线：执行、报告、用量、事件按时间排序，失败时能直接定位到哪一步。
    ticketTrace(id){
      const ticket=get(id);
      const assignments=related('assignment',id);
      const reports=related('report',id);
      const usageRows=store.list('work-usage').filter(row=>row.ticketId===id);
      const events=store.list('work-event').filter(row=>row.ticketId===id);
      const spans=[];
      for(const row of assignments){
        const started=row.startedAt||row.createdAt||'';
        const ended=row.endedAt||null;
        spans.push({kind:'assignment',id:row.id,executor:row.executor,status:row.status,at:started,endedAt:ended,durationMs:ended&&started?Math.max(0,Date.parse(ended)-Date.parse(started)):null});
      }
      for(const row of reports)spans.push({kind:'report',id:row.id,reportKind:row.kind,summary:row.summary,at:row.createdAt});
      for(const row of usageRows)spans.push({kind:'usage',id:row.id,executorId:row.executorId,calls:row.calls||0,tokens:row.totalTokens||0,cost:row.costEstimate||0,at:row.recordedAt});
      for(const row of events)spans.push({kind:'event',id:row.id,eventType:row.type,at:row.createdAt});
      spans.sort((left,right)=>String(left.at||'').localeCompare(String(right.at||'')));
      const ended=ticket.updatedAt||null;
      const startedAt=ticket.createdAt||null;
      return {
        ticket,
        spans,
        summary:{
          startedAt,
          endedAt:ended,
          durationMs:startedAt&&ended?Math.max(0,Date.parse(ended)-Date.parse(startedAt)):null,
          assignments:assignments.length,
          reports:reports.length,
          events:events.length,
          calls:usageRows.reduce((sum,row)=>sum+(Number.isSafeInteger(row.calls)?row.calls:0),0),
          tokens:ticketTokensUsed(store,id),
          cost:Math.round(usageRows.reduce((sum,row)=>sum+(Number.isFinite(row.costEstimate)?row.costEstimate:0),0)*10000)/10000
        }
      };
    },
    decideTeamProposal(id,nodeId,proposalId,decision){return mutateTeam(id,task=>decideTeamProposal(task,nodeId,proposalId,decision));},
    handoff(sourceId,input){
      const source=get(sourceId);
      if(source.handoffChildId){
        const child=db.get('ticket',source.handoffChildId);
        if(!child)throw workError('交接子工单快照不可用',409);
        return {created:false,ticket:publicTicket(child)};
      }
      if(source.status!=='completed')throw workError('只有已完成工单可以交接',409);
      if(source.handoffDepth>=3)throw workError('交接深度已达到上限',409);
      if(!input||typeof input!=='object'||Array.isArray(input))throw workError('交接参数必须为对象');
      if(input.executorId===undefined||input.executorId===null)throw workError('交接必须显式指定 executorId');
      const targetId=executorId(input.executorId);
      const target=executors.requireAvailable(targetId);
      guard(targetId,sourceId,'handoff');
      const handoff=normalizeHandoff(input.handoff);
      const baseText=typeof input.text==='string'&&input.text.trim()?input.text.trim():source.title;
      const brief=handoffBrief(handoff,{sourceTitle:source.title,sourceSummary:source.summary});
      const promptText=brief?`${baseText}\n\n${brief}`:baseText;
      const frozenInput=normalizeExecutorInput(targetId,target,input.executorInput,promptText);
      const titleFor=sourceTicket=>{
        if(input.text===undefined)return typeof sourceTicket.title==='string'?sourceTicket.title.slice(0,100):'交接工单';
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>3000)throw workError('交接 text 必须是非空字符串且不超过 3000 字');
        return input.text.trim().slice(0,100);
      };
      titleFor(source);
      const result=db.transaction(transaction=>{
        const storedSource=transaction.get('ticket',sourceId);
        if(!storedSource)throw workError('工单不存在',404);
        const storedControl=transaction.get('control',sourceId);
        const current=publicTicket({...storedSource,...storedControl});
        if(current.handoffChildId){
          const child=transaction.get('ticket',current.handoffChildId);
          if(!child)throw workError('交接子工单快照不可用',409);
          return {created:false,ticket:publicTicket(child)};
        }
        if(current.status!=='completed')throw workError('只有已完成工单可以交接',409);
        const depth=Number.isSafeInteger(current.handoffDepth)?current.handoffDepth:0;
        if(depth>=3)throw workError('交接深度已达到上限',409);
        const stamp=now();
        const title=titleFor(current);
        const preview=buildPreview({executor:target,executorInput:frozenInput,project:projectByPath(frozenInput?.workspace)||null,fallbackText:title});
        const child=publicTicket({
          id:randomUUID(),
          title,
          status:'awaiting_review',
          stage:'approval',
          source:'handoff',
          executor:targetId,
          summary:`已交接至${target.name}，等待人工确认`,
          attention:review(reviewQuestion(targetId)),
          createdAt:stamp,
          updatedAt:stamp,
          parentTicketId:current.id,
          chainRootId:current.chainRootId||current.id,
          handoffDepth:depth+1,
          handoffSummary:typeof current.summary==='string'?current.summary.slice(0,400):null,
          // 交接发生在同一个项目对话里：不继承 projectChatId 会让子工单脱离项目变更、
          // 项目记忆、MCP 令牌范围，删对话/删消息时也会残留。
          ...(typeof current.projectChatId==='string'&&current.projectChatId?{projectChatId:current.projectChatId}:{}),
          ...(handoff?{handoff}:{}),
          preview
        });
        transaction.put('ticket',child);
        transaction.put('ticket',{...storedSource,handoffChildId:child.id,updatedAt:stamp});
        transaction.put('control',{
          id:child.id,
          clientRequestId:undefined,
          command:title,
          lastAction:undefined,
          executor:targetId,
          executorInput:frozenInput,
          projectChatId:child.projectChatId||null
        });
        transaction.event('ticket',child);
        audit(child.id,'handoff',targetId,'created',`来源 ${current.id}`);
        return {created:true,ticket:child};
      });
      if(result.created&&approvals){
        const chat=result.ticket.projectChatId?db.get('project-chat',result.ticket.projectChatId):null;
        requestApproval({
          threadId:chat?.conversationId||result.ticket.id,
          ticketId:result.ticket.id,
          kind:'ticket',
          executor:targetId,
          title:result.ticket.title,
          summary:result.ticket.summary,
          options:['allow_once','deny'],
          risk:result.ticket.preview?.risk,
          input:{command:result.ticket.title,executor:targetId,preview:result.ticket.preview}
        });
      }
      return result;
    },
    action(id,action,input){
      const ticket=privateTicket(id),assignment=latest(id);
      if(ticket.planId){
        const plan=db.get('plan',ticket.planId);
        if(!plan)throw workError('计划不存在',404);
        if(plan.status!=='active'&&!(['retry','skip'].includes(action)&&plan.status==='failed'))throw workError('计划已结束',409);
        if(ticket.status==='waiting'&&!['resume','skip'].includes(action))throw workError('步骤依赖尚未满足',409);
        if(ticket.status==='waiting'&&action==='resume'){
          const deps=plan.steps[ticket.planStep]?.dependsOn||[];
          if(!deps.every(index=>db.get('ticket',plan.steps[index]?.ticketId)?.status==='completed'))throw workError('步骤依赖尚未满足',409);
        }
        if(action==='retry'){
          const deps=plan.steps[ticket.planStep]?.dependsOn||[];
          if(!deps.every(index=>db.get('ticket',plan.steps[index]?.ticketId)?.status==='completed'))throw workError('步骤依赖尚未满足',409);
        }
      }
      const activeId=assignmentExecutorId(ticket,assignment);
      const active=executors.resolve(activeId);
      if(!active)throw workError('执行器不存在',400);
      if(['approve','retry'].includes(action))guard(activeId,id,action);
      const task=active.get?.(assignment?.sessionId);
      // 同一个动作重复点：approve 之外大多幂等，直接返回当前状态。
      // 但「重试」要分清两种情形：还在跑的时候连点=没事发生；上一次已经失败/被挡住，再点必须真的重跑。
      const retryable = ['failed', 'blocked', 'cancelled', 'waiting'].includes(ticket.status);
      if (action !== 'retry' && ticket.lastAction === action && !(action === 'approve' && ticket.status === 'awaiting_review')) return publicTicket(ticket);
      if (action === 'retry' && ticket.lastAction === 'retry' && !retryable) return publicTicket(ticket);
      assertWorkAction(ticket.status,action);
      const next={...ticket,lastAction:action,updatedAt:now()};
      // 重试/继续表示用户撤销了上次中断：中断标记只属于那一次执行。
      if(['approve','retry'].includes(action)){delete next.interrupted;delete next.interruptedAt;}
      // 重试可以补一次回合预算：大任务第一次常被 error_max_turns 截断，
      // 只改默认值救不了已经在排队的工单，重试时应当能把上限调高再跑。
      const retryTurns=input?.maxTurns;
      if(['approve','retry'].includes(action)&&Number.isSafeInteger(retryTurns)&&retryTurns>=1&&retryTurns<=120){
        next.executorInput={...(next.executorInput&&typeof next.executorInput==='object'?next.executorInput:{}),maxTurns:retryTurns};
      }
      // 跳过这一步：计划里某一步卡死（外部 CLI 装不上、环境缺变量）时，不能把整条
      // 计划永远堵在这里。跳过等于人工判定「这步不要了」，计划继续往下走。
      if(action==='skip'){
        if(!ticket.planId)throw workError('只有计划里的步骤可以跳过',400);
        const reason=typeof input?.reason==='string'&&input.reason.trim()?input.reason.trim().slice(0,200):'已跳过这一步';
        const skipped={...next,status:'completed',attention:undefined,summary:reason};
        const run=assignment?{...assignment,status:'completed',endedAt:now()}:null;
        const result=write(skipped,...(run?[['assignment',run],['report',makeReport(skipped,run,'skipped',reason)]]:[]));
        revivePlan(ticket.planId,ticket.planStep);
        advancePlan(ticket.planId);
        return result;
      }
      if(action==='retry'&&ticket.planId)revivePlan(ticket.planId,ticket.planStep);
      if((action==='approve'&&!task)||action==='retry'){
        try{
          const result=start(next,input);
          // 旧入口点了批准：同一工单上的待审批一并结束，避免审批收件箱留下僵尸项。
          if(action==='approve')approvals?.resolveForTicket(ticket.id,'allow_once','desktop');
          return result;
        }catch(error){
          // 400 是调用参数/状态错误，继续抛出让调用方知道错了；其它错误（预算、执行器失败）落盘为 failed。
          if(error?.status===400)throw error;
          const failed={...next,status:'failed',summary:String(error?.message||'重试失败').slice(0,400),updatedAt:now(),attention:review(String(error?.message||'重试失败').slice(0,200))};
          const run=assignment?{...assignment,status:'failed',endedAt:now(),error:failed.summary}:null;
          return write(failed,...(run?[['assignment',run]]:[]),['report',makeReport(failed,assignment||{},'failed',failed.summary)]);
        }
      }
      if(action==='approve'){
        if(typeof active.approve!=='function')throw workError('该执行器不支持继续审批',409);
        // 执行器返回 false 表示挂起的确认已经失效（服务重启或任务已结束），
        // 这时不能再把工单写成 working，否则会永远卡在那里。
        if(active.approve(task,input,ticket.approvalSnapshot)===false){
          const pending=approvals?.findByRequest({ticketId:ticket.id,requestId:ticket.approvalSnapshot?.requestId});
          if(pending)approvals.expire(pending.id,'执行器已重启，审批请求已失效');
          throw workError('审批请求已失效，请先停止并重试这个工单',409);
        }
        const continued=write({...next,status:'working',stage:activeId==='terminal'?'terminal':['cli','model'].includes(active.kind)?'cli':['tool','window'].includes(active.kind)?'tool':'terminal',approvalSnapshot:undefined,attention:undefined,summary:activeId==='terminal'?'终端命令执行中':activeId==='model'?'Lagent 已继续':active.kind==='cli'?'只读 CLI 执行中':['tool','window'].includes(active.kind)?(activeId==='browser'?'浏览器执行中':activeId==='github'?'GitHub 查询中' :`${active.name}执行中`):'已继续'});
        approvals?.resolveForTicket(ticket.id,'allow_once','desktop');
        return continued;
      }
      if(action==='stop'){
        if(outboxEnabled)cancelTicketEffects(store,id,{now:Date.now()});
        // 用户中断不是失败：先协同停掉执行器（杀掉子进程、拒绝挂起的审批），
        // 再把工单标成 cancelled。stop 本身出错也不能把工单卡在 working。
        let stopError='';
        try {
          if(task&&['running','awaiting_approval'].includes(task.status))active.stop?.(task,assignment);
        } catch(error) { stopError=String(error?.message||'停止执行器失败').slice(0,200); }
        const reason=typeof input?.reason==='string'&&input.reason.trim()?input.reason.trim().slice(0,200):'';
        const summary=reason?`已按你的要求停止：${reason}`:'工单已停止（未判失败）';
        const stopped={...next,status:'cancelled',attention:undefined,summary,interrupted:true,interruptedAt:now()};
        const run=assignment?{...assignment,status:'cancelled',endedAt:now(),...(stopError?{error:stopError}:{})}:null;
        // 中断前已经产生的过程与产物要留下，否则用户只看到「已停止」，不知道停在哪。
        const artifacts=task?{
          interrupted:true,
          ...(Array.isArray(task.activity)&&task.activity.length?{activity:task.activity.slice(-20)}:{}),
          ...(task.artifacts?.cli?{cli:task.artifacts.cli}:{}),
          ...(task.artifacts?.terminal?{terminal:task.artifacts.terminal}:{}),
          ...(task.artifacts?.[activeId]?{[activeId]:task.artifacts[activeId]}:{})
        }:{ interrupted:true };
        const result=write(stopped,...(run?[['assignment',run],['report',makeReport(stopped,run,'dropped',summary,artifacts)]]:[]));
        approvals?.cancelForTicket(id,'工单已停止');
        audit(id,'stop',activeId,'cancelled',reason||'用户中断');
        if (stopped.planId && Number.isSafeInteger(stopped.planStep)) advancePlan(stopped.planId);
        return result;
      }
      if(action==='reject'){
        if(task&&typeof active.reject==='function')active.reject(task);
        // 越权访问被拒绝时任务仍在跑：带着「被拒绝」的结论继续，而不是把工单打回等待。
        const denied=Boolean(task?.accessRequest);
        const rejected=write({...next,status:denied?'working':'waiting',attention:undefined,summary:typeof input?.reason==='string'?input.reason.slice(0,400):denied?'已拒绝这次访问':'已退回，等待新指令'},...(assignment&&!denied?[['assignment',{...assignment,status:'waiting'}]]:[]));
        approvals?.resolveForTicket(ticket.id,'deny','desktop');
        return rejected;
      }
      return write({...next,status:'awaiting_review',attention:review(reviewQuestion(activeId))});
    },
    listEffects(options){return listEffects(store,options);},
    retryEffect(id){return retryEffect(store,id,{now:Date.now()});},
    // 工作区回收判定用：有工单真的在跑时不要把整个 workspace 关掉。
    hasActiveWork(){return db.list('ticket').some(ticket=>ticket.status==='working');},
    usageSummary(options){return summarizeUsage(store,{...(options||{}),budgetTokens:policy.budgets?.maxTokensPerTicket});},
    agentRoster(){
      return buildRoster({
        agents:executors.list().map(({id,name,kind,available,capabilities})=>({id,name,kind,status:(id==='model'?(available&&modelReady()?'available':'needs_setup'):(available?'available':'unavailable')),capabilities})),
        tickets:db.list('ticket'),
        usage:store.list('work-usage'),
        policy
      });
    },
    listTeamTemplates(projectId){return teamTemplates.list(projectId);},
    saveTeamTemplate(input){return teamTemplates.save(input);},
    deleteTeamTemplate(id){return teamTemplates.remove(id);},
    usageForTicket(id){return ticketTokensUsed(store,id);},
    recover(){
      // 旧的「一个 Agent 一个对话」数据在启动时归并成会话；失败不阻塞服务启动。
      try{migrateConversations();}catch(error){audit(null,'conversation-migrate','engine','failed',String(error?.message||error).slice(0,200));}
      if(outboxEnabled){
        for(const effect of recoverRunningEffects(store)){
          if(effect.status==='failed')settleLaunchFailure(effect,{code:'RECOVERY_FAILED'},'failed');
          else requeueLaunch(effect,{code:'RECOVERY_REQUEUED'});
        }
        reconcile();
        drainOutbox();
        recoverPlans();
        return;
      }
      for(const ticket of db.list('ticket').filter(t=>['working','awaiting_review'].includes(t.status))){
        const assignment=latest(ticket.id);if(!assignment)continue;
        // 中断的工单恢复时要重新拉起执行器，而执行器可能已经不在了（本机节点离线、
        // CLI 被卸载）。这类失败只能收尾那一张工单，不能让 recover 抛出——
        // 否则整个工作区都建不起来，该账号之后每个请求都只会看到这条错误。
        try{
          const active=executorFor(assignment);
          const task=active?.get?.(assignment.sessionId);
          if(task){
            sync(privateTicket(ticket.id),assignment,task);
            // resume 返回 false：执行器确认旧循环已丢失并让路，重新开跑原工单。
            if(active.resume?.(task)===false&&ticket.status==='working')start(privateTicket(ticket.id),{},assignment);
          }
          else if(ticket.status==='working')start(privateTicket(ticket.id),{},assignment);
        }catch(error){
          try{
            settleLaunchFailure({ticketId:ticket.id,payload:{assignmentId:assignment.id}},error,error?.status===400?'blocked':'failed');
          }catch(inner){audit(ticket.id,'recover','engine','failed',String(inner?.message||inner).slice(0,200));}
        }
      }
      reconcile();
      recoverPlans();
    },
    drainOutbox,
    close(){closed=true;if(outboxTimer)clearInterval(outboxTimer);unsubscribe();executors.close();}
  };
  // 团队房间依赖 api.getPlan/detail，放在 api 构造完成后接入，避免循环引用。
  const rooms = createTeamRoomService(db, { engine: api, projects, now });
  Object.assign(api, {
    listTeamRooms(projectId){return rooms.list(projectId);},
    getTeamRoom(id){return rooms.get(id);},
    createTeamRoom(input){return rooms.create(input);},
    updateTeamRoom(id,input){return rooms.update(id,input);},
    postTeamRoomMessage(id,input){return rooms.postMessage(id,input);},
    claimTeamRoomTicket(id,input){return rooms.claim(id,input);},
    decideTeamRoom(id,input){return rooms.decide(id,input);},
    deleteTeamRoom(id){return rooms.remove(id);}
  });
  return api;
}
