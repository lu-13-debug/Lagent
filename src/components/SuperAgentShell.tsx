import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Activity, AlertTriangle, AppWindow, Bot, Brain, Check, ChevronRight, Clock, Database, FileText, FolderGit2, GitBranch, Globe, ListChecks, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pin, Plus, Puzzle, RefreshCw, Search, Send, Settings2, ShieldCheck, Smartphone, Sparkles, Square, SunMoon, Terminal, Trash2, Users, Wrench, X } from 'lucide-react';
import { api } from '../api';
import { useAppearance } from '../appearance-context';
import type { Settings, User } from '../types';
import type { WorkAction, WorkBootstrap, WorkConversation, WorkConversationRun, WorkConversationSummary, WorkConversationTurn, WorkInboxItem, WorkMcpToken, WorkPlan, WorkPolicy, WorkProject, WorkProjectChat, WorkReport, WorkRosterEntry, WorkRun, WorkTeamTemplate, WorkTicket, WorkTicketDetail, WorkTrace, WorkUsageReport } from '../superagent';
import { MemoryPanel } from './MemoryPanel';
import { AgentConclusionList, AgentThinkingPanel } from './AgentThinkingPanel';
import { ChatModelPicker, CliModelPicker, readChatModel, writeChatModel, type ChatModelChoice } from './ChatModelPicker';
import { ProjectsPanel } from './ProjectsPanel';
import { ReportCenter } from './ReportCenter';
import { reportTextOf as reportText } from '../report-text';
import { lagentOnlySuggestion } from '../agent-choice';
import { SkillsPanel } from './SkillsPanel';
import { WorkOpsPanel } from './WorkOpsPanel';
import { AppearanceSettings } from './AppearanceSettings';
import { AccountModal } from './AccountModal';
import { SettingsModal } from './ModelSettings';
import { Logo, Modal, Toast } from './ui';
import { STATUS_LABELS } from '../status';
import { baseExecutorId, EXECUTOR_LABELS as executorNames } from '../executor-label';
import '../superagent.css';

type ShellView = 'command' | 'project' | 'projects' | 'agents' | 'runs' | 'reports' | 'tools' | 'skills' | 'memory' | 'settings';
// 主导航收成三项：指挥台（会话）、项目、报告（结论 + 执行记录）。
const primaryNav: { id: ShellView; label: string; icon: typeof Terminal }[] = [
  { id: 'command', label: '指挥台', icon: MessageSquare },
  { id: 'projects', label: '项目', icon: FolderGit2 },
  { id: 'reports', label: '报告', icon: FileText },
];
const moreNav: { id: ShellView; label: string; icon: typeof Terminal }[] = [
  { id: 'agents', label: '团队', icon: Users },
  { id: 'runs', label: '运行', icon: Activity },
  { id: 'tools', label: '工具', icon: Wrench },
  { id: 'skills', label: '技能与插件', icon: Puzzle },
  { id: 'memory', label: '记忆', icon: Brain },
  { id: 'settings', label: '设置', icon: Settings2 },
];
const statusNames: Record<string, string> = {
  ...STATUS_LABELS,
  connected: '可用', available: '可用', needs_setup: '未就绪', needs_auth: '需授权',
  ready: '可用', not_installed: '未安装', unavailable: '不可用',
};
const reportKindNames: Record<string, string> = { ready: '已就绪', failed: '失败', blocked: '受阻', cancelled: '已停止' };
const reviewVerdictNames: Record<string, string> = { pass: '通过', revise: '需修改', reject: '未通过', unreviewed: '未评审' };
const evidenceLevelNames: Record<string, string> = { verified: '命令已验证', reviewed: '仅结构评审', failed: '验收未通过', unreviewed: '无证据' };
const failureModeNames: Record<string, string> = {
  step_repetition: '步骤重复',
  missing_clarification: '该澄清不澄清',
  task_drift: '任务偏航',
  information_withholding: '隐瞒信息',
  incomplete_verification: '验证不完整',
  incorrect_verification: '验证错误'
};
/** 审批卡只回答三件事：会动什么、会跑什么、怎么算完成。 */
function approvalEvidence(ticket: WorkTicket | undefined, access?: { mode?: string; path?: string }) {
  const preview = ticket?.preview;
  const paths = (preview?.paths || []).filter(Boolean);
  const touch = paths.length
    ? `${paths.slice(0, 3).join('、')}${paths.length > 3 ? ` 等 ${paths.length} 处` : ''}`
    : access?.path || preview?.cwd || ticket?.verify?.cwd || '项目目录内';
  const run = preview?.action || (ticket?.executor ? `由 ${executorNames[ticket.executor] || ticket.executor} 执行` : '等待执行器');
  const expect = ticket?.verify?.expect || 'exit=0';
  const accepted = (ticket?.contract?.acceptance || []).filter(Boolean);
  const done = ticket?.verify
    ? expect === 'exit=0' ? '验收命令退出码为 0' : `验收输出包含「${expect.replace(/^contains:/, '')}」`
    : accepted.length ? accepted.join('；') : '完成后由你确认结果';
  return { touch, run, done };
}
const proposalNames: Record<string, string> = { proposed: '待决策', needsApproval: '需确认', accepted: '已接受', rejected: '已拒绝' };
const executorIds = ['terminal', 'codex', 'claude-code', 'claude-acp', 'codex-acp', 'dsh-acp', 'browser', 'github', 'window'];
// 可在对话/项目里直接派活的执行器（不含終端、浏览器、GitHub 这类内置工具）。
const conversationExecutorIds = ['codex', 'claude-code', 'claude-acp', 'codex-acp', 'dsh-acp', 'opencode', 'gemini', 'qwen', 'cursor-agent', 'dsh', 'codebuddy', 'qoder', 'iflow', 'kimi', 'workbuddy', 'model'];
// 项目工作文件夹里能建会话的执行器：终端、浏览器这类受控工具不能进项目。
const projectExecutorIds = ['window', ...conversationExecutorIds];
const terminalStatuses = ['completed', 'failed', 'blocked', 'cancelled'];
// 各家 Agent 的品牌标：能拿到官方图形就用图形（simple-icons / gilbarbara logos / 官网 favicon），
// 拿不到的退回「品牌色 + 缩写」。同一个产品的 ACP / 桌面版复用同一枚。
// 放在模块级：思考面板在组件靠前的位置就要用到它，写在组件体内会被提前引用（TDZ）。
const BRAND_MARKS: Record<string, { text: string; bg: string; icon?: string; mono?: boolean }> = {
  codex: { text: 'CX', bg: '#101014', icon: 'openai.svg', mono: true },
  'claude-code': { text: 'CL', bg: '#d97757', icon: 'anthropic.svg', mono: true },
  opencode: { text: 'OC', bg: '#1b1b1f', icon: 'opencode.svg', mono: true },
  dsh: { text: 'DS', bg: '#4d6bfe', icon: 'deepseek.svg' },
  gemini: { text: 'GE', bg: '#4285f4', icon: 'gemini.svg', mono: true },
  qwen: { text: 'QW', bg: '#6f42c1', icon: 'qwen.svg' },
  'cursor-agent': { text: 'CU', bg: '#0f0f10', icon: 'cursor.svg', mono: true },
  aider: { text: 'AI', bg: '#16a34a', icon: 'aider.svg' },
  amp: { text: 'AM', bg: '#f97316', icon: 'amp.svg' },
  codebuddy: { text: 'CB', bg: '#0052d9', icon: 'codebuddy.svg' },
  qoder: { text: 'QD', bg: '#ff6a00', icon: 'qoder.png', mono: true },
  iflow: { text: 'iF', bg: '#2563eb', icon: 'iflow.png' },
  kimi: { text: 'KM', bg: '#111111', icon: 'kimi.png' },
  'trae-agent': { text: 'TR', bg: '#1d4ed8', icon: 'trae.png' },
  comate: { text: 'Co', bg: '#2932e1', icon: 'comate.png' },
  lingma: { text: '通', bg: '#ff6a00', icon: 'lingma.png' },
  codegeex: { text: 'GX', bg: '#3859ff', icon: 'codegeex.png' },
  workbuddy: { text: 'WB', bg: '#0ea5a4', icon: 'workbuddy.svg' }
};
const brandOf = (id: string) => BRAND_MARKS[baseExecutorId(id).replace(/-(acp|desktop)$/, '')] || null;
// 本机节点连上来时，执行器 id 可能带 node-<短id>- 前缀，但它在对话里和内置的同名 Agent 是一类。
const isConversationExecutor = (id: string) => conversationExecutorIds.includes(id) || conversationExecutorIds.includes(baseExecutorId(id));
const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const shortTime = (value?: string) => {
  if (!value) return '–';
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};
const CROSS_CHECK_KEY = 'lagent.crosschecks.v1';
const windowKey = (handle: number) => `win:${handle}`;
const toolIcon = (id: string, size = 20) => id === 'terminal' ? <Terminal size={size} /> : id === 'browser' ? <Globe size={size} /> : id === 'github' ? <GitBranch size={size} /> : id === 'window' ? <AppWindow size={size} /> : <Wrench size={size} />;

