import { useEffect, useMemo, useState } from 'react';
import { AppWindow, Bot, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardCopy, File as FileIcon, Folder, FolderGit2, GitBranch, History, Inbox, Plus, RefreshCw, Save, Send, Sparkles, Trash2, Users, X } from 'lucide-react';
import { api } from '../api';
import { Modal } from './ui';
import { ChatModelPicker, readChatModel, writeChatModel, type ChatModelChoice } from './ChatModelPicker';
import type { WorkProject, WorkProjectBrief, WorkProjectChange, WorkProjectChat, WorkProjectMemory, WorkProjectSession, WorkRun, WorkTeamwork, WorkTicket } from '../superagent';
import '../projects.css';

type Props = {
  notify: (text: string, error?: boolean) => void;
  onOpenTicket: (id: string) => void;
  allowedExecutors?: string[];
  focusProjectId?: string | null;
  focusChatId?: string | null;
  requestImport?: number;
  onState?: (state: { projects: WorkProject[]; projectId: string | null; chatId: string | null }) => void;
  onFocusProject?: (id: string | null) => void;
  // chat：只显示一个对话（独立页面）；project：单个项目自己的页面；manage：全部项目（导入、浏览、删除）。
  mode?: 'manage' | 'chat' | 'project';
  onOpenChat?: (projectId: string, chatId: string) => void;
  onExitChat?: () => void;
  onBackToProjects?: () => void;
  // 对话页里直接确认待审批的工单，不用先打开详情弹窗。
  onApprove?: (ticketId: string) => void;
  // 消息被删除后通知外层：右侧「执行详情」是主壳自己的一份快照，不刷新会留着已删的卡片。
  onTicketsChanged?: () => void;
};

const EXECUTOR_LABELS: Record<string, string> = {
  model: '内置 Agent',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'claude-acp': 'Claude ACP',
  'dsh-acp': 'DSH ACP',
  'codex-acp': 'Codex ACP',
  opencode: 'OpenCode',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  'cursor-agent': 'Cursor Agent',
  dsh: 'DSH CLI',
  codebuddy: 'CodeBuddy',
  qoder: 'Qoder',
  iflow: 'iFlow',
  kimi: 'Kimi CLI',
  window: '窗口 Agent'
};

// 分派优先级：先 CLI（能改文件、能续接会话），再 ACP，最后其它本机 Agent。
const DISPATCH_ORDER = ['claude-code', 'codex', 'claude-acp', 'dsh-acp', 'codex-acp', 'opencode', 'gemini', 'qwen', 'cursor-agent', 'dsh', 'codebuddy', 'qoder', 'iflow', 'kimi'];

const STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  working: '执行中',
  awaiting_review: '待确认',
  blocked: '受阻',
  failed: '失败',
  waiting: '等待触发',
  completed: '已完成',
  cancelled: '已停止',
  pending: '待执行',
  running: '执行中',
  accepted: '已接受',
  recorded: '已记录'
};

// 编排运行的状态文案；步骤状态复用执行器的那套，避免多一套词。
const RUN_STATUS_LABELS: Record<string, string> = {
  drafting: '分析中',
  awaiting_approval: '等你批准',
  running: '执行中',
  verifying: '验证中',
  repairing: '返工中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断'
};
const RUN_STEP_LABELS: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  skipped: '跳过',
  waiting: '等待'
};

