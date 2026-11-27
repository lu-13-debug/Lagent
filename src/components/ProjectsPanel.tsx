import { useEffect, useMemo, useState } from 'react';
import { Bot, Brain, ChevronLeft, ChevronRight, ClipboardCopy, Download, File as FileIcon, Folder, FolderGit2, FolderOpen, History, Inbox, LayoutDashboard, Package, Plus, RefreshCw, Save, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Modal } from './ui';
import { ProjectFiles } from './ProjectFiles';
import { FileKindIcon, FILE_KIND_LABELS, FilePreviewBody, fileKindFromPath, formatFileSize, formatFileTime, useProjectFilePreview } from './ProjectFilePreview';
import type { WorkProject, WorkProjectBrief, WorkProjectChange, WorkProjectChat, WorkProjectMemory, WorkProjectSession, WorkWorktree } from '../superagent';
import { STATUS_LABELS } from '../status';
import { EXECUTOR_LABELS } from '../executor-label';
import '../projects.css';

type Props = {
  notify: (text: string, error?: boolean) => void;
  allowedExecutors?: string[];
  focusProjectId?: string | null;
  focusChatId?: string | null;
  requestImport?: number;
  onState?: (state: { projects: WorkProject[]; projectId: string | null; chatId: string | null }) => void;
  onFocusProject?: (id: string | null) => void;
  // project：单个项目自己的页面；manage：全部项目（导入、浏览、删除）。
  mode?: 'manage' | 'project';
  onOpenChat?: (projectId: string, chatId: string) => void;
  onBackToProjects?: () => void;
};

