import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, ClipboardCopy, File as FileIcon, Folder, FolderGit2, GitBranch, History, Inbox, Plus, RefreshCw, Save, Send, Sparkles, Trash2, Users } from 'lucide-react';
import { api } from '../api';
import { Modal } from './ui';
import type { WorkProject, WorkProjectBrief, WorkProjectChange, WorkProjectChat, WorkProjectSession, WorkTicket } from '../superagent';
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
};

const EXECUTOR_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'claude-acp': 'Claude ACP',
  'dsh-acp': 'DSH ACP',
  'codex-acp': 'Codex ACP',
  window: '窗口 Agent'
};

// 分派优先级：先 CLI（能改文件、能续接会话），再 ACP。
const DISPATCH_ORDER = ['claude-code', 'codex', 'claude-acp', 'dsh-acp', 'codex-acp'];

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

export function ProjectsPanel({ notify, onOpenTicket, allowedExecutors = ['claude-code', 'codex'], focusProjectId = null, focusChatId = null, requestImport = 0, onState, onFocusProject }: Props) {
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
  const [tab, setTab] = useState<'chat' | 'archive'>('chat');
  const [brief, setBrief] = useState<WorkProjectBrief | null>(null);
  const [briefDraft, setBriefDraft] = useState({ goal: '', summary: '', keyPoints: '', decisions: '', constraints: '' });
  const [changes, setChanges] = useState<WorkProjectChange[]>([]);
  const [archiveBusy, setArchiveBusy] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; run: () => Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [changeTitle, setChangeTitle] = useState('');
  const [changeSummary, setChangeSummary] = useState('');
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchTargets, setDispatchTargets] = useState<string[]>([]);
  const [dispatchBusy, setDispatchBusy] = useState(false);

  const project = useMemo(() => projects.find(item => item.id === activeProjectId) || null, [projects, activeProjectId]);
  const dispatchExecutors = useMemo(() => DISPATCH_ORDER.filter(id => allowedExecutors.includes(id)), [allowedExecutors]);
  const chat = useMemo(() => project?.chats.find(item => item.id === activeChatId) || null, [project, activeChatId]);
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
    setTab('chat'); setBrief(null); setChanges([]); setChangeTitle(''); setChangeSummary('');
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
    if (execs.includes('window') && execs.length > 1) { notify('窗口 Agent 只能单独使用，请取消其他选择。', true); return; }
    if (execs.includes('window') && !windowId) { notify('请选择要接管的窗口。', true); return; }
    setBusy('new-chat');
    try {
      const task = newTask.trim();
      if (execs.length > 1) {
        // 多 Agent：同一任务并行分派，每个 Agent 一条待确认工单，各自在自己的会话里执行。
        if (!task) { notify('多 Agent 协同需要写下要一起完成的任务。', true); return; }
        const result = await api.workProjectDispatch(project.id, task, execs);
        await loadProjects(true);
        setNewChatOpen(false);
        const chatId = result.tickets.map(ticket => ticket.projectChatId).filter(Boolean)[0];
        if (chatId) setActiveChatId(chatId);
        notify(`已把任务分派给 ${execs.length} 个 Agent，确认后各自在项目目录内执行。`);
        return;
      }
      const target = windows.find(item => item.id === windowId);
      const result = await api.workCreateProjectChat(project.id, {
        executorId: execs[0],
        ...(newTitle.trim() ? { title: newTitle.trim() } : {}),
        ...(execs[0] === 'window' && target ? { handle: target.handle, process: target.process, title: target.title } : {})
      });
      let ticketId = '';
      if (task) {
        const sent = await api.workProjectChatMessage(result.chat.id, task);
        ticketId = sent.ticket.id;
      }
      await loadProjects(true);
      setActiveChatId(result.chat.id);
      setNewChatOpen(false);
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
      const result = await api.workProjectChatMessage(chat.id, text);
      setChatDraft('');
      setTickets(current => [...current.filter(item => item.id !== result.ticket.id), result.ticket]);
      await loadProjects(true);
      notify(chat.executorId === 'window' ? '已提交，确认后会发送到该窗口的 Agent 会话。' : '已提交，确认后会在项目目录续接该 Agent 会话并修改文件。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setBusy(''); }
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

  return <section className="pj-page">
    <header className="pj-head">
      <div>
        <p className="pj-eyebrow"><FolderGit2 size={13} /> PROJECTS</p>
        <h1>项目</h1>
        <p className="pj-sub">导入本地文件夹，接管 Claude Code / Codex 已有的项目会话；消息审批后会在同一会话中修改项目文件。</p>
      </div>
      <div className="pj-head-actions">
        <button type="button" className="pj-btn" onClick={() => void loadProjects()} disabled={loading}><RefreshCw size={14} className={loading ? 'pj-spin' : ''} />刷新</button>
        <button type="button" className="pj-btn" onClick={() => void pickFolder()} disabled={busy === 'import'}><Plus size={15} />导入文件夹</button>
      </div>
    </header>

    {editorOpen && <form className="pj-editor" onSubmit={event => { event.preventDefault(); void importProject(pathDraft, nameDraft); }}>
      <label>文件夹绝对路径<input value={pathDraft} onChange={event => setPathDraft(event.target.value)} placeholder="例如 D:\\work\\my-project" autoFocus /></label>
      <label>显示名称（可选）<input value={nameDraft} onChange={event => setNameDraft(event.target.value)} placeholder="默认使用文件夹名" /></label>
      <div className="pj-editor-actions">
        <button type="button" className="pj-btn" onClick={() => setEditorOpen(false)}>取消</button>
        <button type="submit" className="pj-btn pj-primary" disabled={busy === 'import' || !pathDraft.trim()}>{busy === 'import' ? '导入中…' : '导入'}</button>
      </div>
    </form>}

    <div className="pj-layout">
      <aside className="pj-projects">
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
      </aside>

      <div className="pj-main">
        {!project ? <div className="pj-empty-block pj-placeholder"><FolderGit2 size={26} /><p>导入一个本地文件夹开始。</p></div> : <>
          <div className="pj-project-head">
            <div>
              <h2>{project.name}</h2>
              <p>{project.path}{project.gitBranch ? ` · ${project.gitBranch}` : ''}</p>
            </div>
            <div className="pj-head-actions">
              <button type="button" className="pj-btn" onClick={() => void openSessions()} disabled={busy === 'sessions'}><Inbox size={14} />导入已有会话</button>
              <button type="button" className="pj-btn" onClick={() => void openNewChat()}><Plus size={14} />新建对话</button>
            </div>
          </div>

          <div className="pj-tabs">
            <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><Bot size={13} />对话</button>
            <button type="button" className={tab === 'archive' ? 'active' : ''} onClick={openArchive}><History size={13} />变更档案</button>
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
              <small>可选多个 Agent；多选时会用同一条任务并行分派，每个 Agent 各有一条待确认工单。</small>
            </div>
            {newExecutors.includes('window') && <label>目标窗口<select value={windowId} onChange={event => setWindowId(event.target.value)}><option value="">选择窗口…</option>{windows.map(item => <option key={item.id} value={item.id}>{item.process} · {item.title}</option>)}</select></label>}
            <label>对话标题（可选）<input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="例如 修复登录页" /></label>
            <label>任务（可选）<textarea rows={3} maxLength={3000} value={newTask} onChange={event => setNewTask(event.target.value)} placeholder={newExecutors.length > 1 ? '写下要一起完成的任务，创建后立即并行分派' : '写下要完成的任务，创建后立即提交（仍需审批）'} /></label>
            <div className="pj-editor-actions">
              <button type="button" className="pj-btn" onClick={() => setNewChatOpen(false)}>取消</button>
              <button type="button" className="pj-btn pj-primary" disabled={busy === 'new-chat'} onClick={() => void createChat()}>{busy === 'new-chat' ? '创建中…' : newExecutors.length > 1 ? `分派给 ${newExecutors.length} 个 Agent` : '创建'}</button>
            </div>
          </div>}

          {tab === 'archive' ? <div className="pj-archive">
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
              <div className="pj-side-title"><span>项目对话</span><span>{project.chats.length}</span></div>
              {project.chats.length ? <ul>
                {project.chats.map(item => <li key={item.id} className={item.id === activeChatId ? 'active' : ''}>
                  <button type="button" className="pj-chat" onClick={() => setActiveChatId(item.id)}>
                    <span className="pj-chat-title"><Bot size={12} />{item.title}</span>
                    <span className="pj-chat-meta">{EXECUTOR_LABELS[item.executorId] || item.executorId} · {item.source === 'imported' ? '已导入会话' : item.writable ? '可修改项目' : '只读'}</span>
                    {item.lastSummary && <span className="pj-chat-summary">{item.lastSummary}</span>}
                  </button>
                  <button type="button" className="pj-icon" aria-label="删除对话" disabled={busy === `delete-chat-${item.id}`} onClick={() => void removeChat(item)}><Trash2 size={13} /></button>
                </li>)}
              </ul> : <p className="pj-empty">还没有项目对话。可导入已有会话，或新建一个。</p>}
            </div>

            <div className="pj-thread">
              {!chat ? <div className="pj-empty-block pj-placeholder"><p>选择一个项目对话。</p></div> : <>
                <div className="pj-thread-head">
                  <div><strong>{chat.title}</strong><span>{EXECUTOR_LABELS[chat.executorId] || chat.executorId} · {chat.sessionId ? '已绑定会话' : '首次消息将创建会话'}</span><span className="pj-write-path" title={project.path}><FolderGit2 size={12} />写入 {project.path}</span></div>
                  <span className={`pj-source ${chat.writable ? 'write' : ''}`}>{chat.writable ? '可修改项目' : '只读'}</span>
                </div>
                <div className="pj-messages">
                  {tickets.length ? tickets.map(ticket => <button type="button" className="pj-message" key={ticket.id} onClick={() => onOpenTicket(ticket.id)}>
                    <span className="pj-message-head"><span>{STATUS_LABELS[ticket.status] || ticket.status}</span><time>{new Date(ticket.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></span>
                    <span className="pj-message-text">{ticket.title}</span>
                    {ticket.summary && <span className="pj-message-summary">{ticket.summary}</span>}
                  </button>) : <p className="pj-empty">还没有消息。在下方描述任务，确认后才会发送给 Agent。</p>}
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
                  <div className="pj-composer-actions">
                    <button type="button" className="pj-btn" disabled={!chatDraft.trim() || !dispatchExecutors.length} aria-expanded={dispatchOpen} onClick={toggleDispatchPanel}><Users size={14} />并行分派</button>
                    <button type="button" className="pj-btn" disabled={!chatDraft.trim() || planBusy === 'suggest'} onClick={() => void startPlan()}><Sparkles size={14} />{planBusy === 'suggest' ? '拆解中…' : '拆成计划'}</button>
                    <button type="button" className="pj-btn pj-primary" disabled={!chatDraft.trim() || busy === 'send'} onClick={() => void send()}><Send size={14} />{busy === 'send' ? '提交中…' : '发送（需审批）'}</button>
                  </div>
                  <p className="pj-note pj-note-bar">消息会创建待确认工单；批准后 CLI 会在项目目录内修改文件，窗口 Agent 会把指令发到已绑定的窗口。<button type="button" className="pj-link" onClick={openManualPlan}>手动编排计划</button><span className="sa-keyhint">Enter 发送 · Shift + Enter 换行</span></p>
                </div>
              </>}
            </div>
          </div>}
        </>}
      </div>
    </div>

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
    {confirm && <Modal title={confirm.title} subtitle={confirm.body} close={() => { if (!confirmBusy) setConfirm(null); }}>
      <div className="pj-confirm">
        <p>这一步无法撤销，确认继续？</p>
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
