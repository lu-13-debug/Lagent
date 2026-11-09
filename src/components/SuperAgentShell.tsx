import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Activity, AlertTriangle, AppWindow, Bot, Brain, Check, ChevronRight, Clock, Database, FolderGit2, GitBranch, Globe, Inbox, Menu, MessageSquare, MoreHorizontal, Pin, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Smartphone, Sparkles, Square, SunMoon, Terminal, Users, Wrench, X } from 'lucide-react';
import { api } from '../api';
import { useAppearance } from '../appearance-context';
import type { Settings, User } from '../types';
import type { WorkAction, WorkBootstrap, WorkInboxItem, WorkPlan, WorkPolicy, WorkProject, WorkProjectChat, WorkReport, WorkTicket, WorkTicketDetail } from '../superagent';
import { MemoryPanel } from './MemoryPanel';
import { ProjectsPanel } from './ProjectsPanel';
import { AppearanceSettings } from './AppearanceSettings';
import { SettingsModal } from './ModelSettings';
import { Logo, Modal, Toast } from './ui';
import '../superagent.css';

type ShellView = 'command' | 'inbox' | 'parallel' | 'projects' | 'agents' | 'tools' | 'memory' | 'settings';
const navItems: { id: ShellView; label: string; icon: typeof Terminal }[] = [
  { id: 'inbox', label: '收件箱', icon: Inbox },
  { id: 'parallel', label: '并行', icon: Activity },
  { id: 'agents', label: 'Agent', icon: Bot },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'memory', label: '记忆', icon: Brain },
  { id: 'settings', label: '设置', icon: Settings2 },
];
const statusNames: Record<string, string> = {
  queued: '排队中', working: '执行中', awaiting_review: '待确认', blocked: '受阻',
  failed: '失败', waiting: '等待触发', completed: '已完成', cancelled: '已停止',
  pending: '待执行', running: '执行中', accepted: '已接受',
  connected: '可用', available: '可用', needs_setup: '未就绪', needs_auth: '需授权',
  ready: '可用', not_installed: '未安装', unavailable: '不可用',
};
const reportKindNames: Record<string, string> = { ready: '已就绪', failed: '失败', blocked: '受阻', cancelled: '已停止' };
const proposalNames: Record<string, string> = { proposed: '待决策', needsApproval: '需确认', accepted: '已接受', rejected: '已拒绝' };
const quickCommands = ['检查 GitHub 仓库状态', '浏览网页并总结', '运行终端命令'];
const executorIds = ['terminal', 'codex', 'claude-code', 'claude-acp', 'codex-acp', 'dsh-acp', 'browser', 'github', 'window'];
const executorNames: Record<string, string> = { analysis: '数据分析', terminal: '受控终端', codex: 'Codex CLI', 'claude-code': 'Claude Code', 'claude-acp': 'Claude ACP', 'codex-acp': 'Codex ACP', 'dsh-acp': 'DSH ACP', opencode: 'OpenCode', gemini: 'Gemini CLI', qwen: 'Qwen Code', 'cursor-agent': 'Cursor Agent', dsh: 'DSH CLI', browser: '浏览器', github: 'GitHub', window: '窗口 Agent' };
// 可在对话/项目里直接派活的执行器（不含終端、浏览器、GitHub 这类内置工具）。
const conversationExecutorIds = ['analysis', 'codex', 'claude-code', 'claude-acp', 'codex-acp', 'dsh-acp', 'opencode', 'gemini', 'qwen', 'cursor-agent', 'dsh'];
// 项目工作文件夹里能建会话的执行器：数据分析是内置工具，需要在数据集上跑，不能进项目。
const projectExecutorIds = ['window', ...conversationExecutorIds.filter(id => id !== 'analysis')];
const terminalStatuses = ['completed', 'failed', 'blocked', 'cancelled'];
const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const shortTime = (value?: string) => {
  if (!value) return '–';
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};
const CROSS_CHECK_KEY = 'dataagent.crosschecks.v1';
const windowKey = (handle: number) => `win:${handle}`;
const agentIcon = (id: string, size = 20) => id === 'analysis' ? <Database size={size} /> : id === 'terminal' ? <Terminal size={size} /> : id === 'browser' ? <Globe size={size} /> : id === 'github' ? <GitBranch size={size} /> : id === 'window' ? <AppWindow size={size} /> : <Bot size={size} />;
const toolIcon = (id: string, size = 20) => id === 'terminal' ? <Terminal size={size} /> : id === 'browser' ? <Globe size={size} /> : id === 'github' ? <GitBranch size={size} /> : id === 'window' ? <AppWindow size={size} /> : <Wrench size={size} />;

function Status({ status }: { status: string }) {
  return <span className={`sa-status sa-status-${status}`}>{statusNames[status] || status}</span>;
}

function reportText(detail?: WorkTicketDetail | null): string {
  if (!detail) return '';
  const reports = detail.reports || [];
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    const artifacts = reports[index].artifacts as Record<string, any> | undefined;
    const value = artifacts?.acp?.text || artifacts?.cli?.summary || artifacts?.window?.text || artifacts?.report?.summary;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return reports[reports.length - 1]?.summary || detail.ticket.summary || '';
}

function sliceBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= max) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, middle)).length <= max) low = middle;
    else high = middle - 1;
  }
  return `${text.slice(0, low)}\n…（已截断）`;
}

type CrossCheck = { id: string; prompt: string; agentIds: string[]; ticketIds: string[]; createdAt: string; synthesisTicketId?: string; synthesisAgentId?: string };

function loadCrossChecks(): CrossCheck[] {
  try {
    const raw = localStorage.getItem(CROSS_CHECK_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CrossCheck => Boolean(item && typeof item.id === 'string' && typeof item.prompt === 'string' && Array.isArray(item.agentIds) && Array.isArray(item.ticketIds))).slice(0, 30);
  } catch { return []; }
}

const reportIcon = (report: WorkReport) => {
  if (report.kind === 'failed' || report.kind === 'blocked') return AlertTriangle;
  if (report.kind === 'ready') return Check;
  if (report.kind === 'progress') return Activity;
  return Clock;
};

// 草稿与已读位置都存在 localStorage：草稿按会话分开，避免把 A 会话打了一半的指令发到 B。
const DRAFTS_KEY = 'dataagent.drafts.v1';
const CHAT_SEEN_KEY = 'dataagent.chatseen.v1';
const SIDEBAR_WIDTH_KEY = 'dataagent.sidebarw.v1';
const PINNED_KEY = 'dataagent.pinnedfolders.v1';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 隐私模式忽略。*/ }
}

const projectExecutors = ['claude-code', 'codex', 'claude-acp', 'dsh-acp', 'codex-acp'];
const unreadStatuses = ['completed', 'failed', 'blocked', 'awaiting_review'];