export function ProjectsPanel({ notify, allowedExecutors = ['claude-code', 'codex'], focusProjectId = null, focusChatId = null, requestImport = 0, onState, onFocusProject, mode = 'manage', onOpenChat, onBackToProjects }: Props) {
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
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [sessions, setSessions] = useState<WorkProjectSession[] | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newTask, setNewTask] = useState('');
  const [tab, setTab] = useState<'overview' | 'chat' | 'files' | 'archive' | 'memory' | 'artifacts'>('chat');
  const [memory, setMemory] = useState<WorkProjectMemory | null>(null);
  const [memoryBusy, setMemoryBusy] = useState('');
  const [brief, setBrief] = useState<WorkProjectBrief | null>(null);
  const [briefDraft, setBriefDraft] = useState({ goal: '', summary: '', keyPoints: '', decisions: '', constraints: '', openQuestions: '', nextSteps: '', verifyCommands: '' });
  const [changes, setChanges] = useState<WorkProjectChange[]>([]);
  // 隔离执行：项目开关 + 进行中的工作树。服务端未开 LAGENT_WORKTREE 时列表为空。
  const [worktrees, setWorktrees] = useState<WorkWorktree[]>([]);
  const [isolationBusy, setIsolationBusy] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState('');
  const [confirm, setConfirm] = useState<{ title: string; body?: string; quote?: string; notes?: string[]; label: string; run: () => Promise<void> } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [changeTitle, setChangeTitle] = useState('');
  const [changeSummary, setChangeSummary] = useState('');

  const project = useMemo(() => projects.find(item => item.id === activeProjectId) || null, [projects, activeProjectId]);
  const chat = useMemo(() => project?.chats.find(item => item.id === activeChatId) || null, [project, activeChatId]);
  // 产物不看工单，只看项目变更档案：同一路径可能被多次改动，合并成一行。
  const artifactRows = useMemo(() => {
    const rows = new Map<string, { path: string; count: number; last: string; executor: string }>();
    for (const change of changes) {
      for (const file of change.files) {
        const previous = rows.get(file);
        rows.set(file, {
          path: file,
          count: (previous?.count || 0) + 1,
          last: !previous || change.createdAt > previous.last ? change.createdAt : previous.last,
          executor: !previous || change.createdAt > previous.last ? change.executorId : previous.executor
        });
      }
    }
    return [...rows.values()].sort((left, right) => right.last.localeCompare(left.last));
  }, [changes]);
  // 产物预览：与「文件」页共用同一套渲染，点一行看一份。
  const [artifactPath, setArtifactPath] = useState<string | null>(null);
  const artifactRow = useMemo(() => artifactRows.find(row => row.path === artifactPath) || null, [artifactRows, artifactPath]);
  const { preview: artifactPreview, loading: artifactLoading, error: artifactError } = useProjectFilePreview(activeProjectId || '', artifactPath);

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
  // 隔离执行的工作树按项目刷新；切页签或换项目时重拉，失败就当没有。
  useEffect(() => {
    if (!activeProjectId) { setWorktrees([]); return; }
    let alive = true;
    api.workProjectWorktrees(activeProjectId)
      .then(result => { if (alive) setWorktrees(result.worktrees); })
      .catch(() => { if (alive) setWorktrees([]); });
    return () => { alive = false; };
  }, [activeProjectId, tab]);

  const toggleIsolation = async () => {
    if (!project) return;
    setIsolationBusy(true);
    try {
      const next = project.isolation === 'worktree' ? 'direct' : 'worktree';
      const result = await api.workSetIsolation(project.id, next);
      setProjects(previous => previous.map(item => item.id === result.project.id ? { ...item, ...result.project } : item));
      notify(next === 'worktree' ? '已开启隔离执行：之后的任务在独立工作树里运行。' : '已关闭隔离执行，任务直接在当前项目目录运行。');
    } catch (cause) { notify((cause as Error).message, true); }
    finally { setIsolationBusy(false); }
  };

  const reloadWorktrees = async (projectId: string) => {
    try { setWorktrees((await api.workProjectWorktrees(projectId)).worktrees); }
    catch { setWorktrees([]); }
  };

  const commitWorktree = async (id: string) => {
    try {
      const result = await api.workCommitWorktree(id);
      notify(`已提交到分支 ${result.worktree.branch}；合并时机由你决定。`);
      if (activeProjectId) await reloadWorktrees(activeProjectId);
    } catch (cause) { notify((cause as Error).message, true); }
  };

  const releaseWorktree = async (id: string) => {
    try {
      const result = await api.workReleaseWorktree(id);
      notify(`已清理工作树目录，分支 ${result.branch} 保留在主仓库里。`);
      if (activeProjectId) await reloadWorktrees(activeProjectId);
    } catch (cause) { notify((cause as Error).message, true); }
  };
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
  // 只有「换了项目」才重置页签与缓存；项目列表的后台刷新不应该把用户从
  // 记忆/档案/产物页踢回对话。
  useEffect(() => {
    if (!activeProjectId) return;
    setSessionsOpen(false); setSessions(null);
    setTab('chat'); setBrief(null); setChanges([]); setChangeTitle(''); setChangeSummary(''); setMemory(null); setArtifactPath(null);
  }, [activeProjectId]);
  useEffect(() => {
    if (!activeProjectId) { setActiveChatId(null); return; }
    const item = projects.find(entry => entry.id === activeProjectId);
    if (!item) return;
    setActiveChatId(previous => previous && item.chats.some(entry => entry.id === previous) ? previous : item.chats[0]?.id || null);
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
    const picker = window.lagentDesktop?.pickFolder;
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
  // 新建对话不再让用户先挑 Agent：默认由内置 Lagent 负责，建好后在对话输入框里按任务换人。
  const defaultChatExecutor = () => allowedExecutors.includes('model') ? 'model' : (allowedExecutors[0] || '');
  const openNewChat = async () => {
    setNewChatOpen(true);
    setNewTitle('');
    setNewTask('');
  };
  const createChat = async () => {
    if (!project) return;
    const executorId = defaultChatExecutor();
    if (!executorId) { notify('没有可用于项目的执行器，请先在设置里启用。', true); return; }
    setBusy('new-chat');
    try {
      const task = newTask.trim();
      const result = await api.workCreateProjectChat(project.id, {
        executorId,
        ...(newTitle.trim() ? { title: newTitle.trim() } : {})
      });
      if (task) await api.workProjectChatMessage(result.chat.id, task);
      await loadProjects(true);
      setActiveChatId(result.chat.id);
      setNewChatOpen(false);
      if (onOpenChat) onOpenChat(project.id, result.chat.id);
      notify(task
        ? `已创建与 ${EXECUTOR_LABELS[executorId] || executorId} 的项目对话，并提交了任务（待确认）。`
        : `已创建与 ${EXECUTOR_LABELS[executorId] || executorId} 的项目对话。`);
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
      constraints: next.constraints.join('\n'),
      openQuestions: next.openQuestions.join('\n'),
      nextSteps: next.nextSteps.join('\n'),
      verifyCommands: next.verifyCommands.join('\n')
    });
  };
  const openArchive = () => {
    setTab('archive');
    if (!brief) void loadArchive();
  };
  // 概览与产物都依赖简报/变更档案；直接切过去时按需补一次，不要求用户先点档案。
  useEffect(() => {
    if ((tab === 'overview' || tab === 'artifacts') && !brief) void loadArchive();
  }, [tab, brief, activeProjectId]);
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
        constraints: splitLines(briefDraft.constraints),
        openQuestions: splitLines(briefDraft.openQuestions),
        nextSteps: splitLines(briefDraft.nextSteps),
        verifyCommands: splitLines(briefDraft.verifyCommands)
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
  return <section className={`pj-page${projectMode ? ' pj-projectpage' : ''}`}>
    {projectMode && <header className="pj-head">
      <div>
        <p className="pj-eyebrow"><FolderGit2 size={13} /> 项目</p>
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
    <header className="pj-head" hidden={projectMode}>
      <div>
        <p className="pj-eyebrow"><FolderGit2 size={13} /> 工作文件夹</p>
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

    <div className="pj-layout pj-layout-single">
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
            <button type="button" className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><LayoutDashboard size={13} />概览</button>
            <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><Bot size={13} />对话</button>
            <button type="button" className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}><FolderOpen size={13} />文件</button>
            <button type="button" className={tab === 'archive' ? 'active' : ''} onClick={openArchive}><History size={13} />变更档案</button>
            <button type="button" className={tab === 'memory' ? 'active' : ''} onClick={openMemory}><Brain size={13} />项目记忆</button>
            <button type="button" className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}><Package size={13} />产物</button>
          </div>

          {tab === 'overview' && <div className="pj-overview">
            <div className="pj-overview-grid">
              <div className="pj-overview-stat"><span>对话</span><strong>{project?.chats.length || 0}</strong></div>
              <div className="pj-overview-stat"><span>变更</span><strong>{changes.length}</strong></div>
              <div className="pj-overview-stat"><span>产物文件</span><strong>{artifactRows.length}</strong></div>
              <div className="pj-overview-stat"><span>最近更新</span><strong>{brief ? new Date(brief.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) : '—'}</strong></div>
            </div>
            <section className="pj-overview-block pj-isolation">
              <h3>隔离执行</h3>
              <p>{project?.isolation === 'worktree'
                ? '已开启：任务在独立工作树里执行，你正在编辑的文件不会被改动；结束后改动提交到独立分支，合并时机由你决定。'
                : '关闭：任务直接在项目目录里执行。开启后 Agent 改坏代码也只影响工作树，主工作区保持原样。'}</p>
              <div className="pj-head-actions">
                <button type="button" className={`pj-btn ${project?.isolation === 'worktree' ? '' : 'pj-primary'}`} disabled={isolationBusy} onClick={() => void toggleIsolation()}>
                  {isolationBusy ? '处理中…' : project?.isolation === 'worktree' ? '关闭隔离执行' : '开启隔离执行'}
                </button>
              </div>
              {project?.isolation === 'worktree' && (worktrees.length
                ? <ul className="pj-worktrees">{worktrees.map(item => <li key={item.id}>
                    <code>{item.branch}</code>
                    <span>{item.ticketId ? `工单 ${item.ticketId.slice(0, 8)}` : '等待任务'}{item.files?.length ? ` · ${item.files.length} 个文件` : ''}</span>
                    <button type="button" className="pj-link" onClick={() => void commitWorktree(item.id)}>提交</button>
                    <button type="button" className="pj-link" onClick={() => void releaseWorktree(item.id)}>清理</button>
                  </li>)}</ul>
                : <p>还没有进行中的隔离工作树，下一次任务开始时自动创建。</p>)}
            </section>

            <section className="pj-overview-block">
              <h3>现在做到哪</h3>
              <p>{brief?.summary || brief?.goal || '还没有项目简报。打开「变更档案」补充目标与当前进展。'}</p>
              {brief?.nextSteps.length ? <ul>{brief.nextSteps.slice(0, 5).map(item => <li key={item}>{item}</li>)}</ul> : null}
            </section>
            {brief?.verifyCommands.length ? <section className="pj-overview-block">
              <h3>接手先跑</h3>
              <ul className="pj-overview-commands">{brief.verifyCommands.map(item => <li key={item}><code>{item}</code></li>)}</ul>
            </section> : null}
            <section className="pj-overview-block">
              <h3>最近变更</h3>
              {changes.length ? <ul>{changes.slice(0, 4).map(change => <li key={change.id}><strong>{change.title}</strong><span>{EXECUTOR_LABELS[change.executorId] || change.executorId} · {new Date(change.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span></li>)}</ul> : <p>还没有变更记录。</p>}
            </section>
          </div>}

          {tab === 'files' && <ProjectFiles project={project} notify={notify} />}

          {tab === 'artifacts' && <div className="pj-artifact-workspace">
            <aside className="pj-artifact-pane" aria-label="项目产物">
              <div className="pj-artifact-head">
                <strong>项目产物</strong>
                <span className="pj-artifact-head-side">
                  <span>{artifactRows.length} 个文件</span>
                  <button type="button" className="pj-link" onClick={() => setTab('files')} title="产物只列出 Agent 写过的文件，全部项目文件在这里浏览">全部文件</button>
                </span>
              </div>
              {artifactRows.length ? <ul className="pj-artifact-list">
                {artifactRows.map(row => <li key={row.path}>
                  <button
                    type="button"
                    className={`pj-artifact-row${row.path === artifactPath ? ' is-active' : ''}`}
                    onClick={() => setArtifactPath(row.path)}
                    title={row.path}
                  >
                    <span className="pj-artifact-icon"><FileKindIcon kind={fileKindFromPath(row.path)} /></span>
                    <span className="pj-artifact-path">{row.path}</span>
                    <span className="pj-artifact-meta">{[EXECUTOR_LABELS[row.executor] || row.executor, `${row.count} 次`, new Date(row.last).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>)}
              </ul> : <p className="pj-empty">还没有产物。Agent 完成一次写入后，这里会按文件聚合。</p>}
            </aside>
            <section className="pjf-preview" aria-live="polite">
              <header className="pjf-preview-head">
                <div className="pjf-preview-title">
                  <span className="pjf-preview-icon"><FileKindIcon kind={artifactPreview?.kind || (artifactPath ? fileKindFromPath(artifactPath) : 'unsupported')} /></span>
                  <div>
                    <strong>{artifactPreview?.name || artifactPath?.split('/').pop() || '产物预览'}</strong>
                    <span>{artifactPreview
                      ? [FILE_KIND_LABELS[artifactPreview.kind] || artifactPreview.kind, formatFileSize(artifactPreview.size), formatFileTime(artifactPreview.modifiedAt), artifactRow ? [EXECUTOR_LABELS[artifactRow.executor] || artifactRow.executor, `${artifactRow.count} 次`].filter(Boolean).join(' · ') : ''].filter(Boolean).join(' · ')
                      : artifactPath || '从左侧选择产物查看内容'}</span>
                  </div>
                </div>
                {artifactPreview && <div className="pjf-preview-actions">
                  <a className="pj-btn" href={api.workProjectFileUrl(project.id, artifactPreview.path, true)} download><Download size={13} />下载</a>
                </div>}
              </header>
              <div className="pjf-preview-body">
                {!artifactPath
                  ? <div className="pjf-empty pjf-empty-preview"><Package size={26} /><strong>选择一个产物查看内容</strong><span>这里汇总 Agent 写入过的文件，可直接预览或下载。</span></div>
                  : artifactLoading
                    ? <div className="pjf-empty pjf-empty-preview"><RefreshCw size={22} className="pjf-spin" /><span>正在读取产物…</span></div>
                    : artifactError
                      ? <div className="pjf-alert" role="alert">{artifactError}</div>
                      : artifactPreview
                        ? <FilePreviewBody projectId={project.id} preview={artifactPreview} />
                        : <div className="pjf-empty pjf-empty-preview"><span>还没有可显示的内容。</span></div>}
              </div>
            </section>
          </div>}

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
            <p className="pj-note"><Sparkles size={13} />默认由 {defaultChatExecutor() ? EXECUTOR_LABELS[defaultChatExecutor()] || defaultChatExecutor() : '内置 Agent'} 负责；创建后可以在对话输入框上方按任务换人，一个对话里不同任务可以用不同 Agent。</p>
            <label>对话标题（可选）<input value={newTitle} onChange={event => setNewTitle(event.target.value)} placeholder="例如 修复登录页" /></label>
            <label>任务（可选）<textarea rows={3} maxLength={3000} value={newTask} onChange={event => setNewTask(event.target.value)} placeholder="写下要完成的任务，创建后立即提交" /></label>
            <div className="pj-editor-actions">
              <button type="button" className="pj-btn" onClick={() => setNewChatOpen(false)}>取消</button>
              <button type="button" className="pj-btn pj-primary" disabled={busy === 'new-chat'} onClick={() => void createChat()}>{busy === 'new-chat' ? '创建中…' : '创建'}</button>
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
                  {brief && Object.values(brief.sources || {}).includes('mcp') && <span className="pj-source">含外部 Agent 写入</span>}
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
                <div className="pj-field-row pj-field-row-3">
                  <label className="pj-field"><span className="pj-field-label">未解问题（每行一条）{brief?.sources?.openQuestions === 'mcp' && <em className="pj-source">外部写入</em>}</span><textarea rows={3} value={briefDraft.openQuestions} onChange={event => setBriefDraft(current => ({ ...current, openQuestions: event.target.value }))} placeholder="等待确认的取舍、已知风险" /></label>
                  <label className="pj-field"><span className="pj-field-label">下一步（每行一条）{brief?.sources?.nextSteps === 'mcp' && <em className="pj-source">外部写入</em>}</span><textarea rows={3} value={briefDraft.nextSteps} onChange={event => setBriefDraft(current => ({ ...current, nextSteps: event.target.value }))} placeholder="接手的人先做什么" /></label>
                  <label className="pj-field"><span className="pj-field-label">验收命令（每行一条）{brief?.sources?.verifyCommands === 'mcp' && <em className="pj-source">外部写入</em>}</span><textarea rows={3} value={briefDraft.verifyCommands} onChange={event => setBriefDraft(current => ({ ...current, verifyCommands: event.target.value }))} placeholder="npm test" /></label>
                </div>
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
          </div> : tab === 'chat' ? <div className="pj-work">
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

          </div> : null}
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