function Status({ status }: { status: string }) {
  return <span className={`sa-status sa-status-${status}`}>{statusNames[status] || status}</span>;
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
type LiveStep = { kind: string; text: string; detail?: string; at?: string; requestId?: string; decided?: 'allow' | 'deny' };

const TRACE_RECENT = 8;

/** 详情里的 activity 比实时流更全；两者合并去重，避免空的实时数组把详情盖掉。 */
function activityOf(live: LiveStep[] | undefined, detail?: { activity?: LiveStep[] } | null): LiveStep[] {
  const seen = new Set<string>();
  return [...(detail?.activity || []), ...(live || [])].filter(step => {
    if (step.kind === 'result') return false;
    const key = `${step.at || ''}|${step.kind}|${step.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 紧凑执行流：默认只展开最近 8 步，但保留总览、失败定位与更早步骤。
 * 只消费现有 activity 数组，不新增接口、不改 WorkTrace 类型。
 */
function CompactTrace({ steps, ticketId }: { steps: LiveStep[]; ticketId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [jumpTo, setJumpTo] = useState<number | null>(null);
  const hiddenCount = Math.max(0, steps.length - TRACE_RECENT);
  const errors = steps.map((step, index) => ({ step, index })).filter(row => row.step.kind === 'error');
  const windowStart = Math.max(0, steps.length - 12);

  useEffect(() => {
    if (jumpTo == null) return;
    const target = document.getElementById(`sa-trace-${ticketId}-${jumpTo}`);
    if (!target) { setJumpTo(null); return; }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    target.classList.add('is-located');
    const timer = window.setTimeout(() => {
      target.classList.remove('is-located');
      setJumpTo(null);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [jumpTo, ticketId, expanded]);

  const jump = (index: number) => {
    if (index < hiddenCount) setExpanded(true);
    setJumpTo(index);
  };

  const renderStep = (step: LiveStep, index: number) => {
    const Icon = step.kind === 'permission' ? ShieldCheck : step.kind === 'error' ? AlertTriangle : step.kind === 'observation' ? Terminal : Wrench;
    const located = jumpTo === index;
    return <li id={`sa-trace-${ticketId}-${index}`} key={`${index}-${step.at || ''}`} className={`sa-live-step sa-live-${step.kind} sa-trace-step${located ? ' is-located' : ''}`}>
      <span className="sa-live-icon"><Icon size={11} /></span>
      <div><p>{step.text}</p>{step.detail && <span className="sa-live-detail">{step.detail}</span>}</div>
    </li>;
  };

  return <div className="sa-trace">
    {steps.length > TRACE_RECENT && <div className="sa-trace-overview">
      <span className="sa-trace-total">{steps.length} 步</span>
      {errors.length > 0 && <button type="button" className="sa-trace-fail" onClick={() => jump(errors[0].index)}>
        <AlertTriangle size={11} />失败 {errors.length}
      </button>}
      <div className="sa-trace-dots" role="group" aria-label="步骤索引">
        {steps.slice(windowStart).map((step, offset) => {
          const index = windowStart + offset;
          const label = `跳到第 ${index + 1} 步：${step.text.slice(0, 18)}${step.text.length > 18 ? '…' : ''}`;
          return <button type="button" key={index} className="sa-trace-dot" data-kind={step.kind} aria-label={label} title={label} onClick={() => jump(index)} />;
        })}
      </div>
    </div>}
    {hiddenCount > 0 && <button type="button" className="sa-trace-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? `收起更早 ${hiddenCount} 步` : `更早 ${hiddenCount} 步`}
    </button>}
    {expanded && hiddenCount > 0 && <ol className="sa-live-steps sa-live-compact">{steps.slice(0, hiddenCount).map(renderStep)}</ol>}
    <ol className="sa-live-steps sa-live-compact">{steps.slice(hiddenCount).map((step, offset) => renderStep(step, hiddenCount + offset))}</ol>
  </div>;
}

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
const DRAFTS_KEY = 'lagent.drafts.v1';
const CHAT_SEEN_KEY = 'lagent.chatseen.v1';
const SIDEBAR_WIDTH_KEY = 'lagent.sidebarw.v1';
const PINNED_KEY = 'lagent.pinnedfolders.v1';
const RAIL_COLLAPSED_KEY = 'lagent.railcollapsed.v1';
// 新对话的模型/权限选择；项目对话沿用 ChatModelPicker 的按会话存储。
const COMPOSER_KEY = 'composer';
const COMPOSER_PERMISSION_KEY = 'lagent.composer-permission.v1';
type ConversationPermission = 'read' | 'workspace' | 'full';
const PERMISSION_LABELS: Record<ConversationPermission, string> = {
  read: '仅查看',
  workspace: '仅工作区内修改',
  full: '完全权限'
};
const readComposerPermission = (): ConversationPermission => {
  try {
    const saved = localStorage.getItem(COMPOSER_PERMISSION_KEY);
    if (saved === 'read' || saved === 'workspace' || saved === 'full') return saved;
  } catch { /* 隐私模式下读不了，用默认值。 */ }
  return 'workspace';
};

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

const unreadStatuses = ['completed', 'failed', 'blocked', 'awaiting_review'];

export function SuperAgentShell({ user, runtime, settings, onSettingsSaved, notify: pushNotify }: {
  user?: User | null; runtime: { mode: 'local' | 'cloud' }; settings: Settings;
  onSettingsSaved: (settings: Settings) => void; notify: (text: string, error?: boolean) => void;
}) {
  const appearance = useAppearance();
  // 主壳自己渲染提示条，不依赖外层容器。
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const notify = useCallback((text: string, error = false) => { pushNotify(text, error); setToast({ text, error }); }, [pushNotify]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4200); return () => clearTimeout(timer); }, [toast]);
  // 视图与选中项目写进 URL（replaceState，不产生历史记录），刷新后能回到原处。
  const [view, setView] = useState<ShellView>(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('view');
    if (raw === 'chat') return 'command';
    // 旧的「工单」页已并入报告页的执行标签，老链接继续可用。
    if (raw === 'tickets') return 'reports';
    const known: ShellView[] = ['command', 'project', 'projects', 'agents', 'runs', 'reports', 'tools', 'skills', 'memory', 'settings'];
    if (known.includes(raw as ShellView)) return raw as ShellView;
    return params.get('project') ? 'projects' : 'command';
  });
  const [reportTab, setReportTab] = useState<'reports' | 'tickets'>(() => new URLSearchParams(window.location.search).get('view') === 'tickets' ? 'tickets' : 'reports');
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
  const [verifyBusy, setVerifyBusy] = useState(false);
  // 模型 Agent 的实时过程：SSE 推一步就更新一次，按工单 id 存。
  const [liveActivity, setLiveActivity] = useState<Record<string, LiveStep[]>>({});
  const [projectFocus, setProjectFocus] = useState<string | null>(() => new URLSearchParams(window.location.search).get('project'));
  const [chatFocus, setChatFocus] = useState<string | null>(() => new URLSearchParams(window.location.search).get('chat'));
  const [importTick, setImportTick] = useState(0);
  const [collapsedProjects, setCollapsedProjects] = useState<string[]>([]);
  const [folderState, setFolderState] = useState<{ projects: WorkProject[]; projectId: string | null; chatId: string | null }>({ projects: [], projectId: null, chatId: null });
  const [activeTicketId, setActiveTicketId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('ticket'));
  // 旧 URL 仍可能带 ?chat=：打开时先物化成 Lagent 会话，再落到统一线程。
  const [projectChatId, setProjectChatId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('chat'));
  const [materializeError, setMaterializeError] = useState('');
  const [materializeTick, setMaterializeTick] = useState(0);
  // 会话 = 用户可见的唯一对话；activeConversationId 决定主区显示哪条任务线程。
  const [conversations, setConversations] = useState<WorkConversationSummary[]>(() => []);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('conv'));
  const [activeConversation, setActiveConversation] = useState<WorkConversation | null>(null);
  // 会话切换时可能有多个请求在飞；只允许最新一次写回状态，避免旧响应盖掉新会话。
  const conversationRequest = useRef(0);
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const [conversationRunDetails, setConversationRunDetails] = useState<Record<string, WorkTicketDetail>>({});
  // 对话页把 chat 写进地址栏：刷新、分享都能落到同一条对话。
  useEffect(() => {
    const url = new URL(window.location.href);
    if (projectChatId) url.searchParams.set('chat', projectChatId);
    else url.searchParams.delete('chat');
    if ((view === 'project' || view === 'projects') && folderState.projectId) url.searchParams.set('project', folderState.projectId);
    else url.searchParams.delete('project');
    if (view === 'command' && activeTicketId) url.searchParams.set('ticket', activeTicketId);
    else url.searchParams.delete('ticket');
    if (view === 'command' && activeConversationId) url.searchParams.set('conv', activeConversationId);
    else url.searchParams.delete('conv');
    window.history.replaceState(null, '', url);
  }, [view, projectChatId, folderState.chatId, folderState.projectId, activeTicketId, activeConversationId]);
  useEffect(() => { if (view !== 'command') setProjectChatId(null); }, [view]);
  // 窄屏的工作坞是浮层：窗口缩到桌面以下时先收起，避免盖住刚打开的导航。
  useEffect(() => {
    const onResize = () => { if (window.innerWidth < 1180) setInspectorOpen(false); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const [planDetail, setPlanDetail] = useState<WorkPlan | null>(null);
  // 越权访问的确认用弹窗打断：用户没回答之前，Agent 是停在那里等的。
  // 普通「执行前确认」也走弹窗：点过「稍后」的记在这里，下次刷新会再问一次。
  const [handoffExecutor, setHandoffExecutor] = useState('');
  const [handoffText, setHandoffText] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [localSettings, setLocalSettings] = useState(settings);
  const eventRef = useRef<EventSource | null>(null);

  const [projects, setProjects] = useState<WorkProject[] | null>(null);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<WorkTicketDetail | null>(null);
  const [runs, setRuns] = useState<WorkRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<WorkRun | null>(null);
  const [usage, setUsage] = useState<WorkUsageReport | null>(null);
  const [usageHistory, setUsageHistory] = useState(false);
  const [roster, setRoster] = useState<WorkRosterEntry[]>([]);
  const [teamTemplates, setTeamTemplates] = useState<WorkTeamTemplate[]>([]);
  const [trace, setTrace] = useState<WorkTrace | null>(null);
  const [crossChecks, setCrossChecks] = useState<CrossCheck[]>(() => loadCrossChecks());
  const [groupDetails, setGroupDetails] = useState<Record<string, WorkTicketDetail>>({});
  // 新对话默认由内置 Agent（Lagent）负责；需要时在输入框上方换人或加协作 Agent。
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['model']);
  // 简单任务建议是本地提示：用户可以忽略，也可以一键清空协作 Agent。
  const [dismissedSuggestion, setDismissedSuggestion] = useState('');
  // 新对话的模型/思考强度/权限；项目对话分别读取 chat 自己的设置。
  const [composerModel, setComposerModel] = useState<ChatModelChoice>(() => readChatModel(COMPOSER_KEY));
  const [composerPermission, setComposerPermission] = useState<ConversationPermission>(readComposerPermission);
  const [cliModels, setCliModels] = useState<Record<string, string>>(() => readJson<Record<string, string>>('lagent.climodels.v1', {}));
  const [cliEfforts, setCliEfforts] = useState<Record<string, string>>(() => readJson<Record<string, string>>('lagent.cliefforts.v1', {}));
  const [chatModels, setChatModels] = useState<Record<string, ChatModelChoice>>({});
  const [chatPermissionBusy, setChatPermissionBusy] = useState(false);
  // 派活方式只有两种：单 Agent=只由 Lagent 完成；多 Agent=Lagent 拆解分发、协作方互相验收、最后汇总。
  const [composeMode, setComposeMode] = useState<'single' | 'multi'>('single');
  // 多 Agent 的两种用法：拆分分发（先拆成子任务再分派）与并行对比（同一问题各自作答）。
  // 指挥台：一句话目标 → 软件拆解 → 分给 Agent → 汇总。
  // 指挥台绑定的工作文件夹与「一次跑完」开关：绑定后每一步都在该目录内读写。
  // 任务理解：写目标时先本地拆一遍（谁做、改哪儿、会不会冲突），再交给规划器。
  // 多 Agent 模式固定由 Lagent 拆解、分派、收拢；每一步用的模型可以不同。
  const [teamMode, setTeamMode] = useState(false);
  const [teamProfiles, setTeamProfiles] = useState<{ id: string; name: string; model: string }[]>([]);
  const [teamProfile, setTeamProfile] = useState('');
  const [teamModels, setTeamModels] = useState<Record<string, string>>({});
  // 新对话绑定的工作文件夹：选中后指令会作为项目任务分派，Agent 在该目录内读写。
  const [newFolder, setNewFolder] = useState<string>(() => { try { return localStorage.getItem('lagent.newchatfolder.v1') || ''; } catch { return ''; } });
  useEffect(() => { try { localStorage.setItem('lagent.newchatfolder.v1', newFolder); } catch { /* 存储禁用时仅当前会话生效。 */ } }, [newFolder]);
  const [synthesisAgent, setSynthesisAgent] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const landingRef = useRef<HTMLDivElement | null>(null);

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
  const [chatToDelete, setChatToDelete] = useState<{ projectId: string; chat: WorkProjectChat } | null>(null);
  // 侧栏多选：勾选多条对话一次删掉，省得一条条点叉。
  const [selectMode, setSelectMode] = useState(false);
  const [pickedChats, setPickedChats] = useState<string[]>([]);
  const [pickedTickets, setPickedTickets] = useState<string[]>([]);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // 项目对话里每条任务可以换执行器，也可以多选并行：按会话记最近一次的选择。
  const [projectChatAgents, setProjectChatAgents] = useState<Record<string, string[]>>({});
  const [dropActive, setDropActive] = useState(false);
  // 侧栏折叠、右侧检查器、底部用户菜单：让主区尽量宽，工作与过程都放在主区
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => readJson<boolean>(RAIL_COLLAPSED_KEY, false));
  const [moreOpen, setMoreOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(() => typeof window === 'undefined' || window.innerWidth >= 1280);
  const [inspectorTab, setInspectorTab] = useState<'inbox' | 'run' | 'artifacts'>('inbox');
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({});
  const [cardDetails, setCardDetails] = useState<Record<string, WorkTicketDetail>>({});
  const autoOpened = useRef(false);

  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError('');
    try { setWork(await api.workBootstrap()); }
    catch (cause) { setError((cause as Error).message); }
    finally { if (!quiet) setLoading(false); }
  };
  const loadRuns = async () => {
    try { setRuns((await api.workRuns(50, true)).runs); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const loadRun = async (id: string) => {
    try { setRunDetail((await api.workRun(id)).run); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const loadUsage = async () => {
    try { setUsage(await api.workUsage({ days: 30, includeHistory: usageHistory })); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const createTeamTemplate = async () => {
    const ids = (policy?.allowedExecutors || work?.policy?.allowedExecutors || []).slice(0, 3);
    if (!ids.length) { notify('还没有启用的 Agent，先在下面打开开关。', true); return; }
    const labels = ['调研', '实现', '验证'];
    const roles = ids.map((id, index) => ({ role: labels[index] || `角色 ${index + 1}`, executorId: id, permissions: index === 2 ? 'read' as const : 'workspace' as const }));
    try {
      const result = await api.workSaveTeamTemplate({ name: `团队 ${new Date().toLocaleDateString('zh-CN')}`, roles, defaultMode: 'plan' });
      setTeamTemplates(previous => [result.template, ...previous]);
      notify('团队模板已创建。');
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const deleteTeamTemplate = async (id: string) => {
    try {
      await api.workDeleteTeamTemplate(id);
      setTeamTemplates(previous => previous.filter(item => item.id !== id));
      notify('模板已删除。');
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const loadTrace = async (id: string) => {
    try { setTrace(await api.workTicketTrace(id)); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  useEffect(() => { void load(); }, []);
  // 旧版把交叉验证分组存在 localStorage 里；第一次打开时上报一次，之后只认服务端会话。
  useEffect(() => {
    const legacy = loadCrossChecks();
    if (!legacy.length) return;
    api.workImportConversations(legacy)
      .then(result => {
        setCrossChecks([]);
        try { localStorage.removeItem(CROSS_CHECK_KEY); } catch { /* 隐私模式忽略。 */ }
        if (result.imported) void load(true);
      })
      .catch(() => { /* 服务端不可用时下次再试。 */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (view === 'runs') void loadRuns(); }, [view]);
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let flush: ReturnType<typeof setTimeout> | null = null;
    // 事件可能一串一串到；合并成一次刷新，避免每个 token 都拉一遍全量快照。
    const schedule = () => {
      if (flush || document.hidden) return;
      flush = setTimeout(() => { flush = null; void load(true); }, 350);
    };
    try {
      source = new EventSource('/api/work/events');
      // 服务端游标超出保留窗口时会发 reset；此时增量已不完整，直接重拉整份快照。
      source.addEventListener('reset', () => void load(true));
      source.onmessage = event => {
        let skipRefresh = false;
        try {
          const data = JSON.parse(event.data);
          // 模型 Agent 的每一步都单独推送一遍，这样思考与工具调用能实时看到。
          if (data?.type === 'activity' && typeof data.ticketId === 'string') {
            const activity = Array.isArray(data.payload?.activity) ? data.payload.activity : [];
            setLiveActivity(previous => ({ ...previous, [data.ticketId]: activity }));
            const status = typeof data.payload?.status === 'string' ? data.payload.status : '';
            if (status) setWork(previous => previous ? { ...previous, tickets: previous.tickets.map(ticket => ticket.id === data.ticketId ? { ...ticket, status, updatedAt: new Date().toISOString() } : ticket) } : previous);
          }
          if (data?.type === 'delete' && Array.isArray(data.payload?.ids)) {
            const ids = new Set<string>(data.payload.ids);
            setWork(previous => previous ? {
              ...previous,
              tickets: previous.tickets.filter(ticket => !ids.has(ticket.id)),
              attention: previous.attention.filter(item => !ids.has(item.ticketId)),
            } : previous);
          }
          // 工单快照由服务端随每次写入推送：直接合并，不再为每个状态变化重拉整份 bootstrap。
          if (data?.type === 'ticket') {
            const ticket = (data.payload?.ticket ?? data.payload) as WorkTicket;
            if (!ticket?.id) return;
            setWork(previous => {
              if (!previous) return previous;
              const exists = previous.tickets.some(item => item.id === ticket.id);
              const tickets = exists
                ? previous.tickets.map(item => item.id === ticket.id ? { ...item, ...ticket } : item)
                : [ticket, ...previous.tickets];
              const attention = previous.attention.filter(item => item.ticketId !== ticket.id);
              if (ticket.attention) attention.unshift({ ticketId: ticket.id, title: ticket.title, ...ticket.attention });
              return { ...previous, tickets, attention };
            });
            setActiveDetail(previous => previous?.ticket.id === ticket.id ? { ...previous, ticket } : previous);
            skipRefresh = true;
          }
        } catch { /* 心跳与格式异常忽略 */ }
        if (!skipRefresh) schedule();
      };
      // 不要主动 close：EventSource 重连时会带上 Last-Event-ID，服务端补发断线期间的事件。
      source.onopen = () => { if (timer) { clearInterval(timer); timer = null; } };
      source.onerror = () => { if (!timer) timer = setInterval(() => void load(true), 15000); };
      eventRef.current = source;
    } catch { timer = setInterval(() => void load(true), 15000); }
    return () => { source?.close(); eventRef.current?.close(); if (timer) clearInterval(timer); if (flush) clearTimeout(flush); };
  }, []);
  const attention = work?.attention || [];
  const tickets = work?.tickets || [];
  // bootstrap 每次刷新都会带上会话列表；本地只在拿到新快照时覆盖，避免把迁移结果冲掉。
  useEffect(() => { if (work?.conversations) setConversations(work.conversations); }, [work?.conversations]);
  const ticketMap = useMemo(() => new Map(tickets.map(ticket => [ticket.id, ticket])), [tickets]);
  // 项目对话只作为执行绑定；用户打开的入口统一物化成会话线程。
  // 物化是幂等的，旧链接、项目页点击和侧栏直达都走这一条路径。
  useEffect(() => {
    if (!projectChatId || activeConversationId) return;
    let live = true;
    setMaterializeError('');
    api.workMaterializeChat(projectChatId)
      .then(result => {
        if (!live) return;
        autoOpened.current = true;
        setMaterializeError('');
        setProjectFocus(result.conversation.projectId || null);
        const participants = (result.conversation.participants || []).filter(id => id !== 'model').slice(0, 3);
        setSelectedAgents(['model', ...participants]);
        setComposeMode(participants.length ? 'multi' : 'single');
        setTeamMode(participants.length > 0);
        setActiveConversationId(result.conversation.id);
        setProjectChatId(null);
        void loadConversation(result.conversation.id);
      })
      .catch(cause => {
        if (!live) return;
        const message = (cause as Error)?.message || '接入会话失败';
        setMaterializeError(message);
        notify(message, true);
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectChatId, activeConversationId, materializeTick]);
  const agents = work?.agents || [];
  // 用户还没手动改过权限时，跟随设置里的全局档位；改过就记住自己的选择。
  useEffect(() => {
    let saved = null;
    try { saved = localStorage.getItem(COMPOSER_PERMISSION_KEY); } catch { return; }
    if (saved) return;
    const fallback = work?.policy?.permission;
    if (fallback === 'read' || fallback === 'workspace' || fallback === 'full') setComposerPermission(fallback);
  }, [work?.policy?.permission]);
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
  useEffect(() => { if (view === 'agents') { void loadWindows(); void loadProviders(); api.workAgentRoster().then(result => setRoster(result.agents)).catch(() => {}); api.workTeamTemplates().then(result => setTeamTemplates(result.templates)).catch(() => {}); } }, [view]);
  useEffect(() => {
    let live = true;
    api.workProjects()
      .then(result => { if (live) { setProjects(result.projects); setFolderState(prev => ({ ...prev, projects: result.projects })); } })
      .catch(() => { if (live) setProjects([]); });
    return () => { live = false; };
  }, [view === 'projects' || view === 'project']);
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
  // Lagent 是固定主控：它的可用性不受执行器策略开关影响，项目对话永远至少能由它主持。
  const projectAllowedExecutors = useMemo(
    () => ['model', ...allowedExecutors.filter(id => projectExecutorIds.includes(id) && id !== 'window')]
      .filter((id, index, list) => list.indexOf(id) === index),
    [allowedExecutors]
  );
  const [policy, setPolicy] = useState<WorkPolicy | null>(null);
  const [policySaving, setPolicySaving] = useState(false);
  const [windows, setWindows] = useState<{ id: string; handle: number; pid: number; process: string; title: string }[]>([]);
  const [windowDrafts, setWindowDrafts] = useState<Record<string, string>>({});
  const [windowOutputs, setWindowOutputs] = useState<Record<string, string>>({});
  const [windowsLoading, setWindowsLoading] = useState(false);
  const [providers, setProviders] = useState<{ id: string; name: string; executorId?: string | null; kind?: string; command: string | null; installed: boolean; version: string | null; status: string; message: string; auth: { loggedIn: boolean | null; method: string | null; message: string } }[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [executorBusy, setExecutorBusy] = useState('');
  useEffect(() => { if (work?.policy) setPolicy(work.policy); }, [work?.policy]);
  const savePolicy = async () => {
    if (!policy || policySaving) return;
    setPolicySaving(true);
    try { const saved = await api.updateWorkPolicy(policy); setPolicy(saved.policy); await refresh(); notify('执行器策略已保存。'); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setPolicySaving(false); }
  };
  // 所有执行器开关都即时落盘：读最新的 work.policy（避免设置页未保存的本地编辑互相覆盖），
  // 但只把 allowedExecutors 合并回草稿，保留用户还没保存的预算/目录编辑。
  const setExecutorEnabled = async (id: string, enabled: boolean) => {
    const base = work?.policy || policy;
    if (!base || executorBusy) return;
    const current = base.allowedExecutors || [];
    const nextList = enabled ? [...new Set([...current, id])] : current.filter(item => item !== id);
    if (nextList.length === current.length && enabled === current.includes(id)) return;
    // 先乐观更新，勾选立刻有反馈；请求失败再回到服务端已知状态。
    setPolicy(previous => previous ? { ...previous, allowedExecutors: nextList } : previous);
    setExecutorBusy(id);
    try {
      const saved = await api.updateWorkPolicy({ ...base, allowedExecutors: nextList });
      setPolicy(previous => previous ? { ...previous, allowedExecutors: saved.policy.allowedExecutors } : saved.policy);
      await refresh();
      notify(`${executorNames[id] || id}${enabled ? ' 已启用，可在新对话里选择' : ' 已停用'}。`);
    } catch (cause) {
      setPolicy(previous => previous ? { ...previous, allowedExecutors: current } : previous);
      notify((cause as Error).message, true);
    }
    finally { setExecutorBusy(''); }
  };
  const setBudget = (key: 'maxConcurrent' | 'maxCallsPerTicket' | 'maxRuntimeMs' | 'maxTokensPerTicket', value: number) => setPolicy(previous => previous ? { ...previous, budgets: { ...(previous.budgets || { maxConcurrent: 2, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 200000 }), [key]: value } } : previous);
  const [rootDraft, setRootDraft] = useState('');
  // 额外授权目录：登记之后这些目录里的读写不再逐个弹窗（工作目录始终隐式授权）。
  const addExtraRoot = () => {
    const value = rootDraft.trim().replace(/[\\/]+$/, '');
    if (!value) return;
    if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) { notify('请填绝对路径，例如 D:\\shared\\assets', true); return; }
    setPolicy(previous => {
      if (!previous) return previous;
      const list = previous.limits?.extraRoots || [];
      if (list.includes(value)) { notify('这个目录已经在授权列表里。', true); return previous; }
      if (list.length >= 10) { notify('最多登记 10 个额外目录。', true); return previous; }
      return { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), extraRoots: [...list, value] } };
    });
    setRootDraft('');
  };
  const removeExtraRoot = (value: string) => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), extraRoots: (previous.limits?.extraRoots || []).filter(root => root !== value) } } : previous);
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
  // —— 工作区配置档：保存当前策略与对话设置，一键在「省钱 / 质量 / 只读审计」之间切换。——
  const [profileName, setProfileName] = useState('');
  const [profileSkills, setProfileSkills] = useState('');
  const [profileMcpServers, setProfileMcpServers] = useState('');
  const [profileInstructions, setProfileInstructions] = useState('');
  const [profileBusy, setProfileBusy] = useState('');
  const listOf = (value: string) => value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
  const saveProfile = async () => {
    if (!profileName.trim() || profileBusy) return;
    setProfileBusy('save');
    try {
      await api.workSaveProfile({
        name: profileName.trim(),
        settings: { ...composerModel, permission: composerPermission },
        policy: policy || work?.policy || undefined,
        library: { skills: listOf(profileSkills), mcpServers: listOf(profileMcpServers), instructions: listOf(profileInstructions) }
      });
      setProfileName(''); setProfileSkills(''); setProfileMcpServers(''); setProfileInstructions('');
      await refresh();
      notify('配置档已保存。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setProfileBusy(''); }
  };
  const applyProfile = async (id: string) => {
    if (profileBusy) return;
    setProfileBusy(id);
    try {
      const result = await api.workApplyProfile(id);
      setPolicy(result.policy);
      await refresh();
      notify('配置档已应用；之后的新会话会使用这套工作方式。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setProfileBusy(''); }
  };
  const deleteProfile = async (id: string) => {
    if (profileBusy) return;
    setProfileBusy(id);
    try { await api.workDeleteProfile(id); await refresh(); notify('配置档已删除。'); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setProfileBusy(''); }
  };
  const resetProfile = async () => {
    if (profileBusy) return;
    setProfileBusy('reset');
    try { const result = await api.workResetProfile(); setPolicy(result.policy); await refresh(); notify('已恢复默认工作方式。'); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setProfileBusy(''); }
  };
  // —— 加密备份 / 恢复 / 诊断包 ——
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [backupIncludeCredentials, setBackupIncludeCredentials] = useState(true);
  const [backupBusy, setBackupBusy] = useState('');
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [backupLog, setBackupLog] = useState<Array<{ kind: string; result: string; bytes?: number; at: string }>>([]);
  const loadBackupStatus = async () => {
    try { setBackupLog((await api.workBackupStatus()).backups); }
    catch { /* 旧版本没有备份接口时保持空列表。 */ }
  };
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportBackup = async () => {
    if (backupBusy) return;
    if (backupPassphrase.length < 8) { notify('备份口令至少 8 个字符。', true); return; }
    setBackupBusy('export');
    try {
      const blob = await api.workBackupExport(backupPassphrase, backupIncludeCredentials);
      downloadBlob(blob, `lagent-backup-${new Date().toISOString().slice(0, 10)}.lagentbackup`);
      await loadBackupStatus();
      notify('加密备份已导出，请妥善保存口令。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBackupBusy(''); }
  };
  const restoreBackup = async () => {
    if (backupBusy) return;
    if (!backupFile) { notify('请先选择备份文件。', true); return; }
    if (backupPassphrase.length < 8) { notify('请输入导出时使用的备份口令。', true); return; }
    if (!window.confirm('恢复会用备份内容替换当前工作区数据。请先导出当前数据，确认后继续。')) return;
    setBackupBusy('restore');
    try {
      await api.workBackupRestore(backupFile, backupPassphrase);
      await loadBackupStatus();
      notify('恢复完成。建议重启 Lagent 服务，让内存中的策略与执行器状态重新加载。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBackupBusy(''); }
  };
  const exportDiagnostics = async () => {
    if (backupBusy) return;
    setBackupBusy('diagnostics');
    try {
      const result = await api.workDiagnostics();
      downloadBlob(new Blob([JSON.stringify(result.diagnostics, null, 2)], { type: 'application/json' }), `lagent-diagnostics-${new Date().toISOString().slice(0, 10)}.json`);
      notify('诊断包已导出；其中不包含密钥和手机号完整值。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBackupBusy(''); }
  };
  // —— 作用域 MCP 令牌：绑定项目、只读、工具白名单、预算与有效期 ——
  const [scopedTokens, setScopedTokens] = useState<WorkMcpToken[]>([]);
  const [scopedTokenRow, setScopedTokenRow] = useState<{ token: string; endpoint: string; record: WorkMcpToken } | null>(null);
  const [scopedBusy, setScopedBusy] = useState('');
  const [scopedForm, setScopedForm] = useState({ name: '外部 Agent', projectId: '', readOnly: true, ttlDays: 7, budgetTokens: 0, maxCalls: 0, maxConcurrency: 4, tools: '' });
  const loadScopedTokens = async () => {
    try { setScopedTokens((await api.workMcpTokens()).tokens); }
    catch { /* 旧版本或未启用 Work 时保持空列表。 */ }
  };
  useEffect(() => {
    if (view !== 'settings') return;
    void loadScopedTokens(); void loadBackupStatus();
  }, [view]);
  const createScopedToken = async () => {
    if (scopedBusy) return;
    setScopedBusy('create');
    try {
      const result = await api.workCreateMcpToken({
        name: scopedForm.name.trim() || '外部 Agent',
        ...(scopedForm.projectId ? { projectId: scopedForm.projectId } : {}),
        readOnly: scopedForm.readOnly,
        ttlDays: scopedForm.ttlDays,
        budgetTokens: scopedForm.budgetTokens,
        maxCalls: scopedForm.maxCalls,
        maxConcurrency: scopedForm.maxConcurrency,
        tools: scopedForm.tools.split(',').map(item => item.trim()).filter(Boolean)
      });
      setScopedTokenRow({ token: result.token, endpoint: result.endpoint, record: result.record });
      await loadScopedTokens();
      notify('作用域令牌已生成，明文只显示一次。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setScopedBusy(''); }
  };
  const revokeScopedToken = async (id: string) => {
    if (scopedBusy) return;
    setScopedBusy(id);
    try { await api.workRevokeMcpToken(id); await loadScopedTokens(); notify('令牌已撤销。'); }
    catch (cause) { notify((cause as Error).message, true); }
    finally { setScopedBusy(''); }
  };
  const exportUsageCsv = async () => {
    try { downloadBlob(await api.workUsageCsv({ includeHistory: usageHistory }), `lagent-usage-${new Date().toISOString().slice(0, 10)}.csv`); }
    catch (cause) { notify((cause as Error).message, true); }
  };
  const [terminalProgram, setTerminalProgram] = useState('git');
  const [terminalArgs, setTerminalArgs] = useState('status --short');
  const [browserUrl, setBrowserUrl] = useState('');
  const [githubAction, setGithubAction] = useState('repo');
  const [githubOwner, setGithubOwner] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubNumber, setGithubNumber] = useState('');
  const [githubPath, setGithubPath] = useState('');
  const current = useMemo(() => {
    if (view === 'projects' || view === 'project') return folderState.projects.find(item => item.id === folderState.projectId)?.name || '工作文件夹';
    return [...primaryNav, ...moreNav].find(item => item.id === view)?.label || '新对话';
  }, [view, folderState]);
  const openFolder = (projectId: string) => { setView('project'); setProjectFocus(projectId); setChatFocus(null); setActiveConversationId(null); setActiveConversation(null); setNavOpen(false); };
  const handleFolderState = useCallback((next: { projects: WorkProject[]; projectId: string | null; chatId: string | null }) => {
    setFolderState(previous => {
      const projects = next.projects.length ? next.projects : previous.projects;
      if (projects === previous.projects && previous.projectId === next.projectId && previous.chatId === next.chatId) return previous;
      return { projects, projectId: next.projectId, chatId: next.chatId };
    });
  }, []);
  const openFolderChat = (projectId: string, chatId: string) => {
    markChatSeen(chatId);
    // 用户明确打开某个对话时，不应再触发「首次进入自动打开最近工单」，
    // 否则对话页会被上一张工单顶掉。
    autoOpened.current = true;
    setView('command');
    setProjectFocus(projectId);
    setChatFocus(chatId);
    setActiveTicketId(null);
    setActiveGroupId(null);
    setActiveDetail(null);
    // 项目页里的对话如果已经归到 Lagent 会话，直接打开会话线程；
    // 还没有归属的旧对话交给物化 effect，转成同一条线程后再打开。
    const chat = folderState.projects.find(item => item.id === projectId)?.chats.find(item => item.id === chatId);
    if (chat?.conversationId) {
      setProjectChatId(null);
      const participants = (chat.collaborators || []).filter(id => id !== 'model').slice(0, 3);
      setSelectedAgents(['model', ...participants]);
      setComposeMode(participants.length ? 'multi' : 'single');
      setTeamMode(participants.length > 0);
      setActiveConversationId(chat.conversationId);
      setActiveConversation(null);
      void loadConversation(chat.conversationId);
    } else {
      setProjectChatId(chatId);
      setActiveConversationId(null);
      setActiveConversation(null);
    }
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
  // 文件夹行上的「+」：不再先弹 Agent 选择框，直接用 Lagent 建一条会话；
  // 需要换人时在对话输入框上方按任务切换。
  const newChatExecutors = () => projectAllowedExecutors;
  const quickNewChat = async (project: WorkProject) => {
    const usable = newChatExecutors();
    if (!usable.length) { notify('没有可用于项目的执行器，请先在设置里启用。', true); return; }
    const executorId = usable.includes('model') ? 'model' : usable[0];
    try {
      const result = await api.workCreateProjectChat(project.id, { executorId });
      setProjectChatAgents(previous => ({ ...previous, [result.chat.id]: [executorId] }));
      await reloadProjects();
      markChatSeen(result.chat.id);
      setCollapsedProjects(previous => previous.filter(id => id !== project.id));
      openFolderChat(project.id, result.chat.id);
      notify(`已在「${project.name}」新建会话，默认由${executorNames[executorId] || executorId}负责；每条任务都可以换人。`);
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
  const removeChat = async (target: { projectId: string; chat: WorkProjectChat }) => {
    try {
      await api.workDeleteProjectChat(target.chat.id);
      notify(`已删除对话「${target.chat.title}」。`);
      await reloadProjects();
      // 这段对话名下的工单也一并从快照里去掉，右侧「执行详情」不会留着它们的卡片。
      void load();
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const exitSelect = () => {
    setSelectMode(false);
    setPickedChats([]);
    setPickedTickets([]);
    setBulkConfirm(false);
  };
  const togglePick = (kind: 'chat' | 'ticket', id: string) => {
    const update = (list: string[]) => (list.includes(id) ? list.filter(entry => entry !== id) : [...list, id]);
    if (kind === 'chat') setPickedChats(update); else setPickedTickets(update);
  };
  const pickedTotal = pickedChats.length + pickedTickets.length;
  const removePicked = async () => {
    const chats = [...pickedChats];
    const tickets = [...pickedTickets];
    setBulkConfirm(false);
    if (!chats.length && !tickets.length) return;
    setBulkBusy(true);
    let done = 0;
    let firstError = '';
    for (const id of chats) {
      try { await api.workDeleteProjectChat(id); done += 1; }
      catch (cause) { firstError ||= (cause as Error).message; }
    }
    for (const id of tickets) {
      try { await api.workDeleteTicket(id); done += 1; }
      catch (cause) { firstError ||= (cause as Error).message; }
    }
    setBulkBusy(false);
    exitSelect();
    const failed = chats.length + tickets.length - done;
    if (failed) notify(`删掉 ${done} 条，${failed} 条没删成：${firstError}`, true);
    else notify(`已删除 ${done} 条对话。`);
    await reloadProjects();
    // 被删对话名下的工单也要从快照里去掉，右侧「执行详情」不留空卡。
    void load();
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
    const bridge = (window as unknown as { lagentDesktop?: { openPath?: (path: string) => Promise<unknown> } }).lagentDesktop;
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

  const usableAgents = useMemo(() => agents.filter(agent => allowedExecutors.includes(agent.id) && agent.status === 'available'), [agents, allowedExecutors]);
  const crossCapable = useMemo(() => usableAgents.filter(agent => isConversationExecutor(agent.id)), [usableAgents]);
  // 旧服务端没有 lagent 字段时视为就绪，避免升级过程中误锁。
  const lagentState = work?.lagent;
  const lagentReady = lagentState ? lagentState.ready !== false : true;
  const agentLabel = (id: string) => id.startsWith('win:') ? `${windows.find(window => windowKey(window.handle) === id)?.process || '窗口 Agent'} 窗口` : executorNames[id] || id;
  useEffect(() => {
    setSelectedAgents(previous => {
      const valid = previous.filter(id => id !== 'model' && (id.startsWith('win:') ? windows.some(window => windowKey(window.handle) === id) : crossCapable.some(agent => agent.id === id))).slice(0, 3);
      // 主控始终存在；模型没配置时由发送前的就绪检查拦截，而不是悄悄换成外部 Agent。
      if (!valid.length && !crossCapable.length) return ['model'];
      return ['model', ...valid];
    });
  }, [crossCapable, windows]);

  // 团队协作模式下才需要模型清单：只在首次打开时拉一次，失败就只用默认模型。
  useEffect(() => {
    if (!teamMode || teamProfiles.length) return;
    let alive = true;
    api.modelHub()
      .then(state => { if (alive) setTeamProfiles((state.profiles || []).map(item => ({ id: item.id, name: item.name, model: item.model }))); })
      .catch(() => {});
    return () => { alive = false; };
  }, [teamMode, teamProfiles.length]);

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
  const loadConversation = async (id: string) => {
    const seq = ++conversationRequest.current;
    try {
      const result = await api.workConversation(id);
      if (seq !== conversationRequest.current || activeConversationIdRef.current !== id) return;
      setActiveConversation(result.conversation);
      setConversations(previous => {
        const summary: WorkConversationSummary = {
          id: result.conversation.id,
          title: result.conversation.title,
          goal: result.conversation.goal,
          host: result.conversation.host,
          projectId: result.conversation.projectId,
          participants: result.conversation.participants,
          ticketIds: result.conversation.ticketIds,
          turnCount: result.conversation.turns.length,
          lastPrompt: result.conversation.turns.at(-1)?.prompt || '',
          lastMode: result.conversation.turns.at(-1)?.mode || 'auto',
          status: result.conversation.status || 'waiting',
          createdAt: result.conversation.createdAt,
          updatedAt: result.conversation.updatedAt
        };
        return [summary, ...previous.filter(item => item.id !== summary.id)];
      });
      const ids = [...new Set(result.conversation.turns.flatMap(turn => [...turn.runs.map(run => run.ticketId), ...(turn.synthesisTicketId ? [turn.synthesisTicketId] : [])]))];
      const missing = ids.filter(ticketId => !conversationRunDetails[ticketId]).slice(0, 24);
      if (missing.length) {
        const loaded = await Promise.all(missing.map(async ticketId => {
          try { return [ticketId, await api.workTicket(ticketId)] as const; } catch { return null; }
        }));
        if (seq !== conversationRequest.current || activeConversationIdRef.current !== id) return;
        setConversationRunDetails(previous => {
          const next = { ...previous };
          for (const entry of loaded) if (entry) next[entry[0]] = entry[1];
          return next;
        });
      }
    } catch (cause) { notify((cause as Error).message, true); }
  };
  // 地址栏 / 侧栏选中的会话：没有缓存就拉一次，刷新或直接打开链接都能落到同一条线程。
  useEffect(() => {
    if (!activeConversationId) {
      if (activeConversation) setActiveConversation(null);
      return;
    }
    if (activeConversation?.id === activeConversationId) return;
    void loadConversation(activeConversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, activeConversation?.id]);
  const openConversation = (id: string) => {
    autoOpened.current = true;
    setView('command');
    setActiveGroupId(null);
    setActiveTicketId(null);
    setProjectChatId(null);
    setActiveDetail(null);
    // 打开哪条会话，就按它最近的参与者恢复模式：多 Agent 会话继续多 Agent，单 Agent 只留 Lagent。
    const summary = conversations.find(item => item.id === id);
    if (summary) {
      const participants = (summary.participants || []).filter(item => item !== 'model').slice(0, 3);
      setSelectedAgents(['model', ...participants]);
      setComposeMode(participants.length ? 'multi' : 'single');
      setTeamMode(participants.length > 0);
    }
    setActiveConversationId(id);
    setNavOpen(false);
    // 不必在这里直接拉取：上面的 effect 会在 id 变化后加载，重复调用只会多发一次请求。
  };
  const viewTicket = (id: string) => {
    setView('command');
    setActiveGroupId(null);
    setActiveConversationId(null);
    setActiveConversation(null);
    setActiveTicketId(id);
    setActiveDetail(null);
    void loadActiveTicket(id);
  };
  const viewGroup = (group: CrossCheck) => {
    setView('command');
    setActiveTicketId(null);
    setActiveConversationId(null);
    setActiveConversation(null);
    setActiveGroupId(group.id);
    setSynthesisAgent(group.synthesisAgentId || group.agentIds[0] || '');
    void loadGroupDetails([...group.ticketIds, ...(group.synthesisTicketId ? [group.synthesisTicketId] : [])]);
  };
  const newChat = () => {
    // 新建对话是明确的落地页动作，不能被自动打开最近工单覆盖。
    autoOpened.current = true;
    setView('command');
    setActiveGroupId(null);
    setActiveTicketId(null);
    setProjectChatId(null);
    setActiveDetail(null);
    setActiveConversationId(null);
    setActiveConversation(null);
    // 新对话不继承上一张工单的展开态，否则卡片会以“已展开但无数据”出现。
    setCardOpen({});
    setCommand('');
    // 新对话回到「只有 Lagent 主控」，不继承上一条会话的协作名单。
    setSelectedAgents(['model']);
    setComposeMode('single');
    setTeamMode(false);
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
    for (const item of [...primaryNav, ...moreNav]) rows.push({ id: `page:${item.id}`, label: item.label, hint: '页面', icon: item.icon, run: () => { setView(item.id); setNavOpen(false); close(); } });
    rows.push({ id: 'action:new', label: '新对话', hint: '动作', icon: Plus, run: () => { newChat(); close(); } });
    rows.push({ id: 'action:import', label: '添加本地文件夹', hint: '动作', icon: FolderGit2, run: () => { setView('projects'); setProjectFocus(null); setChatFocus(null); setImportTick(tick => tick + 1); setNavOpen(false); close(); } });
    for (const project of folderState.projects) {
      rows.push({ id: `folder:${project.id}`, label: project.name, hint: `文件夹 · ${project.chatCount} 个会话`, icon: FolderGit2, run: () => { openFolder(project.id); close(); } });
      for (const chat of project.chats) rows.push({ id: `chat:${chat.id}`, label: chat.title, hint: `${project.name} · ${executorNames[chat.executorId] || chat.executorId}`, icon: project.chats.length ? MessageSquare : Bot, run: () => { openFolderChat(project.id, chat.id); close(); } });
    }
    for (const item of conversations.slice(0, 30)) {
      rows.push({ id: `conv:${item.id}`, label: item.title, hint: `对话 · ${item.participants.map(id => agentLabel(id)).join(' / ') || 'Lagent'}`, icon: Users, run: () => { openConversation(item.id); close(); } });
    }
    // 还没有归并进会话的老工单仍然能被搜到。
    const inConversations = new Set(conversations.flatMap(item => item.ticketIds));
    for (const item of conversationTickets.slice(0, 20)) {
      if (item.ticket && inConversations.has(item.ticket.id)) continue;
      rows.push({ id: `conv:${item.id}`, label: item.title, hint: item.kind === 'group' ? '交叉验证' : `对话 · ${executorNames[item.ticket?.executor || ''] || item.ticket?.executor || ''}`, icon: item.kind === 'group' ? Users : Bot, run: () => { if (item.kind === 'group' && item.group) viewGroup(item.group); else if (item.ticket) viewTicket(item.ticket.id); close(); } });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderState.projects, conversationTickets, conversations]);
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
  // 会话里只要还有一路在跑，就定时刷新快照与详情，让 tab / 结论卡持续更新。
  const conversationPending = Boolean(activeConversation) && activeConversation!.turns.some(turn => turn.runs.some(run => !terminalStatuses.includes(ticketMap.get(run.ticketId)?.status || 'waiting')));
  // 会话、单卡、团队三种 pending 合并成一个轮询：都在跑时不会每条定时器各拉一遍快照。
  useEffect(() => {
    if (!conversationPending && !singlePending && !groupPending) return;
    const tick = () => {
      if (document.hidden) return;
      if (conversationPending && activeConversationId) { void load(true); void loadConversation(activeConversationId); }
      if (activeTicketId) void loadActiveTicket(activeTicketId);
      if (groupTicketIds.length) void loadGroupDetails(groupTicketIds);
    };
    const timer = setInterval(tick, 3000);
    const first = setTimeout(tick, 500);
    return () => { clearInterval(timer); clearTimeout(first); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationPending, singlePending, groupPending, activeConversationId, activeTicketId, activeGroupId, groupTicketIds.join(',')]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    // 落地页要看到标题与输入框，不能被「最近任务」列表带到最下面。
    if (!activeTicketId && !activeGroupId && !projectChatId && !activeConversationId) {
      node.scrollTo({ top: 0 });
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, [activeTicketId, activeGroupId, projectChatId, activeConversationId, activeDetail?.reports.length, sending]);

  const refresh = async () => { try { setWork(await api.workBootstrap()); } catch { /* keep last snapshot */ } };
  const executorInputFor = (id: string, text: string) => {
    if (id === 'terminal') return { program: terminalProgram, args: terminalArgs.trim().split(/\s+/).filter(Boolean) };
    if (id === 'browser') return { url: browserUrl.trim() };
    if (id === 'github') return { action: githubAction, owner: githubOwner.trim(), repo: githubRepo.trim(), ...(githubNumber.trim() ? { number: Number(githubNumber) } : {}), ...(githubAction === 'file' ? { path: githubPath.trim() } : {}) };
    return { prompt: text.slice(0, 12000) };
  };
  const saveComposerModel = (next: ChatModelChoice) => {
    setComposerModel(next);
    writeChatModel(COMPOSER_KEY, next);
  };
  const saveComposerPermission = (next: ConversationPermission) => {
    setComposerPermission(next);
    try { localStorage.setItem(COMPOSER_PERMISSION_KEY, next); } catch { /* 隐私模式下仅本次生效。 */ }
  };
  useEffect(() => { writeJson('lagent.climodels.v1', cliModels); }, [cliModels]);
  useEffect(() => { writeJson('lagent.cliefforts.v1', cliEfforts); }, [cliEfforts]);
  const cliChoiceOf = (key: string) => ({ model: cliModels[key] || '', effort: cliEfforts[key] || 'default' });
  const saveCliChoice = (key: string, next: { model: string; effort: string }) => {
    setCliModels(previous => ({ ...previous, [key]: next.model }));
    setCliEfforts(previous => ({ ...previous, [key]: next.effort }));
  };
  const validateSingleInput = (id: string): string | null => {
    if (id === 'browser' && !browserUrl.trim()) return '请填写要读取的 http/https 页面地址。';
    if (id === 'github' && (!githubOwner.trim() || !githubRepo.trim())) return '请填写 GitHub owner 和 repo。';
    return null;
  };
  const send = async (text = command) => {
    const value = text.trim(); if (!value || sending) return;
    if (value.length > 3000) { notify('指令不能超过 3000 字。', true); return; }
    // 每个对话都必须由 Lagent 主控；模型没配置时直接引导去设置，外部 Agent 不能绕过。
    if (!lagentReady) {
      notify(lagentState?.reason || 'Lagent 尚未配置模型，请先到「设置 → 模型与 API」配置。', true);
      setView('settings');
      return;
    }
    if (projectChatId) {
      setSending(true);
      try {
        // 每条任务按当前选中的 Agent 执行：单人选一个，多人就并行各开一张工单。
        const agentIds = activeChatAgents.length ? activeChatAgents : (activeProjectChat ? [activeProjectChat.executorId] : ['model']);
        const agentId = agentIds.length === 1 ? agentIds[0] : '';
        let options: { profileId?: string; model?: string; effort?: string; executorId?: string; executorIds?: string[] } = agentIds.length > 1 ? { executorIds: agentIds } : { executorId: agentIds[0] };
        if (activeProjectChat && agentId && agentId === 'model') {
          const choice = chatModels[activeProjectChat.id] || readChatModel(activeProjectChat.id);
          options = { ...options, profileId: choice.profileId, effort: choice.effort };
        } else if (activeProjectChat && agentId && agents.find(agent => agent.id === agentId)?.kind === 'cli') {
          const choice = cliChoiceOf(agentId === activeProjectChat.executorId ? activeProjectChat.id : `${activeProjectChat.id}:${agentId}`);
          options = { ...options, model: choice.model, effort: choice.effort };
        }
        const result = await api.workProjectChatMessage(projectChatId, value, undefined, options);
        setCommand('');
        // 受管入口会把项目对话接进会话：直接落到统一线程，不再维护第二套工单列表。
        if (result.conversationId) {
          setProjectChatId(null);
          setActiveConversationId(result.conversationId);
          void loadConversation(result.conversationId);
        }
        void refresh();
      } catch (cause) { notify((cause as Error).message, true); }
      setSending(false);
      return;
    }
    // 单 Agent 模式只允许 Lagent：即使用户刚打开一条多 Agent 会话，也不能把旧参与者带进新回合。
    const chosen = composeMode === 'single'
      ? ['model']
      : selectedAgents.filter(id => id.startsWith('win:') ? windows.some(window => windowKey(window.handle) === id) : crossCapable.some(agent => agent.id === id));
    if (!chosen.length) { notify('请至少选择一个可用 Agent。', true); return; }
    const execIdFor = (id: string) => id.startsWith('win:') ? 'window' : id;
    // 只有内置 Agent 和外部 CLI 支持对话级模型/权限；工具类执行器忽略这些设置。
    const settingsFor = (ids: string[]) => {
      const execIds = ids.map(execIdFor);
      const hasModel = execIds.includes('model');
      const cliIds = execIds.filter(id => id !== 'model' && agents.find(agent => agent.id === id)?.kind === 'cli');
      if (!hasModel && !cliIds.length) return undefined;
      if (hasModel) {
        // 主控使用模型配置档；同一个回合里的 CLI 协作 Agent 仍可以带自己的模型名。
        const cli = cliIds.length ? cliChoiceOf(cliIds[0]) : null;
        return {
          // 多 Agent 模式在界面上单独选了 Lagent 配置档时，以它为准。
          profileId: composeMode === 'multi' && teamProfile ? teamProfile : composerModel.profileId,
          ...(cli?.model ? { model: cli.model } : {}),
          effort: composerModel.effort,
          permission: composerPermission
        };
      }
      const cli = cliChoiceOf(cliIds[0]);
      return {
        ...(cli.model ? { model: cli.model } : {}),
        ...(cli.effort && cli.effort !== 'default' ? { effort: cli.effort } : {}),
        permission: composerPermission
      };
    };
    const inputFor = (id: string, prompt: string) => {
      if (!id.startsWith('win:')) return executorInputFor(id, prompt);
      const window = windows.find(item => windowKey(item.handle) === id);
      return window ? { handle: window.handle, text: prompt, submit: true, process: window.process, title: window.title } : undefined;
    };
    const problem = chosen.length === 1 ? validateSingleInput(execIdFor(chosen[0])) : null;
    if (problem) { notify(problem, true); return; }
    // 已有会话：追问直接追加到同一条会话，不再新建对话。
    if (activeConversationId && activeConversation) {
      setSending(true);
      try {
        const execIds = [...new Set(chosen.map(execIdFor))];
        const executorInputs: Record<string, unknown> = {};
        for (const id of chosen) {
          const execId = execIdFor(id);
          const input = inputFor(id, value);
          if (input) executorInputs[execId] = input;
        }
        const mode = composeMode === 'multi' ? 'multi' : 'auto';
        await api.workConversationMessage(activeConversationId, {
          text: value,
          mode,
          agentIds: execIds,
          ...(settingsFor(chosen) ? { settings: settingsFor(chosen) } : {}),
          ...(Object.keys(executorInputs).length ? { executorInputs } : {}),
          clientRequestId: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          autoRun: true
        });
        setCommand('');
        await refresh();
        await loadConversation(activeConversationId);
        notify(composeMode === 'multi' ? `Lagent 已把任务拆成多路并分发给 ${execIds.length} 个 Agent。` : 'Lagent 正在处理。');
      } catch (cause) { notify((cause as Error).message, true); }
      setSending(false);
      return;
    }
    // 新对话绑定了工作文件夹：会话仍然只有一条，Agent 在项目目录内执行。
    const scope = isLanding ? folderState.projects.find(item => item.id === newFolder) : undefined;
    // 团队协作：先由内置模型 Agent 理解与拆解，再并行分派给所选 Agent，最后收拢结果；结果落在同一个会话里。
    if (teamMode) {
      const execs = [...new Set(chosen.filter(id => !id.startsWith('win:')).map(execIdFor))];
      if (!execs.length) { notify('团队协作需要至少一个可执行的外部 Agent。', true); return; }
      setSending(true);
      try {
        const models = Object.fromEntries(Object.entries(teamModels).filter(([id, value]) => execs.includes(id) && value.trim()));
        const result = await api.workCollaborate(value, execs, {
          ...(scope ? { projectId: scope.id } : {}),
          ...(teamProfile ? { profileId: teamProfile } : {}),
          ...(Object.keys(models).length ? { models } : {}),
        });
        setCommand('');
        setActiveTicketId(null);
        setActiveGroupId(null);
        notify(`Lagent 已拆解任务，并分派给 ${execs.length} 个 Agent，开始执行。`);
        if (result.conversationId) {
          setActiveConversationId(result.conversationId);
          setProjectChatId(null);
          await refresh();
          await loadConversation(result.conversationId);
        } else if (scope && result.mainChatId) {
          openFolderChat(scope.id, result.mainChatId);
        } else {
          setActiveTicketId(result.steps?.[0]?.ticketId || null);
        }
        void refresh();
        if (scope) void reloadProjects();
      } catch (cause) { notify((cause as Error).message, true); }
      setSending(false);
      return;
    }
    setSending(true);
    const execIds = [...new Set(chosen.map(execIdFor))];
    try {
      const created = await api.workCreateConversation({
        goal: value,
        title: value.slice(0, 60),
        ...(scope ? { projectId: scope.id } : {}),
        agentIds: execIds
      });
      const conversationId = created.conversation.id;
      const executorInputs: Record<string, unknown> = {};
      for (const id of chosen) {
        const execId = execIdFor(id);
        const input = inputFor(id, value);
        if (input) executorInputs[execId] = input;
      }
      const mode = composeMode === 'multi' ? 'multi' : 'auto';
      await api.workConversationMessage(conversationId, {
        text: value,
        mode,
        agentIds: execIds,
        ...(settingsFor(chosen) ? { settings: settingsFor(chosen) } : {}),
        ...(Object.keys(executorInputs).length ? { executorInputs } : {}),
        clientRequestId: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        autoRun: true
      });
      setCommand('');
      setActiveGroupId(null);
      setActiveTicketId(null);
      setProjectChatId(null);
      setActiveDetail(null);
      setActiveConversationId(conversationId);
      await refresh();
      await loadConversation(conversationId);
      if (scope) {
        void reloadProjects();
        notify(`已在 ${scope.name} 里新建会话，交给 ${execIds.length} 个 Agent。`);
      } else {
        notify(execIds.length > 1 ? `已让 ${execIds.length} 个 Agent 在同一会话里作答。` : '指令已提交，Agent 正在处理。');
      }
    } catch (cause) {
      // 不再回退到直接命令：外部 Agent 必须经 Lagent 会话执行，绕过会让主控失效。
      notify((cause as Error).message, true);
    }
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
  const runVerify = async () => {
    if (!detail || verifyBusy) return;
    setVerifyBusy(true);
    try {
      const result = await api.workVerifyTicket(detail.ticket.id);
      setDetail(previous => previous?.ticket.id === result.ticket.id ? { ...previous, ticket: result.ticket } : previous);
      await refresh();
      notify(result.acceptance.status === 'passed' ? '验收通过。' : '验收未通过，工单已阻塞。', result.acceptance.status !== 'passed');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setVerifyBusy(false); }
  };
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
  const open = async (id: string) => { setTrace(null); try { setDetail(await api.workTicket(id)); } catch (cause) { notify((cause as Error).message, true); } };

  useEffect(() => { writeJson(RAIL_COLLAPSED_KEY, railCollapsed); }, [railCollapsed]);

  // 右侧卡片：展开时按需取详情，拿不到就只显示列表里已有的摘要
  const toggleCard = async (ticketId: string) => {
    const next = !cardOpen[ticketId];
    setCardOpen(previous => ({ ...previous, [ticketId]: next }));
    if (!next || cardDetails[ticketId]) return;
    try {
      const full = await api.workTicket(ticketId);
      setCardDetails(previous => ({ ...previous, [ticketId]: full }));
    } catch { /* 历史工单可能已被清理，保持摘要即可 */ }
  };


  // 打开工单时它自己的卡片默认展开
  useEffect(() => {
    if (!activeTicketId) return;
    setCardOpen(previous => previous[activeTicketId] ? previous : { ...previous, [activeTicketId]: true });
  }, [activeTicketId]);

  // 首次进入直接打开最近一条会话：主页就是 Lagent 与各 Agent 的操作与思考。
  // 还没归并成会话的老数据退回打开最近工单，保证审批仍能在首屏看到。
  useEffect(() => {
    if (autoOpened.current || !work || activeTicketId || activeGroupId || activeConversationId) return;
    if (view !== 'command') return;
    if (conversations.length) {
      autoOpened.current = true;
      openConversation(conversations[0].id);
    } else if (tickets.length) {
      autoOpened.current = true;
      viewTicket(tickets[0].id);
    }
  }, [work, activeTicketId, activeGroupId, activeConversationId, view, conversations, tickets]);

  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.sa-more')) return;
      setMoreOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [moreOpen]);

  const handoffTargets = usableAgents.filter(agent => isConversationExecutor(agent.id));
  // 详情弹窗和线程内联交接共用同一份来源：优先当前弹窗，其次线程里打开的那条工单。
  const handoffSource = detail?.ticket || activeTicket;
  useEffect(() => {
    if (handoffSource?.status === 'completed' && !handoffTargets.some(agent => agent.id === handoffExecutor)) setHandoffExecutor(handoffTargets[0]?.id || '');
  }, [handoffSource?.status, handoffTargets, handoffExecutor]);
  const handoff = async () => {
    if (!handoffSource || !handoffExecutor) return;
    try {
      const text = handoffText.trim();
      const sourceDetail = detail && detail.ticket.id === handoffSource.id ? detail : activeDetail;
      const executorInput = ['codex', 'claude-code'].includes(handoffExecutor) ? { prompt: text || handoffSource.title } : undefined;
      const artifacts = [...new Set((sourceDetail?.reports || []).flatMap(report => Object.keys((report.artifacts || {}) as Record<string, unknown>)))].slice(0, 10);
      const acceptance = handoffSource.acceptance;
      const handoff = {
        summary: reportText(sourceDetail) || handoffSource.summary || '',
        artifacts,
        evidence: acceptance?.command ? [`验收${acceptance.status === 'passed' ? '通过' : '未通过'}：${acceptance.command}`] : [],
        nextSteps: text ? [text] : []
      };
      const result = await api.workAction(handoffSource.id, 'handoff', { executorId: handoffExecutor, ...(text ? { text } : {}), handoff, ...(executorInput ? { executorInput } : {}) });
      await refresh(); setDetail(await api.workTicket(result.ticket.id)); setHandoffText(''); notify('已交给下一棒 Agent。');
    } catch (cause) { notify((cause as Error).message, true); }
  };
  const [sheetBusy, setSheetBusy] = useState(false);
  // 交接单：一次编排的「谁做了什么 / 验收过没过 / 下一步」压成一页 Markdown，直接下载。
  const exportPlanSheet = async (id: string) => {
    setSheetBusy(true);
    try {
      const sheet = await api.workPlanSheet(id);
      downloadBlob(new Blob([sheet.markdown], { type: 'text/markdown;charset=utf-8' }), `lagent-handoff-${id.slice(0, 8)}.md`);
      notify('交接单已导出');
    } catch (error) {
      notify(error instanceof Error ? error.message : '导出交接单失败', true);
    } finally {
      setSheetBusy(false);
    }
  };
  const openPlan = async (id: string) => {
    try { setPlanDetail((await api.workPlan(id)).plan); }
    catch (cause) { notify((cause as Error).message, true); }
  };

  // Lagent 是固定主控：外部 Agent 只能作为协作 Agent 增删，不能被它替换掉。
  const toggleAgent = (id: string) => setSelectedAgents(previous => {
    if (id === 'model') return ['model', ...previous.filter(item => item !== 'model')];
    const collaborators = previous.filter(item => item !== 'model');
    const next = collaborators.includes(id) ? collaborators.filter(item => item !== id) : [...collaborators, id].slice(-3);
    return ['model', ...next];
  });
  // 在单 Agent 模式下点协作 Agent，隐含的意思是「改走多 Agent」，不再需要先切模式。
  const pickCollaborator = (id: string) => {
    setComposeMode('multi');
    setTeamMode(true);
    toggleAgent(id);
  };
  const switchComposeMode = (mode: 'single' | 'multi') => {
    setComposeMode(mode);
    if (mode === 'single') {
      // 单 Agent 只留 Lagent，避免上一轮选过的人被悄悄带进来。
      setSelectedAgents(['model']);
      setTeamMode(false);
      return;
    }
    setTeamMode(true);
  };

  const synthesize = async () => {
    if (!activeGroup || synthesizing) return;
    const completed = activeGroup.agentIds.filter((id, index) => !id.startsWith('win:') && groupDetails[activeGroup.ticketIds[index]]?.ticket.status === 'completed');
    if (!completed.length) { notify('还没有可汇总的 Agent 完成，暂时无法汇总。', true); return; }
    const arbiter = completed.includes(synthesisAgent) ? synthesisAgent : completed[0];
    const sections = activeGroup.agentIds.map((id, index) => {
      const text = reportText(groupDetails[activeGroup.ticketIds[index]]);
      return `【${agentLabel(id)}】\n${sliceBytes(text || '（无输出）', 3000)}`;
    });
    const prompt = sliceBytes(`你是交叉验证的汇总者。同一问题由多个 Agent 独立作答。请比较它们的结论：列出一致点、分歧点与各自依据，指出谁遗漏了什么，最后给出你的判断与建议。\n\n问题：\n${activeGroup.prompt}\n\n${sections.join('\n\n')}`, 14000);
    setSynthesizing(true);
    try {
      const { ticket } = await api.workCommand(prompt, `xc-summary-${Date.now()}`, arbiter, executorInputFor(arbiter, prompt));
      const next: CrossCheck = { ...activeGroup, synthesisTicketId: ticket.id, synthesisAgentId: arbiter };
      setCrossChecks(previous => previous.map(group => group.id === next.id ? next : group));
      await refresh();
      await loadGroupDetails([...next.ticketIds, ticket.id]);
      notify(`已让 ${executorNames[arbiter] || arbiter} 汇总交叉验证结果。`);
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setSynthesizing(false); }
  };

  // 待确认事项本身不带项目信息，按 ticketId → projectChatId 反查所属工作文件夹，弹窗里好显示是哪个项目。
  const attentionRows = useMemo(() => {
    const chatOwners = new Map<string, WorkProject>();
    for (const project of folderState.projects) for (const chat of project.chats) chatOwners.set(chat.id, project);
    return attention.map(item => {
      const ticket = tickets.find(candidate => candidate.id === item.ticketId);
      const project = ticket?.projectChatId ? chatOwners.get(ticket.projectChatId) || null : null;
      return { item, ticket, project };
    });
  }, [attention, tickets, folderState.projects]);
  const renderAttention = (items: WorkInboxItem[]) => <div className="sa-attention-list">{items.map(item => {
    const ticket = tickets.find(candidate => candidate.id === item.ticketId);
    const canRetry = ticket && ['failed', 'blocked', 'cancelled'].includes(ticket.status);
    const canVerify = ticket && ticket.verify && ['completed', 'blocked', 'failed'].includes(ticket.status);
    const evidence = approvalEvidence(ticket, { path: item.accessPath, mode: item.accessMode });
    return <article className="sa-attention" key={item.ticketId}>
      <div className="sa-attention-head">
        <span className="sa-attention-icon"><AlertTriangle size={16} /></span>
        <div>
          <strong>{item.title}</strong>
          <p>{item.question}</p>
          {item.kind === 'access' && item.accessPath && <p className="sa-attention-path">{item.accessMode === 'write' ? '写入' : item.accessMode === 'delete' ? '删除' : item.accessMode === 'command' ? '执行' : '读取'} · {item.accessPath}</p>}
        </div>
        <time>{time(item.createdAt)}</time>
      </div>
      <dl className="sa-attention-evidence" aria-label="执行前证据">
        <div><dt>会动什么</dt><dd>{evidence.touch}</dd></div>
        <div><dt>会跑什么</dt><dd><code>{evidence.run}</code></dd></div>
        <div><dt>怎么算完成</dt><dd>{evidence.done}</dd></div>
      </dl>
      {ticket?.preview?.risk && <p className="sa-attention-risk"><span className={`sa-risk sa-risk-${ticket.preview.risk}`}>{ticket.preview.risk === 'high' ? '高风险' : ticket.preview.risk === 'low' ? '低风险' : '需留意'}</span></p>}
      {ticket?.review && <div className={`sa-review-result sa-review-${ticket.review.verdict}`}>
        <ShieldCheck size={12} />
        <span>评审{reviewVerdictNames[ticket.review.verdict] || ticket.review.verdict} · {evidenceLevelNames[ticket.review.evidence?.level || 'unreviewed'] || '无证据'}</span>
        {ticket.review.failureModes?.length ? <span className="sa-review-modes">{ticket.review.failureModes.map(mode => failureModeNames[mode] || mode).join('、')}</span> : null}
      </div>}
      {ticket?.acceptance && <div className={`sa-acceptance sa-acceptance-${ticket.acceptance.status}`}>
        {ticket.acceptance.status === 'passed' ? <Check size={12} /> : <AlertTriangle size={12} />}
        <span>验收{ticket.acceptance.status === 'passed' ? '通过' : '未通过'}：{ticket.acceptance.command}{ticket.acceptance.exitCode !== undefined ? ` · 退出码 ${ticket.acceptance.exitCode}` : ''}</span>
      </div>}
      <div className="sa-attention-actions">
        {(item.options || []).map(option => <button key={option.id} type="button" className={option.action === 'approve' ? 'sa-button sa-primary' : 'sa-button'} onClick={() => void act(item.ticketId, option.action)}>{option.label}</button>)}
        {canRetry && <button type="button" className="sa-button" onClick={() => void act(item.ticketId, 'retry')}><RefreshCw size={12} />重跑</button>}
        {canVerify && <button type="button" className="sa-button" disabled={verifyBusy} onClick={async () => { try { setVerifyBusy(true); const result = await api.workVerifyTicket(item.ticketId); await refresh(); notify(result.acceptance.status === 'passed' ? '验收通过。' : '验收未通过。', result.acceptance.status !== 'passed'); } catch (cause) { notify((cause as Error).message, true); } finally { setVerifyBusy(false); } }}><ListChecks size={12} />验收</button>}
        <button type="button" className="sa-link" onClick={() => void open(item.ticketId)}>查看详情</button>
      </div>
    </article>;
  })}</div>;

  const activeAttention = activeTicketId ? attention.find(item => item.ticketId === activeTicketId) : undefined;
  const activeReports = activeDetail?.reports || [];
  // 产物只看这次工作真正留下的东西：报告里的 artifacts 字段，按名字去重。
  const inspectorArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const rows: { name: string; kind: string; at: string; bytes?: number }[] = [];
    for (const report of activeDetail?.reports || []) {
      for (const [name, value] of Object.entries(report.artifacts || {})) {
        if (seen.has(name)) continue;
        seen.add(name);
        rows.push({ name, kind: report.kind, at: report.createdAt, bytes: typeof value === 'string' ? value.length : undefined });
      }
    }
    return rows;
  }, [activeDetail]);
  // 实时过程优先用 SSE 推送的那份；刷新后从详情里补回来。
  // result 这一步就是下面的「结果」块，不在这里重复一遍。
  const liveSteps: LiveStep[] = activityOf(activeTicketId ? liveActivity[activeTicketId] : undefined, activeDetail);
  const activeResult = activeTicket?.status === 'completed' ? reportText(activeDetail) : '';
  const completedGroupAgents = activeGroup ? activeGroup.agentIds.filter((id, index) => !id.startsWith('win:') && groupDetails[activeGroup.ticketIds[index]]?.ticket.status === 'completed') : [];
  const awaitingGroupAgents = activeGroup ? activeGroup.agentIds.filter((_, index) => groupDetails[activeGroup.ticketIds[index]]?.ticket.status === 'awaiting_review') : [];
  const synthesisDetail = activeGroup?.synthesisTicketId ? groupDetails[activeGroup.synthesisTicketId] : null;
  // 复核组里每一路的过程与结论：SSE 推来的实时 activity 优先，刷新后从工单详情里补回来。
  const groupRows = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.agentIds.map((id, index) => {
      const ticketId = activeGroup.ticketIds[index];
      const detail = groupDetails[ticketId];
      const status = detail?.ticket.status || 'waiting';
      const steps = activityOf(liveActivity[ticketId], detail).map(step => ({ ...step, ticketId }));
      // 排队过的工单 createdAt 早于真正开工时间：优先取这次尝试的 startedAt，没有再用第一条活动兜底。
      const attempt = detail?.assignments?.[detail.assignments.length - 1];
      const firstAt = steps.find(step => step.at)?.at;
      return {
        id,
        ticketId,
        status,
        steps,
        output: reportText(detail).slice(0, 4000),
        startedAt: attempt?.startedAt || firstAt || detail?.ticket.createdAt,
        endedAt: terminalStatuses.includes(status) ? (attempt?.endedAt || detail?.ticket.updatedAt || steps.at(-1)?.at) : undefined
      };
    });
  }, [activeGroup, groupDetails, liveActivity]);
  // ACP 的权限请求：界面只给「允许一次 / 拒绝」，超时由执行器自动拒绝。
  const decidePermission = async (ticketId: string, requestId: string, decision: 'allow' | 'deny') => {
    try {
      await api.workPermissionDecision(ticketId, requestId, decision);
      notify(decision === 'allow' ? '已允许这次操作。' : '已拒绝这次操作。');
      if (activeGroupId) void loadGroupDetails(groupTicketIds);
      else void loadActiveTicket(ticketId);
    } catch (cause) {
      notify((cause as Error).message, true);
    }
  };
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
  const singleAvailableAgent = singleExecutor ? crossCapable.find(agent => agent.id === singleExecutor) || null : null;
  const activeProjectChat = projectChatId ? projects?.flatMap(project => project.chats).find(chat => chat.id === projectChatId) || null : null;
  // 这条任务由谁执行：输入框上方可以按任务换人，也可以多选并行；没选过就是会话默认 Agent。
  const projectChatAgentOptions = activeProjectChat
    ? [...new Set([activeProjectChat.executorId, ...newChatExecutors()])]
    : newChatExecutors();
  const activeChatAgents = activeProjectChat
    ? (() => {
        const picked = (projectChatAgents[activeProjectChat.id] || []).filter(id => projectChatAgentOptions.includes(id));
        return picked.length ? picked.slice(0, 4) : [activeProjectChat.executorId];
      })()
    : [];
  const activeChatAgent = activeChatAgents.length === 1 ? activeChatAgents[0] : '';
  const cliChoiceKey = (chatId: string, agentId: string, defaultAgentId?: string) => agentId === defaultAgentId ? chatId : `${chatId}:${agentId}`;
  const activeChatModel = activeProjectChat ? (chatModels[activeProjectChat.id] || readChatModel(activeProjectChat.id)) : { profileId: '', effort: 'default' };
  const updateActiveChatModel = (next: ChatModelChoice) => {
    if (!activeProjectChat) return;
    setChatModels(previous => ({ ...previous, [activeProjectChat.id]: next }));
    writeChatModel(activeProjectChat.id, next);
  };
  const changeChatPermission = async (next: '' | ConversationPermission) => {
    if (!activeProjectChat) return;
    setChatPermissionBusy(true);
    try {
      await api.workChatPermission(activeProjectChat.id, next);
      await reloadProjects();
      notify('这条对话的权限已更新。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setChatPermissionBusy(false); }
  };
  const isLanding = !activeTicket && !activeGroup && !projectChatId && !activeConversationId;
  // 从会话退回新对话时，落地页要回到标题处，而不是停在上一屏的滚动位置。
  useEffect(() => {
    if (isLanding) landingRef.current?.scrollTo({ top: 0 });
  }, [isLanding]);
  const starters = [
    { icon: GitBranch, title: '检查 GitHub 仓库', desc: 'CI 状态、失败的流水线与 PR', prompt: '检查 GitHub 仓库状态' },
    { icon: Globe, title: '浏览网页并总结', desc: '读取页面正文，提炼要点', prompt: '浏览网页并总结' },
    { icon: Terminal, title: '运行终端命令', desc: '只读的 git / npm / ls 检查', prompt: '运行终端命令' },
    { icon: FolderGit2, title: '跟进项目进展', desc: '读取项目简报与最近变更', prompt: '总结当前项目的进展与变更要点' },
  ];

  // 首页看板：四种状态各一列，卡片仍然指向真实的工单与会话，不新造数据结构。
  const boardDate = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
  const boardAttentionIds = new Set(attentionRows.map(row => row.item.ticketId));
  const boardRest = tickets.filter(ticket => !boardAttentionIds.has(ticket.id));
  const boardLanes = [
    { id: 'plan', title: '待规划', rows: boardRest.filter(ticket => ['waiting', 'queued'].includes(ticket.status)).slice(0, 4) },
    { id: 'run', title: '运行中', rows: boardRest.filter(ticket => ticket.status === 'working').slice(0, 4) },
    { id: 'review', title: '待你确认', rows: [] as WorkTicket[] },
    { id: 'done', title: '已完成', rows: boardRest.filter(ticket => ['completed', 'failed', 'cancelled', 'blocked'].includes(ticket.status)).slice(0, 4) },
  ];
  const runningTickets = tickets.filter(ticket => ticket.status === 'working').length;
  const boardTicketCard = (ticket: WorkTicket) => <article className="sa-bcard" key={ticket.id}>
    <div className="sa-bcard-top"><span className={`sa-bcard-dot is-${ticket.status}`} aria-hidden="true" /><Status status={ticket.status} /><time>{shortTime(ticket.updatedAt)}</time></div>
    <button type="button" className="sa-bcard-title" onClick={() => void open(ticket.id)}>{ticket.title}</button>
    <div className="sa-bcard-meta"><span>{executorNames[ticket.executor] || ticket.executor}</span>{ticket.projectChatId ? <span>项目会话</span> : null}</div>
  </article>;
  const boardAttentionCard = (row: (typeof attentionRows)[number]) => {
    const { item, ticket } = row;
    // 看板只做快速入口，完整审批留在详情页。
    const quick = Boolean(ticket);
    return <article className="sa-bcard sa-bcard-hot" key={item.ticketId}>
      <div className="sa-bcard-top"><span className="sa-bcard-flag">需要你</span>{ticket?.preview?.risk === 'high' ? <span className="sa-bcard-risk">高风险</span> : null}<time>{shortTime(item.createdAt)}</time></div>
      <button type="button" className="sa-bcard-title" onClick={() => void open(item.ticketId)}>{item.title}</button>
      <p className="sa-bcard-desc">{item.question}</p>
      <div className="sa-bcard-actions">
        {quick && (item.options || []).slice(0, 2).map(option => <button type="button" key={option.id} className={option.action === 'approve' ? 'sa-bcard-btn is-primary' : 'sa-bcard-btn'} onClick={() => void act(item.ticketId, option.action)}>{option.label}</button>)}
        <button type="button" className="sa-bcard-link" onClick={() => void open(item.ticketId)}>查看详情</button>
      </div>
    </article>;
  };

  // 右侧面板：当前这次工作里被分配到的 Agent，各自展开看过程
  const inspectorRows = activeGroup
    ? activeGroup.ticketIds.map((id, index) => ({ id, executorId: activeGroup.agentIds[index] || '' }))
    : activeTicket
      ? [{ id: activeTicket.id, executorId: activeTicket.executor }]
      : tickets.slice(0, 8).map(ticket => ({ id: ticket.id, executorId: ticket.executor }));

  const inspectorCard = (row: { id: string; executorId: string }) => {
    const listed = tickets.find(ticket => ticket.id === row.id);
    const groupEntry = groupDetails[row.id];
    const ticket = groupEntry?.ticket || (activeTicketId === row.id ? activeTicket : null) || listed;
    const detail = cardDetails[row.id] || (activeTicketId === row.id ? activeDetail : null) || groupEntry || null;
    const steps = activityOf(liveActivity[row.id], detail);
    const summary = reportText(detail as WorkTicketDetail | null);
    const open = cardOpen[row.id] === true;
    const status = ticket?.status || 'waiting';
    const recent = !activeTicketId && !activeGroup;
    return <article className={`sa-card2 ${open ? 'is-open' : ''}`} key={row.id}>
      <button type="button" className="sa-card2-head" aria-expanded={open} onClick={() => void toggleCard(row.id)}>
        <span className="sa-card2-dot" aria-hidden="true" data-status={status} />
        <span className="sa-card2-name">{recent ? (ticket?.title || agentLabel(row.executorId)) : agentLabel(row.executorId)}</span>
        <Status status={status} />
        <ChevronRight size={13} className={open ? 'open' : ''} />
      </button>
      {open && <div className="sa-card2-body">
        {recent && <p className="sa-card2-sub">{agentLabel(row.executorId)} · {shortTime(ticket?.createdAt)}</p>}
        {steps.length > 0
          ? <CompactTrace steps={steps} ticketId={row.id} />
          : !summary && <p className="sa-card2-empty">{terminalStatuses.includes(status) ? '这条记录没有留下过程。' : status === 'awaiting_review' ? '等待你确认后开始。' : 'Agent 还没有动作。'}</p>}
        {summary && <p className="sa-card2-summary">{summary.slice(0, 240)}</p>}
        <div className="sa-card2-actions">
          {status === 'awaiting_review' && <button type="button" className="sa-button sa-primary" onClick={() => void act(row.id, 'approve')}><Check size={12} />确认</button>}
          {ticket?.planId && <button type="button" className="sa-link" onClick={() => void openPlan(ticket.planId!)}>查看计划</button>}
          <button type="button" className="sa-link" onClick={() => viewTicket(row.id)}>打开对话</button>
        </div>
      </div>}
    </article>;
  };

  // ── 会话线程：一个任务一条会话，Agent 在会话内分 tab 呈现 ──
  const runStatusOf = (ticketId: string) => ticketMap.get(ticketId)?.status || conversationRunDetails[ticketId]?.ticket.status || 'waiting';
  const synthesizeTurn = async (turn: WorkConversationTurn) => {
    if (!activeConversationId || synthesizing) return;
    const completed = turn.runs.some(run => runStatusOf(run.ticketId) === 'completed');
    if (!completed) { notify('还没有完成的结论可汇总。', true); return; }
    setSynthesizing(true);
    try {
      // 汇总者固定是 Lagent 主控，服务端也会忽略其他 agentId。
      await api.workConversationSynthesize(activeConversationId, turn.id, 'model');
      await refresh();
      await loadConversation(activeConversationId);
      notify('已交给 Lagent 汇总结论。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setSynthesizing(false); }
  };
  const renderConversationTurn = (turn: WorkConversationTurn) => {
    const runs = turn.runs.map(run => {
      const ticket = ticketMap.get(run.ticketId) || null;
      const detail = conversationRunDetails[run.ticketId] || null;
      const status = ticket?.status || detail?.ticket.status || 'waiting';
      const startedAt = detail?.ticket.createdAt || ticket?.createdAt || turn.createdAt;
      const endedAt = terminalStatuses.includes(status) ? (detail?.ticket.updatedAt || ticket?.updatedAt) : undefined;
      return { run, ticket, status, startedAt, endedAt, steps: activityOf(liveActivity[run.ticketId], detail), output: reportText(detail) || ticket?.summary || '' };
    });
    // 主控的分工与最后的汇总各有独立位置，不再作为「某一路 Agent」混进标签行和结论清单。
    const displayRuns = runs.filter(row => row.run.role !== 'coordination' && row.run.ticketId !== turn.synthesisTicketId);
    const completed = displayRuns.filter(row => row.status === 'completed');
    const pending = runs.some(row => !terminalStatuses.includes(row.status));
    const collaborators = [...new Set(runs.map(row => row.run.agentId).filter(id => id !== 'model'))];
    const runName = (row: { run: WorkConversationRun }) => row.run.role === 'verify'
      ? `${agentLabel(row.run.agentId)} · 交叉验收`
      : agentLabel(row.run.agentId);
    const synthesisTicket = turn.synthesisTicketId ? ticketMap.get(turn.synthesisTicketId) : null;
    const synthesisDetail = turn.synthesisTicketId ? conversationRunDetails[turn.synthesisTicketId] : null;
    const synthesisText = reportText(synthesisDetail) || synthesisTicket?.summary || '';
    const modeNote = turn.mode === 'plan'
      ? `Lagent 把目标拆成 ${runs.length} 步，各步骤按依赖推进，结果都留在这一条会话里。`
      : turn.mode === 'review'
        ? `复核模式：同一个问题分给 ${runs.length} 路并行作答，互相看不到对方答案。`
        : turn.mode === 'multi'
          ? `多 Agent 模式：Lagent 把任务拆给 ${collaborators.length} 个协作 Agent，各自执行后互相验收，最后由 Lagent 汇总。`
          : runs.length > 1
            ? `同一个任务交给 ${runs.length} 个 Agent，各自作答后在同一会话里对比。`
            : 'Lagent 直接把任务交给这个 Agent，过程与结论都留在会话里。';
    return <section className="sa-conv-turn" key={turn.id}>
      <div className="sa-bubble-user is-prompt">{turn.prompt}</div>
      <AgentThinkingPanel
        dispatchNote={turn.mode === 'multi' ? 'Lagent 拆解分发 · 各自执行 · 交叉验收 · 最后汇总' : '并行执行 · 互不共享上下文'}
        orchestrator={{
          name: 'Lagent',
          role: turn.mode === 'plan' ? '主控 · 计划拆解' : turn.mode === 'multi' ? '主控 · 拆解分发与汇总' : '主控 · 任务规划',
          startedAt: turn.createdAt,
          endedAt: pending ? undefined : (runs.at(-1)?.endedAt || turn.createdAt),
          steps: [{ kind: 'thought', text: modeNote }],
          dispatch: displayRuns.map(row => ({ id: row.run.ticketId, name: runName(row), brand: brandOf(row.run.agentId), status: row.status, startedAt: row.startedAt, endedAt: row.endedAt })),
          summary: displayRuns.length > 1 && !pending
            ? (turn.mode === 'multi'
              ? '执行结果先过交叉验收，再由 Lagent 汇总；验收不通过的问题会写进结论。'
              : '几路结论互相印证才留用；分歧之处回到原始数据再查一遍。')
            : undefined
        }}
        agents={displayRuns.map(row => ({
          id: row.run.ticketId,
          name: runName(row),
          brand: brandOf(row.run.agentId),
          status: row.status,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          steps: row.steps,
          output: row.status === 'completed' ? row.output : ''
        }))}
        onPermission={decidePermission}
      />
      <AgentConclusionList
        rows={displayRuns.map(row => ({
          id: row.run.ticketId,
          ticketId: row.run.ticketId,
          name: runName(row),
          brand: brandOf(row.run.agentId),
          status: row.status,
          summary: row.output.replace(/\s+/g, ' ').slice(0, 160)
        }))}
        onOpen={ticketId => void open(ticketId)}
        onApprove={ticketId => void act(ticketId, 'approve')}
      />
      {turn.synthesisTicketId && <section className="sa-agent-run">
        <header className="sa-agent-head"><span className="sa-agent-avatar"><Sparkles size={16} /></span><div className="sa-agent-name"><strong>{turn.mode === 'multi' ? 'Lagent 汇总' : '交叉验证汇总'}</strong><span>{agentLabel(turn.synthesisAgentId || 'lagent')}</span></div><Status status={runStatusOf(turn.synthesisTicketId)} /></header>
        {synthesisText ? <div className="sa-result"><div className="sa-result-text">{synthesisText}</div></div> : <p className="sa-inline-note">汇总 Agent 正在比较各方结论…</p>}
        <button type="button" className="sa-link" onClick={() => void open(turn.synthesisTicketId!)}>查看汇总工单</button>
      </section>}
      {displayRuns.length > 1 && !turn.synthesisTicketId && completed.length > 0 && <div className="sa-xc-summary">
        <div><strong>{turn.mode === 'multi' ? '执行与验收完成' : '交叉验证完成'} {completed.length}/{displayRuns.length}</strong><span>{turn.mode === 'multi' ? '由 Lagent 汇总交付结果与验收问题。' : '由 Lagent 比较各结论并指出分歧。'}</span></div>
        <p className="sa-inline-note">汇总者：Lagent · 主控</p>
        <button type="button" className="sa-button sa-primary" disabled={synthesizing} onClick={() => void synthesizeTurn(turn)}>{synthesizing ? <RefreshCw size={14} className="sa-spin" /> : <Sparkles size={14} />}{synthesizing ? '汇总中…' : '汇总结论'}</button>
      </div>}
    </section>;
  };

  const conversationPage = <div className={`sa-workspace ${isLanding ? 'sa-workspace-landing' : ''}`}>
    {isLanding ? <div className="sa-landing sa-board" ref={landingRef}>
      <div className="sa-board-main">
        <header className="sa-board-head">
          <p className="sa-board-kicker">{boardDate} · 今日</p>
          <h1>今天想让我做什么？</h1>
          <p className="sa-board-sub">{attentionRows.length ? `${attentionRows.length} 件事需要你拍板` : '没有需要你拍板的事'}{runningTickets ? `，${runningTickets} 个任务在跑` : ''}。把目标写进下面的输入框，Lagent 会拆给合适的 Agent。</p>
        </header>
        <div className="sa-board-lanes">
          {boardLanes.map(lane => <section className={`sa-lane sa-lane-${lane.id}`} key={lane.id} aria-label={lane.title}>
            <header className="sa-lane-head">
              <span className="sa-lane-dot" aria-hidden="true" />
              <h2>{lane.title}</h2>
              <span className="sa-lane-count">{lane.id === 'review' ? attentionRows.length : lane.rows.length}</span>
            </header>
            <div className="sa-lane-cards">
              {lane.id === 'review'
                ? (attentionRows.length ? attentionRows.map(boardAttentionCard) : <p className="sa-lane-empty">没有需要你确认的事。</p>)
                : (lane.rows.length ? lane.rows.map(boardTicketCard) : <p className="sa-lane-empty">{lane.id === 'plan' ? '没有排队的任务。' : lane.id === 'run' ? '现在没有正在执行的任务。' : '还没有结束的任务。'}</p>)}
              {lane.id === 'plan' && <button type="button" className="sa-lane-new" onClick={() => document.getElementById('sa-command')?.focus()}>＋ 写一个目标</button>}
            </div>
          </section>)}
        </div>
        <section className="sa-picker sa-board-agents" aria-labelledby="sa-picker-title">
          <div className="sa-picker-head"><span id="sa-picker-title">Agent</span><span className="sa-picker-hint">Lagent 固定主控 · {composeMode === 'multi' ? '可加 3 个协作 Agent' : '单 Agent 模式只由 Lagent 执行'}</span></div>
          <div className="sa-picker-list">
            <button type="button" className="sa-pick on sa-pick-fixed" aria-pressed="true" aria-disabled="true" title="Lagent 负责任务拆分、分发与汇总，不能取消"><Check size={13} />Lagent · 主控</button>
            {crossCapable.filter(agent => agent.id !== 'model').map(agent => {
              const on = selectedAgents.includes(agent.id);
              return <button key={agent.id} type="button" className={`sa-pick ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => on ? toggleAgent(agent.id) : pickCollaborator(agent.id)}>{on ? <Check size={13} /> : <Plus size={13} />}{executorNames[agent.id] || agent.name}</button>;
            })}
            {windows.slice(0, 4).map(window => {
              const id = windowKey(window.handle);
              const on = selectedAgents.includes(id);
              return <button key={id} type="button" className={`sa-pick ${on ? 'on' : ''}`} title={`${window.title || window.process} · PID ${window.pid}`} aria-pressed={on} onClick={() => on ? toggleAgent(id) : pickCollaborator(id)}>{on ? <Check size={13} /> : <Terminal size={13} />}窗口 · {window.process}</button>;
            })}
            {!crossCapable.length && !windows.length && <span className="sa-pick-empty"><AlertTriangle size={13} />还没有可用 Agent，请到 Agent 页检查探测结果</span>}
          </div>
        </section>
        <section className="sa-starters sa-board-starters" aria-label="常见任务">
          {starters.map(item => <button type="button" key={item.title} className="sa-starter" onClick={() => setCommand(item.prompt)}>
            <span className="sa-starter-icon"><item.icon size={14} /></span>
            <span className="sa-starter-text"><strong>{item.title}</strong><span>{item.desc}</span></span>
          </button>)}
        </section>
        {conversations.length > 0 && <section className="sa-recent" aria-labelledby="sa-recent-title">
          <div className="sa-recent-head"><h2 id="sa-recent-title">最近的对话</h2><button type="button" className="sa-link" onClick={() => setPaletteOpen(true)}>搜索全部</button></div>
          <div className="sa-recent-list">
            {conversations.slice(0, 6).map(item => <button type="button" key={item.id} className="sa-recent-item" onClick={() => openConversation(item.id)}>
              <span className="sa-recent-dot" aria-hidden="true" data-status={item.status} />
              <span className="sa-recent-title">{item.title}</span>
              <span className="sa-recent-agents">{item.participants.map(id => agentLabel(id)).join(' / ')}</span>
              <Status status={item.status} />
              <span className="sa-recent-time">{shortTime(item.updatedAt)}</span>
            </button>)}
          </div>
        </section>}
      </div>
    </div> : activeConversationId && !activeConversation ? <div className="sa-thread">
      <div className="sa-thread-inner"><p className="sa-empty"><RefreshCw size={14} className="sa-spin" /> 正在载入会话…</p></div>
    </div> : activeConversation ? <div className="sa-thread" ref={threadRef}>
      <div className="sa-thread-inner">
        <div className="sa-chat-meta"><span>{activeConversation.projectId ? (folderState.projects.find(item => item.id === activeConversation.projectId)?.name || '工作文件夹') : 'Lagent'}</span><Status status={activeConversation.status || 'waiting'} /><span>{activeConversation.turns.length} 轮 · {activeConversation.participants.map(id => agentLabel(id)).join(' / ')}</span><time>{time(activeConversation.updatedAt)}</time>{activeConversation.ticketIds.length > 0 && <button type="button" className="sa-link" onClick={() => void open(activeConversation.ticketIds[activeConversation.ticketIds.length - 1])}>最新执行详情</button>}</div>
        <h1 className="sa-projectchat-title">{activeConversation.title}</h1>
        <p className="sa-inline-note">一个任务一条会话；选中的 Agent 在下面分 tab 呈现思考过程，结论并列比较，不各自创建对话。</p>
        {activeConversation.turns.map(renderConversationTurn)}
        {!activeConversation.turns.length && <p className="sa-empty">还没有消息。在下面描述目标，Lagent 会在这个会话里派活。</p>}
      </div>
    </div> : projectChatId && !activeTicket ? <div className="sa-thread" ref={threadRef}>
      <div className="sa-thread-inner">
        {materializeError ? <>
          <p className="sa-empty">接入这个项目对话失败：{materializeError}</p>
          <p className="sa-inline-note">如果服务刚更新过，重启或刷新后重试即可。</p>
          <button type="button" className="sa-button" onClick={() => setMaterializeTick(tick => tick + 1)}>重试</button>
        </> : <p className="sa-empty"><RefreshCw size={14} className="sa-spin" />正在把这个项目对话接入 Lagent 会话…</p>}
      </div>
    </div> : <div className="sa-thread" ref={threadRef}>
      <div className="sa-thread-inner">
        {activeGroup ? <>
          <div className="sa-bubble-user is-prompt">{activeGroup.prompt}</div>
          <AgentThinkingPanel
            orchestrator={{
              name: 'Lagent',
              role: '主控 · 任务规划',
              startedAt: activeGroup.createdAt,
              endedAt: groupRows.some(row => row.status === 'waiting' || row.status === 'queued') ? undefined : activeGroup.createdAt,
              steps: [{ kind: 'thought', text: `收到工单：「${activeGroup.prompt}」。复核模式下我不自己答，把同一个问题分给 ${activeGroup.agentIds.length} 路并行作答，互相看不到对方的答案；回来后我逐条比较，只保留互相印证的结论。` }],
              dispatch: groupRows.map(row => ({ id: row.id, name: agentLabel(row.id), brand: brandOf(row.id), status: row.status, startedAt: row.startedAt, endedAt: row.endedAt })),
              summary: '几路结论互相印证才留用；分歧之处回到原始数据再查一遍。'
            }}
            agents={groupRows.map(row => ({
              id: row.id,
              name: agentLabel(row.id),
              brand: brandOf(row.id),
              status: row.status,
              startedAt: row.startedAt,
              endedAt: row.endedAt,
              steps: row.steps,
              output: row.status === 'completed' ? row.output : ''
            }))}
            onPermission={decidePermission}
          />
          <AgentConclusionList
            rows={groupRows.map(row => ({
              id: row.id,
              ticketId: row.ticketId,
              name: agentLabel(row.id),
              brand: brandOf(row.id),
              status: row.status,
              summary: row.output.replace(/\s+/g, ' ').slice(0, 160)
            }))}
            onOpen={ticketId => void open(ticketId)}
            onApprove={ticketId => void act(ticketId, 'approve')}
          />
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
          <div className="sa-chat-meta"><span>{executorNames[activeTicket.executor] || activeTicket.executor}</span><Status status={activeTicket.status} />{activeTicket.status === 'queued' && work?.queue && <span className="sa-queue-chip" title="执行器并发已满，前面的工单结束后会自动开始">并发 {work.queue.running}/{work.queue.maxConcurrent} · 等待空位</span>}{activeTicket.preview?.risk === 'high' && <span className="sa-risk sa-risk-high">高风险</span>}{activeTicket.verify && <span className={`sa-verify-chip sa-verify-${activeTicket.acceptance?.status || 'pending'}`}>{activeTicket.acceptance?.status === 'passed' ? '验收通过' : activeTicket.acceptance?.status === 'failed' ? '验收失败' : '待验收'}</span>}<time>{time(activeTicket.updatedAt)}</time>{activeTicket.planId && <button type="button" className="sa-link" onClick={() => void openPlan(activeTicket.planId!)}>计划第 {(activeTicket.planStep ?? 0) + 1}/{activeTicket.planTotal ?? 0} 步</button>}</div>
          <div className="sa-bubble-user">{activeTicket.title}</div>
          {activeAttention && <div className="sa-thread-attention">{renderAttention([activeAttention])}</div>}
          <section className="sa-agent-run">
            <header className="sa-agent-head"><span className="sa-agent-avatar"><Bot size={16} /></span><div className="sa-agent-name"><strong>{executorNames[activeTicket.executor] || activeTicket.executor}</strong><span>{activeTicket.source} · {time(activeTicket.createdAt)}</span></div><Status status={activeTicket.status} /></header>
            {activeReports.length > 0 ? <ol className="sa-activity">{activeReports.map(report => {
              const Icon = reportIcon(report);
              return <li key={report.id}><span className={`sa-activity-icon sa-activity-${report.kind}`}><Icon size={13} /></span><div><p>{report.summary || report.kind}</p><time>{time(report.createdAt)}</time></div></li>;
            })}</ol> : <p className="sa-inline-note">{terminalStatuses.includes(activeTicket.status) ? '这条工单没有执行记录。' : 'Agent 正在思考并准备执行…'}</p>}
            {liveSteps.length > 0 && <ol className="sa-live-steps" aria-live="polite" aria-label="执行过程">{liveSteps.map((step, index) => {
              if (step.kind === 'permission') {
                const decided = step.decided === 'allow' || step.decided === 'deny' ? step.decided : null;
                return <li key={`${index}-${step.at || ''}`} className={`sa-live-step sa-live-permission${decided ? ' is-decided' : ''}`}>
                  <span className="sa-live-icon"><ShieldCheck size={12} /></span>
                  <div><p>{step.text}</p>{step.detail && <span className="sa-live-detail">{step.detail}</span>}
                    {decided
                      ? <span className="sa-live-permission-state">{decided === 'allow' ? '已允许' : '已拒绝'}</span>
                      : <span className="sa-live-permission-actions">
                        <button type="button" className="sa-button sa-primary" disabled={!step.requestId} onClick={() => step.requestId && void decidePermission(activeTicket.id, step.requestId, 'allow')}>允许一次</button>
                        <button type="button" className="sa-button" disabled={!step.requestId} onClick={() => step.requestId && void decidePermission(activeTicket.id, step.requestId, 'deny')}>拒绝</button>
                      </span>}
                  </div>
                </li>;
              }
              const Icon = step.kind === 'tool' ? Wrench : step.kind === 'observation' ? Terminal : step.kind === 'error' ? AlertTriangle : Check;
              return <li key={`${index}-${step.at || ''}`} className={`sa-live-step sa-live-${step.kind}`}>
                <span className="sa-live-icon"><Icon size={12} /></span>
                <div><p>{step.text}</p>{step.detail && <span className="sa-live-detail">{step.detail}</span>}</div>
              </li>;
            })}</ol>}
            {!terminalStatuses.includes(activeTicket.status) && !['awaiting_review', 'blocked', 'waiting'].includes(activeTicket.status) && liveSteps.length === 0 && <div className="sa-thinking"><span className="sa-thinking-dot" /><span className="sa-thinking-dot" /><span className="sa-thinking-dot" /><span>Agent 正在工作，完成后结果会出现在这里</span></div>}
            {activeResult && <div className="sa-result"><h3><Check size={14} />结果</h3><div className="sa-result-text">{activeResult.slice(0, 12000)}</div></div>}
            <div className="sa-run-actions">
              {activeTicket.status === 'awaiting_review' && <button className="sa-button sa-primary" onClick={() => void act(activeTicket.id, 'approve')}><Check size={15} />确认继续</button>}
              {activeTicket.status === 'awaiting_review' && <button className="sa-button" onClick={() => void act(activeTicket.id, 'reject')}>要求修改</button>}
              {['working', 'queued', 'waiting'].includes(activeTicket.status) && <button className="sa-button" onClick={() => void act(activeTicket.id, 'stop')}><Square size={14} />停止</button>}
              {['failed', 'blocked', 'cancelled'].includes(activeTicket.status) && <button className="sa-button" onClick={() => void act(activeTicket.id, 'retry')}><RefreshCw size={14} />重试</button>}
              {Boolean(activeTicket.planId) && ['failed', 'blocked'].includes(activeTicket.status) && <button className="sa-button" onClick={() => void act(activeTicket.id, 'skip')}>跳过这步</button>}
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
    <div className="sa-composer-dock">
      {(() => {
        const collaborators = selectedAgents.filter(id => id !== 'model');
        const suggestion = lagentOnlySuggestion({
          text: command,
          collaborators,
          mode: composeMode === 'multi' ? 'multi' : 'auto',
          hasProject: Boolean(newFolder || activeConversation?.projectId || folderState.projectId)
        });
        const key = `${command}|${collaborators.join(',')}|${composeMode}`;
        if (!suggestion.suggestLagentOnly || dismissedSuggestion === key) return null;
        return <div className="sa-lagent-suggestion" role="note">
          <Sparkles size={14} />
          <p><strong>这件事可以只用 Lagent。</strong>{suggestion.reason}</p>
          <div>
            <button type="button" className="sa-button sa-primary" onClick={() => { switchComposeMode('single'); setDismissedSuggestion(key); }}>仅用 Lagent</button>
            <button type="button" className="sa-link" onClick={() => setDismissedSuggestion(key)}>仍交给协作 Agent</button>
          </div>
        </div>;
      })()}
      <form className="sa-composer" onSubmit={event => { event.preventDefault(); void send(); }}>
        {!projectChatId && <div className="sa-compose-modes" role="group" aria-label="派活方式">
          <button type="button" className={composeMode === 'single' ? 'active' : ''} aria-pressed={composeMode === 'single'} onClick={() => switchComposeMode('single')} title="只由 Lagent 理解、执行并交付">单 Agent</button>
          <button type="button" className={composeMode === 'multi' ? 'active' : ''} aria-pressed={composeMode === 'multi'} onClick={() => switchComposeMode('multi')} title="Lagent 拆解并分发，协作 Agent 执行后互相验收，最后由 Lagent 汇总">多 Agent</button>
        </div>}
        {!lagentReady && <div className="sa-lagent-blocked" role="alert">
          <AlertTriangle size={14} />
          <p>{lagentState?.reason || 'Lagent 尚未配置模型，外部 Agent 不能绕过主控。'}</p>
          <button type="button" className="sa-button sa-primary" onClick={() => setView('settings')}>去设置模型</button>
        </div>}
        {projectChatId && activeProjectChat && <div className="sa-agent-picks" role="group" aria-label="这条任务由哪些 Agent 执行">
          <span className="sa-picks-label">Agent</span>
          {projectChatAgentOptions.length ? projectChatAgentOptions.map(id => {
            const on = activeChatAgents.includes(id);
            // 第一次点某个 Agent 是「换成它」；已经手动选过之后再点，就是加人并行（最多 4 个）。
            return <button key={id} type="button" className={`sa-agent-pick ${on ? 'on' : ''}`} aria-pressed={on} title="可多选：同一条任务会并行交给多个 Agent" onClick={() => setProjectChatAgents(previous => {
              const stored = previous[activeProjectChat.id];
              if (!stored?.length) return { ...previous, [activeProjectChat.id]: [id] };
              const next = stored.includes(id)
                ? (stored.length > 1 ? stored.filter(item => item !== id) : stored)
                : (stored.length >= 4 ? stored : [...stored, id]);
              return { ...previous, [activeProjectChat.id]: next };
            })}>{on ? <Check size={12} /> : <Plus size={12} />}{executorNames[id] || id}</button>;
          }) : <span className="sa-inline-note">没有可用 Agent</span>}
          <span className="sa-compose-hint">可多选 · 最多 4 个 · 每条任务都能换</span>
        </div>}
        {composeMode === 'multi' && !projectChatId && <div className="sa-agent-picks" role="group" aria-label="选择协作 Agent">
          <span className="sa-picks-label">协作</span>
          <button type="button" className="sa-agent-pick on sa-agent-fixed" aria-pressed="true" aria-disabled="true" title="Lagent 负责拆分、分发与汇总"><Check size={12} />Lagent · 主控</button>
          {crossCapable.filter(agent => agent.id !== 'model').map(agent => <button key={agent.id} type="button" className={`sa-agent-pick ${selectedAgents.includes(agent.id) ? 'on' : ''}`} aria-pressed={selectedAgents.includes(agent.id)} onClick={() => toggleAgent(agent.id)}>{selectedAgents.includes(agent.id) ? <Check size={12} /> : <Plus size={12} />}{executorNames[agent.id] || agent.name}</button>)}
          {windows.slice(0, 4).map(window => {
            const id = windowKey(window.handle);
            const on = selectedAgents.includes(id);
            return <button key={id} type="button" className={`sa-agent-pick ${on ? 'on' : ''}`} title={`${window.title || window.process} · PID ${window.pid}`} aria-pressed={on} onClick={() => toggleAgent(id)}>{on ? <Check size={12} /> : <Plus size={12} />}窗口 · {window.process}</button>;
          })}
          <span className="sa-compose-hint">Lagent 固定主控 · 最多 3 个协作 Agent</span>
        </div>}
        {isLanding && folderState.projects.length > 0 && <div className="sa-scope">
          <FolderGit2 size={13} />
          <label htmlFor="sa-scope-select">工作文件夹</label>
          <select id="sa-scope-select" value={newFolder} onChange={event => setNewFolder(event.target.value)} aria-label="选择工作文件夹">
            <option value="">不使用（在软件内执行）</option>
            {sortedFolders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <span className="sa-scope-hint">{newFolder ? 'Agent 会在这个目录里读写文件，工单仍需你确认' : work?.workspace ? `不选则在 ${work.workspace} 里读写文件` : '选择一个文件夹，Agent 才能改项目里的文件'}</span>
        </div>}
        {composeMode === 'multi' && selectedAgents.length > 1 && <div className="sa-team">
          <span className="sa-team-toggle"><Sparkles size={12} />Lagent 统筹 · 拆解 / 分发 / 汇总</span>
          <select className="sa-team-select" value={teamProfile} onChange={event => setTeamProfile(event.target.value)} aria-label="Lagent 使用的模型">
            <option value="">{teamProfiles.length ? '默认模型' : '尚未配置模型'}</option>
            {teamProfiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          {!teamProfiles.length && <span className="sa-team-hint">还没有模型配置，Lagent 会先按本地规则拆解。</span>}
          {selectedAgents.filter(id => !id.startsWith('win:')).length > 0 && <details className="sa-team-models">
            <summary>分配模型</summary>
            <div className="sa-team-model-list">
              {selectedAgents.filter(id => !id.startsWith('win:')).map(id => <label key={id}>
                <span>{executorNames[id] || id}</span>
                <input value={teamModels[id] || ''} onChange={event => setTeamModels(previous => ({ ...previous, [id]: event.target.value }))} placeholder="留空用该 CLI 自己的模型" aria-label={`${executorNames[id] || id} 使用的模型`} />
              </label>)}
            </div>
          </details>}
          <button type="button" className="sa-link" onClick={() => setPlanOpen(true)}>手动编排多步计划</button>
        </div>}
        <textarea id="sa-command" value={command} maxLength={3000} onChange={event => setCommand(event.target.value)} onKeyDown={event => { if (event.key !== 'Enter') return; if (event.nativeEvent.isComposing) return; if (event.shiftKey || event.altKey) return; event.preventDefault(); void send(); }} rows={2} placeholder={projectChatId ? '回复这个项目对话，例如：先跑一遍测试，再修失败项' : activeConversationId ? '继续这个会话，或换一组 Agent 再问一轮…' : composeMode === 'multi' ? '描述目标，Lagent 会拆解、分派，并让协作 Agent 互相验收' : '描述目标，仅由 Lagent 完成，例如：检查仓库 CI 并修复失败项'} />
        {!projectChatId && singleExecutor === 'terminal' && <div className="sa-executor-fields"><label className="sa-field"><span>程序</span><select value={terminalProgram} onChange={event => setTerminalProgram(event.target.value)}><option value="git">git</option><option value="npm">npm</option><option value="ls">ls</option><option value="pwd">pwd</option></select></label><label className="sa-field"><span>参数</span><input value={terminalArgs} onChange={event => setTerminalArgs(event.target.value)} placeholder="status --short" /></label></div>}
        {!projectChatId && singleExecutor === 'browser' && <div className="sa-executor-fields"><label className="sa-field"><span>页面地址</span><input type="url" value={browserUrl} onChange={event => setBrowserUrl(event.target.value)} placeholder="https://example.com/page" /></label></div>}
        {!projectChatId && singleExecutor === 'github' && <div className="sa-executor-fields"><label className="sa-field"><span>GitHub 动作</span><select value={githubAction} onChange={event => setGithubAction(event.target.value)}><option value="repo">仓库</option><option value="issues">Issues</option><option value="pulls">Pull Requests</option><option value="checks">CI Checks</option><option value="file">文件</option></select></label><label className="sa-field"><span>owner</span><input value={githubOwner} onChange={event => setGithubOwner(event.target.value)} placeholder="acme" /></label><label className="sa-field"><span>repo</span><input value={githubRepo} onChange={event => setGithubRepo(event.target.value)} placeholder="lagent" /></label>{['issues', 'pulls', 'checks'].includes(githubAction) && <label className="sa-field"><span>编号</span><input inputMode="numeric" value={githubNumber} onChange={event => setGithubNumber(event.target.value)} placeholder="7" /></label>}{githubAction === 'file' && <label className="sa-field"><span>文件路径</span><input value={githubPath} onChange={event => setGithubPath(event.target.value)} placeholder="docs/readme.md" /></label>}</div>}
        <div className="sa-composer-foot">
          <div className="sa-chips sa-composer-tools">
            {!projectChatId && composeMode === 'single' && (() => {
              // 主控的模型/强度始终可选；有 CLI 协作者时再并排显示它自己的模型。
              const collaborator = selectedAgents.find(id => id !== 'model' && !id.startsWith('win:') && agents.find(agent => agent.id === id)?.kind === 'cli');
              if (!selectedAgents.includes('model') && !collaborator) return null;
              return <>
                {selectedAgents.includes('model') && <ChatModelPicker chatId={COMPOSER_KEY} value={composerModel} onChange={saveComposerModel} disabled={sending} />}
                {collaborator && <CliModelPicker executorId={collaborator} executorName={executorNames[collaborator] || collaborator} value={cliChoiceOf(collaborator)} onChange={next => saveCliChoice(collaborator, next)} disabled={sending} />}
                <label className="sa-chip" title="这次对话的工作权限">
                  <ShieldCheck size={12} />
                  <span>权限</span>
                  <select value={composerPermission} disabled={sending} aria-label="这次对话的工作权限" onChange={event => saveComposerPermission(event.target.value as ConversationPermission)}>
                    {(Object.keys(PERMISSION_LABELS) as ConversationPermission[]).map(value => <option key={value} value={value}>{PERMISSION_LABELS[value]}</option>)}
                  </select>
                </label>
              </>;
            })()}
            {projectChatId && activeProjectChat && activeChatAgent && (activeChatAgent === 'model' || agents.find(agent => agent.id === activeChatAgent)?.kind === 'cli') && (activeChatAgent === 'model'
              ? <ChatModelPicker chatId={activeProjectChat.id} value={activeChatModel} onChange={updateActiveChatModel} disabled={sending} />
              : <CliModelPicker executorId={activeChatAgent} executorName={executorNames[activeChatAgent] || activeChatAgent} value={cliChoiceOf(cliChoiceKey(activeProjectChat.id, activeChatAgent, activeProjectChat.executorId))} onChange={next => saveCliChoice(cliChoiceKey(activeProjectChat.id, activeChatAgent, activeProjectChat.executorId), next)} disabled={sending} />)}
            {projectChatId && activeProjectChat && <label className={`sa-chip${activeProjectChat.permission ? ' is-local' : ''}`} title="只影响这条对话；跟随设置表示使用全局权限档位">
              <ShieldCheck size={12} />
              <span>权限</span>
              <select value={activeProjectChat.permission || ''} disabled={chatPermissionBusy || sending} aria-label="这条对话的工作权限" onChange={event => void changeChatPermission(event.target.value as '' | ConversationPermission)}>
                <option value="">跟随设置</option>
                {(Object.keys(PERMISSION_LABELS) as ConversationPermission[]).map(value => <option key={value} value={value}>{PERMISSION_LABELS[value]}</option>)}
              </select>
            </label>}
            {!projectChatId && <span className="sa-compose-hint">{composeMode === 'multi' ? 'Lagent 拆解 · 协作执行 · 互相验收 · Lagent 汇总' : '只由 Lagent 理解、执行并交付'}</span>}
          </div>
          <button className="sa-send" type="submit" disabled={!command.trim() || sending || !lagentReady} aria-label={composeMode === 'multi' ? '拆解并派发' : '发送指令'} title={lagentReady ? undefined : '请先配置 Lagent 模型'}>{sending ? <RefreshCw size={16} className="sa-spin" /> : composeMode === 'multi' ? <Users size={16} /> : <Send size={16} />}<span>{sending ? '提交中' : !lagentReady ? '先配置模型' : composeMode === 'multi' ? '拆解并派发' : '发送'}</span></button>
        </div>
      </form>
      <p className="sa-note"><ShieldCheck size={14} />{composeMode === 'multi' ? '多 Agent 模式由 Lagent 先拆解分发，协作 Agent 完成后互相验收，最后统一汇总；会消耗对应执行器的额度。' : '单 Agent 模式只由 Lagent 完成，不会调用其他执行器。'}<span className="sa-keyhint">Enter 发送 · Shift + Enter 换行</span></p>
    </div>
  </div>;

  const dshWindow = windows.find(window => /deepseek/i.test(`${window.process} ${window.title}`));
  const windowFallbackFor = (provider: { id: string; name: string }) => /deepseek/i.test(`${provider.id} ${provider.name}`) && dshWindow
    ? `已检出运行中的「${dshWindow.process}」窗口，无需安装 ACP：在左下角选择「窗口 · ${dshWindow.process}」即可直接发送指令。`
    : '';
  const providerIcon = (id: string) => /desktop|dsh/.test(id) ? <AppWindow size={18} /> : /acp/.test(id) ? <Bot size={18} /> : <Terminal size={18} />;
  const providerKind = (provider: { id: string; kind?: string }) => provider.kind === 'desktop' ? '桌面版' : provider.id.endsWith('-acp') ? 'ACP' : 'CLI';
  const enabledExecutors = policy?.allowedExecutors || work?.policy?.allowedExecutors || [];
  const sortedProviders = [...providers].sort((left, right) => Number(right.installed) - Number(left.installed));
  const installedProviders = sortedProviders.filter(provider => provider.installed);
  const missingProviders = sortedProviders.filter(provider => !provider.installed);
  // 内置的模型 Agent 不是本机 CLI，探测列表里永远没有它，单独渲染一行
  const modelAgentStatus = agents.find(agent => agent.id === 'model')?.status || 'needs_setup';
  const capabilityLabel: Record<string, string> = { reads: '读', writes: '写', commands: '命令', browser: '浏览器', github: 'GitHub', summarize: '总结', parallelSafe: '可并行' };
  const providerRow = (provider: typeof providers[number]) => {
    const executorId = provider.executorId || '';
    const switchable = Boolean(executorId) && provider.installed;
    const enabled = switchable && enabledExecutors.includes(executorId);
    const brand = brandOf(provider.id);
    const capabilities = agents.find(agent => agent.id === executorId)?.capabilities || [];
    return <li className={`sa-agent-row${enabled ? ' is-on' : ''}${provider.installed ? '' : ' is-off'}`} key={provider.id}>
      <span className="sa-agent-glyph">
        {brand?.icon
          ? <img className={`sa-brand-img${brand.mono ? ' sa-brand-mono' : ''}`} src={`/brands/${brand.icon}`} alt="" aria-hidden="true" />
          : brand
            ? <span className="sa-brand-text" style={{ background: brand.bg }}>{brand.text}</span>
            : providerIcon(provider.id)}
        <i className="sa-agent-term" aria-hidden="true">&gt;_</i>
      </span>
      <div className="sa-agent-main">
        <div className="sa-agent-line"><strong>{provider.name}</strong><span className="sa-agent-kind">{providerKind(provider)}</span>{provider.version ? <span className="sa-agent-ver">{provider.version}</span> : null}</div>
        {provider.command ? <p className="sa-agent-path" title={provider.command}>{provider.command}</p> : null}
        {capabilities.length > 0 && <div className="sa-agent-caps">{capabilities.slice(0, 5).map(capability => <span key={capability}>{capabilityLabel[capability] || capability}</span>)}</div>}
        {(provider.status !== 'ready' || provider.kind === 'desktop') && provider.message ? <p className="sa-agent-note-line">{provider.message.replace(/^未找到命令[^；;]*[；;]\s*/, '')}{!/窗口/.test(provider.message) && windowFallbackFor(provider) ? ` ${windowFallbackFor(provider)}` : ''}</p> : null}
      </div>
      <div className="sa-agent-side">
        <Status status={provider.status} />
        {executorId ? <button type="button" role="switch" aria-checked={enabled} aria-label={`${provider.name} 开关`} className={`sa-switch${enabled ? ' on' : ''}`} disabled={!switchable || executorBusy === executorId} onClick={() => void setExecutorEnabled(executorId, !enabled)}><span /></button> : <span className="sa-agent-tag">仅识别</span>}
      </div>
    </li>;
  };
  // 档案里 Agent 和工具分开列：终端、浏览器、GitHub 是被 Agent 调用的能力，
  // 既不能当协作方派出去，也不该按「成功率 / tokens」这套同事指标去衡量。
  const agentRoster = roster.filter(entry => entry.category !== 'tool');
  const rosterCard = (entry: typeof roster[number]) => <article className="sa-roster-card" key={entry.id}>
    <header><strong>{entry.name}</strong><Status status={entry.health === 'available' ? 'available' : entry.health} /></header>
    <p>{entry.bestFor}{entry.permissions.allowed ? '' : ' · 未启用'}</p>
    <div className="sa-roster-stats">
      {entry.category === 'tool'
        ? <>
          <span>调用 {entry.reliability.finished}</span>
          <span>{entry.permissions.allowed ? '已启用' : '未启用'}</span>
          <span>最近 {entry.lastUsedAt ? shortTime(entry.lastUsedAt) : '未使用'}</span>
        </>
        : <>
          <span>成功率 {entry.reliability.successRate === null ? '—' : `${Math.round(entry.reliability.successRate * 100)}%`}</span>
          <span>完成 {entry.reliability.finished}</span>
          <span>平均 {entry.costProfile.avgTokens.toLocaleString()} tokens</span>
          <span>最近 {entry.lastUsedAt ? shortTime(entry.lastUsedAt) : '未使用'}</span>
        </>}
    </div>
  </article>;
  const agentsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">执行者</p><h1>团队</h1><p>本机 Agent、能力边界与开关；停用的 Agent 不会出现在新对话的选择里。</p></div>
    <button type="button" className="sa-button" disabled={providersLoading} onClick={() => void loadProviders(true)}>{providersLoading ? '探测中…' : '重新探测'}</button></header>
    {agentRoster.length > 0 && <section className="sa-roster">
      <div className="sa-agent-group"><h2>Agent 档案</h2><span>能被派进对话、自己完成目标的同事；成功率、用量与擅长任务来自历史工单</span></div>
      <div className="sa-roster-grid">{agentRoster.map(rosterCard)}</div>
    </section>}
    <section className="sa-roster">
      <div className="sa-agent-group"><h2>团队模板</h2><span>角色与权限预设，派活时一键套用</span></div>
      {teamTemplates.length > 0 && <div className="sa-roster-grid">{teamTemplates.map(template => <article className="sa-roster-card" key={template.id}>
        <header><strong>{template.name}</strong><button type="button" className="sa-link" onClick={() => void deleteTeamTemplate(template.id)}>删除</button></header>
        <p>{template.roles.map(role => `${role.role}：${executorNames[role.executorId] || role.executorId}（${role.permissions}）`).join(' · ')}</p>
        <div className="sa-roster-stats"><span>默认模式 {template.defaultMode}</span><span>{template.roles.length} 个角色</span></div>
      </article>)}</div>}
      <div className="sa-plan-actions-inline"><button type="button" className="sa-button" onClick={() => void createTeamTemplate()}>用当前 Agent 生成模板</button></div>
    </section>
    <section className="sa-providers">
      <p className="sa-inline-note"><ShieldCheck size={13} />按 PATH / PATHEXT 解析命令并读取版本，探测结果不会保存输出原文；开关写入执行器策略，停用的 Agent 不会出现在新对话的选择里。</p>
      {work?.externalExecutors === false && <p className="sa-policy-alert"><AlertTriangle size={14} />服务未开启外部执行器总开关，这里的 CLI/ACP 开关虽然能打开，派任务时仍会被拒绝。请设置 <code>LAGENT_ALLOW_EXTERNAL_EXECUTORS=1</code> 后重启服务；用「启动 Lagent.cmd」或 <code>npm run dev</code> 启动会自动开启。</p>}
      <div className="sa-agent-group"><h2>内置</h2><span>不用安装，用「规划设置」里的默认模型运行</span></div>
      <ul className="sa-agent-list">
        <li className={`sa-agent-row${enabledExecutors.includes('model') ? ' is-on' : ''}${modelAgentStatus === 'available' ? '' : ' is-off'}`}>
          <span className="sa-agent-glyph"><img className="sa-brand-img" src="/favicon.svg" alt="" aria-hidden="true" /></span>
          <div className="sa-agent-main">
            <div className="sa-agent-title"><strong>Lagent</strong>{' '}<Status status={modelAgentStatus} /></div>
            <span className="sa-agent-path">Lagent 本体：模型 + 工具循环，读文件、搜代码、跑命令</span>
            <span className="sa-agent-note-line">{modelAgentStatus === 'available' ? '已在「规划设置」里选好默认模型，可以直接派任务。' : '还没配置可用的模型：先去「设置 → 规划设置」选一个默认模型。'}</span>
          </div>
          <div className="sa-agent-side">
            <span className="sa-agent-kind">内置</span>
            {modelAgentStatus === 'available'
              ? <label className="sa-switch"><input type="checkbox" checked={enabledExecutors.includes('model')} disabled={executorBusy === 'model'} onChange={() => void setExecutorEnabled('model', !enabledExecutors.includes('model'))} /><span /></label>
              : <button type="button" className="sa-link" onClick={() => setSettingsOpen(true)}>去配置</button>}
          </div>
        </li>
      </ul>
      {installedProviders.length > 0 && <ul className="sa-agent-list">{installedProviders.map(providerRow)}</ul>}
      {!installedProviders.length && !providersLoading && <p className="sa-empty">还没有探测到已安装的 Agent。</p>}
      {missingProviders.length > 0 && <>
        <div className="sa-agent-group"><h2>未安装（{missingProviders.length}）</h2><span>装好后点「重新探测」即可打开开关</span></div>
        <ul className="sa-agent-list">{missingProviders.map(providerRow)}</ul>
      </>}
      {!providers.length && !providersLoading && <p className="sa-empty">尚未探测到本机 Agent。</p>}
      <p className="sa-inline-note">可选 ACP 入口：<code>npm i -g @agentclientprotocol/claude-agent-acp</code>（Claude Code）、<code>npm i -g dsh-acp</code>（DeepSeek Harness）。内置工具（受控终端 / 浏览器 / GitHub）在<button type="button" className="sa-link" onClick={() => setView('tools')}>工具页</button>管理。</p>
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

  const toolsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">本机能力</p><h1>工具</h1><p>工具由 Agent 调用，不能单独在对话里发起协作；状态一览，启用或停用统一在「设置 → 执行器策略」里调整。</p></div></header><div className="sa-card-grid">{tools.map(tool => {
    const enabled = (policy?.allowedExecutors || []).includes(tool.id);
    return <article className="sa-card" key={tool.id}><div className="sa-card-icon">{toolIcon(tool.id)}</div><div className="sa-card-title"><h2>{tool.name}</h2><Status status={tool.status} /></div><p className="sa-mono">{tool.id === 'terminal' ? '命令执行' : tool.id === 'browser' ? '网页读取' : tool.id === 'github' ? '仓库检索' : '受控工具'}</p><div className="sa-tags">{tool.permissions.map(item => <span key={item}>{item}</span>)}</div>
      {tool.id === 'github' && tool.status === 'needs_setup' && <p className="sa-inline-note">需要配置 GITHUB_TOKEN 并允许外部执行器。</p>}
      {tool.id === 'browser' && tool.status === 'needs_setup' && <p className="sa-inline-note">正在安装或缺少 Chromium。</p>}
      {tool.id === 'terminal' ? <span className="sa-tag-ok"><Check size={13} />内置可用</span> : <div className="sa-plan-actions-inline"><span className={`sa-tag ${enabled ? 'sa-tag-ok' : ''}`}>{enabled ? '已启用' : tool.status === 'needs_setup' ? '待配置' : '未启用'}</span><button className="sa-link" onClick={() => setView('settings')}>在策略中调整</button></div>}
    </article>;
  })}{!tools.length && <p className="sa-empty">工具状态载入中。</p>}</div></section>;

  const settingsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">偏好</p><h1>设置</h1><p>主题、模型与执行权限。</p></div></header><div className="sa-settings-grid"><article className="sa-card"><h2>外观与模型</h2><p>主题与显示密度，以及 Agent 使用的默认模型和凭据。</p><div className="sa-settings-actions"><button className="sa-button" onClick={() => setAppearanceOpen(true)}><SunMoon size={15} />显示设置</button><button className="sa-button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />模型与 API</button></div></article>{runtime.mode === 'cloud' && <article className="sa-card"><h2><ShieldCheck size={16} />账号与安全</h2><p>修改密码、绑定手机号，或退出当前账号。</p><div className="sa-settings-actions"><button className="sa-button" onClick={() => setAccountOpen(true)}><ShieldCheck size={15} />账号与安全</button></div></article>}<article className="sa-card sa-policy-card"><h2>执行器与权限</h2><p>与「Agent」页的开关同步，勾选即时生效；这里还可设置权限模式、预算与额外目录。外部执行器还需 <code>LAGENT_ALLOW_EXTERNAL_EXECUTORS=1</code>。</p>
    {work?.externalExecutors === false && <p className="sa-policy-alert"><AlertTriangle size={14} />服务未开启外部执行器总开关，下面勾选的 CLI/ACP Agent 不会生效。请设置 <code>LAGENT_ALLOW_EXTERNAL_EXECUTORS=1</code> 后重启服务；用「启动 Lagent.cmd」或 <code>npm run dev</code> 启动会自动开启。</p>}
    {policy ? <><div className="sa-policy-executors">{executorIds.map(id => <label key={id}><input type="checkbox" checked={(policy.allowedExecutors || []).includes(id)} disabled={executorBusy === id} onChange={() => void setExecutorEnabled(id, !(policy.allowedExecutors || []).includes(id))} />{executorNames[id]}</label>)}</div>
      <div className="sa-permissions" role="radiogroup" aria-label="权限模式">{[{ id: 'read', name: '仅查看', desc: '只能读文件、跑只读命令，不改任何东西。' }, { id: 'workspace', name: '仅工作区内修改', desc: '项目目录里直接改；目录之外、递归删除、非白名单命令会弹窗问你。' }, { id: 'full', name: '完全权限', desc: '不再逐次确认；系统目录、.git、.ssh、密钥仍然拒绝。' }].map(option => <button key={option.id} type="button" role="radio" aria-checked={(policy.permission || 'workspace') === option.id} className={`sa-permission${(policy.permission || 'workspace') === option.id ? ' is-on' : ''}`} onClick={() => setPolicy(previous => previous ? { ...previous, permission: option.id as 'read' | 'workspace' | 'full' } : previous)}><strong>{option.name}</strong><em>{option.desc}</em></button>)}</div>
      {(policy.permission || 'workspace') === 'workspace' && <label className="sa-policy-toggle"><input type="checkbox" checked={policy.limits?.confirmDanger !== false} onChange={event => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), confirmDanger: event.target.checked } } : previous)} /><span>危险操作再确认<em>递归删除、白名单外的命令，即使目录已授权也会再弹一次窗。</em></span></label>}
      <div className="sa-policy-roots">
        <div className="sa-policy-roots-head"><strong>额外授权的目录</strong><em>工作目录之外的目录。登记后里面的读写直接执行、不再逐个弹窗；最多 10 个，系统目录、.git、.ssh、密钥与 .env 始终不开放。</em></div>
        {(policy.limits?.extraRoots || []).length > 0 ? <ul className="sa-policy-root-list">{policy.limits?.extraRoots?.map(root => <li key={root}><code>{root}</code><button type="button" className="sa-link" onClick={() => removeExtraRoot(root)}>移除</button></li>)}</ul> : <p className="sa-inline-note">还没有额外目录。Lagent 碰到工作目录之外的路径时，会逐次弹窗问你。</p>}
        <div className="sa-policy-root-add"><input value={rootDraft} placeholder="D:\shared\assets" onChange={event => setRootDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addExtraRoot(); } }} /><button type="button" className="sa-button" disabled={!rootDraft.trim()} onClick={addExtraRoot}>添加目录</button></div>
      </div>
      <div className="sa-policy-budgets">
        <label>并发<input type="number" min={1} max={8} value={policy.budgets?.maxConcurrent ?? 2} onChange={event => setBudget('maxConcurrent', Number(event.target.value))} /></label>
        <label>每单调用<input type="number" min={1} max={50} value={policy.budgets?.maxCallsPerTicket ?? 12} onChange={event => setBudget('maxCallsPerTicket', Number(event.target.value))} /></label>
        <label>最长时长（毫秒）<input type="number" min={1000} max={86400000} value={policy.budgets?.maxRuntimeMs ?? 3600000} onChange={event => setBudget('maxRuntimeMs', Number(event.target.value))} /></label>
        <label>Token 上限<input type="number" min={1000} max={10000000} value={policy.budgets?.maxTokensPerTicket ?? 200000} onChange={event => setBudget('maxTokensPerTicket', Number(event.target.value))} /></label>
        <label>浏览器主机<input value={(policy.limits?.browserHosts || []).join(', ')} placeholder="example.com" onChange={event => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), browserHosts: event.target.value.split(',').map(item => item.trim()).filter(Boolean) } } : previous)} /></label>
        <label>GitHub 仓库<input value={(policy.limits?.githubRepos || []).join(', ')} placeholder="owner/repo" onChange={event => setPolicy(previous => previous ? { ...previous, limits: { ...(previous.limits || { browserHosts: [], githubRepos: [] }), githubRepos: event.target.value.split(',').map(item => item.trim()).filter(Boolean) } } : previous)} /></label>
      </div><div className="sa-policy-actions"><button className="sa-button sa-primary" disabled={policySaving} onClick={() => void savePolicy()}>{policySaving ? '保存中…' : '保存策略'}</button><span className="sa-tag-ok"><ShieldCheck size={14} />{`当前：${policy.permission === 'read' ? '仅查看' : policy.permission === 'full' ? '完全权限' : '仅工作区内修改'}`}</span></div></> : <p className="sa-empty">策略载入中…</p>}
  </article><article className="sa-card"><h2><ListChecks size={16} />工作区配置档</h2><p>把模型、思考强度、权限、预算、允许的执行器与 Library 存成命名快照；一键切换，也能恢复默认。</p>
    {work?.activeProfile?.effective ? <p className="sa-inline-note sa-tag-ok"><ShieldCheck size={13} />当前配置档：{work.activeProfile.effective.profile?.name || '已删除的配置档'} · {work.activeProfile.effective.settings.permission === 'read' ? '仅查看' : work.activeProfile.effective.settings.permission === 'full' ? '完全权限' : '仅工作区内修改'}</p> : <p className="sa-inline-note">当前使用默认工作方式。</p>}
    <div className="sa-code-note"><input value={profileName} placeholder="名称，例如：省钱模式 / 质量优先 / 只读审计" onChange={event => setProfileName(event.target.value)} /><input value={profileSkills} placeholder="Skills，逗号分隔（登记名称，会随任务上下文注入）" onChange={event => setProfileSkills(event.target.value)} /><input value={profileMcpServers} placeholder="MCP Servers，逗号分隔（登记名称）" onChange={event => setProfileMcpServers(event.target.value)} /><input value={profileInstructions} placeholder="工作约定，逗号分隔（会注入执行者；可写 [codex] 前缀只给某个 Agent）" onChange={event => setProfileInstructions(event.target.value)} /><button className="sa-button" disabled={!profileName.trim() || Boolean(profileBusy)} onClick={() => void saveProfile()}>{profileBusy === 'save' ? '保存中…' : '保存当前设置为配置档'}</button></div>
    {(work?.profiles || []).length > 0 ? <ul className="sa-mobile-devices">{work?.profiles?.map(profile => <li key={profile.id}><div><strong>{profile.name}</strong><span>{profile.settings.model || profile.settings.profileId || '默认模型'} · {profile.settings.effort || '默认强度'} · {profile.settings.permission === 'read' ? '仅查看' : profile.settings.permission === 'full' ? '完全权限' : '工作区内修改'}</span></div><span><button className="sa-link" disabled={Boolean(profileBusy)} onClick={() => void applyProfile(profile.id)}>{profileBusy === profile.id ? '应用中…' : '应用'}</button> <button className="sa-link" disabled={Boolean(profileBusy)} onClick={() => void deleteProfile(profile.id)}>删除</button></span></li>)}</ul> : <p className="sa-inline-note">还没有配置档。先调整上面的权限与模型，再保存成一套。</p>}
    <button className="sa-link" disabled={Boolean(profileBusy)} onClick={() => void resetProfile()}>恢复默认工作方式</button>
  </article><article className="sa-card"><h2><Database size={16} />加密备份与诊断</h2><p>导出项目、记忆、策略、配置档与凭据（可选），口令加密；换机后可恢复。诊断包只含版本、配置与健康信息，不含密钥和完整手机号。</p>
    <label className="field">备份口令<input type="password" value={backupPassphrase} onChange={event => setBackupPassphrase(event.target.value)} placeholder="至少 8 个字符，恢复时还要用它" autoComplete="new-password" /></label>
    <label className="sa-policy-toggle"><input type="checkbox" checked={backupIncludeCredentials} onChange={event => setBackupIncludeCredentials(event.target.checked)} /><span>包含模型凭据<em>凭据本身仍是工作区主密钥加密后的密文；换机恢复后需要相同主密钥才能使用。</em></span></label>
    <div className="sa-settings-actions"><button className="sa-button" disabled={Boolean(backupBusy)} onClick={() => void exportBackup()}>{backupBusy === 'export' ? '导出中…' : '导出加密备份'}</button><button className="sa-button" disabled={Boolean(backupBusy)} onClick={() => void exportDiagnostics()}>{backupBusy === 'diagnostics' ? '打包中…' : '导出诊断包'}</button></div>
    <div className="sa-code-note"><input type="file" accept=".lagentbackup,application/octet-stream" onChange={event => setBackupFile(event.target.files?.[0] || null)} /><button className="sa-button" disabled={!backupFile || !backupPassphrase || Boolean(backupBusy)} onClick={() => void restoreBackup()}>{backupBusy === 'restore' ? '恢复中…' : '从备份恢复'}</button></div>
    {backupLog.length > 0 && <p className="sa-inline-note">最近备份记录：{time(backupLog[0].at)} · {backupLog[0].kind} · {backupLog[0].result}{typeof backupLog[0].bytes === 'number' ? ` · ${Math.round(backupLog[0].bytes / 1024)} KB` : ''}</p>}
    <p className="sa-inline-note"><ShieldCheck size={13} />定时备份可用 <code>LAGENT_BACKUP_INTERVAL_HOURS</code>、<code>LAGENT_BACKUP_DIR</code>、<code>LAGENT_BACKUP_PASSPHRASE</code> 配置。</p>
  </article><article className="sa-card"><h2><Terminal size={16} />作用域 MCP 令牌</h2><p>给 Claude Code、Codex 等外部 Agent 一个只读、只限某项目、带有效期与预算的令牌；越权调用返回 403 并写入审计。</p>
    <div className="sa-policy-budgets">
      <label>名称<input value={scopedForm.name} onChange={event => setScopedForm(previous => ({ ...previous, name: event.target.value }))} /></label>
      <label>绑定项目<select value={scopedForm.projectId} onChange={event => setScopedForm(previous => ({ ...previous, projectId: event.target.value }))}><option value="">全部项目（可写令牌慎用）</option>{(work?.projects || projects || []).map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>有效期（天）<input type="number" min={1} max={365} value={scopedForm.ttlDays} onChange={event => setScopedForm(previous => ({ ...previous, ttlDays: Number(event.target.value) }))} /></label>
      <label>Token 预算<input type="number" min={0} value={scopedForm.budgetTokens} placeholder="0 表示不限" onChange={event => setScopedForm(previous => ({ ...previous, budgetTokens: Number(event.target.value) }))} /></label>
      <label>调用上限<input type="number" min={0} value={scopedForm.maxCalls} placeholder="0 表示不限" onChange={event => setScopedForm(previous => ({ ...previous, maxCalls: Number(event.target.value) }))} /></label>
      <label>并发上限<input type="number" min={1} max={16} value={scopedForm.maxConcurrency} onChange={event => setScopedForm(previous => ({ ...previous, maxConcurrency: Number(event.target.value) }))} /></label>
      <label>工具白名单<input value={scopedForm.tools} placeholder="留空=按只读规则；可填 work_get_ticket,..." onChange={event => setScopedForm(previous => ({ ...previous, tools: event.target.value }))} /></label>
    </div>
    <label className="sa-policy-toggle"><input type="checkbox" checked={scopedForm.readOnly} onChange={event => setScopedForm(previous => ({ ...previous, readOnly: event.target.checked }))} /><span>只读令牌<em>只读令牌只能读取工单、报告、项目记忆与验收结果。</em></span></label>
    <button className="sa-button" disabled={Boolean(scopedBusy)} onClick={() => void createScopedToken()}>{scopedBusy === 'create' ? '生成中…' : '生成作用域令牌'}</button>
    {scopedTokenRow && <div className="sa-mcp-token"><div><span>端点</span><code>{location.origin}{scopedTokenRow.endpoint}</code></div><div><span>Bearer 令牌</span><code>{scopedTokenRow.token}</code></div><p className="sa-inline-note"><ShieldCheck size={13} />明文只显示一次；有效至 {time(scopedTokenRow.record.expiresAt)}。</p></div>}
    {scopedTokens.length > 0 ? <ul className="sa-mobile-devices">{scopedTokens.map(token => <li key={token.id}><div><strong>{token.name}{token.revokedAt ? '（已撤销）' : ''}</strong><span>{token.readOnly ? '只读' : '可写'} · {token.projectId ? '绑定项目' : '全部项目'} · 调用 {token.calls}{token.maxCalls ? `/${token.maxCalls}` : ''} · Token {token.usedTokens.toLocaleString()}{token.budgetTokens ? `/${token.budgetTokens.toLocaleString()}` : ''} · 有效至 {time(token.expiresAt)}</span></div>{!token.revokedAt && <button className="sa-link" disabled={Boolean(scopedBusy)} onClick={() => void revokeScopedToken(token.id)}>撤销</button>}</li>)}</ul> : <p className="sa-inline-note">还没有作用域令牌。</p>}
  </article><article className="sa-card sa-mobile-card"><h2><Smartphone size={16} />手机指挥</h2><p>{runtime.mode === 'cloud' ? <>在手机浏览器打开 <code>{location.origin}/m</code>，输入一次性配对码即可远程查看、审批和下达指令。</> : <>本地服务只监听 <code>127.0.0.1</code>，手机无法直接访问。请使用云端账号版，或通过 HTTPS 反向代理暴露服务后打开 <code>/m</code>。</>}</p>
    {mobilePair && <div className="sa-mobile-code" role="status"><strong>{mobilePair.code}</strong><span>{mobilePairSeconds > 0 ? `${mobilePairSeconds} 秒后过期` : '已过期，请重新生成'}</span></div>}
    <button className="sa-button" disabled={mobileBusy === 'pair'} onClick={() => void createMobilePair()}>{mobileBusy === 'pair' ? <RefreshCw size={15} className="sa-spin" /> : <Smartphone size={15} />}{mobilePair ? '重新生成配对码' : '生成配对码'}</button>
    {mobileDevices.length > 0 ? <ul className="sa-mobile-devices">{mobileDevices.map(device => <li key={device.id}><div><strong>{device.name}</strong><span>配对时间 {time(device.createdAt)} · 有效至 {time(device.expiresAt)}</span></div><button className="sa-link" disabled={mobileBusy === device.id} onClick={() => void revokeMobileDevice(device.id)}>{mobileBusy === device.id ? '撤销中…' : '撤销'}</button></li>)}</ul> : <p className="sa-inline-note">还没有已配对的手机。</p>}
    <p className="sa-inline-note"><ShieldCheck size={13} />配对码 5 分钟有效且只能使用一次；设备凭证 90 天后过期。</p>
  </article><article className="sa-card sa-mobile-card"><h2><Terminal size={16} />MCP 外部 Agent</h2><p>让 Claude Code、Codex 或其他 MCP Agent 通过 <code>{location.origin}/api/mcp</code> 反向读取工单与报告、查看执行器、创建计划、发送指令和审批。</p>
    {mcpToken ? <div className="sa-mcp-token"><div><span>端点</span><code>{location.origin}{mcpToken.endpoint}</code></div><div><span>Bearer 令牌</span><code>{mcpToken.token}</code></div><p className="sa-inline-note"><ShieldCheck size={13} />令牌只显示一次，请现在复制；有效至{time(mcpToken.expiresAt)}。</p></div> : <button className="sa-button" disabled={mcpBusy} onClick={() => void createMcpToken()}>{mcpBusy ? <RefreshCw size={15} className="sa-spin" /> : <Terminal size={15} />}{mcpBusy ? '生成中…' : '生成 MCP 令牌'}</button>}
    <div className="sa-code-note"><span>Claude Code 示例</span><code>claude mcp add --transport http lagent {location.origin}/api/mcp --header "Authorization: Bearer &lt;令牌&gt;"</code></div>
  </article><WorkOpsPanel projects={projects || work?.projects || []} executors={allowedExecutors.filter(id => projectExecutorIds.includes(id) && id !== 'window')} windows={windows} notify={notify} /></div></section>;

  const runsPage = <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">编排</p><h1>运行</h1><p>深度编排的实时状态、步骤与产物。</p></div></header>
    {selectedRunId && runDetail ? <div className="sa-run-detail">
      <button type="button" className="sa-link" onClick={() => { setSelectedRunId(null); setRunDetail(null); }}><ChevronRight size={12} className="sa-rotated" />返回运行列表</button>
      <header className="sa-run-head"><h2>{runDetail.goal}</h2><Status status={runDetail.status} /><span className="sa-run-meta">{runDetail.steps.filter(s => s.status === 'done').length}/{runDetail.steps.length} 步 · {time(runDetail.createdAt)}</span></header>
      {runDetail.board.length > 0 && <div className="sa-run-board">{runDetail.board.slice(-20).map((entry, idx) => <p key={idx} className={`sa-run-board-entry sa-board-${entry.kind}`}><time>{shortTime(entry.at)}</time><span>{entry.text}</span></p>)}</div>}
      <div className="sa-run-steps">{runDetail.steps.map(step => <article key={step.index} className={`sa-run-step sa-run-step-${step.status}`}>
        <span className="sa-run-step-index">{step.index + 1}</span>
        <div><strong>{step.role}</strong><span>{step.executorId ? executorNames[step.executorId] || step.executorId : '未分配'}{step.summary ? ` · ${step.summary}` : ''}</span></div>
        <Status status={step.status} />
        {step.ticketId && <button type="button" className="sa-link" onClick={() => void open(step.ticketId!)}>查看工单</button>}
      </article>)}</div>
      {runDetail.status === 'paused' && <button type="button" className="sa-button sa-primary" onClick={async () => { try { await api.workResumeRun(runDetail.id); await loadRun(runDetail.id); await loadRuns(); notify('已尝试续跑。'); } catch (cause) { notify((cause as Error).message, true); } }}><RefreshCw size={14} />续跑</button>}
    </div> : <>
      <div className="sa-run-list">{runs.length ? runs.map(run => <article key={run.id} className="sa-card2 sa-card2-link">
        <button type="button" className="sa-card2-head" onClick={() => { setSelectedRunId(run.id); void loadRun(run.id); }}>
          <span className="sa-card2-dot" aria-hidden="true" data-status={run.status} /><span className="sa-card2-name">{run.goal}</span><Status status={run.status} /><ChevronRight size={13} />
        </button>
        <p className="sa-card2-summary">{run.kind === 'plan' ? '多步计划' : '深度编排'} · {run.steps.filter(s => s.status === 'done').length}/{run.steps.length} 步 · {run.templateLabel || '自动模板'} · {time(run.updatedAt)}</p>
      </article>) : <p className="sa-empty">还没有运行。在指挥台发起一次「深度编排」即可看到。</p>}</div>
      <div className="sa-run-usage">{usage ? <>
        <h3>近 30 天用量</h3>
        <div className="sa-usage-totals"><span><strong>{usage.totals.calls}</strong>次调用</span><span><strong>{usage.totals.totalTokens.toLocaleString()}</strong>tokens</span><span><strong>${usage.totals.costEstimate.toFixed(4)}</strong>预估</span>{usage.alerts && <span><strong>{Math.round(usage.alerts.cacheHitRate * 100)}%</strong>缓存命中</span>}</div>
        {usage.budget && <p className={`sa-inline-note ${usage.budget.warnings.length ? 'sa-stalled-note' : ''}`}>单工单 Token 预算 {usage.budget.maxTokensPerTicket.toLocaleString()} · {usage.budget.warnings.length ? `${usage.budget.warnings.length} 个工单已用 ≥80%` : '暂无接近上限的工单'}</p>}
        {usage.alerts?.topProject && <p className="sa-inline-note">最贵的项目：{projects?.find(project => project.id === usage.alerts?.topProject?.projectId)?.name || (usage.alerts.topProject.projectId || '未绑定项目')} · {usage.alerts.topProject.totalTokens.toLocaleString()} tokens</p>}
        {usage.byProject && usage.byProject.length > 0 && <div className="sa-usage-days"><h4>按项目</h4>{usage.byProject.slice(0, 5).map(row => <p key={row.projectId || 'none'}>{projects?.find(project => project.id === row.projectId)?.name || (row.projectId || '未绑定项目')} · {row.calls} 次 · {row.totalTokens.toLocaleString()} tokens</p>)}</div>}
        {usage.byExecutor.length > 0 && <div className="sa-usage-by">{usage.byExecutor.slice(0, 5).map(row => <span key={row.executorId}>{executorNames[row.executorId] || row.executorId} · {row.totalTokens.toLocaleString()} tokens{row.cacheReadTokens ? ` · 缓存 ${row.cacheReadTokens.toLocaleString()}` : ''}</span>)}</div>}
        {usage.byTicket.length > 0 && <div className="sa-usage-days"><h4>最贵的工单</h4>{usage.byTicket.slice(0, 5).map(row => <p key={row.ticketId}><code>{row.ticketId.slice(0, 8)}</code> · {executorNames[row.executorId] || row.executorId} · {row.totalTokens.toLocaleString()} tokens{row.warning ? ' · 接近预算' : ''}</p>)}</div>}
        {usage.byDay.length > 0 && <div className="sa-usage-days"><h4>按天</h4>{usage.byDay.slice(0, 7).map(row => <p key={row.date}><time>{row.date}</time> · {row.calls} 次 · {row.totalTokens.toLocaleString()} tokens</p>)}</div>}
        {usage.history && usage.history.count > 0 && <p className="sa-inline-note">已合并 {usage.history.count} 条历史会话记录（扫描 {usage.history.scanned.files} 个文件）。{usage.history.note}</p>}
        <div className="sa-settings-actions"><label className="sa-inline-note"><input type="checkbox" checked={usageHistory} onChange={event => setUsageHistory(event.target.checked)} />包含 ~/.claude 与 ~/.codex 历史会话</label><button type="button" className="sa-button" onClick={() => void loadUsage()}>刷新用量</button><button type="button" className="sa-button" onClick={() => void exportUsageCsv()}>导出 CSV</button></div>
      </> : <button type="button" className="sa-button" onClick={() => void loadUsage()}>加载用量</button>}</div>
    </>}
  </section>;

  const reportsPage = <ReportCenter projects={projects || work?.projects || []} tickets={tickets} notify={notify} onOpenConversation={openConversation} onOpenTicket={viewTicket} onRefresh={() => void load()} tab={reportTab} onTabChange={setReportTab} />;
  const page = view === 'reports' ? reportsPage : view === 'command' ? conversationPage : view === 'project' ? <ProjectsPanel mode="project" notify={notify} focusProjectId={projectFocus} focusChatId={chatFocus} onState={handleFolderState} onFocusProject={() => { setProjectFocus(null); setChatFocus(null); }} onOpenChat={openFolderChat} onBackToProjects={() => setView('projects')} allowedExecutors={projectAllowedExecutors} /> : view === 'projects' ? <ProjectsPanel mode="manage" notify={notify} focusProjectId={projectFocus} focusChatId={chatFocus} requestImport={importTick} onState={handleFolderState} onFocusProject={() => { setProjectFocus(null); setChatFocus(null); }} onOpenChat={openFolderChat} allowedExecutors={projectAllowedExecutors} /> : view === 'agents' ? agentsPage : view === 'runs' ? runsPage : view === 'tools' ? toolsPage : view === 'skills' ? <SkillsPanel projects={projects || work?.projects || []} notify={notify} /> : view === 'memory' ? <section className="sa-page"><header className="sa-page-head"><div><p className="sa-eyebrow">长期上下文</p><h1>记忆</h1><p>你确认过的偏好、术语和决定。</p></div></header><MemoryPanel /></section> : settingsPage;

  return <div className={`sa-shell ${railCollapsed ? 'sa-rail-collapsed' : ''} ${view === 'command' && inspectorOpen ? 'sa-inspector-open' : ''} ${view === 'command' ? '' : 'sa-no-inspector'}`} style={sidebarWidth ? { '--sa-sidebar': `${sidebarWidth}px` } as React.CSSProperties : undefined}>
    <a className="skip-link" href="#sa-main">跳到主内容</a>
    {navOpen && <button className="sa-nav-shade" aria-label="关闭导航" onClick={() => setNavOpen(false)} />}
    <aside className={`sa-sidebar ${navOpen ? 'sa-nav-open' : ''}`}>
      <div className="sa-edge">
        <button className="sa-brand" aria-label="Lagent 首页" title="Lagent 首页" onClick={newChat}><Logo /></button>
        <nav className="sa-nav" aria-label="主导航">
        {primaryNav.map(item => {
          const active = item.id === 'projects' ? ['project', 'projects'].includes(view) : view === item.id;
          return <button type="button" key={item.id} className={`sa-nav-item ${active ? 'active' : ''}`} aria-label={item.label} title={item.label} aria-current={active ? 'page' : undefined} onClick={() => { setView(item.id); if (item.id === 'reports') setReportTab('reports'); setNavOpen(false); setMoreOpen(false); }}>
            <item.icon size={16} /><span>{item.label}</span>{item.id === 'command' && attentionRows.length ? <span className="sa-nav-count">{attentionRows.length}</span> : null}
          </button>;
        })}
        <div className="sa-more">
          <button type="button" className={`sa-nav-item ${moreNav.some(item => item.id === view) ? 'active' : ''}`} aria-label="更多" title="更多" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(value => !value)}>
            <MoreHorizontal size={16} /><span>更多</span>
          </button>
          {moreOpen && <div className="sa-more-menu" role="menu" aria-label="更多页面">
            {moreNav.map(item => <button type="button" key={item.id} role="menuitem" className={view === item.id ? 'active' : ''} onClick={() => { setView(item.id); setMoreOpen(false); setNavOpen(false); }}>
              <item.icon size={14} /><span>{item.label}</span>
            </button>)}
          </div>}
        </div>
        </nav>
        <div className="sa-edge-foot">
          <button type="button" className="sa-icon sa-rail-toggle" aria-label={railCollapsed ? '展开侧栏' : '收起侧栏'} title={railCollapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!railCollapsed} onClick={() => setRailCollapsed(value => !value)}>
            {railCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
          <span className="sa-avatar sa-edge-avatar" title={user?.displayName || '个人工作区'}>{user?.displayName?.slice(0, 1).toUpperCase() || 'D'}</span>
        </div>
      </div>
      <div className="sa-side-panel">
        <div className="sa-side-head">
          <span className="sa-side-workspace">个人工作区</span>
          <button className="sa-icon sa-nav-close" aria-label="关闭导航" onClick={() => setNavOpen(false)}><X size={18} /></button>
        </div>
      <button className="sa-newchat" onClick={newChat}><span className="sa-newchat-label"><Plus size={16} />新对话</span></button>
      <div className="sa-side-scroll">
      <section className="sa-conv-section" aria-label="最近的对话">
        <div className="sa-side-title"><span>最近的对话</span></div>
        {conversations.length ? <div className="sa-conversations">
          {conversations.slice(0, 8).map(item => <button type="button" key={item.id} className={`sa-conv ${activeConversationId === item.id ? 'active' : ''}`} title={`${item.turnCount} 轮 · ${item.participants.map(id => agentLabel(id)).join(' / ') || 'Lagent'}`} onClick={() => openConversation(item.id)}>
            <span className="sa-conv-body"><span className="sa-conv-title">{item.title}</span></span>
          </button>)}
        </div> : <p className="sa-folder-empty">还没有对话。描述一个目标，Lagent 会在这里建第一条。</p>}
      </section>
      <section className={`sa-folders ${dropActive ? 'sa-drop-active' : ''}`} aria-label="工作文件夹"
        onDragOver={event => { if (Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); setDropActive(true); } }}
        onDragLeave={() => setDropActive(false)}
        onDrop={event => { void importDroppedFolder(event); }}>
        <div className="sa-side-title"><span>工作文件夹</span><button type="button" className="sa-side-action" aria-label="添加本地文件夹" title="添加本地文件夹（也可以把文件夹拖进来）" onClick={() => { setView('projects'); setProjectFocus(null); setChatFocus(null); setImportTick(tick => tick + 1); setNavOpen(false); }}><Plus size={13} /></button></div>
        <div className="sa-folder-list">
          {sortedFolders.length ? sortedFolders.map(item => {
            const collapsed = collapsedProjects.includes(item.id);
            const activeProject = (view === 'project' || view === 'projects') && folderState.projectId === item.id;
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
                {(() => {
                  // 团队协作的从属会话不在侧栏单列，避免一次协作刷出三四条对话。
                  const roots = item.chats.filter(entry => !entry.parentChatId);
                  if (!roots.length) return <p className="sa-folder-empty">还没有会话，点右侧 + 新建一个。</p>;
                  return roots.map(entry => {
                  const active = activeProject && folderState.chatId === entry.id;
                  if (chatRename?.chatId === entry.id) {
                    return <input key={entry.id} className="sa-chat-rename" autoFocus value={chatRename.value} aria-label="会话标题"
                      onChange={event => setChatRename({ ...chatRename, value: event.target.value })}
                      onBlur={() => void commitChatRename()}
                      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void commitChatRename(); } if (event.key === 'Escape') setChatRename(null); }} />;
                  }
                  const unread = chatUnread(entry);
                  const subs = item.chats.filter(chat => chat.parentChatId === entry.id).length;
                  const picked = pickedChats.includes(entry.id);
                  return <div className={`sa-folder-chat-row ${selectMode ? 'is-selecting' : ''} ${picked ? 'is-picked' : ''}`} key={entry.id}>
                    {selectMode && <span className="sa-check" aria-hidden="true">{picked ? <Check size={10} /> : null}</span>}
                    <button type="button" className={`sa-conv sa-conv-sub ${active ? 'active' : ''} ${unread ? 'has-unread' : ''}`} title={selectMode ? `选中「${entry.title}」` : `${executorNames[entry.executorId] || entry.executorId} · 写入 ${item.path}（双击重命名）`} aria-pressed={selectMode ? picked : undefined} onClick={() => (selectMode ? togglePick('chat', entry.id) : openFolderChat(item.id, entry.id))} onDoubleClick={event => { if (selectMode) return; event.preventDefault(); setChatRename({ projectId: item.id, chatId: entry.id, value: entry.title }); }}>
                      <span className="sa-conv-body">
                        <span className="sa-conv-title">{entry.title}{subs > 0 && <em className="sa-chat-sub">{subs} 个 Agent</em>}{unread && <em className="sa-unread" aria-label="有新的执行结果" />}</span>
                      </span>
                    </button>
                    {!selectMode && <button type="button" className="sa-folder-chat-del" aria-label={`删除对话 ${entry.title}`} title="删除对话" onClick={() => setChatToDelete({ projectId: item.id, chat: entry })}><X size={11} /></button>}
                  </div>;
                  });
                })()}
              </div>}
            </div>;
          }) : <p className="sa-folder-empty">还没有工作文件夹。添加或拖入一个目录，Agent 就在里面读写文件。</p>}
        </div>
        {dropActive && <div className="sa-drop-hint"><FolderGit2 size={16} />松开导入这个文件夹</div>}
      </section>
      </div>
      {selectMode && (
        <div className="sa-select-bar" role="region" aria-label="批量删除">
          <span>已选 {pickedTotal} 条</span>
          <button type="button" className="sa-select-cancel" onClick={exitSelect}>取消</button>
          <button type="button" className="sa-select-delete" disabled={!pickedTotal || bulkBusy} onClick={() => setBulkConfirm(true)}><Trash2 size={12} />删除所选</button>
        </div>
      )}
      <div className="sa-sidebar-foot">
        <div className="sa-user">
          <span className="sa-avatar">{user?.displayName?.slice(0, 1).toUpperCase() || 'D'}</span>
          <span><strong>{user?.displayName || '个人工作区'}</strong><small>{runtime.mode === 'cloud' ? '云端账号' : '本地运行'}</small></span>
        </div>
      </div>
      </div>
    </aside>
    <div className="sa-side-resize" role="separator" aria-orientation="vertical" aria-label="拖动调整侧栏宽度" title="拖动调整侧栏宽度，双击恢复默认" onPointerDown={startSidebarResize} onDoubleClick={() => setSidebarWidth(0)} />
    <div className="sa-main"><header className="sa-topbar"><div className="sa-breadcrumb"><button className="sa-icon sa-menu" aria-label="打开导航" onClick={() => setNavOpen(true)}><Menu size={19} /></button><span>{view === 'command' ? (activeGroup ? '交叉验证' : '个人 Agent') : '个人 Agent'}</span><ChevronRight size={12} /><strong>{view === 'command' ? activeGroup ? activeGroup.prompt : activeConversation?.title || activeTicket?.title || activeProjectChat?.title || '新对话' : current}</strong>{view === 'command' && activeGroup && <Status status={groupStatusOf(activeGroup)} />}{view === 'command' && !activeGroup && !activeTicket && activeConversation && <Status status={activeConversation.status || 'waiting'} />}{view === 'command' && activeTicket && <Status status={activeTicket.status} />}</div><div className="sa-topbar-right"><button type="button" className="sa-search-trigger" aria-label="搜索与命令" title="搜索与命令（Ctrl K）" onClick={() => setPaletteOpen(true)}><Search size={15} /><span>搜索</span><kbd>Ctrl K</kbd></button><span className="sa-connection" role="status"><span className="online-dot" />{error ? '指挥服务未连接' : runtime.mode === 'cloud' ? '云端已连接' : '本地已连接'}</span><button className="sa-icon" aria-label={appearance.resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} title={appearance.resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题'} onClick={() => appearance.setTheme(appearance.resolvedTheme === 'dark' ? 'light' : 'dark')}><SunMoon size={17} /></button></div></header>
      <main id="sa-main" className={`sa-content ${view === 'command' ? 'sa-content-chat' : ''}`}>{error && !loading ? <div className="sa-error"><AlertTriangle size={20} /><div><h2>指挥服务尚未连接</h2><p>{error}</p><button className="sa-button" onClick={() => void load()}><RefreshCw size={15} />重试</button></div></div> : loading && !work ? <div className="sa-loading"><RefreshCw size={20} className="sa-spin" /><span>正在载入指挥台…</span></div> : page}</main>
    </div>
    {view === 'command' && (inspectorOpen
      ? <aside className="sa-inspector" aria-label="工作详情">
          <header className="sa-inspector-head">
            <div><span className="sa-eyebrow">工作</span><h2>{activeGroup ? `${inspectorRows.length} 个 Agent` : activeTicket ? '工作详情' : '最近工作'}</h2></div>
            <button type="button" className="sa-icon" aria-label="收起工作详情" title="收起工作详情" onClick={() => setInspectorOpen(false)}><ChevronRight size={15} /></button>
          </header>
          <div className="sa-inspector-tabs" role="tablist" aria-label="工作详情分类">
            {([
              { id: 'inbox', label: '需要你', count: attentionRows.length },
              { id: 'run', label: '当前运行', count: tickets.filter(ticket => ticket.status === 'working').length },
              { id: 'artifacts', label: '产物', count: inspectorArtifacts.length },
            ] as const).map(tab => <button key={tab.id} type="button" role="tab" aria-selected={inspectorTab === tab.id} className={inspectorTab === tab.id ? 'active' : ''} onClick={() => setInspectorTab(tab.id)}>
              {tab.label}{tab.count ? <span className="sa-tab-count">{tab.count}</span> : null}
            </button>)}
          </div>
          <div className="sa-inspector-list">
            {inspectorTab === 'inbox' && (attentionRows.length
              ? renderAttention(attentionRows.map(row => row.item))
              : <p className="sa-inspector-empty">没有需要你确认的事。需要批准的工单会排在这里，按风险从高到低。</p>)}
            {inspectorTab === 'run' && <>
              {activeTicket && <article className="sa-card2">
                <header className="sa-card2-head"><span className="sa-card2-dot" aria-hidden="true" data-status={activeTicket.status} /><span className="sa-card2-name">{activeTicket.title}</span><Status status={activeTicket.status} /></header>
                <p className="sa-card2-summary">{executorNames[activeTicket.executor] || activeTicket.executor}{activeTicket.planId ? ` · 计划第 ${(activeTicket.planStep ?? 0) + 1}/${activeTicket.planTotal ?? 0} 步` : ''} · {activeDetail?.activity?.length ?? 0} 个动作</p>
                <button type="button" className="sa-link" onClick={() => void open(activeTicket.id)}>打开运行详情<ChevronRight size={12} /></button>
              </article>}
              {!activeTicket && (inspectorRows.length ? inspectorRows.map(inspectorCard) : <p className="sa-inspector-empty">还没有工作。在左侧描述一个目标开始。</p>)}
            </>}
            {inspectorTab === 'artifacts' && (inspectorArtifacts.length
              ? <div className="sa-inspector-artifacts">{inspectorArtifacts.map(item => <article className="sa-card2" key={`${item.name}-${item.at}`}>
                <header className="sa-card2-head"><Database size={13} /><span className="sa-card2-name">{item.name}</span></header>
                <p className="sa-card2-summary">{item.kind}{item.bytes ? ` · ${item.bytes} 字节` : ''} · {time(item.at)}</p>
              </article>)}</div>
              : <p className="sa-inspector-empty">这次运行还没有留下文件或报告。完成后产物会出现在这里。</p>)}
          </div>
          <div className="sa-dock-foot"><span>{runtime.mode === 'cloud' ? '云端运行时' : '本地运行时'}</span><span>{tickets.length} 个工单</span></div>
        </aside>
      : <button type="button" className="sa-inspector-tab" aria-label="展开工作详情" title="展开工作详情" onClick={() => setInspectorOpen(true)}>工作</button>)}
    <div className={`sa-statusbar ${error ? 'is-offline' : ''}`}>
      <span className="sa-statusbar-live"><i />{error ? '指挥服务未连接' : runtime.mode === 'cloud' ? '云端已连接' : '本地已连接'}</span>
      <span>{runtime.mode === 'cloud' ? '云端运行时' : '本地运行时'}</span>
      <span className="sa-statusbar-grow" />
      <span>{attentionRows.length} 个待确认</span>
      <span>{tickets.filter(ticket => ticket.status === 'working').length} 个运行中</span>
      <span>Ctrl K 命令面板</span>
    </div>
    {planDetail && <Modal title={planDetail.goal} subtitle={`多步计划${planDetail.autoRun ? ' · 自动执行' : ''} · ${planDetail.status === 'active' ? '进行中' : planDetail.status === 'completed' ? '已完成' : planDetail.status === 'cancelled' ? '已取消' : '已失败'} · ${planDetail.totalSteps} 步`} close={() => setPlanDetail(null)}>
      <div className="sa-plan-graph">{planDetail.steps.map(step => <div className="sa-plan-graph-step" key={step.index}>
        <span className="sa-plan-index">{step.index + 1}</span>
        <div><strong>{step.title}</strong><span>{step.executorId}{step.dependsOn?.length ? ` · 依赖 ${step.dependsOn.map(item => item + 1).join('、')}` : ' · 可并行'}</span></div>
        <Status status={step.status || 'pending'} />
      </div>)}</div>
      <div className="sa-detail-actions">
        <button type="button" className="sa-button" disabled={sheetBusy} onClick={() => void exportPlanSheet(planDetail.id)}><FileText size={14} />{sheetBusy ? '生成中…' : '导出交接单'}</button>
      </div>
    </Modal>}
    {detail && <Modal title={detail.ticket.title} subtitle={`${statusNames[detail.ticket.status] || detail.ticket.status} · ${detail.ticket.executor}`} close={() => setDetail(null)}>
      <div className="sa-detail"><p className="sa-detail-summary">{detail.ticket.summary || '暂无摘要。'}</p>{detail.ticket.status === 'queued' && work?.queue && <p className="sa-inline-note">排队中：当前并发 {work.queue.running}/{work.queue.maxConcurrent}，前面的任务结束后会自动开始。</p>}{detail.ticket.stalled && <p className="sa-inline-note sa-stalled-note"><Clock size={13} />执行器长时间没有心跳，可能已经卡死；可以停止后重试。</p>}{detail.project && <p className="sa-detail-project"><FolderGit2 size={14} /><strong>{detail.project.name}</strong>{detail.projectChat && <span>{executorNames[detail.projectChat.executorId] || detail.projectChat.executorId}{detail.projectChat.title && detail.projectChat.title !== detail.project.name ? ` · ${detail.projectChat.title}` : ''}</span>}<button type="button" className="sa-link" onClick={() => { setDetail(null); openFolder(detail.project!.id); }}>打开项目<ChevronRight size={13} /></button></p>}{detail.ticket.planId && <p className="sa-inline-note">多步计划第 {(detail.ticket.planStep ?? 0) + 1}/{detail.ticket.planTotal ?? 0} 步</p>}{detail.ticket.preview?.action && <div className="sa-preview">
          <span className={`sa-risk sa-risk-${detail.ticket.preview.risk || 'medium'}`}>{detail.ticket.preview.risk === 'high' ? '高风险' : detail.ticket.preview.risk === 'low' ? '低风险' : '需留意'}</span>
          <code>{detail.ticket.preview.action}</code>
          {detail.ticket.preview.cwd && <span className="sa-preview-path">{detail.ticket.preview.cwd}</span>}
        </div>}{detail.ticket.contract && <div className="sa-contract">
          <h3>任务契约</h3>
          {detail.ticket.contract.objective && <p><strong>目标</strong><span>{detail.ticket.contract.objective}</span></p>}
          {detail.ticket.contract.acceptance?.length ? <p><strong>验收</strong><span>{detail.ticket.contract.acceptance.join('；')}</span></p> : null}
          {detail.ticket.contract.constraints?.length ? <p><strong>约束</strong><span>{detail.ticket.contract.constraints.join('；')}</span></p> : null}
          {detail.ticket.contract.inputs?.length ? <p><strong>输入</strong><span>{detail.ticket.contract.inputs.join('；')}</span></p> : null}
        </div>}<div className="sa-trace">
          <div className="sa-trace-head"><h3>时间线</h3><button type="button" className="sa-link" onClick={() => void loadTrace(detail.ticket.id)}>{trace ? '刷新' : '加载'}</button></div>
          {trace && <>
            <p className="sa-inline-note">{trace.summary.assignments} 次执行 · {trace.summary.reports} 份报告 · {trace.summary.events} 个事件 · {trace.summary.tokens.toLocaleString()} tokens · ${trace.summary.cost.toFixed(4)}</p>
            <div className="sa-trace-spans">{trace.spans.slice(-30).map(span => <p key={`${span.kind}-${span.id}`}><time>{shortTime(span.at)}</time><span>{span.kind === 'assignment' ? `执行 ${executorNames[span.executor || ''] || span.executor || ''}${span.status ? ` · ${span.status}` : ''}` : span.kind === 'report' ? `报告 · ${span.reportKind || ''}` : span.kind === 'usage' ? `用量 · ${span.tokens || 0} tokens` : `事件 · ${span.eventType || ''}`}</span></p>)}</div>
          </>}
        </div><div className="sa-detail-actions">
        {detail.ticket.status === 'awaiting_review' && <button className="sa-button sa-primary" onClick={() => void act(detail.ticket.id, 'approve')}><Check size={15} />确认继续</button>}
        {detail.ticket.status === 'awaiting_review' && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'reject')}>要求修改</button>}
        {['working', 'queued', 'waiting'].includes(detail.ticket.status) && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'stop')}><Square size={14} />停止</button>}
        {['failed', 'blocked', 'cancelled'].includes(detail.ticket.status) && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'retry')}><RefreshCw size={14} />重试</button>}
        {Boolean(detail.ticket.planId) && ['failed', 'blocked'].includes(detail.ticket.status) && <button className="sa-button" onClick={() => void act(detail.ticket.id, 'skip')}>跳过这步，继续后面的</button>}
      </div>{detail.ticket.status === 'completed' && <section className="sa-handoff"><h3><GitBranch size={15} />交给另一个 Agent</h3>
        {detail.ticket.handoffChildId ? <div className="sa-handoff-done"><p>已交接给下一棒。</p><button className="sa-button" onClick={() => void open(detail.ticket.handoffChildId!)}>查看下一棒<ChevronRight size={14} /></button></div> : <div className="sa-handoff-form">
          <label className="sa-field"><span>目标执行器</span><select value={handoffExecutor} onChange={event => setHandoffExecutor(event.target.value)}>{handoffTargets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}{!handoffTargets.length && <option value="">没有可用执行器</option>}</select></label>
          <label className="sa-field"><span>补充说明</span><input value={handoffText} onChange={event => setHandoffText(event.target.value)} placeholder="可选：希望下一棒关注什么" /></label>
          <button className="sa-button sa-primary" disabled={!handoffExecutor} onClick={() => void handoff()}>交接</button>
        </div>}
      </section>}{detail.ticket.parentTicketId && <p className="sa-inline-note">来自上一棒工单{detail.ticket.parentTicketId.slice(0, 8)}，当前为第{detail.ticket.handoffDepth ?? 1} 棒。{detail.ticket.handoffSummary ? ` 上一棒摘要：${detail.ticket.handoffSummary}` : ''}</p>}{detail.ticket.handoff && <div className="sa-contract">
        <h3>交接简报</h3>
        {detail.ticket.handoff.summary && <p><strong>已完成</strong><span>{detail.ticket.handoff.summary}</span></p>}
        {detail.ticket.handoff.artifacts?.length ? <p><strong>产物</strong><span>{detail.ticket.handoff.artifacts.join('；')}</span></p> : null}
        {detail.ticket.handoff.evidence?.length ? <p><strong>证据</strong><span>{detail.ticket.handoff.evidence.join('；')}</span></p> : null}
        {detail.ticket.handoff.openQuestions?.length ? <p><strong>未解</strong><span>{detail.ticket.handoff.openQuestions.join('；')}</span></p> : null}
        {detail.ticket.handoff.nextSteps?.length ? <p><strong>下一步</strong><span>{detail.ticket.handoff.nextSteps.join('；')}</span></p> : null}
      </div>}{detail.ticket.verify && <section className="sa-verify">
        <div className="sa-verify-head"><h3>验收</h3><span className={`sa-verify-chip sa-verify-${detail.ticket.acceptance?.status || 'pending'}`}>{detail.ticket.acceptance?.status === 'passed' ? '通过' : detail.ticket.acceptance?.status === 'failed' ? '失败' : '待执行'}</span></div>
        <p className="sa-verify-cmd"><code>{detail.ticket.verify.command}</code><span>期望 {detail.ticket.verify.expect || 'exit=0'} · 超时 {Math.round((detail.ticket.verify.timeoutMs || 120000) / 1000)}s</span></p>
        {detail.ticket.review && <div className={`sa-review-result sa-review-${detail.ticket.review.verdict}`}>
          <ShieldCheck size={12} />
          <span>评审{reviewVerdictNames[detail.ticket.review.verdict] || detail.ticket.review.verdict} · {evidenceLevelNames[detail.ticket.review.evidence?.level || 'unreviewed'] || '无证据'}</span>
          {detail.ticket.review.failureModes?.length ? <span className="sa-review-modes">{detail.ticket.review.failureModes.map(mode => failureModeNames[mode] || mode).join('、')}</span> : null}
        </div>}
        {detail.ticket.review?.issues?.[0] && <p className="sa-inline-note">评审意见：{detail.ticket.review.issues[0].message}{detail.ticket.review.issues[0].fix ? `；${detail.ticket.review.issues[0].fix}` : ''}</p>}
        {detail.ticket.acceptance?.output && <pre className="sa-verify-output">{detail.ticket.acceptance.output.slice(-3000)}</pre>}
        <div className="sa-verify-actions"><button type="button" className="sa-button" disabled={verifyBusy || !['completed', 'blocked', 'failed'].includes(detail.ticket.status)} onClick={() => void runVerify()}>{verifyBusy ? <RefreshCw size={14} className="sa-spin" /> : <ShieldCheck size={14} />}{verifyBusy ? '验收中…' : detail.ticket.acceptance ? '重新验收' : '运行验收'}</button></div>
      </section>}<h3>执行记录</h3>{detail.reports.length ? <ol className="sa-reports">{detail.reports.map(report => <li key={report.id}><Status status={report.kind === 'ready' ? 'completed' : report.kind === 'failed' ? 'failed' : report.kind === 'blocked' ? 'blocked' : 'working'} /><div><strong>{reportKindNames[report.kind] || report.kind}</strong><p>{report.summary}</p></div><time>{time(report.createdAt)}</time></li>)}</ol> : <p className="sa-empty">还没有执行记录。</p>}
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
    {planOpen && <PlanBuilder agents={agents} allowedExecutors={allowedExecutors} windows={windows} initialGoal={command} close={() => setPlanOpen(false)} onCreated={plan => { setPlanOpen(false); setCommand(''); notify('多步计划已创建。'); void refresh().then(() => { const first = plan.steps[0]?.ticketId; if (first) viewTicket(first); }); }} />}
    {appearanceOpen && <AppearanceSettings close={() => setAppearanceOpen(false)} />}
    {settingsOpen && <SettingsModal settings={localSettings} close={() => setSettingsOpen(false)} onSaved={next => { setLocalSettings(next); onSettingsSaved(next); }} notify={notify} />}
    {accountOpen && <AccountModal close={() => setAccountOpen(false)} />}
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
    {chatToDelete && <Modal title={`删除对话「${chatToDelete.chat.title}」`} subtitle="只移除软件里的这条对话记录，Agent 端的会话文件不会被删除。" close={() => setChatToDelete(null)}>
      <div className="sa-confirm">
        <p>删除后这条对话的历史消息也会一起移除。这一步无法撤销，确认继续？</p>
        <div className="sa-confirm-actions"><button type="button" className="sa-button" onClick={() => setChatToDelete(null)}>取消</button><button type="button" className="sa-button sa-danger" onClick={() => { const target = chatToDelete; setChatToDelete(null); void removeChat(target); }}>删除对话</button></div>
      </div>
    </Modal>}
    {bulkConfirm && <Modal title={`删除选中的 ${pickedTotal} 条对话？`} subtitle="只移除软件里的记录，Agent 端的会话文件不会被删除。" close={() => setBulkConfirm(false)}>
      <div className="sa-confirm">
        <ul className="sa-confirm-list">
          {pickedChats.length > 0 && <li>工作文件夹里的 <strong>{pickedChats.length}</strong> 条会话，连同它们的历史消息与本目录内的执行记录</li>}
          {pickedTickets.length > 0 && <li><strong>{pickedTickets.length}</strong> 条独立对话，连同执行记录、报告与改动快照</li>}
        </ul>
        <p>这一步无法撤销，确认继续？</p>
        <div className="sa-confirm-actions"><button type="button" className="sa-button" onClick={() => setBulkConfirm(false)}>取消</button><button type="button" className="sa-button sa-danger" disabled={bulkBusy} onClick={() => void removePicked()}>{bulkBusy ? '正在删除…' : `删除 ${pickedTotal} 条`}</button></div>
      </div>
    </Modal>}
    {toast && <Toast message={toast.text} error={toast.error} close={() => setToast(null)} />}
  </div>;
}