export function ProjectsPanel({ notify, onOpenTicket, allowedExecutors = ['claude-code', 'codex'], focusProjectId = null, focusChatId = null, requestImport = 0, onState, onFocusProject, mode = 'manage', onOpenChat, onExitChat, onBackToProjects, onApprove, onTicketsChanged }: Props) {
  const chatMode = mode === 'chat';
  const projectMode = mode === 'project';
  const [projects, setProjects] = useState<WorkProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserBusy, setBrowserBusy] = useState(false);
  const [browserData, setBrowserData] = useState<{ path: string; parent: string | null; roots: string[]; entries: { name: string; path: string; isDir: boolean }[]; truncated: boolean } | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('project'));
  // 选中项目写进 URL，刷新后自动回到同一个项目。
  useEffect(() => {
    const url = new URL(window.location.href);
    if (activeProjectId) url.searchParams.set('project', activeProjectId);
    else url.searchParams.delete('project');
    window.history.replaceState(null, '', url);
  }, [activeProjectId]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [tickets, setTickets] = useState<WorkTicket[]>([]);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<WorkProjectSession[] | null>(null);
  const [chatDraft, setChatDraft] = useState('');
  const [chatModel, setChatModel] = useState<ChatModelChoice>({ profileId: '', effort: 'default' });
  // 深度编排：开=一次运行里分析/拆解/分发/验证；关=沿用现在的单条工单。
  const [orchestrate, setOrchestrate] = useState(() => {
    try { return localStorage.getItem('dataagent.orchestrate.v1') !== 'off'; } catch { return true; }
  });
  const [runs, setRuns] = useState<WorkRun[]>([]);
  const [runBusy, setRunBusy] = useState('');
  // 服务端关掉编排器（DATAAGENT_ORCHESTRATOR=legacy）时不显示开关，免得点了报 503。
  const [orchestratorOn, setOrchestratorOn] = useState(true);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newExecutors, setNewExecutors] = useState<string[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [newTask, setNewTask] = useState('');
  const [windows, setWindows] = useState<{ id: string; handle: number; pid: number; process: string; title: string }[]>([]);
  const [windowId, setWindowId] = useState('');
  const [planOpen, setPlanOpen] = useState(false);
  const [planGoal, setPlanGoal] = useState('');
  const [planSteps, setPlanSteps] = useState<{ executorId: string; text: string; dependsOn?: number[] }[]>([]);
  const [planBusy, setPlanBusy] = useState('');
  const [tab, setTab] = useState<'chat' | 'archive' | 'memory'>('chat');
  const [memory, setMemory] = useState<WorkProjectMemory | null>(null);
  const [memoryBusy, setMemoryBusy] = useState('');
  const [brief, setBrief] = useState<WorkProjectBrief | null>(null);
  const [briefDraft, setBriefDraft] = useState({ goal: '', summary: '', keyPoints: '', decisions: '', constraints: '' });
  const [changes, setChanges] = useState<WorkProjectChange[]>([]);
  const [archiveBusy, setArchiveBusy] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; body?: string; quote?: string; notes?: string[]; label: string; run: () => Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [changeTitle, setChangeTitle] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchTargets, setDispatchTargets] = useState<string[]>([]);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  // 协作任务：软件把目标拆成三份、分派、再组装成一个游戏。
  const [teamworkOpen, setTeamworkOpen] = useState(false);
  const [teamworkGoal, setTeamworkGoal] = useState('');
  const [teamworkAgents, setTeamworkAgents] = useState<string[]>([]);
  const [teamworkBusy, setTeamworkBusy] = useState('');
  const [teamworks, setTeamworks] = useState<WorkTeamwork[]>([]);
  // 对话页：每条 Agent 回复可以展开看它怎么想、怎么做。按工单 id 缓存，避免重复请求。
  const [expandedTurns, setExpandedTurns] = useState<Record<string, boolean>>({});
  const [traces, setTraces] = useState<Record<string, { loading?: boolean; error?: string; items?: { kind: string; text: string; detail?: string; at?: string }[] }>>({});

  const project = useMemo(() => projects.find(item => item.id === activeProjectId) || null, [projects, activeProjectId]);
  const dispatchExecutors = useMemo(() => DISPATCH_ORDER.filter(id => allowedExecutors.includes(id)), [allowedExecutors]);
  const chat = useMemo(() => project?.chats.find(item => item.id === activeChatId) || null, [project, activeChatId]);
  // 每个对话各自的模型与思考强度，切对话时恢复上次的选择。
  useEffect(() => {
    if (!activeChatId) return;
    setChatModel(readChatModel(activeChatId));
  }, [activeChatId]);
  const planExecutors = useMemo(() => {
    const ids = new Set<string>();
    for (const item of project?.chats || []) ids.add(item.executorId);
    for (const id of allowedExecutors) if (id !== 'window') ids.add(id);
    return [...ids];
  }, [project, allowedExecutors]);

  const loadProjects = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await api.workProjects();
      setProjects(result.projects);
      setActiveProjectId(previous => previous && result.projects.some(item => item.id === previous) ? previous : result.projects[0]?.id || null);
    } catch (cause) { if (!quiet) notify((cause as Error).message, true); }
    finally { if (!quiet) setLoading(false); }
  };
  useEffect(() => { void loadProjects(); }, []);
  const loadTeamworks = async (projectId: string | null = activeProjectId) => {
    if (!projectId) { setTeamworks([]); return; }
    try {
      const result = await api.workProjectTeamworks(projectId);
      setTeamworks(result.teamworks);
    } catch { /* 轮询失败不打断页面。 */ }
  };
  useEffect(() => { void loadTeamworks(activeProjectId); }, [activeProjectId]);
  // 有协作任务在跑时每 5 秒刷新一次状态，跑完自动停。
  useEffect(() => {
    if (!teamworks.some(item => item.status === 'running')) return;
    const timer = window.setInterval(() => void loadTeamworks(), 5000);
    return () => window.clearInterval(timer);
  }, [teamworks, activeProjectId]);
  // 侧栏「添加本地文件夹」：打开导入表单，并把焦点放进路径输入框。
  useEffect(() => {
    if (!requestImport) return;
    setEditorOpen(true);
    setPathDraft('');
    setNameDraft('');
    setBrowserOpen(false);
  }, [requestImport]);
  // 把项目 / 会话的选择同步给外壳侧栏，侧栏据此高亮。
  useEffect(() => {
    onState?.({ projects, projectId: activeProjectId, chatId: activeChatId });
  }, [projects, activeProjectId, activeChatId, onState]);
  useEffect(() => {
    if (!activeProjectId) { setActiveChatId(null); return; }
    const item = projects.find(entry => entry.id === activeProjectId);
    if (!item) return;
    setActiveChatId(previous => previous && item.chats.some(entry => entry.id === previous) ? previous : item.chats[0]?.id || null);
    setSessionsOpen(false); setSessions(null);
    setTab('chat'); setBrief(null); setChanges([]); setChangeTitle(''); setChangeSummary(''); setMemory(null);
  }, [activeProjectId, projects]);
  // 从侧栏或工单详情进入时，切到指定项目 / 指定会话，并清除一次性焦点。
  // 必须排在「切换项目时校正当前会话」之后，否则会被它矫正回第一条会话。
  useEffect(() => {
    if (!focusProjectId && !focusChatId) return;
    // 项目列表还没回来时先等等，否则会把一次性焦点白白消费掉。
    if (!projects.length) return;
    const targetProject = focusProjectId
      ? projects.find(item => item.id === focusProjectId) || null
      : focusChatId
        ? projects.find(item => item.chats.some(entry => entry.id === focusChatId)) || null
        : null;
    if (targetProject) {
      setActiveProjectId(targetProject.id);
      if (focusChatId && targetProject.chats.some(entry => entry.id === focusChatId)) setActiveChatId(focusChatId);
    }
    onFocusProject?.(null);
  }, [focusProjectId, focusChatId, projects, onFocusProject]);
  useEffect(() => {
    let cancelled = false;
    if (!chat) { setTickets([]); return () => { cancelled = true; }; }
    api.workProjectChatTickets(chat.id)
      .then(result => { if (!cancelled) setTickets(result.tickets); })
      .catch(() => { if (!cancelled) setTickets([]); });
    return () => { cancelled = true; };
  }, [chat?.id, chat?.lastTicketId]);

  // 编排器是否启用：只有启用时才显示「深度编排」开关。
  useEffect(() => {
    let cancelled = false;
    api.workOrchestrator()
      .then(result => {
        if (cancelled) return;
        setOrchestratorOn(result.enabled);
        if (!result.enabled) setOrchestrate(false);
      })
      .catch(() => { if (!cancelled) setOrchestratorOn(false); });
    return () => { cancelled = true; };
  }, []);

  // 深度编排的运行记录：只取当前对话的。有活在跑时 3 秒刷一次，空闲时 12 秒兜底
  // （之前只在「本次加载到活运行」时才续期，刚发起的运行永远刷不到新状态）。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!chat) { setRuns([]); return () => { cancelled = true; }; }
    const chatId = chat.id;
    const tick = async () => {
      let delay = 12000;
      try {
        const result = await api.workRuns(20);
        if (cancelled) return;
        const mine = result.runs.filter(run => run.chatId === chatId);
        setRuns(mine);
        if (mine.some(run => ['drafting', 'awaiting_approval', 'running', 'verifying', 'repairing'].includes(run.status))) delay = 3000;
      } catch {
        if (!cancelled) setRuns([]);
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [chat?.id]);

  // 进对话就停在最新一条上（和常见聊天软件一致），否则新消息会藏在输入框下面。
  useEffect(() => {
    const list = [...document.querySelectorAll<HTMLElement>('.pj-messages')].find(node => node.getClientRects().length > 0);
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [chat?.id, tickets.length]);

  const loadDirectory = async (target = '') => {
    setBrowserBusy(true);
    try { setBrowserData(await api.workDirectory(target)); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setBrowserBusy(false); }
  };
  const openFolderBrowser = async () => {
    setBrowserOpen(true);
    if (!browserData) await loadDirectory('');
  };
  const pickFolder = async () => {
    const picker = window.dataagentDesktop?.pickFolder;
    if (!picker) { await openFolderBrowser(); return; }
    try {
      const picked = await picker();
      if (picked) await importProject(picked, nameDraft);
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const importProject = async (path: string, name?: string) => {
    const value = path.trim();
    if (!value) { notify('请填写项目文件夹的绝对路径。', true); return; }
    setBusy('import');
    try {
      const result = await api.workImportProject(value, name?.trim() || undefined);
      await loadProjects(true);
      setActiveProjectId(result.project.id);
      setEditorOpen(false); setPathDraft(''); setNameDraft('');
      notify(result.created ? `已导入项目「${result.project.name}」。` : `项目「${result.project.name}」已在列表中。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBusy(''); }
  };
  const removeProject = (item: WorkProject) => setConfirm({
    title: `移除项目「${item.name}」`,
    body: '只删除软件内的记录，不会删除本地文件，也不会影响 Git 仓库。',
    label: '移除项目',
    run: async () => {
      setBusy(`delete-${item.id}`);
      try {
        await api.workDeleteProject(item.id);
        await loadProjects(true);
        notify(`已移除项目「${item.name}」。`);
      } catch (cause) { notify((cause as Error).message, true); }
      finally { setBusy(''); }
    }
  });
  const openSessions = async () => {
    if (!project) return;
    setSessionsOpen(true);
    if (sessions) return;
    setBusy('sessions');
    try { setSessions((await api.workProjectSessions(project.id)).sessions); }
    catch (cause) { notify((cause as Error).message, true); setSessions([]); }
    finally { setBusy(''); }
  };
  const importSession = async (row: WorkProjectSession) => {
    if (!project) return;
    setBusy(`session-${row.executorId}-${row.sessionId}`);
    try {
      const result = await api.workImportProjectSession(project.id, row.executorId, row.sessionId);
      await loadProjects(true);
      setActiveChatId(result.chat.id);
      setSessions(current => current?.map(item => item.executorId === row.executorId && item.sessionId === row.sessionId ? { ...item, imported: true } : item) || current);
      notify(result.created ? `已导入会话「${result.chat.title}」。` : '该会话已在项目中。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBusy(''); }
  };
  const openNewChat = async () => {
    setNewChatOpen(true);
    setNewExecutors([allowedExecutors[0] || 'claude-code']);
    setNewTitle('');
    setNewTask('');
    if (allowedExecutors.includes('window')) {
      try { setWindows((await api.workWindows()).windows); } catch { setWindows([]); }
    }
  };
  const toggleNewExecutor = (id: string) => setNewExecutors(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const createChat = async () => {
    if (!project) return;
    const execs = [...new Set(newExecutors)].filter(id => allowedExecutors.includes(id));
    if (!execs.length) { notify('请至少选择一个 Agent。', true); return; }
    if (execs.length > 4) { notify('一次最多选择 4 个 Agent。', true); return; }
    const target = windows.find(item => item.id === windowId);
    if (execs.includes('window') && !target) { notify('请选择要接管的窗口。', true); return; }
    setBusy('new-chat');
    try {
      const task = newTask.trim();
      if (execs.length > 1) {
        // 多 Agent：同一任务并行分派，每个 Agent 一条待确认工单，各自在自己的会话里执行。
        // 窗口 Agent 不在项目目录里跑，它把同一段任务发进你选定的那个窗口。
        if (!task) { notify('多 Agent 协同需要写下要一起完成的任务。', true); return; }
        const result = await api.workProjectDispatch(project.id, task, execs, execs.includes('window') && target
          ? { handle: target.handle, process: target.process, title: target.title }
          : undefined);
        await loadProjects(true);
        setNewChatOpen(false);
        const chatId = result.tickets.map(ticket => ticket.projectChatId).filter(Boolean)[0];
        if (chatId) setActiveChatId(chatId);
        notify(execs.includes('window')
          ? `已把任务分派给 ${execs.length} 个 Agent：项目内 Agent 会在项目目录执行，窗口 Agent 会发送到「${target?.title || '所选窗口'}」。`
          : `已把任务分派给 ${execs.length} 个 Agent，确认后各自在项目目录内执行。`);
        return;
      }
      const result = await api.workCreateProjectChat(project.id, {
        executorId: execs[0],
        ...(newTitle.trim() ? { title: newTitle.trim() } : {}),
        ...(execs[0] === 'window' && target ? { handle: target.handle, process: target.process, windowTitle: target.title } : {})
      });
      let ticketId = '';
      if (task) {
        const sent = await api.workProjectChatMessage(result.chat.id, task);
        ticketId = sent.ticket.id;
      }
      await loadProjects(true);
      setActiveChatId(result.chat.id);
      setNewChatOpen(false);
      if (!chatMode && onOpenChat) onOpenChat(project.id, result.chat.id);
      notify(task
        ? `已创建与 ${EXECUTOR_LABELS[execs[0]] || execs[0]} 的项目对话，并提交了任务（待确认）。`
        : `已创建与 ${EXECUTOR_LABELS[execs[0]] || execs[0]} 的项目对话。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBusy(''); }
  };
  const removeChat = (item: WorkProjectChat) => setConfirm({
    title: `删除对话「${item.title}」`,
    body: 'Agent 端的会话文件不会被删除，只移除软件内的这条项目对话。',
    label: '删除对话',
    run: async () => {
      setBusy(`delete-chat-${item.id}`);
      try {
        await api.workDeleteProjectChat(item.id);
        await loadProjects(true);
        notify('已删除项目对话。');
      } catch (cause) { notify((cause as Error).message, true); }
      finally { setBusy(''); }
    }
  });
  const send = async () => {
    const text = chatDraft.trim();
    if (!chat || !text) return;
    setBusy('send');
    try {
      // 深度编排：把整句话交给编排器，它自己拆解、分发、验证。
      if (orchestrate) {
        const started = await api.workStartRun({ goal: text, projectId: project?.id || null, chatId: chat.id });
        setChatDraft('');
        setRuns(current => [started.run, ...current.filter(run => run.id !== started.run.id)]);
        notify('已开始分析任务；拆完的计划会先给你过一遍，批准后才动手。');
        return;
      }
      const result = await api.workProjectChatMessage(chat.id, text, undefined, chat.executorId === 'model' ? chatModel : undefined);
      setChatDraft('');
      setTickets(current => [...current.filter(item => item.id !== result.ticket.id), result.ticket]);
      await loadProjects(true);
      notify(chat.executorId === 'window' ? '已提交，确认后会发送到该窗口的 Agent 会话。' : '已提交，确认后会在项目目录续接该 Agent 会话并修改文件。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBusy(''); }
  };
  const toggleOrchestrate = () => {
    setOrchestrate(current => {
      const next = !current;
      try { localStorage.setItem('dataagent.orchestrate.v1', next ? 'on' : 'off'); } catch { /* 隐私模式下忽略 */ }
      return next;
    });
  };
  const decideRun = async (run: WorkRun, decision: 'approve' | 'reject') => {
    setRunBusy(`${run.id}:${decision}`);
    try {
      const result = await api.workApproveRun(run.id, decision);
      setRuns(current => current.map(item => item.id === result.run.id ? result.run : item));
      notify(decision === 'approve' ? '已批准，编排器开始分发执行。' : '已退回，这次运行不会执行。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setRunBusy(''); }
  };
  const cancelRun = async (run: WorkRun) => {
    setRunBusy(`${run.id}:cancel`);
    try {
      const result = await api.workCancelRun(run.id);
      setRuns(current => current.map(item => item.id === result.run.id ? result.run : item));
      notify('已取消这次运行。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setRunBusy(''); }
  };
  const toggleDispatchTarget = (id: string) => {
    setDispatchTargets(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };
  const toggleDispatchPanel = () => {
    if (dispatchOpen) { setDispatchOpen(false); return; }
    if (!dispatchTargets.length) {
      const preferred = chat && dispatchExecutors.includes(chat.executorId) ? chat.executorId : dispatchExecutors[0];
      setDispatchTargets(preferred ? [preferred] : []);
    }
    setDispatchOpen(true);
  };
  const dispatch = async () => {
    const text = chatDraft.trim();
    if (!project || !text || !dispatchTargets.length) return;
    setDispatchBusy(true);
    try {
      const result = await api.workProjectDispatch(project.id, text, dispatchTargets);
      setChatDraft('');
      setDispatchOpen(false);
      await loadProjects(true);
      notify(`已分派给 ${result.tickets.length} 个 Agent，确认后各自在项目目录内执行。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setDispatchBusy(false); }
  };
  // 协作任务：拆分 → 分派（软件写骨架与契约，三个 Agent 各写一份）→ 组装。
  const startTeamwork = async () => {
    if (!project) return;
    const goal = teamworkGoal.trim();
    if (!goal) { notify('先写下想做什么样的游戏。', true); return; }
    const executors = (teamworkAgents.length ? teamworkAgents : dispatchExecutors.slice(0, 3)).filter(id => dispatchExecutors.includes(id));
    if (!executors.length) { notify('至少选择一个 Agent。', true); return; }
    setTeamworkBusy('start');
    try {
      const result = await api.workStartTeamwork(project.id, goal, executors);
      setTeamworks(previous => [result.teamwork, ...previous]);
      setTeamworkOpen(false);
      setTeamworkGoal('');
      await loadProjects(true);
      const agents = new Set(result.teamwork.parts.map(part => part.executorId)).size;
      notify(`已拆成 ${result.teamwork.parts.length} 份，分给 ${agents} 个 Agent；确认工单后各自开始。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setTeamworkBusy(''); }
  };
  const assembleTeamwork = async (item: WorkTeamwork) => {
    setTeamworkBusy(item.id);
    try {
      const result = await api.workAssembleTeamwork(item.id);
      setTeamworks(previous => previous.map(entry => entry.id === item.id ? result.teamwork : entry));
      if (result.ok) notify(`已组装成 ${result.relativePath}（${Math.max(1, Math.round((result.bytes || 0) / 1024))} KB）。`);
      else notify(`还组装不了：${result.problems[0]?.message || '文件没写齐'}`, true);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setTeamworkBusy(''); }
  };
  const retryTeamworkPart = async (item: WorkTeamwork, partId: string) => {
    setTeamworkBusy(`${item.id}:${partId}`);
    try {
      const result = await api.workRetryTeamworkPart(item.id, partId);
      setTeamworks(previous => previous.map(entry => entry.id === item.id ? result.teamwork : entry));
      notify('已重新派这一段；确认新工单后它会接着写。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setTeamworkBusy(''); }
  };
  const openTeamworkFile = async (item: WorkTeamwork) => {
    if (!item.outputPath) return;
    const absolute = `${item.projectPath || project?.path || ''}\\${item.outputPath.replace(/\//g, '\\')}`;
    const bridge = (window as unknown as { dataagentDesktop?: { openPath?: (target: string) => Promise<unknown> } }).dataagentDesktop;
    if (bridge?.openPath) {
      try { await bridge.openPath(absolute); return; } catch { /* 落到复制路径。 */ }
    }
    try {
      await navigator.clipboard.writeText(absolute);
      notify(`已复制路径：${absolute}`);
    } catch { notify(absolute); }
  };
  const loadArchive = async (projectId = activeProjectId) => {
    if (!projectId) return;
    setArchiveBusy('load');
    try {
      const [briefResult, changeResult] = await Promise.all([api.workProjectBrief(projectId), api.workProjectChanges(projectId)]);
      applyBrief(briefResult.brief);
      setChanges(changeResult.changes);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setArchiveBusy(''); }
  };
  const applyBrief = (next: WorkProjectBrief) => {
    setBrief(next);
    setBriefDraft({
      goal: next.goal,
      summary: next.summary,
      keyPoints: next.keyPoints.join('\n'),
      decisions: next.decisions.join('\n'),
      constraints: next.constraints.join('\n')
    });
  };
  const openArchive = () => {
    setTab('archive');
    if (!brief) void loadArchive();
  };
  const loadMemory = async (projectId = activeProjectId) => {
    if (!projectId) return;
    setMemoryBusy('load');
    try {
      setMemory(await api.workProjectMemory(projectId));
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setMemoryBusy(''); }
  };
  const openMemory = () => {
    setTab('memory');
    if (!memory) void loadMemory();
  };
  const removeMemory = async (memoryId: string) => {
    if (!project) return;
    try {
      await api.workDeleteProjectMemory(project.id, memoryId);
      setMemory(current => current ? { ...current, entries: current.entries.filter(entry => entry.id !== memoryId) } : current);
      notify('已删除这条记忆。');
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const splitLines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
  const saveBrief = async () => {
    if (!project) return;
    setArchiveBusy('save');
    try {
      const result = await api.workSaveProjectBrief(project.id, {
        goal: briefDraft.goal,
        summary: briefDraft.summary,
        keyPoints: splitLines(briefDraft.keyPoints),
        decisions: splitLines(briefDraft.decisions),
        constraints: splitLines(briefDraft.constraints)
      });
      applyBrief(result.brief);
      notify('已保存项目简报，其他 Agent 读取时即可看到。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setArchiveBusy(''); }
  };
  const addChange = async () => {
    if (!project) return;
    const title = changeTitle.trim();
    const summary = changeSummary.trim();
    if (!title && !summary) { notify('请填写变更标题或摘要。', true); return; }
    setArchiveBusy('add');
    try {
      const result = await api.workRecordProjectChange(project.id, {
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
        ...(chat ? { executorId: chat.executorId } : {})
      });
      setChanges(current => [result.change, ...current.filter(item => item.id !== result.change.id)]);
      setChangeTitle(''); setChangeSummary('');
      notify('已补充一条变更记录。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setArchiveBusy(''); }
  };
  const removeChange = (change: WorkProjectChange) => {
    if (!project) return;
    setConfirm({
      title: `删除变更记录「${change.title}」`,
      body: '这条记录会从项目档案中移除，已经写下的文件改动不会回滚。',
      label: '删除记录',
      run: async () => {
        setArchiveBusy(`delete-${change.id}`);
        try {
          await api.workDeleteProjectChange(project.id, change.id);
          setChanges(current => current.filter(item => item.id !== change.id));
          notify('已删除变更记录。');
        } catch (cause) { notify((cause as Error).message, true); }
        finally { setArchiveBusy(''); }
      }
    });
  };
  const copyBriefMarkdown = async () => {
    if (!project) return;
    setArchiveBusy('copy');
    try {
      const result = await api.workProjectBriefMarkdown(project.id);
      await navigator.clipboard.writeText(result.markdown);
      notify('已复制项目简报 Markdown，可直接粘贴给其他 Agent。');
    } catch { notify('复制失败，请允许浏览器访问剪贴板后重试。', true); }
    finally { setArchiveBusy(''); }
  };
  const startPlan = async () => {
    if (!chat) return;
    const goal = chatDraft.trim();
    if (!goal) { notify('请先在输入框描述项目目标。', true); return; }
    setPlanBusy('suggest');
    try {
      const result = await api.suggestWorkPlan(goal, planExecutors, chat.id);
      setPlanGoal(goal);
      setPlanSteps(result.steps.map(step => ({ executorId: step.executorId, text: step.text, ...(step.dependsOn?.length ? { dependsOn: step.dependsOn } : {}) })));
      setPlanOpen(true);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setPlanBusy(''); }
  };
  const openManualPlan = () => {
    if (!chat) return;
    const draft = chatDraft.trim();
    const second = planExecutors.find(id => id !== chat.executorId) || chat.executorId;
    setPlanGoal(draft);
    setPlanSteps([
      { executorId: chat.executorId, text: draft },
      { executorId: second, text: '', dependsOn: [0] }
    ]);
    setPlanOpen(true);
  };
  const addPlanStep = () => {
    setPlanSteps(current => current.length >= 5 ? current : [...current, { executorId: planExecutors[0] || '', text: '', dependsOn: current.length ? [current.length - 1] : [] }]);
  };
  const removePlanStep = (index: number) => {
    if (planSteps.length <= 2) return;
    setPlanSteps(current => current
      .filter((_, position) => position !== index)
      .map(step => ({ ...step, dependsOn: step.dependsOn?.filter(item => item !== index).map(item => item > index ? item - 1 : item) })));
  };
  const createPlan = async () => {
    if (!chat || !planSteps.length) return;
    if (!planGoal.trim()) { notify('请填写计划目标。', true); return; }
    if (planSteps.some(step => !step.executorId || !step.text.trim())) { notify('每个步骤都需要选择 Agent 并填写说明。', true); return; }
    setPlanBusy('create');
    try {
      const plan = await api.createWorkPlan(planGoal, planSteps, `project-${chat.id}-${Date.now()}`, false, chat.id);
      setPlanOpen(false);
      setChatDraft('');
      await loadProjects(true);
      const agents = [...new Set(plan.plan.steps.map(step => EXECUTOR_LABELS[step.executorId] || step.executorId))].join('、');
      notify(`已创建 ${plan.plan.totalSteps} 步计划，批准后会按步骤分派给 ${agents}。`);
      const first = plan.plan.steps[0]?.ticketId;
      if (first) onOpenTicket(first);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setPlanBusy(''); }
  };

  const chatHeader = <header className="pj-chat-head">
    <button type="button" className="pj-btn pj-small" onClick={() => { if (chat?.parentChatId && onOpenChat && project) onOpenChat(project.id, chat.parentChatId); else onExitChat?.(); }}><ChevronLeft size={14} />{chat?.parentChatId ? '返回主对话' : '返回项目'}</button>
    <div className="pj-chat-head-main">
      <strong>{chat?.title || '对话'}</strong>
      <span>{project ? `${project.name} · ${project.path}` : '工作文件夹'}{chat ? ` · ${EXECUTOR_LABELS[chat.executorId] || chat.executorId}` : ''}{chat?.parentChatId ? ' · 团队协作分派' : ''}</span>
    </div>
    {chat && <span className={`pj-source ${chat.executorId !== 'window' && chat.writable ? 'write' : ''}`}>{chat.executorId === 'window' ? '不写文件' : chat.writable ? '可修改项目' : '只读'}</span>}
  </header>;

  // 独立对话页：只渲染这一个对话的消息与输入框。
  // 对话页按时间正序排列：这是「一次对话」，先说的在上面；同批计划步按 planStep 排。
  const threadTickets = tickets.slice().sort((left, right) => {
    const stepDelta = (left.planStep ?? -1) - (right.planStep ?? -1);
    if (left.planId && right.planId && stepDelta !== 0) return stepDelta;
    return String(left.createdAt).localeCompare(String(right.createdAt));
  });

  async function toggleTrace(ticket: WorkTicket) {
    const open = !expandedTurns[ticket.id];
    setExpandedTurns(current => ({ ...current, [ticket.id]: open }));
    if (!open) return;
    scrollTurn(ticket.id);
    if (traces[ticket.id]?.items || traces[ticket.id]?.loading) return;
    setTraces(current => ({ ...current, [ticket.id]: { loading: true } }));
    try {
      const detail = await api.workTicket(ticket.id);
      setTraces(current => ({ ...current, [ticket.id]: { items: (detail.activity || []).slice(0, 120) } }));
    } catch (error) {
      setTraces(current => ({ ...current, [ticket.id]: { error: error instanceof Error ? error.message : '读取执行记录失败' } }));
    }
    scrollTurn(ticket.id);
  }

  // 展开过程后把这一轮的回复滚进可视区：整轮比视口高时，优先露出回复的结尾。
  function scrollTurn(ticketId: string) {
    window.setTimeout(() => {
      const node = document.querySelector<HTMLElement>(`[data-turn="${ticketId}"]`);
      if (!node) return;
      const list = node.closest<HTMLElement>('.pj-messages');
      const bubble = node.querySelector<HTMLElement>('.pj-bubble-agent');
      if (list && bubble) {
        const gap = bubble.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
        if (gap > 0) {
          list.scrollTo({ top: list.scrollTop + gap + 10, behavior: 'smooth' });
          return;
        }
        if (node.getBoundingClientRect().top < list.getBoundingClientRect().top) {
          list.scrollTo({ top: list.scrollTop + node.getBoundingClientRect().top - list.getBoundingClientRect().top - 10, behavior: 'smooth' });
          return;
        }
      }
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 80);
  }

  // 删除自己发的一条消息：连同执行记录、报告、快照一起清掉；属于计划的会整条计划一起删。
  const removeMessage = (ticket: WorkTicket) => setConfirm({
    title: '删除这条消息？',
    quote: ticket.title.slice(0, 160),
    notes: [
      ticket.planId ? '这条消息属于一个多步计划，整个计划会一起删除。' : '',
      '它的执行记录、报告与改动快照会一起删除，无法恢复。'
    ].filter(Boolean),
    label: '删除',
    run: async () => {
      const result = await api.workDeleteTicket(ticket.id);
      setTickets(current => current.filter(item => !result.ids.includes(item.id)));
      setExpandedTurns(current => { const next = { ...current }; result.ids.forEach(id => delete next[id]); return next; });
      notify(result.planRemoved ? `已删除这条消息和它的 ${result.ids.length} 个步骤。` : '已删除这条消息。');
      onTicketsChanged?.();
    }
  });

  const thread = project && chat ? <div className="pj-thread pj-thread-full">
    <div className="pj-messages pj-conv">
      {runs.length > 0 && <div className="pj-runs">
        {runs.map(run => <div className={`pj-run is-${run.status}`} key={run.id}>
          <div className="pj-run-head">
            <span className="pj-run-icon"><Sparkles size={13} /></span>
            <span className="pj-run-title">深度编排</span>
            {run.templateLabel && <span className="pj-run-tag">{run.templateLabel}</span>}
            <span className={`pj-run-status is-${run.status}`}>{RUN_STATUS_LABELS[run.status] || run.status}</span>
            <span className="pj-run-time">{new Date(run.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
          <p className="pj-run-goal">{run.goal}</p>
          {run.steps.length > 0 && <ol className="pj-run-steps">
            {run.steps.map(step => <li key={`${run.id}-${step.index}`} className={`pj-run-step is-${step.status}`}>
              <span className="pj-run-step-index">{step.index + 1}</span>
              <span className="pj-run-step-role">{step.role}</span>
              <span className="pj-run-step-exec">{step.executorId ? (EXECUTOR_LABELS[step.executorId] || step.executorId) : '待分配'}</span>
              <span className="pj-run-step-status">{RUN_STEP_LABELS[step.status] || step.status}</span>
            </li>)}
          </ol>}
          {run.board.length > 0 && <ul className="pj-run-board">
            {run.board.slice(-3).map((entry, index) => <li key={`${run.id}-board-${index}`}>{entry.text}</li>)}
          </ul>}
          {run.status === 'completed' && run.digest && <p className="pj-run-digest">{run.digest}</p>}
          {run.error && <p className="pj-run-error">{run.error}</p>}
          <div className="pj-run-actions">
            {run.status === 'awaiting_approval' && <>
              <button type="button" className="pj-btn pj-primary pj-small" disabled={runBusy.startsWith(run.id)} onClick={() => void decideRun(run, 'approve')}><Check size={13} />{runBusy === `${run.id}:approve` ? '批准中…' : '批准计划'}</button>
              <button type="button" className="pj-btn pj-small" disabled={runBusy.startsWith(run.id)} onClick={() => void decideRun(run, 'reject')}>退回</button>
            </>}
            {['drafting', 'awaiting_approval', 'running', 'verifying', 'repairing'].includes(run.status) && <button type="button" className="pj-link" disabled={runBusy.startsWith(run.id)} onClick={() => void cancelRun(run)}><X size={12} />取消这次运行</button>}
          </div>
        </div>)}
      </div>}
      {threadTickets.length ? threadTickets.map(ticket => {
        const open = expandedTurns[ticket.id] === true;
        const trace = traces[ticket.id];
        const items = trace?.items || [];
        const agentName = EXECUTOR_LABELS[ticket.executor || ''] || EXECUTOR_LABELS[chat.executorId] || ticket.executor || chat.executorId;
        const stamp = new Date(ticket.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        return <div className="pj-turn" key={ticket.id} data-turn={ticket.id}>
          <div className="pj-turn-row pj-turn-user">
            <div className="pj-bubble pj-bubble-user">
              <p className="pj-bubble-text">{ticket.title}</p>
              <div className="pj-bubble-foot">
                <time>{stamp}</time>
                <button type="button" className="pj-bubble-delete" title="删除这条消息" aria-label="删除这条消息" onClick={() => removeMessage(ticket)}><Trash2 size={12} /></button>
              </div>
            </div>
          </div>
          <div className="pj-turn-row pj-turn-agent">
            <div className="pj-bubble pj-bubble-agent">
              <div className="pj-bubble-head">
                <span className="pj-agent-name"><Bot size={13} />{agentName}</span>
                <span className={`pj-agent-status is-${ticket.status}`}>{STATUS_LABELS[ticket.status] || ticket.status}</span>
                <time>{stamp}</time>
              </div>
              {ticket.summary ? <p className={`pj-bubble-text${open ? '' : ' pj-clamp'}`}>{ticket.summary}</p> : <p className="pj-bubble-text pj-bubble-muted">{ticket.status === 'awaiting_review' ? '等你确认后开始执行。' : ticket.status === 'queued' ? '排队中，还没开始。' : '还没有输出。'}</p>}
              <div className="pj-bubble-actions">
                <button type="button" className="pj-link" aria-expanded={open} onClick={() => void toggleTrace(ticket)}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{open ? '收起过程' : '展开思考过程'}</button>
                {ticket.status === 'awaiting_review' && onApprove && <button type="button" className="pj-btn pj-primary pj-small" onClick={() => onApprove(ticket.id)}><Check size={13} />确认执行</button>}
                <button type="button" className="pj-link" onClick={() => onOpenTicket(ticket.id)}>完整详情</button>
              </div>
              {open && <div className="pj-trace">
                {trace?.loading && <p className="pj-trace-empty">正在读取执行记录…</p>}
                {trace?.error && <p className="pj-trace-empty">{trace.error}</p>}
                {!trace?.loading && !trace?.error && (items.length
                  ? <ol className="pj-trace-list">{items.map((item, index) => <li key={`${ticket.id}-${index}`} className="pj-trace-item">
                    <span className="pj-trace-index">{index + 1}</span>
                    <div className="pj-trace-body">
                      <span className="pj-trace-text">{item.text || item.kind}</span>
                      {item.detail && <span className="pj-trace-detail">{item.detail}</span>}
                    </div>
                    {item.at && <time className="pj-trace-time">{new Date(item.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}
                  </li>)}</ol>
                  : <p className="pj-trace-empty">{ticket.status === 'queued' || ticket.status === 'awaiting_review' ? '还没开始执行，暂时没有过程记录。' : '这次执行没有留下步骤记录。'}</p>)}
              </div>}
            </div>
          </div>
        </div>;
      }) : <p className="pj-empty">还没有消息。在下方描述任务，确认后才会发送给 Agent。</p>}
    </div>
    <div className="pj-composer">
      <textarea value={chatDraft} onChange={event => setChatDraft(event.target.value)} rows={3} maxLength={3000} onKeyDown={event => { if (event.key !== 'Enter') return; if (event.nativeEvent.isComposing) return; if (event.shiftKey || event.altKey) return; event.preventDefault(); void send(); }} placeholder={chat.executorId === 'window' ? '描述要发送到该窗口 Agent 会话的指令…' : '描述要在该项目中完成的任务，例如：修复首页布局在窄屏下的溢出'} />
      {dispatchOpen && <div className="pj-dispatch">
        <span className="pj-dispatch-label">并行分派给</span>
        {dispatchExecutors.map(id => <button type="button" key={id} className={`pj-chip ${dispatchTargets.includes(id) ? 'on' : ''}`} aria-pressed={dispatchTargets.includes(id)} onClick={() => toggleDispatchTarget(id)}>{dispatchTargets.includes(id) ? <Check size={12} /> : <Plus size={12} />}{EXECUTOR_LABELS[id] || id}</button>)}
        <span className="pj-dispatch-hint">每个 Agent 各建一条待确认工单</span>
        <span className="pj-dispatch-actions">
          <button type="button" className="pj-link" onClick={() => setDispatchOpen(false)}>取消</button>
          <button type="button" className="pj-btn pj-primary pj-small" disabled={!dispatchTargets.length || dispatchBusy} onClick={() => void dispatch()}>{dispatchBusy ? '分派中…' : `分派给 ${dispatchTargets.length} 个 Agent`}</button>
        </span>
      </div>}
      {chat.executorId === 'model' && <ChatModelPicker
        chatId={chat.id}
        value={chatModel}
        onChange={next => { setChatModel(next); writeChatModel(chat.id, next); }}
        disabled={busy === 'send'}
      />}
      <div className="pj-composer-actions">
        {orchestratorOn && <button type="button" className={`pj-chip pj-orch${orchestrate ? ' on' : ''}`} aria-pressed={orchestrate} onClick={toggleOrchestrate} title="开着：先分析任务、拆成步骤、分配 Agent，批准后逐步执行并在验证不过时返工">{orchestrate ? <Check size={12} /> : <Plus size={12} />}深度编排</button>}
        <button type="button" className="pj-btn" disabled={!chatDraft.trim() || !dispatchExecutors.length} aria-expanded={dispatchOpen} onClick={toggleDispatchPanel}><Users size={14} />并行分派</button>
        <button type="button" className="pj-btn" disabled={!chatDraft.trim() || planBusy === 'suggest'} onClick={() => void startPlan()}><Sparkles size={14} />{planBusy === 'suggest' ? '拆解中…' : '拆成计划'}</button>
        <button type="button" className="pj-btn pj-primary" disabled={!chatDraft.trim() || busy === 'send'} onClick={() => void send()}><Send size={14} />{busy === 'send' ? '提交中…' : orchestrate ? '开始编排' : '发送（需审批）'}</button>
      </div>
      <p className="pj-note pj-note-bar">{orchestrate ? '深度编排：先分析任务、拆成步骤并分给合适的 Agent，批准后逐步执行，验证不过会自动返工（最多 2 轮）。危险操作仍会单独弹窗。' : '消息会创建待确认工单；批准后 CLI 会在项目目录内修改文件，窗口 Agent 会把指令发到已绑定的窗口。'}<button type="button" className="pj-link" onClick={openManualPlan}>手动编排计划</button><span className="sa-keyhint">Enter 发送 · Shift + Enter 换行</span></p>
    </div>
  </div> : null;

  return <section className={`pj-page${chatMode ? ' pj-chatpage' : ''}${projectMode ? ' pj-projectpage' : ''}`}>
    {chatMode && <>{chatHeader}{thread || <div className="pj-empty-block pj-placeholder"><p>选择一个对话。</p></div>}</>}
    {projectMode && <header className="pj-head">
      <div>
        <p className="pj-eyebrow"><FolderGit2 size={13} /> PROJECT</p>
        <h1>{project?.name || '项目'}</h1>
        <p className="pj-sub">{project ? `${project.path}${project.gitBranch ? ` · ${project.gitBranch}` : ''} · ${project.chatCount} 个对话` : '这个项目已不在列表里。'}</p>
      </div>
      <div className="pj-head-actions">
        <button type="button" className="pj-btn" onClick={() => onBackToProjects?.()}><ChevronLeft size={14} />全部项目</button>
        {project && <button type="button" className="pj-btn" onClick={() => void openSessions()} disabled={busy === 'sessions'}><Inbox size={14} />导入已有会话</button>}
        {project && <button type="button" className="pj-btn pj-primary" onClick={() => void openNewChat()}><Plus size={14} />新建对话</button>}
        <button type="button" className="pj-btn" onClick={() => void loadProjects()} disabled={loading}><RefreshCw size={14} className={loading ? 'pj-spin' : ''} />刷新</button>
      </div>
    </header>}
    {!chatMode && <header className="pj-head" hidden={projectMode}>
      <div>
        <p className="pj-eyebrow"><FolderGit2 size={13} /> PROJECTS</p>
        <h1>项目</h1>
        <p className="pj-sub">导入本地文件夹，接管 Claude Code / Codex 已有的项目会话；消息审批后会在同一会话中修改项目文件。</p>
      </div>
      <div className="pj-head-actions">
        <button type="button" className="pj-btn" onClick={() => void loadProjects()} disabled={loading}><RefreshCw size={14} className={loading ? 'pj-spin' : ''} />刷新</button>
        <button type="button" className="pj-btn" onClick={() => void pickFolder()} disabled={busy === 'import'}><Plus size={15} />导入文件夹</button>
      </div>
    </header>}

    {!chatMode && editorOpen && <form className="pj-editor" onSubmit={event => { event.preventDefault(); void importProject(pathDraft, nameDraft); }}>
      <label>文件夹绝对路径<input value={pathDraft} onChange={event => setPathDraft(event.target.value)} placeholder="例如 D:\\work\\my-project" autoFocus /></label>
      <label>显示名称（可选）<input value={nameDraft} onChange={event => setNameDraft(event.target.value)} placeholder="默认使用文件夹名" /></label>
      <div className="pj-editor-actions">
        <button type="button" className="pj-btn" onClick={() => setEditorOpen(false)}>取消</button>
        <button type="submit" className="pj-btn pj-primary" disabled={busy === 'import' || !pathDraft.trim()}>{busy === 'import' ? '导入中…' : '导入'}</button>
      </div>
    </form>}

    {!chatMode && <div className={`pj-layout${projectMode ? ' pj-layout-single' : ''}`}>
      {!projectMode && <aside className="pj-projects">
        <div className="pj-side-title"><span>已导入的项目</span><span>{projects.length}</span></div>
        {loading ? <p className="pj-empty">载入中…</p> : projects.length ? <ul>
          {projects.map(item => <li key={item.id}>
            <button type="button" className={`pj-project ${item.id === activeProjectId ? 'active' : ''}`} onClick={() => setActiveProjectId(item.id)}>
              <span className="pj-project-name">{item.name}</span>
              <span className="pj-project-meta">{item.gitBranch ? <><GitBranch size={11} />{item.gitBranch}</> : '非 Git 目录'} · {item.chatCount} 个对话</span>
              <span className="pj-project-path">{item.path}</span>
            </button>
            <button type="button" className="pj-icon" aria-label={`移除 ${item.name}`} disabled={busy === `delete-${item.id}`} onClick={() => void removeProject(item)}><Trash2 size={13} /></button>
          </li>)}
        </ul> : <div className="pj-empty-block"><p>还没有导入项目。</p><p>选择本地文件夹，或粘贴绝对路径。</p></div>}
      </aside>}

      <div className="pj-main">
        {!project ? <div className="pj-empty-block pj-placeholder"><FolderGit2 size={26} /><p>导入一个本地文件夹开始。</p></div> : <>
          {!projectMode && <div className="pj-project-head">
            <div>
              <h2>{project.name}</h2>
              <p>{project.path}{project.gitBranch ? ` · ${project.gitBranch}` : ''}</p>
            </div>
            <div className="pj-head-actions">
              <button type="button" className="pj-btn" onClick={() => void openSessions()} disabled={busy === 'sessions'}><Inbox size={14} />导入已有会话</button>
              <button type="button" className="pj-btn" onClick={() => void openNewChat()}><Plus size={14} />新建对话</button>
            </div>
          </div>}



          <div className="pj-tabs">
            <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><Bot size={13} />对话</button>
            <button type="button" className={tab === 'archive' ? 'active' : ''} onClick={openArchive}><History size={13} />变更档案</button>
            <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={openMemory}><Brain size={13} />项目记忆</button>
          </div>

          {tab === 'chat' && sessionsOpen && <div className="pj-sessions">
            <div className="pj-sessions-head"><strong>该项目可导入的 Agent 会话</strong><button type="button" className="pj-link" onClick={() => setSessionsOpen(false)}>收起</button></div>
            {sessions === null || busy === 'sessions' ? <p className="pj-empty">正在扫描 Claude Code 与 Codex 的本地会话…</p> : sessions.length ? <ul>
              {sessions.map(row => <li key={`${row.executorId}:${row.sessionId}`}>
                <span className="pj-session-agent">{EXECUTOR_LABELS[row.executorId] || row.executorId}</span>
                <span className="pj-session-title">{row.title}</span>
                <time>{new Date(row.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
                <button type="button" className="pj-btn pj-small" disabled={row.imported || busy === `session-${row.executorId}-${row.sessionId}`} onClick={() => void importSession(row)}>{row.imported ? '已导入' : busy === `session-${row.executorId}-${row.sessionId}` ? '导入中…' : '导入'}</button>
              </li>)}
            </ul> : <p className="pj-empty">没有找到属于该目录的会话。可以先新建对话，或在该目录运行一次 Agent。</p>}
          </div>}

          {tab === 'chat' && newChatOpen && <div className="pj-newchat">
            <div className="pj-newchat-agents">
              <span>Agent</span>
              <div className="pj-newchat-chips">
                {(allowedExecutors.length ? allowedExecutors : ['claude-code', 'codex']).map(id => {
                  const on = newExecutors.includes(id);
                  return <button type="button" key={id} className={`pj-chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggleNewExecutor(id)}>{on && <Check size={11} />}{EXECUTOR_LABELS[id] || id}</button>;
                })}
              </div>
              <small>{newExecutors.includes('window') ? '窗口 Agent 会把同一条任务发送到你选定的那个窗口，其余 Agent 在项目目录里执行；每个 Agent 各有一条待确认工单。' : '可选多个 Agent；多选时会用同一条任务并行分派，每个 Agent 各有一条待确认工单。'}</small>
            </div>
            {newExecutors.includes('window') && <label>目标窗口<select value={windowId} onChange={event => setWindowId(event.target.value)}><option value="">选择窗口…</option>{windows.map(item => <option key={item.id} value={item.id}>{item.process} · {item.title}</option>)}</select></label>}
            <label>对话标题（可选）<input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="例如 修复登录页" /></label>
            <label>任务（可选）<textarea rows={3} maxLength={3000} value={newTask} onChange={event => setNewTask(event.target.value)} placeholder={newExecutors.length > 1 ? '写下要一起完成的任务，创建后立即并行分派' : '写下要完成的任务，创建后立即提交（仍需审批）'} /></label>
            <div className="pj-editor-actions">
              <button type="button" className="pj-btn" onClick={() => setNewChatOpen(false)}>取消</button>
              <button type="button" className="pj-btn pj-primary" disabled={busy === 'new-chat'} onClick={() => void createChat()}>{busy === 'new-chat' ? '创建中…' : newExecutors.length > 1 ? `分派给 ${newExecutors.length} 个 Agent` : '创建'}</button>
            </div>
          </div>}

          {tab === 'memory' ? <div className="pj-memory">
            <div className="pj-card-head">
              <strong>项目记忆</strong>
              <button type="button" className="pj-link" onClick={() => void loadMemory()} disabled={memoryBusy === 'load'}>{memoryBusy === 'load' ? '读取中…' : '刷新'}</button>
            </div>
            <p className="pj-note">每次执行结束后自动记下「谁改了什么、改进了什么、还欠什么」。新会话、新的计划都会先读到这段记忆，不必从头讲一遍。</p>
            {memory === null || memoryBusy === 'load'
              ? <p className="pj-empty">正在读取项目记忆…</p>
              : memory.entries.length === 0
                ? <p className="pj-empty">还没有记忆。在这个项目里跑完一次任务后，会自动出现第一条。</p>
                : <>
                  <pre className="pj-memory-digest">{memory.digest}</pre>
                  <ul className="pj-memory-list">
                    {memory.entries.map(entry => <li key={entry.id} className="pj-memory-item">
                      <div className="pj-memory-head">
                        <strong>{entry.title}</strong>
                        <span>{EXECUTOR_LABELS[entry.executorId || ''] || entry.executorId || 'Agent'} · {new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      {entry.summary && <p>{entry.summary}</p>}
                      {entry.improvements.length > 0 && <ul className="pj-memory-points">
                        {entry.improvements.map(item => <li key={item}>改进：{item}</li>)}
                      </ul>}
                      {entry.openQuestions.length > 0 && <ul className="pj-memory-points is-open">
                        {entry.openQuestions.map(item => <li key={item}>待办：{item}</li>)}
                      </ul>}
                      {entry.files.length > 0 && <p className="pj-memory-files">{entry.files.slice(0, 6).join('、')}{entry.files.length > 6 ? ` 等 ${entry.files.length} 个文件` : ''}</p>}
                      <div className="pj-memory-foot">
                        <span>{entry.source === 'model' ? `模型总结${entry.model?.model ? ` · ${entry.model.model}` : ''}` : '自动记录'}</span>
                        <button type="button" className="pj-link pj-danger" onClick={() => void removeMemory(entry.id)}><Trash2 size={12} />删除</button>
                      </div>
                    </li>)}
                  </ul>
                </>}
          </div> : tab === 'archive' ? <div className="pj-archive">
            <div className="pj-archive-grid">
              <section className="pj-card">
                <div className="pj-card-head">
                  <strong>项目简报</strong>
                  <button type="button" className="pj-link" onClick={() => void copyBriefMarkdown()} disabled={archiveBusy === 'copy'}><ClipboardCopy size={12} />{archiveBusy === 'copy' ? '复制中…' : '复制 Agent 简报'}</button>
                </div>
                <p className="pj-note">简报会与变更记录一起导出为 Markdown；其他 Agent 读取本软件即可了解项目目标、关键决定与最新改动。</p>
                <label className="pj-field">项目目标<textarea rows={2} maxLength={300} value={briefDraft.goal} onChange={event => setBriefDraft(current => ({ ...current, goal: event.target.value }))} placeholder="这个项目要解决的核心问题" /></label>
                <label className="pj-field">当前进展<textarea rows={3} maxLength={4000} value={briefDraft.summary} onChange={event => setBriefDraft(current => ({ ...current, summary: event.target.value }))} placeholder="已完成什么、正在进行什么" /></label>
                <div className="pj-field-row">
                  <label className="pj-field">任务要点（每行一条）<textarea rows={4} value={briefDraft.keyPoints} onChange={event => setBriefDraft(current => ({ ...current, keyPoints: event.target.value }))} placeholder="首页在窄屏下溢出" /></label>
                  <label className="pj-field">关键决定（每行一条）<textarea rows={4} value={briefDraft.decisions} onChange={event => setBriefDraft(current => ({ ...current, decisions: event.target.value }))} placeholder="只隐藏入口，保留后端代码" /></label>
                </div>
                <label className="pj-field">约束与边界（每行一条）<textarea rows={3} value={briefDraft.constraints} onChange={event => setBriefDraft(current => ({ ...current, constraints: event.target.value }))} placeholder="不覆盖窗口草稿；不提交、不打包" /></label>
                <div className="pj-editor-actions">
                  <span className="pj-note">{archiveBusy === 'load' ? '读取中…' : brief?.updatedAt ? `上次更新 ${new Date(brief.updatedAt).toLocaleString('zh-CN')}` : '尚未编辑'}</span>
                  <button type="button" className="pj-btn pj-primary" onClick={() => void saveBrief()} disabled={archiveBusy === 'save'}><Save size={14} />{archiveBusy === 'save' ? '保存中…' : '保存简报'}</button>
                </div>
              </section>
              <section className="pj-card">
                <div className="pj-card-head"><strong>变更记录</strong><span className="pj-count">{changes.length}</span></div>
                <div className="pj-change-form">
                  <input value={changeTitle} onChange={event => setChangeTitle(event.target.value)} maxLength={200} placeholder="变更标题，例如 修复窄屏溢出" />
                  <textarea rows={2} value={changeSummary} onChange={event => setChangeSummary(event.target.value)} maxLength={4000} placeholder="摘要：改了什么、为什么、影响范围" />
                  <button type="button" className="pj-btn" onClick={() => void addChange()} disabled={archiveBusy === 'add'}><Plus size={13} />{archiveBusy === 'add' ? '记录中…' : '补充一条变更'}</button>
                </div>
                {archiveBusy === 'load' && !changes.length ? <p className="pj-empty">读取中…</p> : changes.length ? <ul className="pj-changes">
                  {changes.map(change => <li key={change.id}>
                    <div className="pj-change-head">
                      <span className={`pj-tag ${change.source}`}>{change.source === 'auto' ? '自动' : '手动'}</span>
                      <strong>{change.title}</strong>
                      <time>{new Date(change.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
                      <button type="button" className="pj-icon" aria-label="删除变更" disabled={archiveBusy === `delete-${change.id}`} onClick={() => void removeChange(change)}><Trash2 size={12} /></button>
                    </div>
                    {change.summary && <p>{change.summary}</p>}
                    <div className="pj-change-meta">
                      <span>{change.executorId ? EXECUTOR_LABELS[change.executorId] || change.executorId : change.source === 'auto' ? '自动记录' : '手动记录'} · {STATUS_LABELS[change.status] || change.status}</span>
                      {change.files.length > 0 && <span title={change.files.join('\n')}>{change.files.slice(0, 3).join(' · ')}{change.files.length > 3 ? ` 等 ${change.files.length} 个文件` : ''}</span>}
                    </div>
                  </li>)}
                </ul> : <p className="pj-empty">Agent 完成项目任务后会自动记录摘要与改动文件；也可以手动补充。</p>}
              </section>
            </div>
          </div> : <div className="pj-work">
            <div className="pj-chats">
              <div className="pj-side-title"><span>项目对话</span><span>{project.chats.filter(item => !item.parentChatId).length}</span></div>
              {project.chats.filter(item => !item.parentChatId).length ? <ul>
                {project.chats.filter(item => !item.parentChatId).map(item => {
                  const subs = project.chats.filter(entry => entry.parentChatId === item.id).length;
                  return <li key={item.id} className={item.id === activeChatId ? 'active' : ''}>
                  <button type="button" className="pj-chat" onClick={() => onOpenChat ? onOpenChat(project.id, item.id) : setActiveChatId(item.id)}>
                    <span className="pj-chat-title"><Bot size={12} />{item.title}{subs > 0 && <em className="pj-chat-sub">{subs} 个 Agent</em>}<ChevronRight size={12} className="pj-chat-open" /></span>
                    <span className="pj-chat-meta">{EXECUTOR_LABELS[item.executorId] || item.executorId} · {item.source === 'imported' ? '已导入会话' : item.executorId === 'window' ? '发送到窗口' : item.writable ? '可修改项目' : '只读'}</span>
                    {item.lastSummary && <span className="pj-chat-summary">{item.lastSummary}</span>}
                  </button>
                  <button type="button" className="pj-icon" aria-label="删除对话" disabled={busy === `delete-chat-${item.id}`} onClick={() => void removeChat(item)}><Trash2 size={13} /></button>
                </li>;})}
              </ul> : <p className="pj-empty">还没有项目对话。可导入已有会话，或新建一个。</p>}
            </div>

          </div>}
        </>}
      </div>
    </div>}

    {browserOpen && <div className="pj-plan">
      <div className="pj-plan-card pj-browser">
        <header><strong>选择项目文件夹</strong><button type="button" className="pj-link" onClick={() => setBrowserOpen(false)}>关闭</button></header>
        <p className="pj-browser-path">{browserData?.path || '此电脑'}</p>
        <div className="pj-browser-list">
          {browserData?.parent && <button type="button" onClick={() => void loadDirectory(browserData.parent as string)}>↑ 上一级</button>}
          {browserBusy ? <p className="pj-empty">读取中…</p> : browserData?.entries.length ? browserData.entries.map(entry => <button type="button" key={entry.path} title={entry.path} onClick={() => void loadDirectory(entry.path)}>{entry.isDir ? <Folder size={14} /> : <FileIcon size={14} />} {entry.name}</button>) : <p className="pj-empty">没有子文件夹。</p>}
        </div>
        {browserData?.truncated && <p className="pj-note">文件夹过多，仅显示前 500 个。</p>}
        <footer>
          <button type="button" className="pj-btn" onClick={() => { setBrowserOpen(false); setEditorOpen(true); }}>手动输入路径</button>
          <span className="pj-head-actions">
            <button type="button" className="pj-btn" onClick={() => setBrowserOpen(false)}>取消</button>
            <button type="button" className="pj-btn pj-primary" disabled={!browserData?.path || busy === 'import'} onClick={() => { const target = browserData?.path; setBrowserOpen(false); if (target) void importProject(target); }}>导入此文件夹</button>
          </span>
        </footer>
      </div>
    </div>}

    {planOpen && <div className="pj-plan">
      <div className="pj-plan-card">
        <header><strong>项目拆解</strong><button type="button" className="pj-link" onClick={() => setPlanOpen(false)}>关闭</button></header>
        <label className="pj-field"><span>计划目标</span><input value={planGoal} maxLength={300} onChange={event => setPlanGoal(event.target.value)} placeholder="这次要完成什么" /></label>
        <ol>{planSteps.map((step, index) => <li key={index}>
          <select
            value={step.executorId}
            aria-label={`第 ${index + 1} 步执行的 Agent`}
            onChange={event => {
              const executorId = event.target.value;
              setPlanSteps(current => current.map((item, position) => position === index ? { ...item, executorId } : item));
            }}
          >
            {(planExecutors.includes(step.executorId) ? planExecutors : [step.executorId, ...planExecutors]).map(id => <option key={id} value={id}>{EXECUTOR_LABELS[id] || id}</option>)}
          </select>
          <input
            className="pj-plan-text"
            value={step.text}
            maxLength={3000}
            aria-label={`第 ${index + 1} 步说明`}
            placeholder={index === 0 ? '第一步做什么' : '下一步做什么'}
            onChange={event => {
              const text = event.target.value;
              setPlanSteps(current => current.map((item, position) => position === index ? { ...item, text } : item));
            }}
          />
          {step.dependsOn?.length ? <em>依赖第 {step.dependsOn.map(item => item + 1).join('、')} 步</em> : null}
          {planSteps.length > 2 && <button type="button" className="pj-link" aria-label={`删除第 ${index + 1} 步`} onClick={() => removePlanStep(index)}>删除</button>}
        </li>)}</ol>
        <button type="button" className="pj-link" disabled={planSteps.length >= 5} onClick={addPlanStep}>+ 添加步骤</button>
        <p className="pj-note">每步可以选择不同的 Agent；未建立对话的 Agent 会在创建计划时自动建立项目对话。也可以不用 AI，直接手动编排。</p>
        <footer>
          <button type="button" className="pj-btn" onClick={() => setPlanOpen(false)}>取消</button>
          <button type="button" className="pj-btn pj-primary" disabled={planBusy === 'create'} onClick={() => void createPlan()}>{planBusy === 'create' ? '创建中…' : '创建计划'}</button>
        </footer>
      </div>
    </div>}
    {confirm && <Modal title={confirm.title} subtitle={confirm.quote ? '这一步无法撤销。' : confirm.body} close={() => { if (!confirmBusy) setConfirm(null); }}>
      <div className="pj-confirm">
        {confirm.quote && <blockquote className="pj-confirm-quote">{confirm.quote}</blockquote>}
        {confirm.notes && confirm.notes.length > 0 && <ul className="pj-confirm-notes">{confirm.notes.map(note => <li key={note}>{note}</li>)}</ul>}
        <footer>
          <button type="button" className="pj-btn" disabled={confirmBusy} onClick={() => setConfirm(null)}>取消</button>
          <button type="button" className="pj-btn pj-danger" disabled={confirmBusy} onClick={async () => {
            setConfirmBusy(true);
            try { await confirm.run(); setConfirm(null); }
            finally { setConfirmBusy(false); }
          }}>{confirmBusy ? '处理中…' : confirm.label}</button>
        </footer>
      </div>
    </Modal>}
  </section>;
}
