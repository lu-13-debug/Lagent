import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Activity, AlertTriangle, AppWindow, Bot, Brain, Check, ChevronRight, Clock, Database, FolderGit2, GitBranch, Globe, Inbox, Menu, Plus, RefreshCw, Send, Settings2, ShieldCheck, Smartphone, Sparkles, Square, SunMoon, Terminal, Users, Wrench, X } from 'lucide-react';
import { api } from '../api';
import { useAppearance } from '../appearance-context';
import type { Settings, User } from '../types';
import type { WorkAction, WorkBootstrap, WorkInboxItem, WorkPlan, WorkPolicy, WorkProject, WorkReport, WorkTicket, WorkTicketDetail } from '../superagent';
import { MemoryPanel } from './MemoryPanel';
import { ProjectsPanel } from './ProjectsPanel';
import { AppearanceSettings } from './AppearanceSettings';
import { SettingsModal } from './ModelSettings';
import { Logo, Modal } from './ui';
import '../superagent.css';

type ShellView = 'command' | 'inbox' | 'projects' | 'agents' | 'tools' | 'memory' | 'settings';
const navItems: { id: ShellView; label: string; icon: typeof Terminal }[] = [
  { id: 'inbox', label: '收件箱', icon: Inbox },
  { id: 'projects', label: '项目', icon: FolderGit2 },
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
const executorNames: Record<string, string> = { analysis: '数据分析', terminal: '受控终端', codex: 'Codex CLI', 'claude-code': 'Claude Code', 'claude-acp': 'Claude ACP', 'codex-acp': 'Codex ACP', 'dsh-acp': 'DSH ACP', browser: '浏览器', github: 'GitHub', window: '窗口 Agent' };
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

export function SuperAgentShell({ user, runtime, settings, onSettingsSaved, notify }: {
  user?: User | null; runtime: { mode: 'local' | 'cloud' }; settings: Settings;
  onSettingsSaved: (settings: Settings) => void; notify: (text: string, error?: boolean) => void;
}) {
  const appearance = useAppearance();
  // 视图与选中项目写进 URL（replaceState，不产生历史记录），刷新后能回到原处。
  const [view, setView] = useState<ShellView>(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('view');
    const known: ShellView[] = ['command', 'inbox', 'projects', 'agents', 'tools', 'memory', 'settings'];
    if (known.includes(raw as ShellView)) return raw as ShellView;
    return params.get('project') ? 'projects' : 'command';
  });
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
  const [command, setCommand] = useState('');
  const [sending, setSending] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [detail, setDetail] = useState<WorkTicketDetail | null>(null);
  const [projectFocus, setProjectFocus] = useState<string | null>(null);
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
  const [synthesisAgent, setSynthesisAgent] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);

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
      .then(result => { if (live) setProjects(result.projects); })
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
  const [providers, setProviders] = useState<{ id: string; name: string; kind?: string; command: string | null; installed: boolean; version: string | null; status: string; message: string; auth: { loggedIn: boolean | null; method: string | null; message: string } }[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
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
  const current = useMemo(() => navItems.find(item => item.id === view)?.label || '新对话', [view]);

  const usableAgents = useMemo(() => agents.filter(agent => agent.id !== 'analysis' && allowedExecutors.includes(agent.id) && agent.status === 'available'), [agents, allowedExecutors]);
  const visibleAgents = useMemo(() => agents.filter(agent => agent.id !== 'analysis'), [agents]);
  const crossCapable = useMemo(() => usableAgents.filter(agent => ['analysis', 'codex', 'claude-code'].includes(agent.id) || agent.id.endsWith('-acp')), [usableAgents]);
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
    const singles = tickets.filter(ticket => !grouped.has(ticket.id)).map(ticket => ({ kind: 'ticket' as const, id: ticket.id, title: ticket.title, createdAt: ticket.createdAt, ticket, group: null as CrossCheck | null }));
    const groups = crossChecks.map(group => ({ kind: 'group' as const, id: group.id, title: group.prompt, createdAt: group.createdAt, ticket: null as WorkTicket | null, group }));
    return [...groups, ...singles].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 60);
  }, [tickets, crossChecks]);
  const activeTicket = activeDetail?.ticket?.id === activeTicketId ? activeDetail.ticket : tickets.find(ticket => ticket.id === activeTicketId) || null;

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
    const problem = chosen.length === 1 ? validateSingleInput(execIdFor(chosen[0])) : chosen.some(id => execIdFor(id) === 'analysis') ? (datasets.length === 0 ? '交叉验证包含数据分析，请先上传数据集。' : datasets.length > 1 && !datasetId ? '交叉验证包含数据分析，请先选择数据集。' : null) : null;
    if (problem) { notify(problem, true); return; }
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
  const handoffTargets = usableAgents.filter(agent => ['codex', 'claude-code'].includes(agent.id) || agent.id.endsWith('-acp'));
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
  const enableTool = async (id: string) => {
    if (!policy) return;
    try {
      const next = await api.updateWorkPolicy({ ...policy, allowedExecutors: [...new Set([...(policy.allowedExecutors || []), id])] });
      setPolicy(next.policy); await refresh(); notify(`${executorNames[id] || id} 已加入允许策略。`);
    } catch (cause) { notify((cause as Error).message, true); }
  };

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
  const composerTitle = selectedAgents.length > 1 ? `交叉验证 · ${selectedAgents.length} 个 Agent` : '发送指令';
  const isLanding = !activeTicket && !activeGroup;
  const conversationGroups = useMemo(() => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const buckets: { label: string; items: typeof conversationTickets }[] = [
      { label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '更早', items: [] },
    ];
    for (const item of conversationTickets) {
      const created = Date.parse(item.createdAt);
      const index = created >= startOfToday.getTime() ? 0 : created >= startOfYesterday.getTime() ? 1 : 2;
      buckets[index].items.push(item);
    }
    return buckets.filter(bucket => bucket.items.length > 0);
  }, [conversationTickets]);
  const starters = [
    { icon: GitBranch, title: '检查 GitHub 仓库', desc: 'CI 状态、失败的流水线与 PR', prompt: '检查 GitHub 仓库状态' },
    { icon: Globe, title: '浏览网页并总结', desc: '读取页面正文，提炼要点', prompt: '浏览网页并总结' },
    { icon: Terminal, title: '运行终端命令', desc: '只读的 git / npm / ls 检查', prompt: '运行终端命令' },
    { icon: FolderGit2, title: '跟进项目进展', desc: '读取项目简报与最近变更', prompt: '总结当前项目的进展与变更要点' },
  ];

  const conversationPage = <div className="sa-workspace">
    {isLanding ? <div className="sa-landing">
      <div className="sa-landing-main">
        <header className="sa-hero">
          <p className="sa-eyebrow">PERSONAL AGENT</p>
          <h1>今天想让我做什么？</h1>
          <p className="sa-hero-sub">选择一个或多个 Agent，描述目标。需要时我会拆解任务、并行交叉验证，并把结论汇总给你。</p>
        </header>
        <section className="sa-picker" aria-labelledby="sa-picker-title">
          <div className="sa-picker-head"><span id="sa-picker-title">执行 Agent</span><span className="sa-picker-hint">{crossCapable.length + windows.length} 个可选 · 最多 4 个</span></div>
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
          {selectedAgents.length > 1 && <span className="sa-xc-badge"><Users size={12} />交叉验证</span>}
        </div>}
        <textarea id="sa-command" value={command} maxLength={3000} onChange={event => setCommand(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} rows={2} placeholder={selectedAgents.length > 1 ? '描述要交叉验证的问题，例如：审查这段鉴权逻辑是否有漏洞？' : '描述目标，例如：检查 DataAgent 仓库的 CI，修复失败项并开 PR'} />
        {singleExecutor === 'analysis' && (datasets.length > 1 ? <div className="sa-executor-fields"><label className="sa-field"><span>数据集</span><select value={datasetId} onChange={event => setDatasetId(event.target.value)}><option value="">请选择数据集</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.rowCount.toLocaleString()} 行</option>)}</select></label></div> : datasets.length === 1 ? <div className="sa-executor-fields"><span className="sa-inline-note"><Check size={13} />数据集：{datasets[0].name}</span></div> : <div className="sa-executor-fields"><span className="sa-inline-note">还没有数据集，请先在工作区上传或加载示例数据。</span></div>)}
        {singleExecutor === 'terminal' && <div className="sa-executor-fields"><label className="sa-field"><span>程序</span><select value={terminalProgram} onChange={event => setTerminalProgram(event.target.value)}><option value="git">git</option><option value="npm">npm</option><option value="ls">ls</option><option value="pwd">pwd</option></select></label><label className="sa-field"><span>参数</span><input value={terminalArgs} onChange={event => setTerminalArgs(event.target.value)} placeholder="status --short" /></label></div>}
        {singleExecutor === 'browser' && <div className="sa-executor-fields"><label className="sa-field"><span>页面地址</span><input type="url" value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} placeholder="https://example.com/page" /></label></div>}
        {singleExecutor === 'github' && <div className="sa-executor-fields"><label className="sa-field"><span>GitHub 动作</span><select value={githubAction} onChange={event => setGithubAction(event.target.value)}><option value="repo">仓库</option><option value="issues">Issues</option><option value="pulls">Pull Requests</option><option value="checks">CI Checks</option><option value="file">文件</option></select></label><label className="sa-field"><span>owner</span><input value={githubOwner} onChange={event => setGithubOwner(event.target.value)} placeholder="acme" /></label><label className="sa-field"><span>repo</span><input value={githubRepo} onChange={event => setGithubRepo(event.target.value)} placeholder="data-agent" /></label>{['issues', 'pulls', 'checks'].includes(githubAction) && <label className="sa-field"><span>编号</span><input inputMode="numeric" value={githubNumber} onChange={event => setGithubNumber(event.target.value)} placeholder="7" /></label>}{githubAction === 'file' && <label className="sa-field"><span>文件路径</span><input value={githubPath} onChange={event => setGithubPath(event.target.value)} placeholder="docs/readme.md" /></label>}</div>}
        <div className="sa-composer-foot"><div className="sa-chips">{!isLanding && quickCommands.map(item => <button type="button" key={item} onClick={() => setCommand(item)}>{item}</button>)}<button type="button" onClick={() => setPlanOpen(true)}>多步计划</button></div><button className="sa-send" type="submit" disabled={!command.trim() || sending} aria-label="发送指令">{sending ? <RefreshCw size={16} className="sa-spin" /> : <Send size={16} />}<span>{sending ? '提交中' : composerTitle}</span></button></div>
      </form>
      <p className="sa-note"><ShieldCheck size={14} />{selectedAgents.length > 1 ? '多个 Agent 会并行独立作答，方便对比与交叉验证；会消耗对应执行器的额度。' : '只会执行你明确授权或规则允许的操作；危险动作会先请求确认。'}</p>
    </div>
  </div>;

  const inboxPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">ATTENTION</p><h1>收件箱<span className="sa-count">{attention.length}</span></h1><p>只有需要你决定的事项会出现在这里。</p></div></header>{attention.length ? renderAttention(attention) : <div className="sa-empty-card"><Check size={22} /><h2>没有需要处理的事项</h2><p>Agent 会继续执行已授权的工作。</p></div>}</section>;

  const dshWindow = windows.find(window => /deepseek/i.test(`${window.process} ${window.title}`));
  const windowFallbackFor = (provider: { id: string; name: string }) => /deepseek/i.test(`${provider.id} ${provider.name}`) && dshWindow
    ? `已检出运行中的「${dshWindow.process}」窗口，无需安装 ACP：在左下角选择「窗口 · ${dshWindow.process}」即可直接发送指令。`
    : '';
  const agentsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">EXECUTORS</p><h1>Agent</h1><p>可被调度的执行器，以及本机正在运行的 Agent 窗口。</p></div></header><div className="sa-card-grid">{(work?.agents || []).map(agent => <article className="sa-card" key={agent.id}><div className="sa-card-icon">{agentIcon(agent.id)}</div><div className="sa-card-title"><h2>{agent.name}</h2><Status status={agent.status} /></div><p className="sa-mono">{agent.kind}</p><div className="sa-tags">{agent.capabilities.map(item => <span key={item}>{item}</span>)}</div>{agent.capabilities.includes('acp') && <p className="sa-inline-note">ACP 统一协议：指令文本会作为提示词发送，v1 只读，拒绝文件与终端权限。</p>}</article>)}{!work?.agents?.length && <p className="sa-empty">还没有注册执行器。</p>}</div>
    <section className="sa-providers"><div className="sa-section-head"><h2>本机 Agent 探测</h2><button type="button" className="sa-link" disabled={providersLoading} onClick={() => void loadProviders(true)}>{providersLoading ? '探测中…' : '重新探测'}</button></div>
      <p className="sa-inline-note"><ShieldCheck size={13} />通过 PATH/PATHEXT 解析命令，并读取版本与登录状态；不会保存输出原文。</p>
      <p className="sa-inline-note">可选 ACP 入口：<code>npm i -g @agentclientprotocol/claude-agent-acp</code>（Claude Code）。<code>npm i -g dsh-acp</code>（DeepSeek Harness）；安装后重启服务会自动出现在执行器列表。</p>
      <ul className="sa-provider-list">{providers.map(provider => <li className="sa-provider" key={provider.id}><div className="sa-provider-head"><div><strong>{provider.name}</strong><span>{provider.command || '未找到命令'}</span></div><Status status={provider.status} /></div><div className="sa-provider-meta"><span>版本 {provider.version || '未知'}</span><span>{provider.auth.message}</span></div>{provider.status !== 'ready' || provider.kind === 'desktop' ? <p className="sa-inline-note">{provider.message}{!/窗口/.test(provider.message) && windowFallbackFor(provider) ? ` ${windowFallbackFor(provider)}` : ''}</p> : null}</li>)}</ul>
      {!providers.length && !providersLoading && <p className="sa-empty">尚未探测到本机 Agent。</p>}
    </section>
    <section className="sa-windows"><div className="sa-section-head"><h2>已打开的 Agent 窗口</h2><button type="button" className="sa-link" disabled={windowsLoading} onClick={() => void loadWindows()}>{windowsLoading ? '刷新中…' : '刷新窗口'}</button></div>
      <p className="sa-inline-note"><ShieldCheck size={13} />只向白名单进程窗口发送；发送会直接键入该窗口并回车，请先确认标题。DeepSeek Harness 已加入默认白名单。</p>
      {windows.length ? <ul className="sa-window-list">{windows.map(window => <li className="sa-window" key={window.id}>
        <div className="sa-window-head"><div><strong>{window.title || window.process}</strong><span>{window.process} · PID {window.pid} · 句柄 {window.handle}</span></div><span className="sa-tag-ok">可操作</span></div>
        <div className="sa-window-actions"><input value={windowDrafts[window.id] || ''} onChange={event => setWindowDrafts(previous => ({ ...previous, [window.id]: event.target.value }))} placeholder="输入要发送给该窗口的指令" aria-label={`向${window.process} 发送指令`} /><button type="button" className="sa-button sa-primary" disabled={!(windowDrafts[window.id] || '').trim()} onClick={() => void sendToWindow(window)}>发送</button><button type="button" className="sa-button" onClick={() => void readFromWindow(window)}>读取</button></div>
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

  const page = view === 'command' ? conversationPage : view === 'inbox' ? inboxPage : view === 'projects' ? <ProjectsPanel notify={notify} onOpenTicket={viewTicket} focusProjectId={projectFocus} onFocusProject={setProjectFocus} allowedExecutors={allowedExecutors.filter(id => ['claude-code', 'codex', 'claude-acp', 'dsh-acp', 'codex-acp', 'window'].includes(id))} /> : view === 'agents' ? agentsPage : view === 'tools' ? toolsPage : view === 'memory' ? <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">MEMORY</p><h1>记忆</h1><p>你确认过的偏好、术语和决定。</p></div></header><MemoryPanel /></section> : settingsPage;

  return <div className="sa-shell">
    <a className="skip-link" href="#sa-main">跳到主内容</a>
    {navOpen && <button className="sa-nav-shade" aria-label="关闭导航" onClick={() => setNavOpen(false)} />}
    <aside className={`sa-sidebar ${navOpen ? 'sa-nav-open' : ''}`}>
      <div className="sa-brand-row">
        <button className="sa-brand" onClick={newChat}><Logo /><span>DataAgent<span className="brand-dot">.</span></span></button>
      </div>
      <button className="sa-icon sa-nav-close" aria-label="关闭导航" onClick={() => setNavOpen(false)}><X size={18} /></button>
      <button className="sa-newchat" onClick={newChat}><span className="sa-newchat-label"><Plus size={16} />新对话</span></button>
      <nav className="sa-nav" aria-label="功能导航">{navItems.map(item => <button key={item.id} className={`sa-nav-item ${view === item.id ? 'active' : ''}`} aria-current={view === item.id ? 'page' : undefined} onClick={() => { setView(item.id); setNavOpen(false); }}><item.icon size={16} /><span>{item.label}</span>{item.id === 'inbox' && attention.length > 0 && <em>{attention.length}</em>}</button>)}</nav>
      <section className="sa-conv-section">
        <div className="sa-side-title"><span>对话</span><span>{conversationTickets.length}</span></div>
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
          </div>) : <p className="sa-conv-empty">还没有对话。在上方描述目标即可开始。</p>}
        </div>
      </section>
      <div className="sa-sidebar-foot"><div className="sa-user"><span className="sa-avatar">{user?.displayName?.slice(0, 1).toUpperCase() || 'D'}</span><span><strong>{user?.displayName || '个人工作区'}</strong><small>{runtime.mode === 'cloud' ? '云端账号' : '本地运行'}</small></span><Sparkles size={14} /></div></div>
    </aside>
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

