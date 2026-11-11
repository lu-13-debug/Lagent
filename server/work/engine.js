import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertWorkAction, workError } from './domain.js';
import { manualTrigger } from './sources/manual.js';
import { defaultPolicy, externalExecutorAllowed, normalizePolicy, PERMISSIONS, WORK_POLICY_ID } from './policy.js';
import { workStore } from './store.js';
import { executorRegistry } from './executors/index.js';
import { decideTeamProposal, projectTeamTask, reviewTeamNode, teamEventKey } from './team.js';
import { cancelTicketEffects, claimDue, complete, enqueue, fail as failOutbox, recoverRunningEffects, sanitizeOutboxError, WORK_EFFECT_KIND } from './outbox.js';
import { PROJECT_CHAT_EXECUTORS, projectService } from './projects.js';
import { createProjectMemory, summarizeExecution } from './project-memory.js';
import { isKeyChange, normalizePrompts, refineLocal } from './prompt-refiner.js';
import { analyzeTask } from './task-analyzer.js';
import * as teamwork from './teamwork.js';

const now = () => new Date().toISOString();
const review = (question, approveLabel = '批准', rejectLabel = '退回') => ({question,createdAt:now(),options:[{id:'approve',label:approveLabel,action:'approve'},{id:'reject',label:rejectLabel,action:'reject'}]});
// 越权访问的确认文案：命令类的 path 其实是命令本身。
const ACCESS_VERBS = { read: '读取', write: '写入', delete: '删除', command: '执行命令' };
const accessPrompt = request => `模型 Agent 请求${ACCESS_VERBS[request.mode] || '访问'}：${String(request.path || '').slice(0, 240)}`;
const accessReview = request => ({...review(accessPrompt(request), `允许这次${ACCESS_VERBS[request.mode] || '访问'}`, '拒绝'),kind:'access',accessMode:request.mode,accessPath:String(request.path || '').slice(0,240)});
const publicTicket = ({clientRequestId, command, lastAction, datasetId, useAI, approvalSnapshot, executorInput, artifacts, prompt, parentTicketId, chainRootId, handoffDepth, handoffSummary, handoffChildId, planId, planStep, planTotal, ...ticket}) => ({
  ...ticket,
  datasetId:datasetId??null,
  parentTicketId:parentTicketId??null,
  chainRootId:chainRootId??null,
  handoffDepth:Number.isSafeInteger(handoffDepth)&&handoffDepth>0?handoffDepth:0,
  handoffSummary:typeof handoffSummary==='string'?handoffSummary.slice(0,400):null,
  handoffChildId:handoffChildId??null,
  planId:typeof planId==='string'?planId:null,
  planStep:Number.isSafeInteger(planStep)?planStep:null,
  planTotal:Number.isSafeInteger(planTotal)?planTotal:null
});
const datasetMetadata = dataset => ({
  id: dataset.id,
  name: typeof dataset.name === 'string' ? dataset.name : '未命名数据集',
  rowCount: Number.isFinite(dataset.rowCount) ? dataset.rowCount : 0,
  source: typeof dataset.source === 'string' ? dataset.source : ''
});
const sameValue = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export function createWorkEngine(store, executor, publish = () => {}, options = {}) {
  const db = workStore(store, publish);
  const executors = executorRegistry(executor);
  const savedPolicy = store.get('work-policy', WORK_POLICY_ID);
  const savedPolicyBody = savedPolicy ? Object.fromEntries(Object.entries(savedPolicy).filter(([key]) => key !== 'id')) : null;
  let policy = normalizePolicy(options.policy || savedPolicyBody || defaultPolicy());
  const env = options.env || process.env;
  const outboxEnabled = options.outboxEnabled === true;
  const windowBridge = options.windowBridge || null;
  const projects = projectService(db, { environment: env, home: options.home });
  const memory = createProjectMemory(db);
  const brain = options.brain || null;
  const workspace = typeof options.workspace === 'string' && options.workspace ? options.workspace : null;
  // 模型 Agent 只有在配置了可用模型时才真正能干活，否则界面上应显示为待配置。
  const modelReady = () => { try { return Boolean(brain?.availability?.().ok); } catch { return false; } };
  const agentUsable = agent => Boolean(agent?.available) && (agent.id !== 'model' || modelReady());
  const planSuggestionTimes = [];
  let drainingOutbox = false;
  let outboxTimer = null;
  const audit = (ticketId, action, executorId, result, reason = '') => {
    store.put('work-audit', { id: randomUUID(), ticketId: ticketId || null, action: String(action).slice(0, 40), executor: String(executorId || '').slice(0, 40), at: now(), result: String(result).slice(0, 20), reason: String(reason).slice(0, 200) });
    for (const row of store.list('work-audit').slice(2000)) store.delete('work-audit', row.id);
  };
  const guard = (executorId, ticketId, action) => {
    if (!policy.allowedExecutors.includes(executorId) || !externalExecutorAllowed(executorId, policy, env)) {
      audit(ticketId, action, executorId, 'denied', '执行器未获当前策略允许');
      throw workError(`执行器「${executorId}」未获当前策略允许`, 403);
    }
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
  const selectedDatasetId = value => {
    if(value===undefined||value===null)return null;
    if(typeof value!=='string'||!value.trim())throw workError('datasetId 必须是非空字符串');
    return value.trim();
  };
  const executorId = value => {
    if(value===undefined||value===null)return 'analysis';
    if(typeof value!=='string'||!value.trim())throw workError('executorId 必须是非空字符串');
    return value.trim();
  };
  const requireDataset = id => {
    try {
      const dataset=store.get('dataset',id);
      if(!dataset)throw workError('数据集不存在或不属于当前工作区');
      return dataset;
    } catch(error) {
      if(error.status===400)throw workError('数据集不存在或不属于当前工作区');
      throw error;
    }
  };
  const resolveStartDataset = (ticket,input) => {
    const requested=selectedDatasetId(input?.datasetId);
    if(requested)requireDataset(requested);
    const frozen=selectedDatasetId(ticket.datasetId);
    if(frozen){
      requireDataset(frozen);
      if(requested&&requested!==frozen)throw workError('数据集已选定，不能切换');
      return frozen;
    }
    if(requested)return requested;
    const datasets=store.list('dataset');
    if(datasets.length===1)return datasets[0].id;
    if(datasets.length>1)throw workError('当前工作区有多个数据集，请明确选择 datasetId');
    return null;
  };
  const executorFor = assignment => executors.resolve(assignment?.executor || 'analysis');  const assignmentExecutorId = (ticket, assignment) => assignment?.executor || ticket?.executor || 'analysis';
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
  const projectMemoryContext = project => {
    try {
      const digest = memory.digest(project.id, { limit: 6 });
      return digest ? `【项目记忆 · 之前会话留下的结论与待办】\n${digest}` : '';
    } catch {
      return '';
    }
  };
  /**
   * 内置 Agent 把项目记忆同步给协作的外部 Agent。
   * 外部 CLI 不会自己去读记忆库，只能从提示词里拿到这一段，所以要显式带上。
   */
  const sharedMemoryBrief = project => {
    try {
      const digest = memory.digest(project.id, { limit: 6 });
      return digest ? `【项目关键改动 · 由内置 Agent 同步给你】\n${digest}` : '';
    } catch {
      return '';
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
      const lines = ['【项目现状 · 由 DataAgent 维护】', `项目：${project.name}（${project.path}）`];
      const changes = typeof projects.listChanges === 'function' ? projects.listChanges(project.id) : [];
      const recent = changes.slice(-6).reverse();
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
  const projectBriefContext = project => {
    try {
      const brief = projects.getBrief(project.id);
      const changes = projects.listChanges(project.id);
      const lines = ['【项目上下文 · 由 DataAgent 维护，供你了解项目现状】', `项目：${project.name}`, `路径：${project.path}`];
      if (project.gitBranch) lines.push(`分支：${project.gitBranch}`);
      if (brief.goal) lines.push('', `目标：${brief.goal}`);
      if (brief.summary) lines.push('', `当前进展：${brief.summary}`);
      const pushList = (title, items) => {
        const values = Array.isArray(items) ? items.filter(item => typeof item === 'string' && item.trim()) : [];
        if (!values.length) return;
        lines.push('', `${title}：`);
        for (const item of values.slice(0, 8)) lines.push(`- ${item}`);
      };
      pushList('任务要点', brief.keyPoints);
      pushList('关键决定', brief.decisions);
      pushList('约束与边界', brief.constraints);
      const recent = changes.slice(-3);
      if (recent.length) {
        lines.push('', '最近变更：');
        for (const change of recent) {
          const files = Array.isArray(change.files) ? change.files.slice(0, 6) : [];
          lines.push(`- ${change.title}${change.summary ? `：${String(change.summary).slice(0, 90)}` : ''}${files.length ? `（动了 ${files.join('、')}）` : ''}`);
        }
        lines.push('这些是别人已经改过的部分：先看清单，需要细节再用 git diff 或只读相关段落，不要整篇重读。');
        lines.push('想确认得更细，直接调 project_changes 工具（里面有文件清单和摘要），不要靠通读文件去猜。');
      }
      const digest = projectMemoryContext(project);
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
    if (!executor || executor.kind !== 'cli') throw workError('该执行器暂不支持项目对话', 400);
    const requestedTurns = Number(options?.maxTurns);
    // 项目内的一次真实改动常常要读十来个文件、改几处、再验证一次；
    // 12 个回合会在「刚开始动手」时就被 error_max_turns 掐断。
    const maxTurns = Number.isInteger(requestedTurns) && requestedTurns >= 1 && requestedTurns <= 60 ? requestedTurns : 24;
    const resuming = typeof chat.sessionId === 'string' && chat.sessionId;
    // 首条消息给完整项目简报；后续消息只带记忆摘录，避免每轮都塞大段背景。
    const context = resuming ? projectMemoryContext(project) : projectBriefContext(project);
    // 权限模式决定能不能写：会话自己设了档位就用它，否则跟随全局策略；仅查看一律只读。
    const chatPermission = PERMISSIONS.includes(chat.permission) ? chat.permission : '';
    const permission = chatPermission || (PERMISSIONS.includes(policy.permission) ? policy.permission : 'workspace');
    const isAcp = Array.isArray(executor.capabilities) && executor.capabilities.includes('acp');
    const isModel = executor?.id === 'model';
    const write = chat.writable !== false && permission !== 'read';
    // 计划步骤可以带一份已经写好的任务书（协作派单就是这么给的）；
    // 有就用它当正文，别再退回到一句标题。
    const body = typeof options?.prompt === 'string' && options.prompt.trim() ? options.prompt.trim() : text;
    return {
      prompt: context ? `${context}\n${body}` : body,
      maxTurns,
      workspace: project.path,
      write,
      // 模型 Agent 的会话级模型与思考强度：只在模型执行器上透传，其它 CLI 不认识这些键。
      ...(isModel && typeof options?.profileId === 'string' && options.profileId.trim() ? { profileId: options.profileId.trim().slice(0, 100) } : {}),
      ...(isModel && typeof options?.effort === 'string' && options.effort.trim() ? { effort: options.effort.trim().slice(0, 10) } : {}),
      // 跨目录读写：策略里登记的额外目录直接放行，其余路径按权限模式处理（工作区模式下逐次弹窗）。
      ...(isModel && Array.isArray(policy.limits?.extraRoots) && policy.limits.extraRoots.length ? { roots: [...policy.limits.extraRoots] } : {}),
      ...(isModel ? { permission, confirmDanger: permission === 'workspace' && policy.limits?.confirmDanger !== false } : {}),
      ...(resuming ? { resume: chat.sessionId } : {})
    };
  };
  // 执行前给项目工单拍一张 git 快照，执行完成后据此算出「本次真正改动的文件」。
  const takeGitSnapshot = (ticketId, projectPath) => {
    try {
      db.put('git-snapshot', { id: ticketId, files: projects.gitChangedFilesSync(projectPath), at: now() });
    } catch { /* 快照失败不影响工单创建。 */ }
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
      ? path.join(project.path, '.dataagent', 'runs')
      : path.join(os.tmpdir(), 'dataagent-runs');
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
  const stepContext = (plan, upTo) => {
    const lines = [];
    for (const step of plan.steps.slice(0, upTo)) {
      const ticket = db.get('ticket', step.ticketId);
      if (!ticket || ticket.status !== 'completed') continue;
      const reports = related('report', ticket.id);
      const report = reports[reports.length - 1];
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
      if (!body) body = summary.slice(0, 1500);
      if (!body) continue;
      lines.push(`### 第 ${step.index + 1} 步 · ${step.executorId}\n${body.slice(0, 4000)}`);
    }
    return lines.length ? `【前序步骤材料 · 由 DataAgent 汇总，供你直接使用】\n${lines.join('\n\n')}\n\n` : '';
  };
  const ensureProjectChat = (project, executorId, options = {}) => {
    const parentChatId = typeof options.parentChatId === 'string' ? options.parentChatId : '';
    const existing = projects.listChats(project.id).find(chat => chat.executorId === executorId && (chat.parentChatId || '') === parentChatId);
    if (existing) return existing;
    if (!PROJECT_CHAT_EXECUTORS.includes(executorId)) throw workError('该执行器暂不支持项目工作区', 400);
    if (executorId === 'window') throw workError('窗口 Agent 需要先在项目中创建并绑定窗口对话');
    const target = executors.requireAvailable(executorId);
    if (target.kind !== 'cli') throw workError('该执行器暂不支持项目工作区', 400);
    return projects.createChat(project.id, {
      executorId,
      ...(parentChatId ? { parentChatId } : {}),
      ...(typeof options.title === 'string' && options.title.trim() ? { title: options.title.trim().slice(0, 60) } : {})
    });
  };
  const scopedTicket = ticket => {
    if (!ticket || !ticket.projectChatId) return ticket;
    const context = projectContext(ticket.projectChatId, { required: true });
    const target = executors.resolve(ticket.executor || context.chat.executorId);
    if (!target) return ticket;
    if (target.kind === 'cli') {
      const current = ticket.executorInput && typeof ticket.executorInput === 'object' && !Array.isArray(ticket.executorInput) ? ticket.executorInput : {};
      return {
        ...ticket,
        executorInput: {
          ...current,
          prompt: typeof current.prompt === 'string' && current.prompt.trim() ? current.prompt : String(ticket.command || ''),
          workspace: context.project.path,
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
    : '请选择数据集并批准分析';
  // Control fields stay in the workspace, outside the event payload and API projection.
  const controlOf = ticket => {
    const {clientRequestId, command, lastAction, datasetId, useAI, approvalSnapshot, executor, executorInput, projectChatId}=ticket;
    return {id:ticket.id,clientRequestId,command,lastAction,datasetId:datasetId??null,useAI,approvalSnapshot,executor,executorInput,projectChatId:projectChatId??null};
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
    if(assignmentExecutorId(null, assignment) !== 'analysis') throw workError('该执行器不提供团队能力', 409);
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
  const makeReport = (ticket,assignment,kind,summary,artifacts) => ({id:randomUUID(),ticketId:ticket.id,assignmentId:assignment.id,kind,summary,artifacts,createdAt:now()});
  const launchKey = assignment => `launch:${assignment.ticketId}:${assignment.id}`;
  const launchStage = (activeId, active) => activeId==='terminal'?'terminal':active.kind==='cli'?'cli':active.kind==='tool'?'tool':'analysis';
  const launchLabel = (activeId, active) => activeId==='terminal'?'终端命令':active.kind==='cli'?'只读 CLI':active.kind==='tool'?(activeId==='browser'?'浏览器':activeId==='github'?'GitHub':active.name):'分析';
  const queuedSummary = (activeId, active) => `${launchLabel(activeId, active)}等待启动`;
  const launchInput = (ticket, payload) => ({
    datasetId:payload.datasetId??null,
    useAI:payload.useAI===true,
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
    const activeId=assignment?.executor||ticket.executor||'analysis';
    const active=executors.resolve(activeId);
    const status=forcedStatus||'failed';
    const summary=status==='blocked'?'执行器启动受阻，未进入执行':`${launchLabel(activeId,active||{name:'执行器',kind:'analysis'})}启动失败，已停止重试`;
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
    const activeId=assignment.executor||ticket.executor||'analysis';
    const active=executors.resolve(activeId)||{name:'执行器',kind:'analysis'};
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
    const activeId=assignment.executor||ticket.executor||'analysis';
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
    const working={...privateState,executor:activeId,status:'working',stage:launchStage(activeId,active),attention:undefined,summary:`${launchLabel(activeId,active)}执行中`,updatedAt:now(),datasetId:effect.payload?.datasetId??privateState.datasetId??null,useAI:effect.payload?.useAI??privateState.useAI};
    const run={...assignment,status:'working',startedAt,endedAt:undefined,error:undefined};
    try {
      write(working,['assignment',run]);
      const task=active.start(working,run,launchInput(privateState,effect.payload||{}));
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
  /** 把一次完成/失败的执行写成项目记忆；有模型时异步换成更好的总结。 */
  function recordProjectMemory(project, { ticket, status, summary, files, executorId, projectChatId }) {
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
        source: 'local'
      });
    } catch { /* 记忆写入失败不影响工单。 */ }
    if (!entry || !brain) return entry;
    const availability = brain.availability?.();
    if (!availability?.ok) return entry;
    void brain
      .summarize({ goal: ticket.command, project, executorId, summary, files, kind: 'ticket' })
      .then(result => {
        if (!result?.summary) return;
        memory.update(entry.id, { ...result, source: 'model' });
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
    if(activeId==='analysis')announceTeam(ticket.id, task);
    if(!['working','awaiting_review'].includes(ticket.status))return;
    const status = {running:'working',awaiting_approval:'awaiting_review',completed:'completed',failed:'failed',cancelled:'cancelled'}[task.status];
    const approvalSnapshot=status==='awaiting_review'?active.approval?.(task):undefined;
    if(!status || (ticket.status===status&&assignment.sessionId===task.id&&JSON.stringify(approvalSnapshot)===JSON.stringify(ticket.approvalSnapshot)))return;
    const terminal=activeId==='terminal';
    const cli=active.kind==='cli';
    const tool=active.kind==='tool';
    const label=terminal?'终端命令':cli?(activeId==='model'?'模型 Agent':cliWritable(ticket)?'CLI':'只读 CLI'):tool?(activeId==='browser'?'浏览器':activeId==='github'?'GitHub':active.name):'分析';
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
    const summary=status==='failed'?String(task.error||`${label}执行失败`).slice(0,400):{
      working:`${label}执行中`,
      awaiting_review:task.accessRequest?accessPrompt(task.accessRequest):`${label}等待确认`,
      completed:activeId==='window'?(typeof task.report?.summary==='string'&&task.report.summary.trim()?task.report.summary.trim():'窗口指令已发送'):tool?toolSummary:terminal?'终端命令执行完成':activeId==='model'?(typeof task.artifacts?.cli?.summary==='string'&&task.artifacts.cli.summary.trim()?task.artifacts.cli.summary.trim().slice(0,200):'模型 Agent 执行完成'):cli?`${label}执行完成`:'分析报告已生成',
      cancelled:`${label}已停止`
    }[status];
    const finished=['completed','failed','cancelled'].includes(status);
    const next={...ticket,status,stage:status==='awaiting_review'?(task.steps?.[task.currentStep]?.id||(terminal||cli||tool?'approval':'plan')):finished?'result':terminal?'terminal':cli?'cli':tool?'tool':'analysis',summary,updatedAt:now(),approvalSnapshot,attention:status==='awaiting_review'?(task.accessRequest?accessReview(task.accessRequest):review(summary)):undefined};
    const run={...assignment,status,sessionId:task.id,...(finished?{endedAt:now()}: {})};
    const kind={awaiting_review:'waiting',completed:'ready',failed:'failed',cancelled:'dropped'}[status];
    const artifacts={taskId:task.id,...(status==='completed'&&task.report?{report:task.report}:{}),...(terminal&&task.artifacts?.terminal?{terminal:task.artifacts.terminal}:{}),...(cli&&task.artifacts?.cli?{cli:task.artifacts.cli}:{}),...(tool&&task.artifacts?.[activeId]?{[activeId]:task.artifacts[activeId]}:{})};
    write(next,['assignment',run],...(kind?[['report',makeReport(next,run,kind,summary,artifacts)]]:[]));
    if (finished && next.planId && Number.isSafeInteger(next.planStep)) {
      const detail = (cli && typeof task.artifacts?.cli?.summary === 'string' && task.artifacts.cli.summary.trim()) || (toolDetail || summary);
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
        const sessionId = status === 'completed' ? task.artifacts?.cli?.sessionId : '';
        const cliSummary = status === 'completed' && typeof task.artifacts?.cli?.summary === 'string' && task.artifacts.cli.summary.trim() ? task.artifacts.cli.summary.trim() : String(summary);
        db.put('project-chat', {
          ...chat,
          lastTicketId: ticket.id,
          ...(typeof sessionId === 'string' && sessionId ? { sessionId } : {}),
          ...(finished ? { lastSummary: cliSummary.slice(0, 200) } : {}),
          updatedAt: now()
        });
        if (finished) {
          const project = db.get('project', chat.projectId);
          // 文件清单优先用 git 前后差集；目录不是 git 仓库时退回执行器自己报告的产出
          // （model 的 artifacts.cli.artifacts、CLI 的 files），否则变更档案里永远是空的。
          // 失败也要记：文件确实被改过，这件事跟这次任务算不算成功无关。
          const reported = reportedFiles(task);
          const changedFiles = project
            ? [...new Set([...(status === 'completed' ? changedSinceSnapshot(ticket.id, project.path) : []), ...reported])]
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
    }
  }
  function blockWithoutDataset(ticket,assignment) {
    const summary='当前工作区没有可用数据集，请先上传数据集后再批准';
    const blocked={...ticket,status:'blocked',stage:'dataset',attention:undefined,summary,updatedAt:now()};
    const run={...assignment,status:'blocked',endedAt:now(),error:summary};
    write(blocked,['assignment',run],['report',makeReport(blocked,run,'blocked',summary)]);
    if (blocked.planId && Number.isSafeInteger(blocked.planStep)) advancePlan(blocked.planId);
    return get(ticket.id);
  }
  function start(ticket,input,existing) {
    ticket = scopedTicket(ticket);
    const activeId=assignmentExecutorId(ticket, existing);
    const active=executors.requireAvailable(activeId);
    const attempts=related('assignment',ticket.id);
    if(attempts.length>=policy.budgets.maxCallsPerTicket){audit(ticket.id,'start',activeId,'denied','工单执行次数达到策略上限');throw workError('工单执行次数达到策略上限',429);}
    if(!outboxEnabled&&!existing&&db.list('assignment').filter(row=>row.status==='working').length>=policy.budgets.maxConcurrent){audit(ticket.id,'start',activeId,'denied','并发执行达到策略上限');throw workError('并发执行达到策略上限',429);}
    if(existing?.startedAt&&Date.now()-Date.parse(existing.startedAt)>policy.budgets.maxRuntimeMs){audit(ticket.id,'start',activeId,'denied','执行时长达到策略上限');throw workError('执行时长达到策略上限',429);}
    const needsDataset=active.requiresDataset!==false;
    const datasetId=needsDataset?resolveStartDataset(ticket,input):selectedDatasetId(ticket.datasetId);
    const assignment=existing||{id:randomUUID(),ticketId:ticket.id,executor:activeId,status:outboxEnabled?'queued':'working',...(outboxEnabled?{queuedAt:now()}:{startedAt:now()})};
    if(needsDataset&&!datasetId)return blockWithoutDataset({...ticket,executor:activeId,datasetId:null},assignment);
    const useAI=input?.useAI??ticket.useAI;
    if(outboxEnabled){
      const queued={...ticket,executor:activeId,status:'queued',stage:'launch',attention:undefined,summary:queuedSummary(activeId,active),updatedAt:now(),datasetId,useAI};
      write(queued,['assignment',{...assignment,status:'queued'}]);
      enqueue(store,{kind:WORK_EFFECT_KIND,key:launchKey(assignment),ticketId:ticket.id,payload:{assignmentId:assignment.id,datasetId:queued.datasetId??null,useAI:queued.useAI===true}},{now:Date.now()});
      audit(ticket.id,'enqueue',activeId,'queued');
      return get(ticket.id);
    }
    const terminal=activeId==='terminal';
    const cli=active.kind==='cli';
    const tool=active.kind==='tool';
    const toolLabel=activeId==='browser'?'浏览器':activeId==='github'?'GitHub':active.name;
    const working={...ticket,executor:activeId,status:'working',stage:terminal?'terminal':cli?'cli':tool?'tool':'analysis',attention:undefined,summary:terminal?'终端命令执行中':cli?'只读 CLI 执行中':tool?`${toolLabel}执行中`:'分析执行中',updatedAt:now(),datasetId,useAI};
    write(working,['assignment',assignment]);
    try {
      const task=active.start(working,assignment,{datasetId:working.datasetId,useAI:working.useAI,...(working.executorInput!==undefined?{executorInput:working.executorInput}:{})});
      sync(working,assignment,task);active.resume?.(task);
    } catch(error) {
      const status=error.status===400?'blocked':'failed';
      const summary=error.status===400?error.message:(terminal?'终端命令启动失败':cli?'只读 CLI 启动失败':tool?`${toolLabel}启动失败`:'分析启动失败');
      const failed={...working,status,summary,updatedAt:now()};
      write(failed,['assignment',{...assignment,status,endedAt:now(),error:summary}],['report',makeReport(failed,assignment,status,summary)]);
      if(failed.planId&&Number.isSafeInteger(failed.planStep))advancePlan(failed.planId);
    }
    return get(ticket.id);
  }
  const publicPlan = plan => ({
    id: plan.id,
    goal: plan.goal,
    status: plan.status,
    autoRun: plan.autoRun === true,
    currentStep: plan.currentStep,
    totalSteps: plan.steps.length,
    projectChatId: typeof plan.projectChatId === 'string' ? plan.projectChatId : null,
    projectId: typeof plan.projectId === 'string' ? plan.projectId : null,
    steps: plan.steps.map(step => {
      const ticket = db.get('ticket', step.ticketId);
      return { index: step.index, ticketId: step.ticketId, executorId: step.executorId, title: step.title, status: ticket?.status || 'missing', dependsOn: Array.isArray(step.dependsOn) ? [...step.dependsOn] : [], ...(Array.isArray(step.scope) && step.scope.length ? { scope: [...step.scope] } : {}), projectChatId: ticket?.projectChatId || step.projectChatId || null };
    }),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  });
  function startPlan(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('计划参数必须为对象');
    const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
    if (!goal || goal.length > 4000) throw workError('计划目标须为 1–4000 字');
    if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 5) throw workError('计划必须包含 2–5 个步骤');
    const clientRequestId = typeof input.clientRequestId === 'string' ? input.clientRequestId.trim() : '';
    // 显式传 autoRun 时以它为准；否则「先批准再执行」模式下逐步等确认，其余模式一路跑完。
    const autoRun = typeof input.autoRun === 'boolean' ? input.autoRun : policy.requireApproval !== true;
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
      if (projectChat || projectRecord) {
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
        if (!chat && target.kind === 'cli' && !PROJECT_CHAT_EXECUTORS.includes(targetId)) throw workError(`第 ${index + 1} 步的执行器不支持项目工作区`);
      }
      const text = typeof step.text === 'string' ? step.text.trim() : '';
      if (!text || text.length > 3000) throw workError(`第 ${index + 1} 步说明须为 1–3000 字`);
      const datasetId = selectedDatasetId(step.datasetId);
      if (datasetId) requireDataset(datasetId);
      const dependsOn = step.dependsOn === undefined ? [] : step.dependsOn;
      if (!Array.isArray(dependsOn) || dependsOn.length > 3) throw workError(`第 ${index + 1} 步依赖必须是最多 3 项的数组`);
      if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some(item => !Number.isInteger(item) || item < 0 || item >= index)) throw workError(`第 ${index + 1} 步依赖必须引用更早步骤`);
      const scope = Array.isArray(step.scope) ? step.scope.filter(item => typeof item === 'string' && item.trim() && item.length <= 120).slice(0, 6) : [];
      return { targetId, target, text, rawInput: step.executorInput, datasetId, dependsOn: [...dependsOn], chat, scope };
    });
    for (const step of prepared) {
      if (projectRecord && !step.chat && PROJECT_CHAT_EXECUTORS.includes(step.targetId)) {
        step.chat = ensureProjectChat(projectRecord, step.targetId, {
          ...(parentChat ? { parentChatId: parentChat.id } : {}),
          title: parentChat ? step.text : ''
        });
      }
      // 计划里的每一步都只负责自己那一块。内置 Agent 容易把「整件事没做完」当成自己的失败，
      // 于是在别的步骤还没跑的时候就把自己判成未完成，整条计划跟着塌。这里把范围写清楚。
      if (step.targetId === 'model' || step.chat?.executorId === 'model') {
        step.text = `${step.text}\n\n【范围】这一步只做你负责的部分：你该写的文件都写好了，就写 done:true。别的 Agent 负责任务里的文件还没出现，不算你这一步没完成。`;
      }
      step.executorInput = step.chat
        ? normalizeExecutorInput(step.targetId, step.target, projectExecutorInput(step.chat, projectRecord, step.text, step.rawInput, step.target), step.text)
        : normalizeExecutorInput(step.targetId, step.target, step.rawInput, step.text);
    }
    const planId = randomUUID();
    const stamp = now();
    const tickets = prepared.map((step, index) => {
      const ready = step.dependsOn.length === 0;
      return {
        id: randomUUID(),
        title: step.text.slice(0, 100),
        status: ready ? (autoRun ? 'queued' : 'awaiting_review') : 'waiting',
        stage: ready && step.target.requiresDataset !== false ? 'dataset' : 'approval',
        source: 'plan',
        executor: step.targetId,
        summary: ready ? (autoRun ? '自动计划待启动' : step.targetId === 'analysis' ? '请选择数据集并批准计划步骤' : `请确认${step.target.name}计划步骤`) : `计划第 ${index + 1} 步，等待依赖步骤完成`,
        ...(ready && !autoRun ? { attention: review(reviewQuestion(step.targetId, step.chat ? (step.chat.executorId === 'window' ? 'window' : 'write') : undefined)) } : {}),
        createdAt: stamp,
        updatedAt: stamp,
        command: step.text,
        datasetId: step.datasetId,
        executorInput: step.executorInput,
        ...(step.chat ? { projectChatId: step.chat.id } : {}),
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
      steps: tickets.map((ticket, index) => ({ index, ticketId: ticket.id, executorId: ticket.executor, title: ticket.title, dependsOn: prepared[index].dependsOn, ...(prepared[index].scope.length ? { scope: prepared[index].scope } : {}), ...(ticket.projectChatId ? { projectChatId: ticket.projectChatId } : {}) })),
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
    if (autoRun && created?.id === planId) {
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
      const ticket = db.get('ticket', ticketId);
      if (ticket && ['queued', 'working'].includes(ticket.status)) {
        const waiting = { ...ticket, status: 'waiting', attention: undefined, summary: `等待执行器空闲：${String(error?.message || '启动失败').slice(0, 80)}`, updatedAt: now() };
        write(waiting);
      }
      return false;
    }
  }
  function advancePlan(planId) {
    const plan = db.get('plan', planId);
    if (!plan || plan.status !== 'active') return;
    const autoReady = [];
    db.transaction(transaction => {
      const stored = transaction.get('plan', planId);
      if (!stored || stored.status !== 'active') return;
      const autoRun = stored.autoRun === true;
      const tickets = stored.steps.map(step => transaction.get('ticket', step.ticketId));
      let changed = false;
      for (const step of stored.steps) {
        const ticket = tickets[step.index];
        if (!ticket) continue;
        const blockedRecovery = ticket.status === 'blocked' && (step.dependsOn || []).length > 0;
        if (ticket.status !== 'waiting' && !blockedRecovery) continue;
        const deps = (step.dependsOn || []).map(index => tickets[index]);
        const failedDep = deps.findIndex(dep => dep && ['failed', 'blocked', 'cancelled'].includes(dep.status));
        if (failedDep >= 0) {
          const blocked = { ...ticket, status: 'blocked', attention: undefined, summary: `依赖步骤 ${(step.dependsOn[failedDep] ?? 0) + 1} 未完成`, updatedAt: now() };
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
        const allowed = policy.allowedExecutors.includes(ticket.executor) && externalExecutorAllowed(ticket.executor, policy, env);
        if (!target || !allowed) {
          const summary = target ? '目标执行器未获当前策略允许' : '目标执行器不可用';
          const blocked = { ...ticket, status: 'blocked', attention: undefined, summary, updatedAt: now() };
          transaction.put('ticket', blocked); tickets[step.index] = blocked; changed = true;
          transaction.event('ticket', blocked);
          audit(planId, 'plan/block', ticket.executor, 'blocked');
          continue;
        }
        const context = stepContext(stored, step.index);
        // 前序材料要写进 control（执行器真正读取的输入），票面 publicTicket 不保留 executorInput。
        const control = transaction.get('control', ticket.id);
        const baseInput = control?.executorInput;
        if (context && typeof baseInput?.prompt === 'string' && !baseInput.prompt.includes('【前序步骤材料')) {
          transaction.put('control', { ...control, executorInput: { ...baseInput, prompt: context + baseInput.prompt } });
        }
        const ready = {
          ...ticket,
          status: autoRun ? 'queued' : 'awaiting_review',
          stage: target.requiresDataset === false ? 'approval' : 'dataset',
          summary: autoRun ? '自动计划执行中' : `计划第 ${step.index + 1}/${stored.steps.length} 步，依赖已满足，等待确认`,
          ...(autoRun ? { attention: undefined } : { attention: review(reviewQuestion(ticket.executor)) }),
          updatedAt: now()
        };
        transaction.put('ticket', ready); tickets[step.index] = ready; changed = true;
        transaction.event('ticket', ready);
        if (autoRun) autoReady.push(ticket.id);
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
    });
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
  function commanderReport(planId){
    const plan=db.get('plan',planId);
    if(!plan)throw workError('计划不存在',404);
    const names=new Map(executors.list().map(agent=>[agent.id,agent.name]));
    const rows=plan.steps.map(step=>{
      const ticket=db.get('ticket',step.ticketId);
      const reports=related('report',step.ticketId);
      const latest=reports.length?reports[reports.length-1]:null;
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
  const api = {
    bootstrap(){
      const tickets=db.list('ticket').map(publicTicket);
      return {
        capabilities:{work:true},
        // 未绑定工作文件夹的对话，Agent 就在这个目录里读写。
        workspace,
        tickets,
        attention:tickets.filter(t=>t.attention).map(t=>({ticketId:t.id,title:t.title,...t.attention})),
        datasets:store.list('dataset').slice(0,50).map(datasetMetadata),
        projects:projects.listProjects(),
        agents:executors.list().map(({id,name,kind,available,capabilities})=>({id,name,kind,status:(id==='model'?(available&&modelReady()?'available':'needs_setup'):(available?'available':'unavailable')),capabilities})),
        tools:[
          {id:'terminal',name:'受控终端',kind:'terminal',status:'connected',permissions:['git','npm','ls','pwd']},
          ...executors.list().filter(agent=>['browser','github'].includes(agent.id)).map(agent=>({id:agent.id,name:agent.name,kind:agent.kind,status:agent.available?'connected':'needs_setup',permissions:agent.capabilities||[]})),
          ...(windowBridge?[{id:'window',name:'窗口 Agent',kind:'window',status:'connected',permissions:['list','read','send']}]:[])
        ],
        policy:JSON.parse(JSON.stringify(policy)),
        plans:db.list('plan').sort((left,right)=>String(right.updatedAt).localeCompare(String(left.updatedAt))).slice(0,20).map(plan=>({id:plan.id,goal:plan.goal,status:plan.status,autoRun:plan.autoRun===true,currentStep:plan.currentStep,totalSteps:plan.steps.length,projectChatId:typeof plan.projectChatId==='string'?plan.projectChatId:null,updatedAt:plan.updatedAt}))
      };
    },
    policy(){return JSON.parse(JSON.stringify(policy));},
    auditExternal(action,executor,result,reason=''){audit(null,action,executor,result,reason);},
    updatePolicy(input){
      // 与当前策略合并：只改传进来的字段，不再把其它设置重置成默认值。
      const next=normalizePolicy(input,policy);
      policy=next;
      store.put('work-policy',{id:WORK_POLICY_ID,...next});
      audit(null,'policy','policy','allowed','策略更新');
      return JSON.parse(JSON.stringify(policy));
    },
    listProjects(){return projects.listProjects();},
    getProject(id){return projects.getProject(id);},
    importProject(input){return projects.importProject(input);},
    deleteProject(id){
      const project=projects.getProject(id);
      const chatIds=projects.listChats(project.id).map(chat=>chat.id);
      const removed=purgeChatTickets(chatIds);
      const runs=purgeRuns({projectId:project.id,chatIds});
      return {...projects.deleteProject(id),removed,runs};
    },
    renameProject(id,input){return projects.renameProject(id,input);},
    listDirectory(input){return projects.listDirectory(input);},
    projectBrief(id){return projects.getBrief(id);},
    saveProjectBrief(id,input){return projects.saveBrief(id,input);},
    projectChanges(id){return projects.listChanges(id);},
    recordProjectChange(id,input){return projects.recordChange(id,input);},
    deleteProjectChange(projectId,changeId){return projects.deleteChange(projectId,changeId);},
    projectBriefMarkdown(id){return projects.briefMarkdown(id);},
    projectMemory(id,limit){projects.getProject(id);return memory.list(id,limit||20);},
    projectMemoryDigest(id){projects.getProject(id);return {digest:memory.digest(id,{limit:8}),entries:memory.list(id,30)};},
    deleteProjectMemory(id,memoryId){projects.getProject(id);return memory.remove(memoryId);},
    // 给执行器（模型 Agent）用：按工作目录拿到「最近改了什么」，不泄露其它项目。
    projectStateBrief(workspace){return projectStateBrief(workspace);},
    createProjectChat(projectId,input){
      const chat=projects.createChat(projectId,input);
      try{
        const target=executors.requireAvailable(chat.executorId);
        if(chat.executorId==='window'&&!windowBridge)throw workError('窗口桥未启用',503);
        guard(chat.executorId,null,'project/chat');
        if(target.kind!=='cli'&&chat.executorId!=='window')throw workError('该执行器暂不支持项目对话',400);
      }catch(error){
        try{projects.deleteChat(chat.id);}catch{/* 回滚失败不掩盖原错误。 */}
        throw error;
      }
      return {chat,project:projects.getProject(projectId)};
    },
    deleteProjectChat(id){
      const removed=purgeChatTickets([id]);
      const runs=purgeRuns({chatIds:[id]});
      return {...projects.deleteChat(id),removed,runs};
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
    projectChatMessage(chatId,input){
      const chat=projects.getChat(chatId);
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      // 会话级模型与思考强度：缺省时沿用工作流默认模型。
      const executorInput={};
      if(typeof input?.profileId==='string'&&input.profileId.trim())executorInput.profileId=input.profileId.trim();
      if(typeof input?.effort==='string'&&input.effort.trim())executorInput.effort=input.effort.trim();
      const ticket=api.command({text,executorId:chat.executorId,projectChatId:chat.id,clientRequestId:input?.clientRequestId,...(Object.keys(executorInput).length?{executorInput}:{})});
      try{projects.adoptTitle(chat.id,text);}catch{/* 改名失败不影响已提交的工单。 */}
      return ticket;
    },
    projectDispatch(projectId,input){
      const text=typeof input?.text==='string'?input.text.trim():'';
      if(!text||text.length>3000)throw workError('消息须为 1–3000 字',400);
      const requested=Array.isArray(input?.executorIds)?input.executorIds:[];
      const wanted=[...new Set(requested.map(item=>String(item??'').trim()).filter(Boolean))];
      if(!wanted.length)throw workError('请选择要分派的执行器',400);
      if(wanted.length>4)throw workError('一次最多分派给 4 个 Agent',400);
      const unsupported=wanted.filter(id=>!PROJECT_CHAT_EXECUTORS.includes(id));
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
      const chats=projects.listChats(projectId);
      const stamp=Date.now().toString(36);
      const tickets=[];
      for(const executorId of wanted){
        let chat;
        if(executorId==='window'){
          chat=chats.find(item=>item.executorId==='window'&&item.window?.handle===windowTarget.handle)
            ||api.createProjectChat(projectId,{executorId,...windowTarget}).chat;
        }else{
          const existing=chats.find(item=>item.executorId===executorId&&item.source!=='imported')||chats.find(item=>item.executorId===executorId);
          chat=existing||api.createProjectChat(projectId,{executorId}).chat;
        }
        tickets.push(api.projectChatMessage(chat.id,{text,clientRequestId:`dispatch-${stamp}-${executorId}`}));
      }
      return {project:projects.getProject(projectId),tickets};
    },
    teamworkStart(projectId,input){
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
        const ticket=api.projectChatMessage(chat.id,{
          text:teamwork.teamworkTaskText({part,goal,executorName:executorId}),
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
      const ticket=api.projectChatMessage(chat.id,{
        text:teamwork.teamworkTaskText({part:def,goal:record.goal,executorName:part.executorId}),
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
    command(input){
      const trigger=manualTrigger(input);
      const activeId=executorId(input?.executorId);
      const active=executors.requireAvailable(activeId);
      guard(activeId,null,'command');
      const project=projectContext(input?.projectChatId);
      if(project&&project.chat.executorId!==activeId)throw workError('项目对话绑定的执行器不匹配',409);
      if(!project&&input?.executorInput&&typeof input.executorInput==='object'){
        for(const key of ['workspace','resume','write'])if(key in input.executorInput)throw workError('只有项目对话可以指定工作目录、续接会话或写入模式',400);
      }
      const executorInput=project
        ?normalizeExecutorInput(activeId,active,projectExecutorInput(project.chat,project.project,trigger.text,input?.executorInput,active),trigger.text)
        :normalizeExecutorInput(activeId,active,input?.executorInput,trigger.text);
      enforceBrowserHost(activeId, executorInput, policy.limits?.browserHosts);
      const datasetId=selectedDatasetId(input?.datasetId);
      if(datasetId)requireDataset(datasetId);
      const prior=trigger.clientRequestId&&db.list('ticket').find(t=>store.get('work-control',t.id)?.clientRequestId===trigger.clientRequestId);
      if(prior){
        const control=store.get('work-control',prior.id);
        if((control?.executor||'analysis')!==activeId||control?.command!==trigger.text||(control?.datasetId??null)!==(datasetId??null)||(control?.projectChatId??null)!==(project?.chat.id??null)||!sameValue(control?.executorInput,executorInput))throw workError('此请求编号已用于不同指令、数据集或执行器，请使用新的 clientRequestId',409);
        return publicTicket(prior);
      }
      const stamp=now();
      const direct=active.requiresDataset===false;
      const cli=active.kind==='cli';
      // 不需要数据集、且策略没有要求先批准时，直接开跑：批准只在真正需要额外权限时出现。
      const auto=direct&&policy.requireApproval!==true;
      // 内置模型 Agent 的能力取决于权限模式，文案不能说「只读」。
      const modelCopy=executorInput?.write===true?'执行中（会在项目目录内读写文件）':'执行中（只读项目文件）';
      const confirmCopy=activeId==='browser'?'请确认受控浏览器读取后批准执行':activeId==='github'?'请确认 GitHub 只读查询后批准执行':activeId==='terminal'?'请确认终端命令后批准执行':activeId==='model'?modelCopy:cli?'请确认只读 CLI 任务后批准执行':'请选择数据集并批准开始';
      // 标题只取第一行：把整段多行需求塞进标题会让侧栏和工单卡片变成一大坨。
      const headline=trigger.text.split('\n').map(line=>line.trim()).find(Boolean)||trigger.text;
      const record={id:randomUUID(),title:(typeof input?.title==='string'&&input.title.trim()?input.title.trim():headline).slice(0,60),status:auto?'queued':'awaiting_review',stage:direct?(auto?'launch':'approval'):'dataset',source:'manual',executor:activeId,summary:auto?(activeId==='model'?modelCopy:activeId==='terminal'?'终端命令执行中':cli?'CLI 执行中':'执行中'):confirmCopy,attention:auto?undefined:review(reviewQuestion(activeId,project?(project.chat.executorId==='window'?'window':'write'):undefined)),createdAt:stamp,updatedAt:stamp,command:trigger.text,clientRequestId:trigger.clientRequestId,datasetId,executorInput,...(project?{projectChatId:project.chat.id}:{})};
      // write() 返回的是 publicTicket（会剥掉 executorInput），直接执行必须用原始记录，否则会写回一份空的执行输入。
      const created=write(record);
      if(project)touchProjectChat(project.chat,{lastTicketId:created.id});
      if(project)takeGitSnapshot(created.id,project.project.path);
      // 直接执行：start() 会把工单推进到 working 并调用执行器；失败时保留现场让用户能看到原因。
      if(auto)try{return start(record);}catch(error){return get(created.id);}
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
      let allowedExecutors=executors.list().filter(agent=>agentUsable(agent)&&policy.allowedExecutors.includes(agent.id)&&externalExecutorAllowed(agent.id,policy,env)&&(!requested||requested.has(agent.id))).map(agent=>agent.id);
      if(projectRow){
        const kinds=new Map(executors.list().map(agent=>[agent.id,agent.kind]));
        allowedExecutors=allowedExecutors.filter(id=>{
          if(id==='window')return projectWindows.length>0||project?.chat.executorId==='window';
          return PROJECT_CHAT_EXECUTORS.includes(id)||kinds.get(id)==='tool'||id==='analysis';
        });
      }
      if(!allowedExecutors.length)throw workError(projectRow?'项目中没有可用的 Agent':'没有可用于规划的执行器');
      const agentDescriptors=executors.list().filter(agent=>allowedExecutors.includes(agent.id)).map(({id,name,kind,capabilities})=>({id,name,kind,capabilities}));
      const nowMs=Date.now();
      while(planSuggestionTimes.length&&planSuggestionTimes[0]<=nowMs-60000)planSuggestionTimes.shift();
      if(planSuggestionTimes.length>=5)throw workError('规划请求过于频繁，请稍后再试',429);
      const datasets=store.list('dataset').slice(0,10).map(dataset=>({id:dataset.id,name:typeof dataset.name==='string'?dataset.name.slice(0,120):dataset.id}));
      const windows=windowBridge?await windowBridge.listWindows():[];
      const analysis=analyzeTask({goal,executors:allowedExecutors,...(projectRow?{project:{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch}}:{}),hasDataset:datasets.length>0,hasWindow:windows.length>0});
      const result=await options.planner({goal,executors:allowedExecutors,agents:agentDescriptors,datasets,windows,analysis,...(projectRow?{project:{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch,memory:memory.digest(projectRow.id,{limit:5}),chats:projectChats.map(chat=>({executorId:chat.executorId,title:chat.title,window:chat.window?.process||null}))}}:{})});
      const steps=Array.isArray(result?.steps)?result.steps:[];
      if(steps.length<2||steps.length>5)throw workError('规划模型必须返回 2–5 个步骤',502);
      const allowedSet=new Set(allowedExecutors);
      const kindsOf=new Map(executors.list().map(agent=>[agent.id,agent.kind]));
      const datasetIds=new Set(datasets.map(dataset=>dataset.id));
      const safeSteps=steps.map((step,index)=>{
        const executor=typeof step?.executorId==='string'?step.executorId.trim():'';
        if(!allowedSet.has(executor))throw workError(`规划第 ${index+1} 步使用了不可用执行器`,502);
        if(projectRow&&!PROJECT_CHAT_EXECUTORS.includes(executor)&&kindsOf.get(executor)==='cli')throw workError(`规划第 ${index+1} 步的执行器不支持项目工作区`,502);
        const text=typeof step?.text==='string'?step.text.trim():'';
        if(!text||text.length>500)throw workError(`规划第 ${index+1} 步说明无效`,502);
        const datasetId=typeof step?.datasetId==='string'?step.datasetId.trim():'';
        if(datasetId&&!datasetIds.has(datasetId))throw workError(`规划第 ${index+1} 步引用了未知数据集`,502);
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
        return {executorId:executor,text,...(datasetId?{datasetId}:{}),...(executorInput?{executorInput}:{}),...(scope.length?{scope}:{}),...(dependsOn.length?{dependsOn:[...dependsOn]}:{})};
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
      const available=executors.list().filter(agent=>agentUsable(agent)&&policy.allowedExecutors.includes(agent.id)&&externalExecutorAllowed(agent.id,policy,env)).map(agent=>agent.id);
      const requested=Array.isArray(input?.executors)?input.executors.filter(id=>typeof id==='string'):null;
      const scoped=requested&&requested.length?available.filter(id=>requested.includes(id)):available;
      const pool=scoped.length?scoped:available;
      const local=analyzeTask({goal,executors:pool,...(projectRow?{project:{name:projectRow.name,path:projectRow.path,gitBranch:projectRow.gitBranch}}:{}),hasDataset:store.list('dataset').length>0,hasWindow:input?.hasWindow===true});
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
    cancelPlan(id){return stopPlan(id);},
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
      const goal=typeof input?.goal==='string'?input.goal.trim():'';
      if(!goal||goal.length>4000)throw workError('协作目标须为 1–4000 字');
      const projectChatId=typeof input?.projectChatId==='string'?input.projectChatId.trim():'';
      const projectId=typeof input?.projectId==='string'?input.projectId.trim():'';
      const scope={...(projectChatId?{projectChatId}:{}),...(projectId&&!projectChatId?{projectId}:{})};
      const profileId=typeof input?.profileId==='string'?input.profileId.trim():'';
      const requested=Array.isArray(input?.agentIds)?input.agentIds.filter(id=>typeof id==='string'&&id.trim()).map(id=>id.trim()).slice(0,4):[];
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
      const memoryBrief=projectRecord?sharedMemoryBrief(projectRecord):'';
      const others=chosen.map(step=>`${step.executorId}（${step.title}）`).join('、');
      const steps=[{
        executorId:'model',
        text:`理解并拆解：${goal}`,
        executorInput:{prompt:[
          '你在一个多 Agent 团队里担任协调者，负责先把任务想清楚再分派，这一步不要修改任何文件。',
          `目标：${goal}`,
          brief&&brief!==goal?`我的初步理解：\n${brief}`:'',
          memoryBrief,
          `接下来会并行交给：${others}。`,
          '请先用两三句话说明你如何理解这个任务，再逐条写清每个执行者要做什么、交付什么、验收标准是什么。',
          '分派时把每个人要写的文件写清楚，避免两个 Agent 抢同一个文件。',
        ].filter(Boolean).join('\n\n'),...(profileId?{profileId}:{})}
      }];
      chosen.forEach(step=>{
        const model=typeof models[step.executorId]==='string'?models[step.executorId].trim():'';
        // 外部 Agent 拿到的是完整任务书：目标、它的分工、别重复别人做过的、交付与证据要求。
        // 以前这里只有一行 step.title，Agent 只能靠猜，写完也不知道算不算完成任务。
        const prompt=[
          `你是这次协作里的执行者之一，负责其中一部分。`,
          `整个任务：${goal}`,
          `你负责的部分：${step.title||'执行任务'}${Array.isArray(step.scope)&&step.scope.length?`（改动范围：${step.scope.join('、')}）`:''}${step.output?`\n期望产出：${step.output}`:''}`,
          `同时参与的还有：${others}。只做你这一部分，不要替别人改他要负责的文件。`,
          memoryBrief,
          '做事要求：先看现状再动手；改完确认真的生效（命令能跑通、页面能看到、语法没错）；',
          '最后用几句话说清：你改了哪些文件、怎么验证的、还有什么没做完。',
        ].filter(Boolean).join('\n\n');
        steps.push({
          executorId:step.executorId,
          text:step.title||'执行任务',
          ...(Array.isArray(step.scope)&&step.scope.length?{scope:step.scope}:{}),
          dependsOn:[0],
          ...(model?{executorInput:{prompt,model}}:{executorInput:{prompt}}),
        });
      });
      steps.push({
        executorId:'model',
        text:'汇总结果与下一步',
        dependsOn:chosen.map((_,index)=>index+1),
        executorInput:{prompt:[
          '你是团队的协调者。前面几位 Agent 已经把结果交回给你（见上方材料）。',
          '请写一份团队汇总：每个人做了什么、结果是否达成目标、还有什么没做完或不可靠，',
          '如果目标里点名了具体文件（比如 index.html、game.js），先列目录确认它们都在，缺了必须写明缺哪个，不要笼统说"完成了"。',
          '并明确「下一步建议交给谁、做什么」，方便继续分派。只依据给定材料，不要编造。',
        ].join('\n'),...(profileId?{profileId}:{})}
      });
      const plan=startPlan({goal,steps,...scope,...(parentChatId?{parentChatId}:{}),autoRun:input?.autoRun===true,clientRequestId:typeof input?.clientRequestId==='string'?input.clientRequestId:''});
      return {plan,steps:plan.steps,analysis,mainChatId:parentChatId||null};
    },
    commanderReport(id){return commanderReport(id);},    detail(id){
      const ticket=get(id);
      const assignment=latest(id);
      const activeId=assignmentExecutorId(ticket,assignment);
      const projectChat=ticket.projectChatId?db.get('project-chat',ticket.projectChatId):null;
      const project=projectChat?db.get('project',projectChat.projectId):null;
      // 模型 Agent 的逐步过程：只有真的走过步骤时才带这个字段，普通工单的投影键集合保持不变。
      const liveTask=taskFor(id);
      const activity=Array.isArray(liveTask?.activity)?liveTask.activity.slice(-40):[];
      return {ticket,assignments:assignments(id),reports:related('report',id),team:activeId==='analysis'?projectTeamTask(taskFor(id)):null,...(activity.length?{activity}:{}),...(project?{project:{id:project.id,name:project.name,path:project.path,gitBranch:project.gitBranch||''},projectChat:projectChat?{id:projectChat.id,title:projectChat.title,executorId:projectChat.executorId}:null}:{})};
    },
    reviewTeamNode(id,nodeId,decision){return mutateTeam(id,task=>reviewTeamNode(task,nodeId,decision));},
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
      const frozenInput=normalizeExecutorInput(targetId,target,input.executorInput,typeof input.text==='string'&&input.text.trim()?input.text:source.title);
      const requestedDatasetId=selectedDatasetId(input.datasetId);
      if(requestedDatasetId)requireDataset(requestedDatasetId);
      const titleFor=sourceTicket=>{
        if(input.text===undefined)return typeof sourceTicket.title==='string'?sourceTicket.title.slice(0,100):'交接工单';
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>3000)throw workError('交接 text 必须是非空字符串且不超过 3000 字');
        return input.text.trim().slice(0,100);
      };
      titleFor(source);
      return db.transaction(transaction=>{
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
        const sourceDatasetId=selectedDatasetId(current.datasetId);
        let datasetId=requestedDatasetId;
        if(target.requiresDataset!==false&&sourceDatasetId){
          requireDataset(sourceDatasetId);
          if(requestedDatasetId&&requestedDatasetId!==sourceDatasetId)throw workError('数据集已选定，不能切换',409);
          datasetId=sourceDatasetId;
        }
        const stamp=now();
        const title=titleFor(current);
        const child=publicTicket({
          id:randomUUID(),
          title,
          status:'awaiting_review',
          stage:target.requiresDataset===false?'approval':'dataset',
          source:'handoff',
          executor:targetId,
          summary:`已交接至${target.name}，等待人工确认`,
          attention:review(reviewQuestion(targetId)),
          createdAt:stamp,
          updatedAt:stamp,
          datasetId,
          parentTicketId:current.id,
          chainRootId:current.chainRootId||current.id,
          handoffDepth:depth+1,
          handoffSummary:typeof current.summary==='string'?current.summary.slice(0,400):null
        });
        transaction.put('ticket',child);
        transaction.put('ticket',{...storedSource,handoffChildId:child.id,updatedAt:stamp});
        transaction.put('control',{
          id:child.id,
          clientRequestId:undefined,
          command:title,
          lastAction:undefined,
          datasetId:child.datasetId,
          useAI:false,
          executor:targetId,
          executorInput:frozenInput
        });
        transaction.event('ticket',child);
        audit(child.id,'handoff',targetId,'created',`来源 ${current.id}`);
        return {created:true,ticket:child};
      });
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
      const requested=selectedDatasetId(input?.datasetId);
      // 同一个动作重复点：approve 之外大多幂等，直接返回当前状态。
      // 但「重试」必须真的再跑一次——上一次重试失败后用户再点，不能当成没事发生。
      if(action!=='retry'&&ticket.lastAction===action&&!(action==='approve'&&ticket.status==='awaiting_review'))return publicTicket(ticket);
      assertWorkAction(ticket.status,action);
      if(requested)requireDataset(requested);
      if(action==='approve'&&task) {
        const frozen=selectedDatasetId(ticket.datasetId??task.datasetId);
        if(requested&&requested!==frozen)throw workError('数据集已选定，不能切换');
      }
      const next={...ticket,lastAction:action,updatedAt:now()};
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
      if((action==='approve'&&!task)||action==='retry')return start(next,input);
      if(action==='approve'){
        if(typeof active.approve!=='function')throw workError('该执行器不支持继续审批',409);
        active.approve(task,input,ticket.approvalSnapshot);
        return write({...next,status:'working',stage:activeId==='terminal'?'terminal':active.kind==='cli'?'cli':active.kind==='tool'?'tool':'analysis',approvalSnapshot:undefined,attention:undefined,summary:activeId==='terminal'?'终端命令执行中':active.kind==='cli'?'只读 CLI 执行中':active.kind==='tool'?(activeId==='browser'?'浏览器执行中':activeId==='github'?'GitHub 查询中':`${active.name}执行中`):'分析已继续'});
      }
      if(action==='stop'){
        if(outboxEnabled)cancelTicketEffects(store,id,{now:Date.now()});
        if(task&&['running','awaiting_approval'].includes(task.status))active.stop?.(task,assignment);
        const stopped={...next,status:'cancelled',attention:undefined,summary:'工单已停止'};
        const run=assignment?{...assignment,status:'cancelled',endedAt:now()}:null;
        const result=write(stopped,...(run?[['assignment',run],['report',makeReport(stopped,run,'dropped','工单已停止')]]:[]));
        if (stopped.planId && Number.isSafeInteger(stopped.planStep)) advancePlan(stopped.planId);
        return result;
      }
      if(action==='reject'){
        if(task&&typeof active.reject==='function')active.reject(task);
        // 越权访问被拒绝时任务仍在跑：带着「被拒绝」的结论继续，而不是把工单打回等待。
        const denied=Boolean(task?.accessRequest);
        return write({...next,status:denied?'working':'waiting',attention:undefined,summary:typeof input?.reason==='string'?input.reason.slice(0,400):denied?'已拒绝这次访问':'已退回，等待新指令'},...(assignment&&!denied?[['assignment',{...assignment,status:'waiting'}]]:[]));
      }
      return write({...next,status:'awaiting_review',attention:review(reviewQuestion(activeId))});
    },
    recover(){
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
        const active=executorFor(assignment);
        const task=active?.get?.(assignment.sessionId);
        if(task){sync(privateTicket(ticket.id),assignment,task);active.resume?.(task);}
        else if(ticket.status==='working')start(privateTicket(ticket.id),{},assignment);
      }
      reconcile();
      recoverPlans();
    },
    drainOutbox,
    close(){closed=true;if(outboxTimer)clearInterval(outboxTimer);unsubscribe();executors.close();}
  };
  return api;
}