export function SuperAgentShell({ user, runtime, settings, onSettingsSaved, notify: pushNotify }: {
  user?: User | null; runtime: { mode: 'local' | 'cloud' }; settings: Settings;
  onSettingsSaved: (settings: Settings) => void; notify: (text: string, error?: boolean) => void;
}) {
  const appearance = useAppearance();
  // 主壳自己渲染提示条：App 的 Toast 只在分析工作台分支里挂载，超级 Agent 分支拿不到。
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => { pushNotify(text, error); setToast({ text, error }); }, [pushNotify]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4200); return () => clearTimeout(timer); }, [toast]);
  // 视图与选中项目写进 URL（replaceState，不产生历史记录），刷新后能回到原处。
  const [view, setView] = useState<ShellView>(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('view');
    const known: ShellView[] = ['command', 'inbox', 'projects', 'agents', 'tools', 'memory', 'settings'];
    if (known.includes(raw as ShellView)) return raw as ShellView;
    return params.get('project') ? 'projects' : 'command';
  });
  const [convQuery, setConvQuery] = useState('');
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === 'command') url.searchParams.delete('view');
    else url.searchParams.set('view', view);
    window.history.replaceState(null, '', url);
  }, [view]);
  const [navOpen, setNavOpen] = useState(false);
  const [work, setWork] = useState<WorkBootstrap | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [detail, setDetail] = useState<WorkTicketDetail | null>(null);
  const [projectFocus, setProjectFocus] = useState<string | null>(null);
  const [chatFocus, setChatFocus] = useState<string | null>(null);
  const [importTick, setImportTick] = useState(0);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [folderState, setFolderState] = useState<{ projects: WorkProject[]; projectId: string | null; chatId: string | null }>({ projects: [], projectId: null, chatId: null });
  const [planDetail, setPlanDetail] = useState<WorkPlan | null>(null);
  const [handoffExecutor, setHandoffExecutor] = useState('');
  const [handoffText, setHandoffText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [localSettings, setLocalSettings] = useState(settings);
  const eventRef = useRef<EventSource | null>(null);

  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
  const [projects, setProjects] = useState<WorkProject[] | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<WorkTicketDetail | null>(null);
  const [crossChecks, setCrossChecks] = useState<CrossCheck[]>(() => loadCrossChecks());
  const [groupDetails, setGroupDetails] = useState<Record<string, WorkTicketDetail>>({});
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['claude-acp']);
  // 多 Agent 的两种用法：拆分分发（先拆成子任务再分派）与并行对比（同一问题各自作答）。
  const [dispatchMode, setDispatchMode] = useState<'split' | 'compare'>('split');
  const [parallelDetails, setParallelDetails] = useState<Record<string, WorkTicketDetail>>({});
  // 新对话绑定的工作文件夹：选中后指令会作为项目任务分派，Agent 在该目录内读写。
  const [newFolder, setNewFolder] = useState<string>(() => { try { return localStorage.getItem('dataagent.newchatfolder.v1') || ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem('dataagent.newchatfolder.v1', newFolder); } catch { /* 存储禁用时仅当前会话生效。 */ } }, [newFolder]);
  const [synthesisAgent, setSynthesisAgent] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

  // 草稿按「会话」分桶：新对话、某个工单、某组交叉验证各存一份。
  const [drafts, setDrafts] = useState<Record<string, string>>(() => readJson<Record<string, string>>(DRAFTS_KEY, {}));
  const draftKey = activeGroupId ? `group:${activeGroupId}` : activeTicketId ? `ticket:${activeTicketId}` : 'new';
  const command = drafts[draftKey] || '';
  const setCommand = (value: string) => {
    setDrafts(previous => (previous[draftKey] === value ? previous : { ...previous, [draftKey]: value }));
  };
  useEffect(() => { writeJson(DRAFTS_KEY, drafts); }, [drafts]);
  const [chatSeen, setChatSeen] = useState<Record<string, string>>(() => readJson<Record<string, string>>(CHAT_SEEN_KEY, {}));
  const [pinnedProjects, setPinnedProjects] = useState<string[]>(() => readJson<string[]>(PINNED_KEY, []));
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => Number(readJson<number>(SIDEBAR_WIDTH_KEY, 0)) || 0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [folderMenu, setFolderMenu] = useState<string | null>(null);
  const [folderRename, setFolderRename] = useState<{ id: string; value: string } | null>(null);
  const [chatRename, setChatRename] = useState<{ projectId: string; chatId: string; value: string } | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<WorkProject | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try { setWork(await api.workBootstrap()); }
    catch (cause) { setError((cause as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    try {
      source = new EventSource('/api/work/events');
      source.onmessage = () => void load();
      source.onerror = () => { source?.close(); source = null; if (!timer) timer = setInterval(() => void load(), 15000); };
      eventRef.current = source;
    } catch { timer = setInterval(() => void load(), 15000); }
    return () => { source?.close(); eventRef.current?.close(); if (timer) clearInterval(timer); };
  }, []);
  const attention = work?.attention || [];
  const tickets = work?.tickets || [];
  const datasets = work?.datasets || [];
  const agents = work?.agents || [];
  const plans = work?.plans || [];
  const tools = work?.tools || [];
  const loadWindows = async (quiet = false) => {
    setWindowsLoading(true);
    try { setWindows((await api.workWindows()).windows); }
    catch (cause) { if (!quiet) notify((cause as Error).message, true); }
    finally { setWindowsLoading(false); }
  };
  const loadProviders = async (refresh = false) => {
    setProvidersLoading(true);
    try { setProviders((await api.workProviders(refresh)).providers); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setProvidersLoading(false); }
  };
  useEffect(() => { if (view === 'agents') { void loadWindows(); void loadProviders(); } }, [view]);
  useEffect(() => {
    let live = true;
    api.workProjects()
      .then(result => { if (live) { setProjects(result.projects); setFolderState(prev => ({ ...prev, projects: result.projects })); } })
      .catch(() => { if (live) setProjects([]); });
    return () => { live = false; };
  }, [view === 'projects']);
  useEffect(() => { void loadWindows(true); }, []);
  useEffect(() => { if (planOpen) void loadWindows(); }, [planOpen]);
  const sendToWindow = async (window: { id: string; process: string }) => {
    const text = windowDrafts[window.id]?.trim();
    if (!text) return;
    try {
      await api.sendWorkWindow(window.id, text, true);
      setWindowDrafts(previous => ({ ...previous, [window.id]: '' }));
      notify(`已发送到 ${window.process} 窗口。`);
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const readFromWindow = async (window: { id: string; process: string }) => {
    try {
      const result = await api.readWorkWindow(window.id);
      setWindowOutputs(previous => ({ ...previous, [window.id]: result.text }));
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const allowedExecutors = work?.policy?.allowedExecutors || [];
  const [policy, setPolicy] = useState<WorkPolicy | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [windows, setWindows] = useState<{ id: string; handle: number; pid: number; process: string; title: string }[]>([]);
  const [windowDrafts, setWindowDrafts] = useState<Record<string, string>>({});
  const [windowOutputs, setWindowOutputs] = useState<Record<string, string>>({});
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [providers, setProviders] = useState<{ id: string; name: string; executorId?: string | null; kind?: string; command: string | null; installed: boolean; version: string | null; status: string; message: string; auth: { loggedIn: boolean | null; method: string | null; message: string } }[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [executorBusy, setExecutorBusy] = useState('');
  const [showMissing, setShowMissing] = useState(false);
  useEffect(() => { if (work?.policy) setPolicy(work.policy); }, [work?.policy]);
  const savePolicy = async () => {
    if (!policy || policySaving) return;
    setPolicySaving(true);
    try { const saved = await api.updateWorkPolicy(policy); setPolicy(saved.policy); await refresh(); notify('执行器策略已保存。'); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setPolicySaving(false); }
  };
  const toggleExecutor = (id: string) => setPolicy(previous => {
    if (!previous) return previous;
    const current = previous.allowedExecutors || [];
    return { ...previous, allowedExecutors: current.includes(id) ? current.filter(item => item !== id) : [...current, id] };
  });
  // 开关即时落盘：读最新的 work.policy（避免设置页未保存的本地编辑互相覆盖）。
  const setExecutorEnabled = async (id: string, enabled: boolean) => {
    const base = work?.policy || policy;
    if (!base || executorBusy) return;
    const current = base.allowedExecutors || [];
    const nextList = enabled ? [...new Set([...current, id])] : current.filter(item => item !== id);
    if (nextList.length === current.length && enabled === current.includes(id)) return;
    setExecutorBusy(id);
    try {
      const saved = await api.updateWorkPolicy({ ...base, allowedExecutors: nextList });
      setPolicy(saved.policy);
      await refresh();
      notify(`${executorNames[id] || id}${enabled ? ' 已启用，可在新对话里选择' : ' 已停用'}。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setExecutorBusy(''); }
  };
  const setBudget = (key: 'maxConcurrent' | 'maxCallsPerTicket' | 'maxRuntimeMs' | 'maxTokensPerTicket', value: number) => setPolicy(previous => previous ? { ...previous, budgets: { ...(previous.budgets || { maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 200000 }), [key]: value } } : previous);
  const [mobilePair, setMobilePair] = useState<{ code: string; expiresAt: string } | null>(null);
  const [mobileDevices, setMobileDevices] = useState<{ id: string; name: string; createdAt: string; expiresAt: string }[]>([]);
  const [mobileBusy, setMobileBusy] = useState('');
  const [mobileNow, setMobileNow] = useState(Date.now());
  const [mcpToken, setMcpToken] = useState<{ endpoint: string; token: string; expiresAt: string } | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const loadMobileDevices = async () => {
    try { setMobileDevices((await api.mobileDevices()).devices); }
    catch { /* 旧版本或未启用 Work 时保持空列表。*/ }
  };
  useEffect(() => { if (view === 'settings') void loadMobileDevices(); }, [view]);
  useEffect(() => {
    if (!mobilePair) return;
    const timer = setInterval(() => setMobileNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [mobilePair]);
  const createMobilePair = async () => {
    if (mobileBusy) return;
    setMobileBusy('pair');
    try {
      const pair = await api.mobilePair();
      setMobilePair(pair); setMobileNow(Date.now());
      await loadMobileDevices();
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setMobileBusy(''); }
  };
  const revokeMobileDevice = async (id: string) => {
    if (mobileBusy) return;
    setMobileBusy(id);
    try { await api.revokeMobileDevice(id); await loadMobileDevices(); notify('已撤销该手机设备。'); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setMobileBusy(''); }
  };
  const mobilePairSeconds = mobilePair ? Math.max(0, Math.ceil((Date.parse(mobilePair.expiresAt) - mobileNow) / 1000)) : 0;
  const createMcpToken = async () => {
    if (mcpBusy) return;
    setMcpBusy(true);
    try { setMcpToken(await api.mcpToken()); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setMcpBusy(false); }
  };
  const [datasetId, setDatasetId] = useState('');
  const [attentionDatasets, setAttentionDatasets] = useState<Record<string, string>>({});
  const [terminalProgram, setTerminalProgram] = useState('git');
  const [terminalArgs, setTerminalArgs] = useState('status --short');
  const [browserUrl, setBrowserUrl] = useState('');
  const [githubAction, setGithubAction] = useState('repo');
  const [githubOwner, setGithubOwner] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubNumber, setGithubNumber] = useState('');
  const [githubPath, setGithubPath] = useState('');
  useEffect(() => { if (datasets.length === 1) setDatasetId(datasets[0].id); }, [datasets.length, datasets[0]?.id]);
  const current = useMemo(() => (view === 'projects' ? folderState.projects.find(item => item.id === folderState.projectId)?.name || '工作文件夹' : navItems.find(item => item.id === view)?.label || '新对话'), [view, folderState]);
  const openFolder = (projectId: string) => { setView('projects'); setProjectFocus(projectId); setChatFocus(null); setNavOpen(false); };
  const handleFolderState = useCallback((next: { projects: WorkProject[]; projectId: string | null; chatId: string | null }) => {
    setFolderState(previous => {
      const projects = next.projects.length ? next.projects : previous.projects;
      if (projects === previous.projects && previous.projectId === next.projectId && previous.chatId === next.chatId) return previous;
      return { projects, projectId: next.projectId, chatId: next.chatId };
    });
  }, []);
  const openFolderChat = (projectId: string, chatId: string) => {
    markChatSeen(chatId);
    setView('projects');
    setProjectFocus(projectId);
    setChatFocus(chatId);
    setNavOpen(false);
  };
  const toggleProject = (id: string) => setCollapsedProjects(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]);

  const markChatSeen = (chatId: string) => setChatSeen(previous => ({ ...previous, [chatId]: new Date().toISOString() }));
  useEffect(() => { writeJson(CHAT_SEEN_KEY, chatSeen); }, [chatSeen]);
  useEffect(() => { writeJson(PINNED_KEY, pinnedProjects); }, [pinnedProjects]);
  const chatUnread = (chat: WorkProjectChat) => Boolean(chat.lastTicketAt) && unreadStatuses.includes(chat.lastTicketStatus || '') && String(chat.lastTicketAt) > String(chatSeen[chat.id] || '');
  const reloadProjects = async () => {
    try {
      const result = await api.workProjects();
      setProjects(result.projects);
      setFolderState(previous => ({ ...previous, projects: result.projects }));
      return result.projects;
    } catch { return folderState.projects; }
  };
  // 文件夹行上的「+」：用这个文件夹上一次用过的执行器直接开一段会话。
  const quickNewChat = async (project: WorkProject) => {
    const usable = projectExecutors.filter(id => allowedExecutors.includes(id));
    const preferred = project.chats.find(chat => usable.includes(chat.executorId))?.executorId;
    const executorId = preferred || usable[0];
    if (!executorId) { notify('没有可用于项目的执行器，请先在设置里启用。', true); return; }
    try {
      const result = await api.workCreateProjectChat(project.id, { executorId });
      await reloadProjects();
      markChatSeen(result.chat.id);
      setCollapsedProjects(previous => previous.filter(id => id !== project.id));
      openFolderChat(project.id, result.chat.id);
      notify(`已在「${project.name}」新建会话。`);
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const commitChatRename = async () => {
    if (!chatRename) return;
    const title = chatRename.value.trim();
    const target = chatRename;
    setChatRename(null);
    if (!title) return;
    try { await api.workRenameProjectChat(target.chatId, title); await reloadProjects(); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const commitFolderRename = async () => {
    if (!folderRename) return;
    const name = folderRename.value.trim();
    const target = folderRename;
    setFolderRename(null);
    if (!name) return;
    try { await api.workRenameProject(target.id, name); await reloadProjects(); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const removeFolder = async (project: WorkProject) => {
    try {
      await api.workDeleteProject(project.id);
      await reloadProjects();
      if (folderState.projectId === project.id) { setView('command'); setProjectFocus(null); setChatFocus(null); }
      notify(`已移除「${project.name}」，本地文件没有被删除。`);
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const revealFolder = async (project: WorkProject) => {
    const bridge = (window as unknown as { dataagentDesktop?: { openPath?: (path: string) => Promise<unknown> } }).dataagentDesktop;
    setFolderMenu(null);
    if (bridge?.openPath) {
      try { await bridge.openPath(project.path); return; } catch { /* 落到复制路径。*/ }
    }
    try { await navigator.clipboard.writeText(project.path); notify(`已复制路径：${project.path}`); }
    catch { notify(project.path); }
  };
  const togglePin = (id: string) => setPinnedProjects(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const sortedFolders = useMemo(() => [...folderState.projects].sort((left, right) => {
    const pinnedDiff = Number(pinnedProjects.includes(right.id)) - Number(pinnedProjects.includes(left.id));
    if (pinnedDiff) return pinnedDiff;
    return String(right.lastActivity || right.updatedAt || '').localeCompare(String(left.lastActivity || left.updatedAt || ''));
  }), [folderState.projects, pinnedProjects]);
  const importDroppedFolder = async (event: React.DragEvent) => {
    event.preventDefault();
    setDropActive(false);
    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined;
    const droppedPath = file?.path || '';
    if (!droppedPath) {
      notify('浏览器拿不到文件夹的绝对路径，请在导入面板里选择目录。');
      setView('projects');
      setProjectFocus(null);
      setChatFocus(null);
      setImportTick(tick => tick + 1);
      return;
    }
    try {
      const result = await api.workImportProject(droppedPath);
      await reloadProjects();
      setProjectFocus(result.project.id);
      setChatFocus(null);
      setView('projects');
      notify(`已导入工作文件夹「${result.project.name}」。`);
    } catch (cause) { notify((cause as Error).message, true); }
  };

  const usableAgents = useMemo(() => agents.filter(agent => agent.id !== 'analysis' && allowedExecutors.includes(agent.id) && agent.status === 'available'), [agents, allowedExecutors]);
  const visibleAgents = useMemo(() => agents.filter(agent => agent.id !== 'analysis'), [agents]);
  const crossCapable = useMemo(() => usableAgents.filter(agent => conversationExecutorIds.includes(agent.id)), [usableAgents]);
  const agentLabel = (id: string) => id.startsWith('win:') ? `${windows.find(window => windowKey(window.handle) === id)?.process || '窗口 Agent'} 窗口` : executorNames[id] || id;
  useEffect(() => {
    setSelectedAgents(previous => {
      const valid = previous.filter(id => id.startsWith('win:') ? windows.some(window => windowKey(window.handle) === id) : crossCapable.some(agent => agent.id === id));
      if (valid.length) return valid;
      if (!crossCapable.length) return [];
      const preferred = ['claude-acp', 'codex', 'claude-code'].find(id => crossCapable.some(agent => agent.id === id)) || crossCapable[0].id;
      return [preferred];
    });
  }, [crossCapable, windows]);

  const activeGroup = useMemo(() => crossChecks.find(group => group.id === activeGroupId) || null, [crossChecks, activeGroupId]);
  const groupStatusOf = (group: CrossCheck) => {
    const statuses = group.ticketIds.map(id => groupDetails[id]?.ticket.status || tickets.find(ticket => ticket.id === id)?.status || 'waiting');
    const synthesisStatus = group.synthesisTicketId ? groupDetails[group.synthesisTicketId]?.ticket.status || tickets.find(ticket => ticket.id === group.synthesisTicketId)?.status || 'waiting' : null;
    const all = synthesisStatus ? [...statuses, synthesisStatus] : statuses;
    if (all.some(status => ['working', 'queued'].includes(status))) return 'working';
    if (all.some(status => status === 'awaiting_review')) return 'awaiting_review';
    if (all.some(status => status === 'waiting')) return 'waiting';
    if (synthesisStatus) return synthesisStatus;
    if (statuses.every(status => status === 'completed')) return 'completed';
    if (statuses.some(status => ['failed', 'blocked'].includes(status))) return 'failed';
    return statuses.every(status => status === 'cancelled') ? 'cancelled' : 'completed';
  };
  const groupTicketIds = useMemo(() => activeGroup ? [...activeGroup.ticketIds, ...(activeGroup.synthesisTicketId ? [activeGroup.synthesisTicketId] : [])] : [], [activeGroup]);
  const conversationTickets = useMemo(() => {
    const grouped = new Set(crossChecks.flatMap(group => [...group.ticketIds, ...(group.synthesisTicketId ? [group.synthesisTicketId] : [])]));
    // 项目工单只在文件夹的会话里出现，不再混进「对话」列表（否则同一个活会出现两次）。
    const singles = tickets.filter(ticket => !grouped.has(ticket.id) && !ticket.projectChatId).map(ticket => ({ kind: 'ticket' as const, id: ticket.id, title: ticket.title, createdAt: ticket.createdAt, ticket, group: null as CrossCheck | null }));
    const groups = crossChecks.map(group => ({ kind: 'group' as const, id: group.id, title: group.prompt, createdAt: group.createdAt, ticket: null as WorkTicket | null, group }));
    return [...groups, ...singles].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 60);
  }, [tickets, crossChecks]);
  const activeTicket = activeDetail?.ticket?.id === activeTicketId ? activeDetail.ticket : tickets.find(ticket => ticket.id === activeTicketId) || null;

  // 并行面板：把每个在跑的工单的最新输出都拉回来，同屏刷新，不必逐个点开。
  const liveTickets = useMemo(() => tickets.filter(ticket => !terminalStatuses.includes(ticket.status)), [tickets]);
  const liveKey = liveTickets.map(ticket => `${ticket.id}:${ticket.status}`).join(',');
  useEffect(() => {
    if (view !== 'parallel' || !liveKey) return;
    let cancelled = false;
    const ids = liveKey.split(',').map(part => part.split(':')[0]);
    const pull = async () => {
      const results = await Promise.all(ids.map(async id => {
        try { return [id, await api.workTicket(id)] as const; }
        catch { return null; }
      }));
      if (cancelled) return;
      setParallelDetails(previous => {
        const next = { ...previous };
        for (const entry of results) if (entry) next[entry[0]] = entry[1];
        return next;
      });
    };
    void pull();
    const timer = setInterval(() => void pull(), 2500);
    return () => { cancelled = true; clearInterval(timer); };
  }, [view, liveKey]);

  useEffect(() => {
    try { localStorage.setItem(CROSS_CHECK_KEY, JSON.stringify(crossChecks.slice(0, 30))); } catch { /* 隐私模式忽略。*/ }
  }, [crossChecks]);

  const loadActiveTicket = async (id: string) => {
    try {
      const next = await api.workTicket(id);
      setActiveDetail(previous => previous && previous.ticket.id !== id && activeTicketId !== id ? previous : next);
    } catch { /* 轮询失败时保留上一次快照。*/ }
  };
  const loadGroupDetails = async (ids: string[]) => {
    if (!ids.length) return;
    const entries = await Promise.all(ids.map(async id => {
      try { return [id, await api.workTicket(id)] as const; }
      catch { return null; }
    }));
    setGroupDetails(previous => {
      const next = { ...previous };
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      return next;
    });
  };
  const viewTicket = (id: string) => {
    setView('command');
    setActiveGroupId(null);
    setActiveTicketId(id);
    setActiveDetail(null);
    void loadActiveTicket(id);
  };
  const viewGroup = (group: CrossCheck) => {
    setView('command');
    setActiveTicketId(null);
    setActiveGroupId(group.id);
    setSynthesisAgent(group.synthesisAgentId || group.agentIds[0] || '');
    void loadGroupDetails([...group.ticketIds, ...(group.synthesisTicketId ? [group.synthesisTicketId] : [])]);
  };
  const newChat = () => {
    setView('command');
    setActiveGroupId(null);
    setActiveTicketId(null);
    setActiveDetail(null);
    setCommand('');
    setNavOpen(false);
  };
  // 对某个窗口 Agent 新建对话：清空当前会话，并把该窗口钉为唯一执行 Agent。
  const startWindowChat = (window: { handle: number; process: string; title?: string }) => {
    newChat();
    setSelectedAgents([windowKey(window.handle)]);
    setCommand('');
    requestAnimationFrame(() => document.getElementById('sa-command')?.focus());
  };

  type PaletteItem = { id: string; label: string; hint: string; icon: LucideIcon; run: () => void };
  const paletteItems = useMemo<PaletteItem[]>(() => {
    const rows: PaletteItem[] = [];
    const close = () => { setPaletteOpen(false); setPaletteQuery(''); setPaletteIndex(0); };
    for (const item of navItems) rows.push({ id: `page:${item.id}`, label: item.label, hint: '页面', icon: item.icon, run: () => { setView(item.id); setNavOpen(false); close(); } });
    rows.push({ id: 'action:new', label: '新对话', hint: '动作', icon: Plus, run: () => { newChat(); close(); } });
    rows.push({ id: 'action:import', label: '添加本地文件夹', hint: '动作', icon: FolderGit2, run: () => { setView('projects'); setProjectFocus(null); setChatFocus(null); setImportTick(tick => tick + 1); setNavOpen(false); close(); } });
    for (const project of folderState.projects) {
      rows.push({ id: `folder:${project.id}`, label: project.name, hint: `文件夹 · ${project.chatCount} 个会话`, icon: FolderGit2, run: () => { openFolder(project.id); close(); } });
      for (const chat of project.chats) rows.push({ id: `chat:${chat.id}`, label: chat.title, hint: `${project.name} · ${executorNames[chat.executorId] || chat.executorId}`, icon: project.chats.length ? MessageSquare : Bot, run: () => { openFolderChat(project.id, chat.id); close(); } });
    }
    for (const item of conversationTickets.slice(0, 30)) {
      rows.push({ id: `conv:${item.id}`, label: item.title, hint: item.kind === 'group' ? '交叉验证' : `对话 · ${executorNames[item.ticket?.executor || ''] || item.ticket?.executor || ''}`, icon: item.kind === 'group' ? Users : Bot, run: () => { if (item.kind === 'group' && item.group) viewGroup(item.group); else if (item.ticket) viewTicket(item.ticket.id); close(); } });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderState.projects, conversationTickets]);
  const paletteMatches = useMemo(() => {
    const query = paletteQuery.trim().toLowerCase();
    if (!query) return paletteItems.slice(0, 40);
    return paletteItems.filter(item => `${item.label} ${item.hint}`.toLowerCase().includes(query)).slice(0, 40);
  }, [paletteItems, paletteQuery]);
  useEffect(() => { setPaletteIndex(0); }, [paletteQuery, paletteOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(open => !open);
        setPaletteQuery('');
      }
      if (event.key === 'Escape') { setPaletteOpen(false); setFolderMenu(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!folderMenu) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.sa-folder-menu') || target?.closest('.sa-folder-more')) return;
      setFolderMenu(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [folderMenu]);
  useEffect(() => { writeJson(SIDEBAR_WIDTH_KEY, sidebarWidth); }, [sidebarWidth]);
  const startSidebarResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth || document.querySelector<HTMLElement>('.sa-sidebar')?.offsetWidth || 264;
    const onMove = (move: PointerEvent) => setSidebarWidth(Math.min(420, Math.max(216, Math.round(startWidth + move.clientX - startX))));
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const singlePending = Boolean(activeTicketId) && !terminalStatuses.includes(activeDetail?.ticket.status || 'waiting');
  const groupPending = Boolean(activeGroup) && groupTicketIds.some(id => !terminalStatuses.includes(groupDetails[id]?.ticket.status || 'waiting'));
  useEffect(() => {
    if (!singlePending && !groupPending) return;
    const tick = () => {
      if (activeTicketId) void loadActiveTicket(activeTicketId);
      if (groupTicketIds.length) void loadGroupDetails(groupTicketIds);
    };
    const timer = setInterval(tick, 3000);
    const first = setTimeout(tick, 500);
    return () => { clearInterval(timer); clearTimeout(first); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTicketId, activeGroupId, singlePending, groupPending, groupTicketIds.join(',')]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [activeTicketId, activeGroupId, activeDetail?.reports.length, sending]);

  const refresh = async () => { try { setWork(await api.workBootstrap()); } catch { /* keep last snapshot */ } };
  const executorInputFor = (id: string, text: string) => {
    if (id === 'terminal') return { program: terminalProgram, args: terminalArgs.trim().split(/\s+/).filter(Boolean) };
    if (id === 'browser') return { url: browserUrl.trim() };
    if (id === 'github') return { action: githubAction, owner: githubOwner.trim(), repo: githubRepo.trim(), ...(githubNumber.trim() ? { number: Number(githubNumber) } : {}), ...(githubAction === 'file' ? { path: githubPath.trim() } : {}) };
    if (['analysis'].includes(id)) return undefined;
    return { prompt: text.slice(0, 12000) };
  };
  const validateSingleInput = (id: string): string | null => {
    if (id === 'analysis') {
      if (datasets.length === 0) return '请先在工作区上传或加载数据集。';
      if (datasets.length > 1 && !datasetId) return '请先选择要分析的数据集。';
    }
    if (id === 'browser' && !browserUrl.trim()) return '请填写要读取的 http/https 页面地址。';
    if (id === 'github' && (!githubOwner.trim() || !githubRepo.trim())) return '请填写 GitHub owner 和 repo。';
    return null;
  };
  const send = async (text = command) => {
    const value = text.trim(); if (!value || sending) return;
    if (value.length > 3000) { notify('指令不能超过 3000 字。', true); return; }
    const chosen = selectedAgents.filter(id => id.startsWith('win:') ? windows.some(window => windowKey(window.handle) === id) : crossCapable.some(agent => agent.id === id));
    if (!chosen.length) { notify('请至少选择一个可用 Agent。', true); return; }
    const execIdFor = (id: string) => id.startsWith('win:') ? 'window' : id;
    const inputFor = (id: string, prompt: string) => {
      if (!id.startsWith('win:')) return executorInputFor(id, prompt);
      const window = windows.find(item => windowKey(item.handle) === id);
      return window ? { handle: window.handle, text: prompt, submit: true, process: window.process, title: window.title } : undefined;
    };
    // 拆分分发：先让规划器把目标拆成子任务，再按子任务分派，避免同一段话广播给所有 Agent。
    const splitAndDispatch = async (goal: string, targets: string[]): Promise<boolean> => {
      const execs = [...new Set(targets.map(execIdFor))];
      let steps: { executorId: string; text: string; datasetId?: string; dependsOn?: number[]; executorInput?: { handle?: number; process?: string; title?: string } }[];
      try {
        steps = (await api.suggestWorkPlan(goal, execs)).steps;
      } catch (cause) {
        notify(`任务拆分失败：${(cause as Error).message}；改为并行对比。`, true);
        return false;
      }
      const usable = steps.filter(step => step.text.trim() && execs.includes(step.executorId));
      if (usable.length < 2) return false;
      const windowId = targets.find(id => id.startsWith('win:'));
      const targetWindow = windowId ? windows.find(item => windowKey(item.handle) === windowId) : undefined;
      const payload = usable.map(step => {
        const text = step.text.trim();
        const input = step.executorId === 'window'
          ? { handle: targetWindow?.handle ?? step.executorInput?.handle, text, submit: true, process: targetWindow?.process || step.executorInput?.process, title: targetWindow?.title || step.executorInput?.title }
          : step.executorInput;
        return {
          executorId: step.executorId,
          text,
          ...(input ? { executorInput: input } : {}),
          ...(step.executorId === 'analysis' && (step.datasetId || datasetId) ? { datasetId: step.datasetId || datasetId } : {}),
          ...(Array.isArray(step.dependsOn) && step.dependsOn.length ? { dependsOn: step.dependsOn } : {}),
        };
      });
      try {
        await api.createWorkPlan(goal, payload, `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, true);
        setCommand('');
        setActiveTicketId(null);
        setActiveGroupId(null);
        setView('parallel');
        await refresh();
        notify(`已拆成 ${payload.length} 个步骤，分发给 ${payload.length} 个 Agent 并行执行。`);
        return true;
      } catch (cause) { notify((cause as Error).message, true); return true; }
    };
    const problem = chosen.length === 1 ? validateSingleInput(execIdFor(chosen[0])) : chosen.some(id => execIdFor(id) === 'analysis') ? (datasets.length === 0 ? '交叉验证包含数据分析，请先上传数据集。' : datasets.length > 1 && !datasetId ? '交叉验证包含数据分析，请先选择数据集。' : null) : null;
    if (problem) { notify(problem, true); return; }
    // 新对话绑定了工作文件夹：走项目分派，工单在项目目录内执行。
    const scope = isLanding ? folderState.projects.find(item => item.id === newFolder) : undefined;
    if (scope) {
      const execs = chosen.filter(id => !id.startsWith('win:') && projectExecutors.includes(id));
      if (!execs.length) { notify('这个工作文件夹只接受 Claude Code、Codex、ACP 或窗口 Agent，请重新选择 Agent。', true); return; }
      setSending(true);
      try {
        const result = await api.workProjectDispatch(scope.id, value, execs);
        const chatId = result.tickets.map(ticket => ticket.projectChatId).filter(Boolean)[0] || null;
        const targets = result.tickets.map(ticket => ticket.executor).filter(Boolean);
        setCommand('');
        setActiveGroupId(null);
        setActiveTicketId(null);
        // 先切到项目页再补数据：分派已经落库，等待刷新只会让点击像是没反应。
        setView('projects');
        setProjectFocus(scope.id);
        setChatFocus(chatId);
        setSending(false);
        notify(`已把任务分派给 ${targets.length || execs.length} 个 Agent，确认后在 ${scope.name} 目录内执行。`);
        void refresh();
        void reloadProjects();
      } catch (cause) { notify((cause as Error).message, true); setSending(false); }
      return;
    }
    setSending(true);
    try {
      if (chosen.length === 1) {
        const id = chosen[0];
        const execId = execIdFor(id);
        const { ticket } = await api.workCommand(value, `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, execId === 'analysis' ? datasetId || undefined : undefined, execId, inputFor(id, value));
        setCommand('');
        setActiveGroupId(null);
        setActiveTicketId(ticket.id);
        setActiveDetail(null);
        await refresh();
        await loadActiveTicket(ticket.id);
        notify('指令已提交，Agent 正在处理。');
      } else if (dispatchMode === 'split' && await splitAndDispatch(value, chosen)) {
        // 已按子任务分派，不再把同一份提示词广播给所有 Agent。
      } else {
        const stamp = Date.now();
        const results = await Promise.all(chosen.map(id => {
          const execId = execIdFor(id);
          return api.workCommand(value, `cross-${stamp}-${id.replace(/[^a-z0-9-]/gi, '')}`, execId === 'analysis' ? datasetId || undefined : undefined, execId, inputFor(id, value));
        }));
        const group: CrossCheck = { id: `xc-${stamp}`, prompt: value, agentIds: chosen, ticketIds: results.map(result => result.ticket.id), createdAt: new Date().toISOString() };
        setCrossChecks(previous => [group, ...previous].slice(0, 30));
        setCommand('');
        setActiveTicketId(null);
        setActiveGroupId(group.id);
        setSynthesisAgent(chosen.find(id => !id.startsWith('win:')) || '');
        await refresh();
        await loadGroupDetails(group.ticketIds);
        notify(`已让 ${chosen.length} 个 Agent 并行交叉验证。`);
      }
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setSending(false); }
  };
  const act = async (ticketId: string, action: WorkAction, input?: Record<string, unknown>) => {
    try {
      await api.workAction(ticketId, action, input);
      await refresh();
      if (activeGroupId) void loadGroupDetails(groupTicketIds);
      const next = await api.workTicket(ticketId);
      setDetail(previous => previous?.ticket.id === ticketId ? next : previous);
      if (activeTicketId === ticketId) setActiveDetail(next);
      notify('操作已提交。');
    }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const reloadDetail = async (ticketId: string) => { setDetail(await api.workTicket(ticketId)); await refresh(); };
  const reviewNode = async (nodeId: string, decision: 'accept' | 'reject') => {
    if (!detail) return;
    try { await api.workReviewTeam(detail.ticket.id, nodeId, decision); await reloadDetail(detail.ticket.id); notify('团队节点验收已提交。'); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const decideProposal = async (nodeId: string, proposalId: string, decision: 'accept' | 'reject') => {
    if (!detail) return;
    try { await api.workDecideProposal(detail.ticket.id, nodeId, proposalId, decision); await reloadDetail(detail.ticket.id); notify('提案决策已记录。'); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const open = async (id: string) => { try { setDetail(await api.workTicket(id)); } catch (cause) { notify((cause as Error).message, true); } };
  const handoffTargets = usableAgents.filter(agent => conversationExecutorIds.includes(agent.id) && agent.id !== 'analysis');
  useEffect(() => {
    if (detail?.ticket.status === 'completed' && !handoffTargets.some(agent => agent.id === handoffExecutor)) setHandoffExecutor(handoffTargets[0]?.id || '');
  }, [detail?.ticket.status, handoffTargets, handoffExecutor]);
  const handoff = async () => {
    if (!detail || !handoffExecutor) return;
    try {
      const text = handoffText.trim();
      const executorInput = ['codex', 'claude-code'].includes(handoffExecutor) ? { prompt: text || detail.ticket.title } : undefined;
      const result = await api.workAction(detail.ticket.id, 'handoff', { executorId: handoffExecutor, ...(text ? { text } : {}), ...(executorInput ? { executorInput } : {}) });
      await refresh(); setDetail(await api.workTicket(result.ticket.id)); setHandoffText(''); notify('已交给下一棒 Agent。');
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const cancelPlan = async (id: string) => {
    try { await api.cancelWorkPlan(id); await refresh(); notify('计划已取消。'); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const openPlan = async (id: string) => {
    try { setPlanDetail((await api.workPlan(id)).plan); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const enableTool = async (id: string) => setExecutorEnabled(id, true);

  const toggleAgent = (id: string) => setSelectedAgents(previous => previous.includes(id) ? (previous.length > 1 ? previous.filter(item => item !== id) : previous) : [...previous, id].slice(0, 4));

  const synthesize = async () => {
    if (!activeGroup || synthesizing) return;
    const completed = activeGroup.agentIds.filter((id, index) => !id.startsWith('win:') && groupDetails[activeGroup.ticketIds[index]]?.ticket.status === 'completed');
    if (!completed.length) { notify('还没有可汇总的 Agent 完成，暂时无法汇总。', true); return; }
    const arbiter = completed.includes(synthesisAgent) ? synthesisAgent : completed[0];
    const sections = activeGroup.agentIds.map((id, index) => {
      const text = reportText(groupDetails[activeGroup.ticketIds[index]]);
      return `、{agentLabel(id)}】\n${sliceBytes(text || '（无输出）', 3000)}`;
    });
    const prompt = sliceBytes(`你是交叉验证的汇总者。同一问题由多个 Agent 独立作答。请比较它们的结论：列出一致点、分歧点与各自依据，指出谁遗漏了什么，最后给出你的判断与建议。\n\n问题：\n${activeGroup.prompt}\n\n${sections.join('\n\n')}`, 14000);
    setSynthesizing(true);
    try {
      const { ticket } = await api.workCommand(prompt, `xc-summary-${Date.now()}`, undefined, arbiter, executorInputFor(arbiter, prompt));
      const next: CrossCheck = { ...activeGroup, synthesisTicketId: ticket.id, synthesisAgentId: arbiter };
      setCrossChecks(previous => previous.map(group => group.id === next.id ? next : group));
      await refresh();
      await loadGroupDetails([...next.ticketIds, ticket.id]);
      notify(`已让 ${executorNames[arbiter] || arbiter} 汇总交叉验证结果。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setSynthesizing(false); }
  };

  const [inboxFilter, setInboxFilter] = useState('');
  // 待确认事项本身不带项目信息，按 ticketId → projectChatId 反查所属工作文件夹再分组。
  const inboxRows = useMemo(() => {
    const chatOwners = new Map<string, WorkProject>();
    for (const project of folderState.projects) for (const chat of project.chats) chatOwners.set(chat.id, project);
    return attention.map(item => {
      const ticket = tickets.find(candidate => candidate.id === item.ticketId);
      const project = ticket?.projectChatId ? chatOwners.get(ticket.projectChatId) || null : null;
      return { item, ticket, project };
    });
  }, [attention, tickets, folderState.projects]);
  const inboxProjects = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const row of inboxRows) {
      if (!row.project) continue;
      const entry = counts.get(row.project.id) || { id: row.project.id, name: row.project.name, count: 0 };
      entry.count += 1;
      counts.set(row.project.id, entry);
    }
    return [...counts.values()].sort((left, right) => right.count - left.count);
  }, [inboxRows]);
  const inboxGroups = useMemo(() => {
    const rows = inboxFilter ? inboxRows.filter(row => row.project?.id === inboxFilter) : inboxRows;
    const groups = new Map<string, typeof inboxRows>();
    for (const row of rows) {
      const key = row.project ? row.project.name : '未绑定工作文件夹';
      const list = groups.get(key) || [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }));
  }, [inboxRows, inboxFilter]);

  const renderAttention = (items: WorkInboxItem[]) => <div className="sa-attention-list">{items.map(item => {
    const ticket = tickets.find(candidate => candidate.id === item.ticketId);
    const needsDataset = !ticket?.executor || ticket.executor === 'analysis';
    const chosen = attentionDatasets[item.ticketId] || ticket?.datasetId || (datasets.length === 1 ? datasets[0].id : '');
    return <article className="sa-attention" key={item.ticketId}>
      <div className="sa-attention-head"><span className="sa-attention-icon"><AlertTriangle size={16} /></span><div><strong>{item.title}</strong><p>{item.question}</p></div><time>{time(item.createdAt)}</time></div>
      <div className="sa-attention-actions">
        {needsDataset && datasets.length > 1 && <label className="sa-dataset-inline"><span>数据集</span><select value={chosen} onChange={event => setAttentionDatasets(previous => ({ ...previous, [item.ticketId]: event.target.value }))}><option value="">请选择数据集</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>}
        {needsDataset && datasets.length === 0 && <span className="sa-inline-note">请先在工作区上传数据集</span>}
        {(item.options || []).map(option => <button key={option.id} type="button" className={option.action === 'approve' ? 'sa-button sa-primary' : 'sa-button'} disabled={option.action === 'approve' && needsDataset && (datasets.length === 0 || (datasets.length > 1 && !chosen))} onClick={() => void act(item.ticketId, option.action, option.action === 'approve' && needsDataset && chosen ? { datasetId: chosen } : undefined)}>{option.label}</button>)}<button type="button" className="sa-link" onClick={() => void open(item.ticketId)}>查看详情</button>
      </div>
    </article>;
  })}</div>;

  const activeAttention = activeTicketId ? attention.find(item => item.ticketId === activeTicketId) : undefined;
  const activeReports = activeDetail?.reports || [];
  const activeResult = activeTicket?.status === 'completed' ? reportText(activeDetail) : '';
  const completedGroupAgents = activeGroup ? activeGroup.agentIds.filter((id, index) => !id.startsWith('win:') && groupDetails[activeGroup.ticketIds[index]]?.ticket.status === 'completed') : [];
  const awaitingGroupAgents = activeGroup ? activeGroup.agentIds.filter((id, index) => groupDetails[activeGroup.ticketIds[index]]?.ticket.status === 'awaiting_review') : [];
  const synthesisDetail = activeGroup?.synthesisTicketId ? groupDetails[activeGroup.synthesisTicketId] : null;
  const approveGroup = async () => {
    if (!activeGroup) return;
    const ids = activeGroup.ticketIds.filter(id => groupDetails[id]?.ticket.status === 'awaiting_review');
    if (!ids.length) return;
    try {
      await Promise.all(ids.map(id => api.workAction(id, 'approve')));
      await refresh();
      await loadGroupDetails(groupTicketIds);
      notify('已确认全部 Agent 开始执行。');
    } catch (cause) { notify((cause as Error).message, true); }
  };

  const singleExecutor = selectedAgents.length === 1 ? selectedAgents[0] : null;
  const composerTitle = selectedAgents.length > 1 ? (dispatchMode === 'split' ? `拆分分发 · ${selectedAgents.length} 个 Agent` : `并行对比 · ${selectedAgents.length} 个 Agent`) : '发送指令';
  const dispatchToggle = selectedAgents.length > 1 ? <span className="sa-dispatch" role="group" aria-label="多个 Agent 的工作方式">
    <button type="button" className={dispatchMode === 'split' ? 'on' : ''} aria-pressed={dispatchMode === 'split'} onClick={() => setDispatchMode('split')} title="先拆成子任务，再各领一部分"><GitBranch size={12} />拆分分发</button>
    <button type="button" className={dispatchMode === 'compare' ? 'on' : ''} aria-pressed={dispatchMode === 'compare'} onClick={() => setDispatchMode('compare')} title="同一问题各自作答，便于比较"><Users size={12} />并行对比</button>
  </span> : null;
  const isLanding = !activeTicket && !activeGroup;
  const conversationGroups = useMemo(() => {
    const keyword = convQuery.trim().toLowerCase();
    const matched = keyword
      ? conversationTickets.filter(item => `${item.title} ${item.ticket?.executor || ''} ${executorNames[item.ticket?.executor || ''] || ''} ${statusNames[item.ticket?.status || ''] || ''}`.toLowerCase().includes(keyword))
      : conversationTickets;
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const buckets: { label: string; items: typeof conversationTickets }[] = [
      { label: keyword ? '搜索结果' : '今天', items: [] }, { label: '昨天', items: [] }, { label: '更早', items: [] },
    ];
    for (const item of matched) {
      if (keyword) { buckets[0].items.push(item); continue; }
      const created = Date.parse(item.createdAt);
      const index = created >= startOfToday.getTime() ? 0 : created >= startOfYesterday.getTime() ? 1 : 2;
      buckets[index].items.push(item);
    }
    return buckets.filter(bucket => bucket.items.length > 0);
  }, [conversationTickets, convQuery]);
  const starters = [
    { icon: GitBranch, title: '检查 GitHub 仓库', desc: 'CI 状态、失败的流水线与 PR', prompt: '检查 GitHub 仓库状态' },
    { icon: Globe, title: '浏览网页并总结', desc: '读取页面正文，提炼要点', prompt: '浏览网页并总结' },
    { icon: Terminal, title: '运行终端命令', desc: '只读的 git / npm / ls 检查', prompt: '运行终端命令' },
    { icon: FolderGit2, title: '跟进项目进展', desc: '读取项目简报与最近变更', prompt: '总结当前项目的进展与变更要点' },
  ];

  const conversationPage = <div className={`sa-workspace ${isLanding ? 'sa-workspace-landing' : ''}`}>
    {isLanding ? <div className="sa-landing">
      <div className="sa-landing-main">
        <header className="sa-hero">
          <p className="sa-eyebrow">PERSONAL AGENT</p>
          <h1>今天想让我做什么？</h1>
          <p className="sa-hero-sub">选择一个或多个 Agent，描述目标。多选时我会把任务拆成子任务分派下去，进度在「并行」里同屏可见。</p>
        </header>
        <section className="sa-picker" aria-labelledby="sa-picker-title">
          <div className="sa-picker-head"><span id="sa-picker-title">执行 Agent</span><span className="sa-picker-hint">{crossCapable.length + windows.length} 个可用 · 最多选 4 个</span></div>
          <div className="sa-picker-list">
            {crossCapable.map(agent => {
              const on = selectedAgents.includes(agent.id);
              return <button key={agent.id} type="button" className={`sa-pick ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggleAgent(agent.id)}>{on ? <Check size={13} /> : <Bot size={13} />}{executorNames[agent.id] || agent.name}</button>;
            })}
            {windows.slice(0, 4).map(window => {
              const id = windowKey(window.handle);
              const on = selectedAgents.includes(id);
              return <button key={id} type="button" className={`sa-pick ${on ? 'on' : ''}`} title={`${window.title || window.process} · PID ${window.pid}`} aria-pressed={on} onClick={() => toggleAgent(id)}>{on ? <Check size={13} /> : <Terminal size={13} />}窗口 · {window.process}</button>;
            })}
            {!crossCapable.length && !windows.length && <span className="sa-pick-empty"><AlertTriangle size={13} />还没有可用 Agent，请到 Agent 页检查探测结果</span>}
          </div>
        </section>
        <section className="sa-starters" aria-label="常见任务">
          {starters.map(item => <button type="button" key={item.title} className="sa-starter" onClick={() => setCommand(item.prompt)}>
            <span className="sa-starter-icon"><item.icon size={14} /></span>
            <span className="sa-starter-text"><strong>{item.title}</strong><span>{item.desc}</span></span>
          </button>)}
        </section>
      </div>
      <aside className="sa-rail" aria-label="工作台概览">
        <section className="sa-rail-card">
          <div className="sa-rail-head"><Inbox size={13} /><span>待你确认</span><em>{attention.length}</em></div>
          {attention.length ? <div className="sa-rail-list">{attention.slice(0, 3).map(item => <button type="button" key={item.ticketId} className="sa-rail-row" onClick={() => setView('inbox')}><em className="sa-dot sa-dot-awaiting_review" /><span>{item.title}</span><time>{shortTime(item.createdAt)}</time></button>)}</div> : <p className="sa-rail-empty"><Check size={13} />没有需要你处理的事项</p>}
        </section>
        <section className="sa-rail-card">
          <div className="sa-rail-head"><Activity size={13} /><span>最近任务</span><em>{tickets.length}</em></div>
          {tickets.length ? <div className="sa-rail-list">{tickets.slice(0, 4).map(ticket => <button type="button" key={ticket.id} className="sa-rail-row" onClick={() => viewTicket(ticket.id)}><em className={`sa-dot sa-dot-${ticket.status}`} /><span>{ticket.title}</span><time>{shortTime(ticket.createdAt)}</time></button>)}</div> : <p className="sa-rail-note">还没有任务。描述目标即可开始。</p>}
        </section>
        <section className="sa-rail-card">
          <div className="sa-rail-head"><FolderGit2 size={13} /><span>项目</span><em>{projects?.length ?? 0}</em></div>
          {projects?.length ? <div className="sa-rail-list">{projects.slice(0, 3).map(item => <button type="button" key={item.id} className="sa-rail-row" onClick={() => setView('projects')}><span>{item.name}</span><time>{item.chatCount} 个对话</time></button>)}</div>
            : <div className="sa-rail-action"><p className="sa-rail-note">导入本地文件夹后，拆分出的任务会带着项目上下文执行，改动也会自动归档。</p><button type="button" className="sa-rail-cta" onClick={() => setView('projects')}>打开项目<ChevronRight size={13} /></button></div>}
        </section>
      </aside>
    </div> : <div className="sa-thread" ref={threadRef}>
      <div className="sa-thread-inner">
        {activeGroup ? <>
          <div className="sa-bubble-user">{activeGroup.prompt}</div>
          <div className="sa-xc-note"><Users size={14} /><span>{activeGroup.agentIds.length} 个 Agent 并行独立作答，互不共享上下文；完成后可比较结论并汇总。</span></div>
          <div className="sa-xc-grid">{activeGroup.agentIds.map((id, index) => {
            const groupTicketId = activeGroup.ticketIds[index];
            const groupDetail = groupDetails[groupTicketId];
            const status = groupDetail?.ticket.status || 'waiting';
            const text = reportText(groupDetail);
            return <article className={`sa-xc-card ${terminalStatuses.includes(status) ? 'is-done' : ''}`} key={groupTicketId}>
              <div className="sa-xc-head"><span className="sa-agent-avatar"><Bot size={16} /></span><div className="sa-agent-name"><strong>{agentLabel(id)}</strong><span>{groupTicketId.slice(0, 8)}</span></div><Status status={status} /></div>
              {text ? <pre className="sa-xc-output">{text.slice(0, 6000)}</pre> : <p className="sa-inline-note">{terminalStatuses.includes(status) ? '没有文本输出，查看详情了解原因。' : status === 'awaiting_review' ? '等待你确认后开始执行。' : 'Agent 正在思考…'}</p>}
              <div className="sa-run-actions">
                {status === 'awaiting_review' && <button type="button" className="sa-button sa-primary" onClick={() => void act(groupTicketId, 'approve')}><Check size={13} />确认执行</button>}
                <button type="button" className="sa-link" onClick={() => void open(groupTicketId)}>查看工单详情</button>
              </div>
            </article>;
          })}</div>
        {awaitingGroupAgents.length > 0 && <div className="sa-xc-summary">
          <div><strong>{awaitingGroupAgents.length} 个 Agent 等待确认</strong><span>确认后指令会作为只读提示词并行发送。</span></div>
          <button type="button" className="sa-button sa-primary" onClick={() => void approveGroup()}><Check size={14} />全部确认</button>
        </div>}
          {completedGroupAgents.length > 0 && !activeGroup.synthesisTicketId && <div className="sa-xc-summary">
            <div><strong>交叉验证完成 {completedGroupAgents.length}/{activeGroup.agentIds.length}</strong><span>让一个 Agent 比较各结论并指出分歧。</span></div>
            <label className="sa-field"><span>汇总者</span><select value={completedGroupAgents.includes(synthesisAgent) ? synthesisAgent : completedGroupAgents[0]} onChange={event => setSynthesisAgent(event.target.value)}>{completedGroupAgents.map(id => <option key={id} value={id}>{executorNames[id] || id}</option>)}</select></label>
            <button type="button" className="sa-button sa-primary" disabled={synthesizing} onClick={() => void synthesize()}>{synthesizing ? <RefreshCw size={14} className="sa-spin" /> : <Sparkles size={14} />}{synthesizing ? '汇总中…' : '汇总结论'}</button>
          </div>}
          {synthesisDetail && <section className="sa-agent-run">
            <header className="sa-agent-head"><span className="sa-agent-avatar"><Sparkles size={16} /></span><div className="sa-agent-name"><strong>交叉验证汇总</strong><span>{executorNames[activeGroup.synthesisAgentId || ''] || activeGroup.synthesisAgentId}</span></div><Status status={synthesisDetail.ticket.status} /></header>
            {reportText(synthesisDetail) ? <div className="sa-result"><div className="sa-result-text">{reportText(synthesisDetail)}</div></div> : <p className="sa-inline-note">汇总 Agent 正在比较各方结论…</p>}
            <button type="button" className="sa-link" onClick={() => void open(synthesisDetail.ticket.id)}>查看汇总工单</button>
          </section>}
        </> : activeTicket ? <>
          <div className="sa-chat-meta"><span>{executorNames[activeTicket.executor] || activeTicket.executor}</span><Status status={activeTicket.status} /><time>{time(activeTicket.updatedAt)}</time>{activeTicket.planId && <button type="button" className="sa-link" onClick={() => void openPlan(activeTicket.planId!)}>计划第{(activeTicket.planStep ?? 0) + 1}/{activeTicket.planTotal ?? 0} 此</button>}</div>
          <div className="sa-bubble-user">{activeTicket.title}</div>
          {activeAttention && <div className="sa-thread-attention">{renderAttention([activeAttention])}</div>}
          <section className="sa-agent-run">
            <header className="sa-agent-head"><span className="sa-agent-avatar"><Bot size={16} /></span><div className="sa-agent-name"><strong>{executorNames[activeTicket.executor] || activeTicket.executor}</strong><span>{activeTicket.source} · {time(activeTicket.createdAt)}</span></div><Status status={activeTicket.status} /></header>
            {activeReports.length > 0 ? <ol className="sa-activity">{activeReports.map(report => {
              const Icon = reportIcon(report);
              return <li key={report.id}><span className={`sa-activity-icon sa-activity-${report.kind}`}><Icon size={13} /></span><div><p>{report.summary || report.kind}</p><time>{time(report.createdAt)}</time></div></li>;
            })}</ol> : <p className="sa-inline-note">{terminalStatuses.includes(activeTicket.status) ? '这条工单没有执行记录。' : 'Agent 正在思考并准备执行…'}</p>}
            {!terminalStatuses.includes(activeTicket.status) && <div className="sa-thinking"><span className="sa-thinking-dot" /><span className="sa-thinking-dot" /><span className="sa-thinking-dot" /><span>Agent 正在工作，完成后结果会出现在这里</span></div>}
            {activeResult && <div className="sa-result"><h3><Check size={14} />结果</h3><div className="sa-result-text">{activeResult.slice(0, 12000)}</div></div>}
            <div className="sa-run-actions">
              {activeTicket.status === 'awaiting_review' && <button className="sa-button sa-primary" onClick={() => void act(activeTicket.id, 'approve')}><Check size={15} />确认继续</button>}
              {activeTicket.status === 'awaiting_review' && <button className="sa-button" onClick={() => void act(activeTicket.id, 'reject')}>要求修改</button>}
              {['working', 'queued', 'waiting'].includes(activeTicket.status) && <button className="sa-button" onClick={() => void act(activeTicket.id, 'stop')}><Square size={14} />停止</button>}
              {['failed', 'blocked', 'cancelled'].includes(activeTicket.status) && <button className="sa-button" onClick={() => void act(activeTicket.id, 'retry')}><RefreshCw size={14} />重试</button>}
              <button className="sa-button" onClick={() => void open(activeTicket.id)}><ChevronRight size={14} />完整详情与交接</button>
            </div>
          </section>
          {activeTicket.status === 'completed' && handoffTargets.length > 0 && <section className="sa-handoff-inline">
            <h3><GitBranch size={15} />交给另一个 Agent 接力</h3>
            <div className="sa-handoff-form"><label className="sa-field"><span>目标</span><select value={handoffExecutor} onChange={event => setHandoffExecutor(event.target.value)}>{handoffTargets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><label className="sa-field"><span>补充说明</span><input value={handoffText} onChange={event => setHandoffText(event.target.value)} placeholder="可选：希望下一棒关注什么" /></label><button className="sa-button" disabled={!handoffExecutor} onClick={() => void handoff()}>交接</button></div>
          </section>}
        </> : null}
      </div>
    </div>}
    <div className={`sa-composer-dock${isLanding ? ' sa-dock-split' : ''}`}>
      <form className="sa-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        {!isLanding && <div className="sa-agent-picks" role="group" aria-label="选择执行 Agent">
          <span className="sa-picks-label">Agent</span>
          {crossCapable.length ? crossCapable.map(agent => <button key={agent.id} type="button" className={`sa-agent-pick ${selectedAgents.includes(agent.id) ? 'on' : ''}`} aria-pressed={selectedAgents.includes(agent.id)} onClick={() => toggleAgent(agent.id)}>{selectedAgents.includes(agent.id) ? <Check size={12} /> : <Plus size={12} />}{executorNames[agent.id] || agent.name}</button>) : <span className="sa-inline-note">没有可用 Agent</span>}
          {windows.slice(0, 4).map(window => {
            const id = windowKey(window.handle);
            const on = selectedAgents.includes(id);
            return <button key={id} type="button" className={`sa-agent-pick ${on ? 'on' : ''}`} title={`${window.title || window.process} · PID ${window.pid}`} aria-pressed={on} onClick={() => toggleAgent(id)}>{on ? <Check size={12} /> : <Plus size={12} />}窗口 · {window.process}</button>;
          })}
        </div>}
        {isLanding && folderState.projects.length > 0 && <div className="sa-scope">
          <FolderGit2 size={13} />
          <label htmlFor="sa-scope-select">工作文件夹</label>
          <select id="sa-scope-select" value={newFolder} onChange={event => setNewFolder(event.target.value)} aria-label="选择工作文件夹">
            <option value="">不使用（在软件内执行）</option>
            {sortedFolders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <span className="sa-scope-hint">{newFolder ? 'Agent 会在这个目录里读写文件，工单仍需你确认' : '选择一个文件夹，Agent 才能改项目里的文件'}</span>
        </div>}
        {dispatchToggle && <div className="sa-composer-modes">{dispatchToggle}<span className="sa-inline-note">已选 {selectedAgents.length} 个 Agent，{dispatchMode === 'split' ? '任务会先拆成子任务' : '各自独立作答'}</span></div>}
        <textarea id="sa-command" value={command} maxLength={3000} onChange={event => setCommand(event.target.value)} onKeyDown={event => { if (event.key !== 'Enter') return; if (event.nativeEvent.isComposing) return; if (event.shiftKey || event.altKey) return; event.preventDefault(); void send(); }} rows={2} placeholder={selectedAgents.length > 1 ? (dispatchMode === 'split' ? '描述目标，例如：重构鉴权模块，一个 Agent 改代码、一个写测试、一个更新文档' : '描述要对比的问题，例如：审查这段鉴权逻辑是否有漏洞？') : '描述目标，例如：检查 DataAgent 仓库的 CI，修复失败项并开 PR'} />
        {singleExecutor === 'analysis' && (datasets.length > 1 ? <div className="sa-executor-fields"><label className="sa-field"><span>数据集</span><select value={datasetId} onChange={event => setDatasetId(event.target.value)}><option value="">请选择数据集</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.rowCount.toLocaleString()} 行</option>)}</select></label></div> : datasets.length === 1 ? <div className="sa-executor-fields"><span className="sa-inline-note"><Check size={13} />数据集：{datasets[0].name}</span></div> : <div className="sa-executor-fields"><span className="sa-inline-note">还没有数据集，请先在工作区上传或加载示例数据。</span></div>)}
        {singleExecutor === 'terminal' && <div className="sa-executor-fields"><label className="sa-field"><span>程序</span><select value={terminalProgram} onChange={event => setTerminalProgram(event.target.value)}><option value="git">git</option><option value="npm">npm</option><option value="ls">ls</option><option value="pwd">pwd</option></select></label><label className="sa-field"><span>参数</span><input value={terminalArgs} onChange={event => setTerminalArgs(event.target.value)} placeholder="status --short" /></label></div>}
        {singleExecutor === 'browser' && <div className="sa-executor-fields"><label className="sa-field"><span>页面地址</span><input type="url" value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} placeholder="https://example.com/page" /></label></div>}
        {singleExecutor === 'github' && <div className="sa-executor-fields"><label className="sa-field"><span>GitHub 动作</span><select value={githubAction} onChange={event => setGithubAction(event.target.value)}><option value="repo">仓库</option><option value="issues">Issues</option><option value="pulls">Pull Requests</option><option value="checks">CI Checks</option><option value="file">文件</option></select></label><label className="sa-field"><span>owner</span><input value={githubOwner} onChange={event => setGithubOwner(event.target.value)} placeholder="acme" /></label><label className="sa-field"><span>repo</span><input value={githubRepo} onChange={event => setGithubRepo(event.target.value)} placeholder="data-agent" /></label>{['issues', 'pulls', 'checks'].includes(githubAction) && <label className="sa-field"><span>编号</span><input inputMode="numeric" value={githubNumber} onChange={event => setGithubNumber(event.target.value)} placeholder="7" /></label>}{githubAction === 'file' && <label className="sa-field"><span>文件路径</span><input value={githubPath} onChange={event => setGithubPath(event.target.value)} placeholder="docs/readme.md" /></label>}</div>}
        <div className="sa-composer-foot"><div className="sa-chips">{!isLanding && quickCommands.map(item => <button type="button" key={item} onClick={() => setCommand(item)}>{item}</button>)}<button type="button" onClick={() => setPlanOpen(true)}>多步计划</button></div><button className="sa-send" type="submit" disabled={!command.trim() || sending} aria-label="发送指令">{sending ? <RefreshCw size={16} className="sa-spin" /> : <Send size={16} />}<span>{sending ? '提交中' : composerTitle}</span></button></div>
      </form>
      <p className="sa-note"><ShieldCheck size={14} />{selectedAgents.length > 1 ? (dispatchMode === 'split' ? '任务会先拆成子任务再分派给各 Agent，开工前仍按策略逐单确认。' : '多个 Agent 会并行独立作答，方便对比；会消耗对应执行器的额度。') : '只会执行你明确授权或规则允许的操作；危险动作会先请求确认。'}<span className="sa-keyhint">Enter 发送 · Shift + Enter 换行</span></p>
    </div>
  </div>;

  const inboxPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">ATTENTION</p><h1>收件箱<span className="sa-count">{attention.length}</span></h1><p>只有需要你决定的事项会出现在这里。</p></div></header>
    {attention.length ? <>
      {inboxProjects.length > 0 && <div className="sa-inbox-filters" role="group" aria-label="按工作文件夹筛选">
        <button type="button" className={`sa-chip ${inboxFilter ? '' : 'on'}`} aria-pressed={!inboxFilter} onClick={() => setInboxFilter('')}>全部<span>{attention.length}</span></button>
        {inboxProjects.map(project => <button type="button" key={project.id} className={`sa-chip ${inboxFilter === project.id ? 'on' : ''}`} aria-pressed={inboxFilter === project.id} onClick={() => setInboxFilter(inboxFilter === project.id ? '' : project.id)}>{project.name}<span>{project.count}</span></button>)}
      </div>}
      {inboxGroups.map(group => <section className="sa-inbox-group" key={group.label}>
        <div className="sa-group-head"><h2>{group.label}</h2><span>{group.items.length}</span></div>
        {renderAttention(group.items.map(row => row.item))}
      </section>)}
      {!inboxGroups.length && <p className="sa-empty">这个工作文件夹没有待确认事项。</p>}
    </> : <div className="sa-empty-card"><Check size={22} /><h2>没有需要处理的事项</h2><p>Agent 会继续执行已授权的工作。</p></div>}</section>;

  const dshWindow = windows.find(window => /deepseek/i.test(`${window.process} ${window.title}`));
  const windowFallbackFor = (provider: { id: string; name: string }) => /deepseek/i.test(`${provider.id} ${provider.name}`) && dshWindow
    ? `已检出运行中的「${dshWindow.process}」窗口，无需安装 ACP：在左下角选择「窗口 · ${dshWindow.process}」即可直接发送指令。`
    : '';
  const providerIcon = (id: string) => /desktop|dsh/.test(id) ? <AppWindow size={18} /> : /acp/.test(id) ? <Bot size={18} /> : <Terminal size={18} />;
  const providerKind = (provider: { id: string; kind?: string }) => provider.kind === 'desktop' ? '桌面版' : provider.id.endsWith('-acp') ? 'ACP' : 'CLI';
  const enabledExecutors = policy?.allowedExecutors || work?.policy?.allowedExecutors || [];
  const sortedProviders = [...providers].sort((left, right) => Number(right.installed) - Number(left.installed));
  const missingProviders = sortedProviders.filter(provider => !provider.installed);
  const visibleProviders = showMissing ? sortedProviders : sortedProviders.filter(provider => provider.installed);
  const agentsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">AGENTS</p><h1>本机 Agent</h1><p>自动识别本机已安装的 Agent 程序，用开关决定它们能否被调度。</p></div>
    <button type="button" className="sa-button" disabled={providersLoading} onClick={() => void loadProviders(true)}>{providersLoading ? '探测中…' : '重新探测'}</button></header>
    <section className="sa-providers">
      <p className="sa-inline-note"><ShieldCheck size={13} />按 PATH / PATHEXT 解析命令并读取版本，探测结果不会保存输出原文；开关写入执行器策略，停用的 Agent 不会出现在新对话的选择里。</p>
      <ul className="sa-agent-list">{visibleProviders.map(provider => {
        const executorId = provider.executorId || '';
        const switchable = Boolean(executorId) && provider.installed;
        const enabled = switchable && enabledExecutors.includes(executorId);
        return <li className={`sa-agent-row${enabled ? ' is-on' : ''}${provider.installed ? '' : ' is-off'}`} key={provider.id}>
          <span className="sa-agent-glyph">{providerIcon(provider.id)}</span>
          <div className="sa-agent-main">
            <div className="sa-agent-line"><strong>{provider.name}</strong><span className="sa-agent-kind">{providerKind(provider)}</span>{provider.version ? <span className="sa-agent-ver">{provider.version}</span> : null}</div>
            <p className="sa-agent-path" title={provider.command || ''}>{provider.command || '未找到命令'}{provider.installed ? '' : ' · 未安装或不在 PATH'}</p>
            {(provider.status !== 'ready' || provider.kind === 'desktop') && provider.message ? <p className="sa-agent-note-line">{provider.message}{!/窗口/.test(provider.message) && windowFallbackFor(provider) ? ` ${windowFallbackFor(provider)}` : ''}</p> : null}
          </div>
          <div className="sa-agent-side">
            <Status status={provider.status} />
            {executorId ? <button type="button" role="switch" aria-checked={enabled} aria-label={`${provider.name} 开关`} className={`sa-switch${enabled ? ' on' : ''}`} disabled={!switchable || executorBusy === executorId} onClick={() => void setExecutorEnabled(executorId, !enabled)}><span /></button> : <span className="sa-agent-tag">仅识别</span>}
          </div>
        </li>;
      })}</ul>
      {!providers.length && !providersLoading && <p className="sa-empty">尚未探测到本机 Agent。</p>}
      {Boolean(missingProviders.length) && <button type="button" className="sa-link sa-agent-more" onClick={() => setShowMissing(value => !value)}>{showMissing ? '收起未安装项' : `还有 ${missingProviders.length} 个未安装的 Agent，展开查看`}</button>}
      <p className="sa-inline-note">可选 ACP 入口：<code>npm i -g @agentclientprotocol/claude-agent-acp</code>（Claude Code）、<code>npm i -g dsh-acp</code>（DeepSeek Harness）。内置工具（数据分析 / 受控终端 / 浏览器 / GitHub）在<button type="button" className="sa-link" onClick={() => setView('tools')}>工具页</button>管理。</p>
    </section>
    <section className="sa-windows"><div className="sa-section-head"><h2>已打开的 Agent 窗口</h2><button type="button" className="sa-link" disabled={windowsLoading} onClick={() => void loadWindows()}>{windowsLoading ? '刷新中…' : '刷新窗口'}</button></div>
      <p className="sa-inline-note"><ShieldCheck size={13} />只向白名单进程窗口发送；发送会直接键入该窗口并回车，请先确认标题。DeepSeek Harness 与 Codex 桌面版已加入默认白名单。</p>
      {windows.length ? <ul className="sa-window-list">{windows.map(window => <li className="sa-window" key={window.id}>
        <div className="sa-window-head"><div><strong>{window.title || window.process}</strong><span>{window.process} · PID {window.pid} · 句柄 {window.handle}</span></div><span className="sa-tag-ok">可操作</span></div>
        <div className="sa-window-actions"><input value={windowDrafts[window.id] || ''} onChange={event => setWindowDrafts(previous => ({ ...previous, [window.id]: event.target.value }))} placeholder="输入要发送给该窗口的指令" aria-label={`向${window.process} 发送指令`} /><button type="button" className="sa-button sa-primary" disabled={!(windowDrafts[window.id] || '').trim()} onClick={() => void sendToWindow(window)}>发送</button><button type="button" className="sa-button" onClick={() => void readFromWindow(window)}>读取</button><button type="button" className="sa-button" title={`与「${window.title || window.process}」开始一段新对话`} onClick={() => startWindowChat(window)}>新对话</button></div>
        {windowOutputs[window.id] && <pre className="sa-window-output">{windowOutputs[window.id].slice(-2000)}</pre>}
      </li>)}</ul> : <div className="sa-empty-card"><h2>没有检测到可操作的 Agent 窗口</h2><p>请先打开 Codex、Claude Code、DeepSeek Harness 或终端窗口，然后刷新。</p></div>}
    </section>
  </section>;

  const toolsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">TOOLS</p><h1>工具</h1><p>软件自带工具；启用后即可在指令和计划中使用。</p></div></header><div className="sa-card-grid">{tools.map(tool => {
    const enabled = (policy?.allowedExecutors || []).includes(tool.id);
    const action = tool.id === 'window';
    return <article className="sa-card" key={tool.id}><div className="sa-card-icon">{toolIcon(tool.id)}</div><div className="sa-card-title"><h2>{tool.name}</h2><Status status={tool.status} /></div><p className="sa-mono">{tool.kind}</p><div className="sa-tags">{tool.permissions.map(item => <span key={item}>{item}</span>)}</div>
      {tool.id === 'github' && tool.status === 'needs_setup' && <p className="sa-inline-note">需要配置 GITHUB_TOKEN 并允许外部执行器。</p>}
      {tool.id === 'browser' && tool.status === 'needs_setup' && <p className="sa-inline-note">正在安装或缺少 Chromium。</p>}
      {action ? <div className="sa-plan-actions-inline"><button className="sa-button" disabled={enabled} onClick={() => void enableTool(tool.id)}>{enabled ? '已启用' : '启用工具'}</button><button className="sa-button" onClick={() => setView('agents')}>打开窗口 Agent</button></div> : tool.id === 'terminal' ? <span className="sa-tag-ok"><Check size={13} />内置可用</span> : <button className="sa-button" disabled={enabled || tool.status === 'needs_setup'} onClick={() => void enableTool(tool.id)}>{enabled ? '已启用' : tool.status === 'needs_setup' ? '需要先完成配置' : '启用工具'}</button>}
    </article>;
  })}{!tools.length && <p className="sa-empty">工具状态载入中。</p>}</div></section>;

  const settingsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">SETTINGS</p><h1>设置</h1><p>主题、模型与执行权限。</p></div></header><div className="sa-settings-grid"><article className="sa-card"><h2>外观</h2><p>当前仅保留简洁版，主题可切换。</p><button className="sa-button" onClick={() => setAppearanceOpen(true)}><SunMoon size={15} />打开显示设置</button></article><article className="sa-card"><h2>模型与 API</h2><p>配置执行器使用的模型和凭据。</p><button className="sa-button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />打开模型设置</button></article><article className="sa-card sa-policy-card"><h2>执行器策略</h2><p>默认只允许受控终端与内置工具；外部执行器还需设置 <code>DATAAGENT_ALLOW_EXTERNAL_EXECUTORS=1</code>。</p>
    {policy ? <><div className="sa-policy-executors">{executorIds.map(id => <label key={id}><input type="checkbox" checked={(policy.allowedExecutors || []).includes(id)} onChange={() => toggleExecutor(id)} />{executorNames[id]}</label>)}</div>
      <label className="sa-policy-toggle"><input type="checkbox" checked={policy.limits?.acpWrites !== false} onChange={event => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), acpWrites: event.target.checked } } : previous)} /><span>项目内 ACP 可写<em>关闭后 ACP Agent 在项目里只能读文件；终端调用始终拒绝。</em></span></label>
      <div className="sa-policy-budgets">
        <label>并发<input type="number" min={1} max={8} value={policy.budgets?.maxConcurrent ?? 2} onChange={event => setBudget('maxConcurrent', Number(event.target.value))} /></label>
        <label>每单调用<input type="number" min={1} max={50} value={policy.budgets?.maxCallsPerTicket ?? 12} onChange={event => setBudget('maxCallsPerTicket', Number(event.target.value))} /></label>
        <label>最长时长（毫秒）<input type="number" min={1000} max={86400000} value={policy.budgets?.maxRuntimeMs ?? 3600000} onChange={event => setBudget('maxRuntimeMs', Number(event.target.value))} /></label>
        <label>Token 上限<input type="number" min={1000} max={10000000} value={policy.budgets?.maxTokensPerTicket ?? 200000} onChange={event => setBudget('maxTokensPerTicket', Number(event.target.value))} /></label>
        <label>浏览器主机<input value={(policy.limits?.browserHosts || []).join(', ')} placeholder="example.com" onChange={event => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), browserHosts: event.target.value.split(',').map(item => item.trim()).filter(Boolean) } } : previous)} /></label>
        <label>GitHub 仓库<input value={(policy.limits?.githubRepos || []).join(', ')} placeholder="owner/repo" onChange={event => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), githubRepos: event.target.value.split(',').map(item => item.trim()).filter(Boolean) } } : previous)} /></label>
      </div><div className="sa-policy-actions"><button className="sa-button sa-primary" disabled={policySaving} onClick={() => void savePolicy()}>{policySaving ? '保存中…' : '保存策略'}</button><span className="sa-tag-ok"><ShieldCheck size={14} />审批模式开启</span></div></> : <p className="sa-empty">策略载入中…</p>}
  </article><article className="sa-card sa-mobile-card"><h2><Smartphone size={16} />手机指挥</h2><p>{runtime.mode === 'cloud' ? <>在手机浏览器打开 <code>{location.origin}/m</code>，输入一次性配对码即可远程查看、审批和下达指令。</> : <>本地服务只监听 <code>127.0.0.1</code>，手机无法直接访问。请使用云端账号版，或通过 HTTPS 反向代理暴露服务后打开 <code>/m</code>。</>}</p>
    {mobilePair && <div className="sa-mobile-code" role="status"><strong>{mobilePair.code}</strong><span>{mobilePairSeconds > 0 ? `${mobilePairSeconds} 秒后过期` : '已过期，请重新生成'}</span></div>}
    <button className="sa-button" disabled={mobileBusy === 'pair'} onClick={() => void createMobilePair()}>{mobileBusy === 'pair' ? <RefreshCw size={15} className="sa-spin" /> : <Smartphone size={15} />}{mobilePair ? '重新生成配对码' : '生成配对码'}</button>
    {mobileDevices.length > 0 ? <ul className="sa-mobile-devices">{mobileDevices.map(device => <li key={device.id}><div><strong>{device.name}</strong><span>配对时间 {time(device.createdAt)} · 有效至 {time(device.expiresAt)}</span></div><button className="sa-link" disabled={mobileBusy === device.id} onClick={() => void revokeMobileDevice(device.id)}>{mobileBusy === device.id ? '撤销中…' : '撤销'}</button></li>)}</ul> : <p className="sa-inline-note">还没有已配对的手机。</p>}
    <p className="sa-inline-note"><ShieldCheck size={13} />配对码 5 分钟有效且只能使用一次；设备凭证 90 天后过期。</p>
  </article><article className="sa-card sa-mobile-card"><h2><Terminal size={16} />MCP 外部 Agent</h2><p>让 Claude Code、Codex 或其他 MCP Agent 通过 <code>{location.origin}/api/mcp</code> 反向读取工单与报告、查看执行器、创建计划、发送指令和审批。</p>
    {mcpToken ? <div className="sa-mcp-token"><div><span>端点</span><code>{location.origin}{mcpToken.endpoint}</code></div><div><span>Bearer 令牌</span><code>{mcpToken.token}</code></div><p className="sa-inline-note"><ShieldCheck size={13} />令牌只显示一次，请现在复制；有效至{time(mcpToken.expiresAt)}。</p></div> : <button className="sa-button" disabled={mcpBusy} onClick={() => void createMcpToken()}>{mcpBusy ? <RefreshCw size={15} className="sa-spin" /> : <Terminal size={15} />}{mcpBusy ? '生成中…' : '生成 MCP 令牌'}</button>}
    <div className="sa-code-note"><span>Claude Code 示例</span><code>claude mcp add --transport http dataagent {location.origin}/api/mcp --header "Authorization: Bearer &lt;令牌&gt;"</code></div>
  </article></div></section>;

  const parallelPage = (() => {
    const elapsedOf = (iso: string) => {
      const ms = Date.now() - Date.parse(iso);
      if (!Number.isFinite(ms) || ms < 0) return '';
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return `${sec} 秒`;
      const min = Math.floor(sec / 60);
      return min < 60 ? `${min} 分 ${sec % 60} 秒` : `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
    };
    const done = tickets.filter(ticket => terminalStatuses.includes(ticket.status)).slice(0, 6);
    const card = (ticket: WorkTicket, live: boolean) => {
      const detail = parallelDetails[ticket.id];
      const text = reportText(detail).trim();
      const stopped = ['completed', 'failed', 'blocked', 'cancelled'].includes(ticket.status);
      return <article className={`sa-live-card${live ? ' is-live' : ''}`} key={ticket.id}>
        <header className="sa-live-head">
          <span className="sa-agent-avatar">{agentIcon(ticket.executor, 15)}</span>
          <div className="sa-live-title"><strong>{executorNames[ticket.executor] || ticket.executor}</strong><span title={ticket.title}>{ticket.title}</span></div>
          <Status status={ticket.status} />
        </header>
        {(text || live) && <pre className="sa-live-body">{text ? text.slice(-1200) : '正在等待第一个输出…'}</pre>}
        <footer className="sa-live-foot">
          <span>{elapsedOf(ticket.createdAt)}{ticket.planId ? ` · 第 ${(ticket.planStep ?? 0) + 1}/${ticket.planTotal ?? 0} 步` : ''}{ticket.projectChatId ? ' · 项目任务' : ''}</span>
          <div>
            {ticket.status === 'awaiting_review' && <button type="button" className="sa-link" onClick={() => void act(ticket.id, 'approve')}>批准</button>}
            {ticket.status === 'awaiting_review' && <button type="button" className="sa-link" onClick={() => void act(ticket.id, 'reject')}>要求修改</button>}
            <button type="button" className="sa-link" onClick={() => viewTicket(ticket.id)}>打开</button>
            {!stopped && <button type="button" className="sa-link sa-link-danger" onClick={() => void act(ticket.id, 'stop')}>停止</button>}
            {['failed', 'blocked', 'cancelled'].includes(ticket.status) && <button type="button" className="sa-link" onClick={() => void act(ticket.id, 'retry')}>重试</button>}
          </div>
        </footer>
      </article>;
    };
    return <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">PARALLEL</p><h1>并行执行<span className="sa-count">{liveTickets.length}</span></h1><p>所有 Agent 的实时进度同屏显示，每 2.5 秒自动刷新，不用逐个点开。</p></div><button className="sa-button" onClick={() => void refresh()}><RefreshCw size={14} />刷新</button></header>
      {liveTickets.length
        ? <div className="sa-live-grid">{liveTickets.map(ticket => card(ticket, true))}</div>
        : <div className="sa-empty-card"><span className="sa-empty-icon"><Activity size={20} /></span><div><strong>现在没有正在执行的 Agent</strong><span>选择两个以上 Agent 后发送指令，任务会先被拆成子任务再分派，结果在这里同时出现。</span></div><button className="sa-button" onClick={() => setView('command')}>去下达指令</button></div>}
      {done.length > 0 && <section className="sa-section"><div className="sa-section-head"><h2>刚结束</h2><span className="sa-inline-note">最多显示 6 个</span></div><div className="sa-live-grid">{done.map(ticket => card(ticket, false))}</div></section>}
    </section>;
  })();

  const page = view === 'command' ? conversationPage : view === 'inbox' ? inboxPage : view === 'parallel' ? parallelPage : view === 'projects' ? <ProjectsPanel notify={notify} onOpenTicket={viewTicket} focusProjectId={projectFocus} focusChatId={chatFocus} requestImport={importTick} onState={handleFolderState} onFocusProject={() => { setProjectFocus(null); setChatFocus(null); }} allowedExecutors={allowedExecutors.filter(id => projectExecutorIds.includes(id))} /> : view === 'agents' ? agentsPage : view === 'tools' ? toolsPage : view === 'memory' ? <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">MEMORY</p><h1>记忆</h1><p>你确认过的偏好、术语和决定。</p></div></header><MemoryPanel /></section> : settingsPage;

  return <div className="sa-shell" style={sidebarWidth ? { '--sa-sidebar': `${sidebarWidth}px` } as React.CSSProperties : undefined}>
    <a className="skip-link" href="#sa-main">跳到主内容</a>
    {navOpen && <button className="sa-nav-shade" aria-label="关闭导航" onClick={() => setNavOpen(false)} />}
    <aside className={`sa-sidebar ${navOpen ? 'sa-nav-open' : ''}`}>
      <div className="sa-brand-row">
        <button className="sa-brand" onClick={newChat}><Logo /><span>DataAgent<span className="brand-dot">.</span></span></button>
      </div>
      <button className="sa-icon sa-nav-close" aria-label="关闭导航" onClick={() => setNavOpen(false)}><X size={18} /></button>
      <button className="sa-newchat" onClick={newChat}><span className="sa-newchat-label"><Plus size={16} />新对话</span></button>
      <nav className="sa-nav" aria-label="功能导航">{navItems.map(item => <button key={item.id} className={`sa-nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id); setNavOpen(false); }}><item.icon size={16} /><span>{item.label}</span>{item.id === 'inbox' && attention.length > 0 && <em>{attention.length}</em>}{item.id === 'parallel' && liveTickets.length > 0 && <em className="sa-nav-live">{liveTickets.length}</em>}</button>)}</nav>
      <div className="sa-side-scroll">
      <section className={`sa-folders ${dropActive ? 'sa-drop-active' : ''}`} aria-label="工作文件夹"
        onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDropActive(true); } }}
        onDragLeave={() => setDropActive(false)}
        onDrop={event => { void importDroppedFolder(event); }}>
        <div className="sa-side-title"><span>工作文件夹</span><button type="button" className="sa-side-action" aria-label="添加本地文件夹" title="添加本地文件夹（也可以把文件夹拖进来）" onClick={() => { setView('projects'); setProjectFocus(null); setChatFocus(null); setImportTick(tick => tick + 1); setNavOpen(false); }}><Plus size={13} /></button></div>
        <div className="sa-folder-list">
          {sortedFolders.length ? sortedFolders.map(item => {
            const collapsed = collapsedProjects.includes(item.id);
            const activeProject = view === 'projects' && folderState.projectId === item.id;
            const menuOpen = folderMenu === item.id;
            const pending = item.chats.reduce((sum, chat) => sum + (chat.pendingCount || 0), 0);
            return <div key={item.id} className={`sa-folder ${activeProject ? 'active' : ''}`}>
              <div className="sa-folder-row">
                <button type="button" className="sa-folder-toggle" aria-label={collapsed ? `展开 ${item.name}` : `收起 ${item.name}`} aria-expanded={!collapsed} onClick={() => toggleProject(item.id)}><ChevronRight size={12} className={collapsed ? '' : 'open'} /></button>
                {folderRename?.id === item.id
                  ? <input className="sa-folder-rename" autoFocus value={folderRename.value} aria-label="工作文件夹名称"
                      onChange={event => setFolderRename({ id: item.id, value: event.target.value })}
                      onBlur={() => void commitFolderRename()}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commitFolderRename(); } if (event.key === 'Escape') setFolderRename(null); }} />
                  : <button type="button" className="sa-folder-name" title={item.path} onClick={() => openFolder(item.id)} onDoubleClick={() => { setFolderRename({ id: item.id, value: item.name }); }}>
                    {pinnedProjects.includes(item.id) ? <Pin size={12} /> : <FolderGit2 size={13} />}<span>{item.name}</span>{pending > 0 && <em className="sa-folder-pending">{pending}</em>}
                  </button>}
                <button type="button" className="sa-folder-add" aria-label={`在 ${item.name} 新建会话`} title="新建会话" onClick={() => void quickNewChat(item)}><Plus size={12} /></button>
                <button type="button" className="sa-folder-more" aria-label={`${item.name} 更多操作`} aria-expanded={menuOpen} onClick={() => setFolderMenu(menuOpen ? null : item.id)}><MoreHorizontal size={13} /></button>
              </div>
              {menuOpen && <div className="sa-folder-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => void revealFolder(item)}>在资源管理器中打开</button>
                <button type="button" role="menuitem" onClick={() => { setFolderMenu(null); setFolderRename({ id: item.id, value: item.name }); }}>重命名</button>
                <button type="button" role="menuitem" onClick={() => { setFolderMenu(null); togglePin(item.id); }}>{pinnedProjects.includes(item.id) ? '取消置顶' : '置顶'}</button>
                <button type="button" role="menuitem" className="danger" onClick={() => { setFolderMenu(null); setFolderToDelete(item); }}>移除文件夹</button>
              </div>}
              {!collapsed && <div className="sa-folder-chats">
                {item.chats.length ? item.chats.map(entry => {
                  const active = activeProject && folderState.chatId === entry.id;
                  if (chatRename?.chatId === entry.id) {
                    return <input key={entry.id} className="sa-chat-rename" autoFocus value={chatRename.value} aria-label="会话标题"
                      onChange={event => setChatRename({ ...chatRename, value: event.target.value })}
                      onBlur={() => void commitChatRename()}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commitChatRename(); } if (event.key === 'Escape') setChatRename(null); }} />;
                  }
                  const unread = chatUnread(entry);
                  return <button type="button" key={entry.id} className={`sa-conv sa-conv-sub ${active ? 'active' : ''} ${unread ? 'has-unread' : ''}`} title={`${executorNames[entry.executorId] || entry.executorId} · 写入 ${item.path}（双击重命名）`} onClick={() => openFolderChat(item.id, entry.id)} onDoubleClick={event => { event.preventDefault(); setChatRename({ projectId: item.id, chatId: entry.id, value: entry.title }); }}>
                    <span className="sa-conv-body">
                      <span className="sa-conv-title">{entry.title}</span>
                      <span className="sa-conv-meta"><span>{executorNames[entry.executorId] || entry.executorId}</span><time>{shortTime(entry.updatedAt || entry.createdAt)}</time>{unread && <em className="sa-unread" aria-label="有新的执行结果" />}</span>
                    </span>
                  </button>;
                }) : <p className="sa-folder-empty">还没有会话，点右侧 + 新建一个。</p>}
              </div>}
            </div>;
          }) : <p className="sa-folder-empty">还没有工作文件夹。添加或拖入一个目录，Agent 就在里面读写文件。</p>}
        </div>
        {dropActive && <div className="sa-drop-hint"><FolderGit2 size={16} />松开导入这个文件夹</div>}
      </section>
      <section className="sa-conv-section">
        <div className="sa-side-title"><span>对话</span><span>{conversationTickets.length}</span></div>
        <label className="sa-conv-search"><Search size={13} /><input type="search" value={convQuery} onChange={event => setConvQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setConvQuery(''); } }} placeholder="搜索对话" aria-label="搜索对话" /></label>
        <div className="sa-conversations">
          {conversationGroups.length ? conversationGroups.map(group => <div key={group.label}>
            <p className="sa-conv-group">{group.label}</p>
            {group.items.map(item => {
              const active = item.kind === 'group' ? item.id === activeGroupId : item.id === activeTicketId && !activeGroupId;
              const status = item.kind === 'group' && item.group ? groupStatusOf(item.group) : item.ticket?.status || 'waiting';
              return <button type="button" key={item.id} className={`sa-conv ${active ? 'active' : ''}`} aria-current={active ? 'true' : undefined} onClick={() => { setNavOpen(false); if (item.kind === 'group' && item.group) viewGroup(item.group); else if (item.ticket) viewTicket(item.ticket.id); }}>
                <span className="sa-conv-icon">{item.kind === 'group' ? <Users size={12} /> : <Bot size={12} />}</span>
                <span className="sa-conv-body">
                  <span className="sa-conv-title">{item.title}</span>
                  <span className="sa-conv-meta"><em className={`sa-dot sa-dot-${status}`} /><span>{item.kind === 'group' ? `${item.group?.agentIds.length || 0} 个 Agent 交叉验证` : executorNames[item.ticket?.executor || ''] || item.ticket?.executor}</span><time>{shortTime(item.createdAt)}</time></span>
                </span>
              </button>;
            })}
          </div>) : <p className="sa-conv-empty">{convQuery.trim() ? `没有匹配「${convQuery.trim()}」的对话。` : '还没有对话。在上方描述目标即可开始。'}</p>}
        </div>
      </section>
      </div>
      <div className="sa-sidebar-foot"><div className="sa-user"><span className="sa-avatar">{user?.displayName?.slice(0, 1).toUpperCase() || 'D'}</span><span><strong>{user?.displayName || '个人工作区'}</strong><small>{runtime.mode === 'cloud' ? '云端账号' : '本地运行'}</small></span><Sparkles size={14} /></div></div>
    </aside>
    <div className="sa-side-resize" role="separator" aria-orientation="vertical" aria-label="拖动调整侧栏宽度" title="拖动调整侧栏宽度，双击恢复默认" onPointerDown={startSidebarResize} onDoubleClick={() => setSidebarWidth(0)} />
    <div className="sa-main"><header className="sa-topbar"><div className="sa-breadcrumb"><button className="sa-icon sa-menu" aria-label="打开导航" onClick={() => setNavOpen(true)}><Menu size={19} /></button><span>{view === 'command' ? (activeGroup ? '交叉验证' : '个人 Agent') : '个人 Agent'}</span><ChevronRight size={12} /><strong>{view === 'command' ? activeGroup ? activeGroup.prompt : activeTicket?.title || '新对话' : current}</strong>{view === 'command' && activeGroup && <Status status={groupStatusOf(activeGroup)} />}{view === 'command' && activeTicket && <Status status={activeTicket.status} />}</div><div className="sa-topbar-right"><span className="sa-connection" role="status"><span className="online-dot" />{error ? '指挥服务未连接' : runtime.mode === 'cloud' ? '云端已连接' : '本地已连接'}</span><button className="sa-icon" aria-label={appearance.resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={appearance.resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => appearance.setTheme(appearance.resolvedTheme === 'dark' ? 'light' : 'dark')}><SunMoon size={17} /></button></div></header>
      <main id="sa-main" className={`sa-content ${view === 'command' ? 'sa-content-chat' : ''}`}>{error && !loading ? <div className="sa-error"><AlertTriangle size={20} /><div><h2>指挥服务尚未连接</h2><p>{error}</p><button className="sa-button" onClick={() => void load()}><RefreshCw size={15} />重试</button></div></div> : loading && !work ? <div className="sa-loading"><RefreshCw size={20} className="sa-spin" /><span>正在载入指挥台…</span></div> : page}</main>
    </div>
    {planDetail && <Modal title={planDetail.goal} subtitle={`多步计划${planDetail.autoRun ? ' · 自动执行' : ''} · ${planDetail.status === 'active' ? '进行中' : planDetail.status === 'completed' ? '已完成' : planDetail.status === 'cancelled' ? '已取消' : '已失败'} · ${planDetail.totalSteps} 步`} close={() => setPlanDetail(null)}>
      <div className="sa-plan-graph">{planDetail.steps.map(step => <div className="sa-plan-graph-step" key={step.index}>
        <span className="sa-plan-index">{step.index + 1}</span>
        <div><strong>{step.title}</strong><span>{step.executorId}{step.dependsOn?.length ? ` · 依赖 ${step.dependsOn.map(item => item + 1).join('、')}` : ' · 可并行'}</span></div>
        <Status status={step.status || 'pending'} />
      </div>)}</div>
    </Modal>}
    {detail && <Modal title={detail.ticket.title} subtitle={`${statusNames[detail.ticket.status] || detail.ticket.status} · ${detail.ticket.executor}`} close={() => setDetail(null)}>
      <div className="sa-detail"><p className="sa-detail-summary">{detail.ticket.summary || '暂无摘要。'}</p>{detail.project && <p className="sa-detail-project"><FolderGit2 size={14} /><strong>{detail.project.name}</strong>{detail.projectChat && <span>{executorNames[detail.projectChat.executorId] || detail.projectChat.executorId}{detail.projectChat.title && detail.projectChat.title !== detail.project.name ? ` · ${detail.projectChat.title}` : ''}</span>}<button type="button" className="sa-link" onClick={() => { setDetail(null); setView('projects'); setProjectFocus(detail.project!.id); }}>打开项目<ChevronRight size={13} /></button></p>}{detail.ticket.planId && <p className="sa-inline-note">多步计划第{(detail.ticket.planStep ?? 0) + 1}/{detail.ticket.planTotal ?? 0} 此</p>}<div className="sa-detail-actions">
        {detail.ticket.status === 'awaiting_review' && <button className="sa-button sa-primary" onClick={() => void act(detail.ticket.id, 'approve')}><Check size={15} />确认继续</button>}
        {detail.ticket.status === 'awaiting_review' && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'reject')}>要求修改</button>}
        {['working', 'queued', 'waiting'].includes(detail.ticket.status) && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'stop')}><Square size={14} />停止</button>}
        {['failed', 'blocked', 'cancelled'].includes(detail.ticket.status) && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'retry')}><RefreshCw size={14} />重试</button>}
      </div>{detail.ticket.status === 'completed' && <section className="sa-handoff"><h3><GitBranch size={15} />交给另一个 Agent</h3>
        {detail.ticket.handoffChildId ? <div className="sa-handoff-done"><p>已交接给下一棒。</p><button className="sa-button" onClick={() => void open(detail.ticket.handoffChildId!)}>查看下一棒<ChevronRight size={14} /></button></div> : <div className="sa-handoff-form">
          <label className="sa-field"><span>目标执行器</span><select value={handoffExecutor} onChange={event => setHandoffExecutor(event.target.value)}>{handoffTargets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}{!handoffTargets.length && <option value="">没有可用执行器</option>}</select></label>
          <label className="sa-field"><span>补充说明</span><input value={handoffText} onChange={event => setHandoffText(event.target.value)} placeholder="可选：希望下一棒关注什么" /></label>
          <button className="sa-button sa-primary" disabled={!handoffExecutor} onClick={() => void handoff()}>交接</button>
        </div>}
      </section>}{detail.ticket.parentTicketId && <p className="sa-inline-note">来自上一棒工单{detail.ticket.parentTicketId.slice(0, 8)}，当前为第{detail.ticket.handoffDepth ?? 1} 棒。{detail.ticket.handoffSummary ? ` 上一棒摘要：${detail.ticket.handoffSummary}` : ''}</p>}<h3>执行记录</h3>{detail.reports.length ? <ol className="sa-reports">{detail.reports.map(report => <li key={report.id}><Status status={report.kind === 'ready' ? 'completed' : report.kind === 'failed' ? 'failed' : report.kind === 'blocked' ? 'blocked' : 'working'} /><div><strong>{reportKindNames[report.kind] || report.kind}</strong><p>{report.summary}</p></div><time>{time(report.createdAt)}</time></li>)}</ol> : <p className="sa-empty">还没有执行记录。</p>}
      <section className="sa-team"><div className="sa-team-head"><h3><GitBranch size={15} />团队任务树</h3><span>{detail.team ? `revision ${detail.team.revision}` : '未启用'}</span></div>
        {detail.team ? <>
          <div className="sa-team-summary"><span>调用 {detail.team.usage.calls}</span><span>Token {detail.team.usage.totalTokens.toLocaleString()}</span><span>并发上限 {detail.team.limits.maxConcurrent}</span>{detail.team.cancelled && <span className="sa-team-cancelled">团队已取消</span>}</div>
          <div className="sa-tree">{[...detail.team.nodes].sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)).map(node => <div className="sa-tree-node" key={node.id} style={{ paddingLeft: Math.max(0, node.depth - 1) * 16 }}>
            <div className="sa-tree-row"><strong>{node.name}</strong><Status status={node.status} /><span>深度 {node.depth}{node.retries ? ` · 重试 ${node.retries}` : ''}</span></div>
            {node.parentId && ['completed', 'failed'].includes(node.status) && <div className="sa-node-actions"><button type="button" className="sa-button sa-primary" onClick={() => void reviewNode(node.id, 'accept')}>接受</button><button type="button" className="sa-button" disabled={node.retries >= 1} onClick={() => void reviewNode(node.id, 'reject')}>退回</button></div>}
            {node.proposals.length > 0 && <div className="sa-proposals">{node.proposals.map(proposal => <div className="sa-proposal" key={proposal.id}><span className={`sa-proposal-status sa-proposal-${proposal.status}`}>{proposal.kind === 'chart' ? '图表提案' : '处理提案'} · {proposalNames[proposal.status] || proposal.status}</span><span>{proposal.summary}</span>{['proposed', 'needsApproval'].includes(proposal.status) && <span className="sa-proposal-actions"><button type="button" onClick={() => void decideProposal(node.id, proposal.id, 'accept')}>接受</button><button type="button" onClick={() => void decideProposal(node.id, proposal.id, 'reject')}>拒绝</button></span>}</div>)}</div>}
          </div>)}</div>
          {detail.team.events.length > 0 && <details className="sa-team-events"><summary>最近事件</summary><ul>{detail.team.events.slice(-8).map(event => <li key={`${event.seq}-${event.type}`}><span>{event.type}</span>{event.status && <span>{event.status}</span>}<time>{time(event.createdAt)}</time></li>)}</ul></details>}
        </> : <p className="sa-empty">本任务未启用团队模式。</p>}
      </section></div>
    </Modal>}
    {planOpen && <PlanBuilder agents={agents} allowedExecutors={allowedExecutors} datasets={datasets} windows={windows} initialGoal={command} close={() => setPlanOpen(false)} onCreated={plan => { setPlanOpen(false); setCommand(''); notify('多步计划已创建。'); void refresh().then(() => { const first = plan.steps[0]?.ticketId; if (first) viewTicket(first); }); }} />}
    {appearanceOpen && <AppearanceSettings close={() => setAppearanceOpen(false)} />}
    {settingsOpen && <SettingsModal settings={localSettings} close={() => setSettingsOpen(false)} onSaved={next => { setLocalSettings(next); onSettingsSaved(next); }} notify={notify} />}
    {paletteOpen && <div className="sa-palette-shade" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
      <div className="sa-palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="sa-palette-input"><Search size={15} /><input autoFocus value={paletteQuery} placeholder="搜索会话、工作文件夹、页面，或直接执行动作" aria-label="命令面板搜索"
          onChange={event => setPaletteQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex(index => Math.min(paletteMatches.length - 1, index + 1)); }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex(index => Math.max(0, index - 1)); }
            else if (event.key === 'Enter') { event.preventDefault(); paletteMatches[paletteIndex]?.run(); }
            else if (event.key === 'Escape') { event.preventDefault(); setPaletteOpen(false); }
          }} /><kbd>Esc</kbd></div>
        <div className="sa-palette-list" role="listbox" aria-label="可跳转的目标">
          {paletteMatches.length ? paletteMatches.map((item, index) => <button type="button" role="option" aria-selected={index === paletteIndex} key={item.id} className={`sa-palette-row ${index === paletteIndex ? 'on' : ''}`} onMouseEnter={() => setPaletteIndex(index)} onClick={() => item.run()}>
            <item.icon size={14} /><span className="sa-palette-label">{item.label}</span><small>{item.hint}</small>
          </button>) : <p className="sa-palette-empty">没有匹配项。</p>}
        </div>
        <p className="sa-palette-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
      </div>
    </div>}
    {folderToDelete && <Modal title={`移除工作文件夹「${folderToDelete.name}」`} subtitle="只删除软件内的记录，不会删除本地文件，也不会影响 Git 仓库。" close={() => setFolderToDelete(null)}>
      <div className="sa-confirm">
        <p>{folderToDelete.chatCount} 个会话记录也会一起移除。这一步无法撤销，确认继续？</p>
        <div className="sa-confirm-actions"><button type="button" className="sa-button" onClick={() => setFolderToDelete(null)}>取消</button><button type="button" className="sa-button sa-danger" onClick={() => { const target = folderToDelete; setFolderToDelete(null); void removeFolder(target); }}>移除文件夹</button></div>
      </div>
    </Modal>}
    {toast && <Toast message={toast.text} error={toast.error} close={() => setToast(null)} />}
  </div>;
}

type PlanStepDraft = { executorId: string; text: string; datasetId: string; dependsOn: number[]; windowHandle: string };

function PlanBuilder({ agents, allowedExecutors, datasets, windows, initialGoal, close, onCreated }: {
  agents: { id: string; name: string; status: string }[];
  allowedExecutors: string[];
  datasets: { id: string; name: string; rowCount: number }[];
  windows: { id: string; handle: number; pid: number; process: string; title: string }[];
  initialGoal: string;
  close: () => void;
  onCreated: (plan: WorkPlan) => void;
}) {
  const targets = agents.filter(agent => allowedExecutors.includes(agent.id) && agent.status === 'available' && (['codex', 'claude-code', 'window'].includes(agent.id) || agent.id.endsWith('-acp')) && (agent.id !== 'window' || windows.length > 0));
  const defaultExecutor = targets.find(agent => agent.id === 'codex')?.id || targets[0]?.id || '';
  const [goal, setGoal] = useState(initialGoal);
  const [steps, setSteps] = useState<PlanStepDraft[]>([
    { executorId: defaultExecutor, text: initialGoal, datasetId: datasets.length === 1 ? datasets[0].id : '', dependsOn: [], windowHandle: '' },
    { executorId: defaultExecutor, text: '', datasetId: datasets.length === 1 ? datasets[0].id : '', dependsOn: [0], windowHandle: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  const [error, setError] = useState('');
  const update = (index: number, patch: Partial<PlanStepDraft>) => setSteps(previous => previous.map((step, current) => current === index ? { ...step, ...patch } : step));
  const suggest = async () => {
    const value = goal.trim();
    if (!value || suggesting) return;
    setSuggesting(true); setError('');
    try {
      const result = await api.suggestWorkPlan(value, targets.map(target => target.id));
      setSteps(result.steps.map(step => ({ executorId: step.executorId, text: step.text, datasetId: step.datasetId || (datasets.length === 1 ? datasets[0].id : ''), dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter(index => Number.isInteger(index) && index >= 0) : [], windowHandle: step.executorInput?.handle ? String(step.executorInput.handle) : (step.executorId === 'window' ? (windows[0]?.id || '') : '') })));
    } catch (cause) { setError((cause as Error).message); }
    finally { setSuggesting(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = goal.trim();
    if (!value) { setError('请填写计划目标。'); return; }
    if (steps.length < 2) { setError('至少需要两步。'); return; }
    if (steps.some(step => !step.text.trim() && !value)) { setError('每一步都需要说明。'); return; }
    if (steps.some(step => step.executorId === 'analysis' && datasets.length > 1 && !step.datasetId)) { setError('请为分析步骤选择数据集。'); return; }
    if (steps.some(step => step.executorId === 'window' && !step.windowHandle)) { setError('请为窗口 Agent 步骤选择目标窗口。'); return; }
    setBusy(true); setError('');
    try {
      const payload = steps.map(step => {
        const text = step.text.trim() || value;
        return {
          executorId: step.executorId,
          text,
          ...(step.executorId === 'codex' || step.executorId === 'claude-code' ? { executorInput: { prompt: text } } : {}),
          ...(step.executorId === 'analysis' && step.datasetId ? { datasetId: step.datasetId } : {}),
          ...(step.executorId === 'window' ? { executorInput: { handle: Number(step.windowHandle), text, submit: true, ...(windows.find(item => item.id === step.windowHandle)?.process ? { process: windows.find(item => item.id === step.windowHandle)!.process } : {}), ...(windows.find(item => item.id === step.windowHandle)?.title ? { title: windows.find(item => item.id === step.windowHandle)!.title } : {}) } } : {}),
          ...(step.dependsOn.length ? { dependsOn: step.dependsOn } : {}),
        };
      });
      const result = await api.createWorkPlan(value, payload, `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, autoRun);
      onCreated(result.plan);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const parseDependencies = (raw: string, index: number) => [...new Set(raw.split(/[,，\s]+/).map(Number).filter(item => Number.isInteger(item) && item >= 1 && item <= index))].slice(0, 3).map(item => item - 1);
  const removeStep = (index: number) => setSteps(previous => previous.filter((_, current) => current !== index).map(step => ({ ...step, dependsOn: step.dependsOn.filter(item => item !== index).map(item => item > index ? item - 1 : item) })));
  return <Modal title="多步计划" subtitle="按依赖推进，每一步仍需要你审批" close={close}>
    <form className="sa-plan-form" onSubmit={submit}>
      <div className="sa-plan-goal"><label className="sa-field"><span>计划目标</span><input value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：检查 CI、修复失败项并验证" autoFocus /></label><button type="button" className="sa-button" disabled={!goal.trim() || suggesting || !targets.length} onClick={() => void suggest()}>{suggesting ? '规划中…' : 'AI 帮我规划'}</button></div>
      <div className="sa-plan-steps">{steps.map((step, index) => <div className="sa-plan-step" key={index}>
        <span className="sa-plan-index">{index + 1}</span>
        <select value={step.executorId} onChange={event => update(index, { executorId: event.target.value })} aria-label={`第${index + 1} 步执行器`}>{targets.length ? targets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">没有可用执行器</option>}</select>
        <input value={step.text} onChange={event => update(index, { text: event.target.value })} placeholder={index === 0 ? '第一步做什么' : '下一步做什么'} aria-label={`第${index + 1} 步说明`} />
        {step.executorId === 'analysis' && datasets.length > 1 && <select value={step.datasetId} onChange={event => update(index, { datasetId: event.target.value })} aria-label={`第${index + 1} 步数据集`}><option value="">选择数据集</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select>}
        {step.executorId === 'window' && <select value={step.windowHandle} onChange={event => update(index, { windowHandle: event.target.value })} aria-label={`第${index + 1} 步窗口`}><option value="">选择窗口</option>{windows.map(item => <option key={item.id} value={item.id}>{item.process} · {item.title}</option>)}</select>}
        {index > 0 && <input className="sa-plan-deps" value={step.dependsOn.map(item => item + 1).join(',')} onChange={event => update(index, { dependsOn: parseDependencies(event.target.value, index) })} placeholder="依赖 1,2" aria-label={`第${index + 1} 步依赖`} />}
        {steps.length > 2 && <button type="button" className="sa-icon" aria-label={`删除第${index + 1} 步`} onClick={() => removeStep(index)}><X size={15} /></button>}
      </div>)}</div>
      <div className="sa-plan-form-foot">
        <button type="button" className="sa-button" disabled={steps.length >= 5} onClick={() => setSteps(previous => [...previous, { executorId: defaultExecutor, text: '', datasetId: datasets.length === 1 ? datasets[0].id : '', dependsOn: previous.length ? [previous.length - 1] : [], windowHandle: '' }])}>添加一步</button>
        <span className="sa-inline-note">最多 5 步；无依赖步骤可并行，依赖满足后自动待审批。</span>
      </div>
      {error && <p className="sa-error-text" role="alert">{error}</p>}
      <label className="sa-plan-auto"><input type="checkbox" checked={autoRun} onChange={event => setAutoRun(event.target.checked)} /><span>创建后自动执行（跳过逐步审批，仍受执行器策略与预算限制）</span></label>
      <div className="sa-plan-actions"><button type="button" className="sa-button" onClick={close}>取消</button><button type="submit" className="sa-button sa-primary" disabled={busy || !targets.length}>{busy ? '创建中…' : autoRun ? '创建并执行' : '创建计划'}</button></div>
    </form>
  </Modal>;
}