type PlanStepDraft = { executorId: string; text: string; dependsOn: number[]; windowHandle: string };

function PlanBuilder({ agents, allowedExecutors, windows, initialGoal, close, onCreated }: {
  agents: { id: string; name: string; status: string }[];
  allowedExecutors: string[];
  windows: { id: string; handle: number; pid: number; process: string; title: string }[];
  initialGoal: string;
  close: () => void;
  onCreated: (plan: WorkPlan) => void;
}) {
  const targets = agents.filter(agent => allowedExecutors.includes(agent.id) && agent.status === 'available' && (['codex', 'claude-code', 'window'].includes(agent.id) || agent.id.endsWith('-acp')) && (agent.id !== 'window' || windows.length > 0));
  const defaultExecutor = targets.find(agent => agent.id === 'codex')?.id || targets[0]?.id || '';
  const [goal, setGoal] = useState(initialGoal);
  const [steps, setSteps] = useState<PlanStepDraft[]>([
    { executorId: defaultExecutor, text: initialGoal, dependsOn: [], windowHandle: '' },
    { executorId: defaultExecutor, text: '', dependsOn: [0], windowHandle: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [autoRun, setAutoRun] = useState(true);
  const [error, setError] = useState('');
  const update = (index: number, patch: Partial<PlanStepDraft>) => setSteps(previous => previous.map((step, current) => current === index ? { ...step, ...patch } : step));
  const suggest = async () => {
    const value = goal.trim();
    if (!value || suggesting) return;
    setSuggesting(true); setError('');
    try {
      const result = await api.suggestWorkPlan(value, targets.map(target => target.id));
      setSteps(result.steps.map(step => ({ executorId: step.executorId, text: step.text, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.filter(index => Number.isInteger(index) && index >= 0) : [], windowHandle: step.executorInput?.handle ? String(step.executorInput.handle) : (step.executorId === 'window' ? (windows[0]?.id || '') : '') })));
    } catch (cause) { setError((cause as Error).message); }
    finally { setSuggesting(false); }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = goal.trim();
    if (!value) { setError('请填写计划目标。'); return; }
    if (steps.length < 2) { setError('至少需要两步。'); return; }
    // 空步骤会回落到计划总目标（见下方 payload），这里不再做恒假的「每一步都需要说明」校验。
    if (steps.some(step => step.executorId === 'window' && !step.windowHandle)) { setError('请为窗口 Agent 步骤选择目标窗口。'); return; }
    setBusy(true); setError('');
    try {
      const payload = steps.map(step => {
        const text = step.text.trim() || value;
        return {
          executorId: step.executorId,
          text,
          ...(step.executorId === 'codex' || step.executorId === 'claude-code' ? { executorInput: { prompt: text } } : {}),
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
  return <Modal title="多步计划" subtitle="按依赖推进，默认一路跑完；需要逐步确认时关掉下面的自动执行" close={close}>
    <form className="sa-plan-form" onSubmit={submit}>
      <div className="sa-plan-goal"><label className="sa-field"><span>计划目标</span><input value={goal} onChange={event => setGoal(event.target.value)} placeholder="例如：检查 CI、修复失败项并验证" autoFocus /></label><button type="button" className="sa-button" disabled={!goal.trim() || suggesting || !targets.length} onClick={() => void suggest()}>{suggesting ? '规划中…' : 'AI 帮我规划'}</button></div>
      <div className="sa-plan-steps">{steps.map((step, index) => <div className="sa-plan-step" key={index}>
        <span className="sa-plan-index">{index + 1}</span>
        <select value={step.executorId} onChange={event => update(index, { executorId: event.target.value })} aria-label={`第${index + 1} 步执行器`}>{targets.length ? targets.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">没有可用执行器</option>}</select>
        <input value={step.text} onChange={event => update(index, { text: event.target.value })} placeholder={index === 0 ? '第一步做什么' : '下一步做什么'} aria-label={`第${index + 1} 步说明`} />
        {step.executorId === 'window' && <select value={step.windowHandle} onChange={event => update(index, { windowHandle: event.target.value })} aria-label={`第${index + 1} 步窗口`}><option value="">选择窗口</option>{windows.map(item => <option key={item.id} value={item.id}>{item.process} · {item.title}</option>)}</select>}
        {index > 0 && <input className="sa-plan-deps" value={step.dependsOn.map(item => item + 1).join(',')} onChange={event => update(index, { dependsOn: parseDependencies(event.target.value, index) })} placeholder="依赖 1,2" aria-label={`第${index + 1} 步依赖`} />}
        {steps.length > 2 && <button type="button" className="sa-icon" aria-label={`删除第${index + 1} 步`} onClick={() => removeStep(index)}><X size={15} /></button>}
      </div>)}</div>
      <div className="sa-plan-form-foot">
        <button type="button" className="sa-button" disabled={steps.length >= 5} onClick={() => setSteps(previous => [...previous, { executorId: defaultExecutor, text: '', dependsOn: previous.length ? [previous.length - 1] : [], windowHandle: '' }])}>添加一步</button>
        <span className="sa-inline-note">最多 5 步；无依赖步骤可并行，依赖满足后自动开始。</span>
      </div>
      {error && <p className="sa-error-text" role="alert">{error}</p>}
      <label className="sa-plan-auto"><input type="checkbox" checked={autoRun} onChange={event => setAutoRun(event.target.checked)} /><span>创建后自动执行（关掉就每一步都等你确认；权限与预算限制不变）</span></label>
      <div className="sa-plan-actions"><button type="button" className="sa-button" onClick={close}>取消</button><button type="submit" className="sa-button sa-primary" disabled={busy || !targets.length}>{busy ? '创建中…' : autoRun ? '创建并执行' : '创建计划'}</button></div>
    </form>
  </Modal>;
}
