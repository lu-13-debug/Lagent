import { useEffect, useState } from 'react';
import { BookOpen, Bot, MessageSquare, Play, RefreshCw, ShieldCheck, Sparkles, Square, Users } from 'lucide-react';
import { api } from '../api';
import type { WorkImChannel, WorkImConfig, WorkLibraryPreview, WorkLibrarySync, WorkLiveSession, WorkMcpServer, WorkProject, WorkRoutine, WorkRoutineKind, WorkRoutineSchedule, WorkTeamRoom } from '../superagent';
import { Spinner } from './ui';

type Tab = 'library' | 'routines' | 'mcp' | 'im' | 'rooms' | 'live';
type Notify = (message: string, error?: boolean) => void;

const TABS: { id: Tab; label: string; icon: typeof BookOpen }[] = [
  { id: 'library', label: 'Library 同步', icon: BookOpen },
  { id: 'routines', label: '例行任务', icon: RefreshCw },
  { id: 'mcp', label: 'MCP 客户端', icon: Bot },
  { id: 'im', label: 'IM 通知', icon: MessageSquare },
  { id: 'rooms', label: '团队房间', icon: Users },
  { id: 'live', label: '实时观察', icon: Play }
];

const statusNames: Record<string, string> = {
  queued: '排队中', working: '执行中', awaiting_review: '待确认', blocked: '受阻', failed: '失败',
  waiting: '等待依赖', completed: '已完成', cancelled: '已取消', live: '观察中', paused: '已暂停',
  takeover: '已接管', error: '异常', open: '进行中', active: '进行中'
};

function projectName(projects: WorkProject[], id: string | null) {
  return projects.find(project => project.id === id)?.name || '未选择项目';
}

function scheduleText(schedule: WorkRoutineSchedule) {
  if (schedule.kind === 'interval') return `每 ${Math.round(schedule.intervalMs / 60000)} 分钟`;
  if (schedule.kind === 'daily') return `每天 ${schedule.at}`;
  if (schedule.kind === 'webhook') return 'Webhook';
  if (schedule.kind === 'git') return 'Git 提交';
  if (schedule.kind === 'file') return `文件 ${schedule.path}`;
  return '手动';
}

async function attempt<T>(notify: Notify, action: () => Promise<T>): Promise<T | null> {
  try { return await action(); } catch (cause) { notify((cause as Error).message || '操作失败', true); return null; }
}

export function WorkOpsPanel({ projects, executors, windows, notify }: { projects: WorkProject[]; executors: string[]; windows: { handle: number; process: string; title: string }[]; notify: Notify }) {
  const [tab, setTab] = useState<Tab>('library');
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projects, projectId]);
  return <article className="sa-card sa-ops-card" id="p1-ops">
    <div className="sa-section-head"><h2><Sparkles size={16} />协作与自动化</h2><span className="sa-tag">P1</span></div>
    <p>把项目记忆同步给外部 Agent、定时生成建议、连接 MCP 与 IM、在团队房间里协作，或对桌面窗口做实时观察与接管。</p>
    <div className="sa-ops-tabs" role="tablist">{TABS.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-on' : ''} onClick={() => setTab(item.id)}><item.icon size={14} />{item.label}</button>)}</div>
    {projects.length > 1 && <label className="sa-ops-project">项目<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    <div className="sa-ops-body">
      {tab === 'library' && <LibraryPanel projectId={projectId} notify={notify} />}
      {tab === 'routines' && <RoutinesPanel projectId={projectId} projects={projects} executors={executors} notify={notify} />}
      {tab === 'mcp' && <McpPanel notify={notify} />}
      {tab === 'im' && <ImPanel notify={notify} />}
      {tab === 'rooms' && <RoomsPanel projectId={projectId} projects={projects} notify={notify} />}
      {tab === 'live' && <LivePanel windows={windows} notify={notify} />}
    </div>
  </article>;
}

function LibraryPanel({ projectId, notify }: { projectId: string; notify: Notify }) {
  const [preview, setPreview] = useState<WorkLibraryPreview | null>(null);
  const [syncs, setSyncs] = useState<WorkLibrarySync[]>([]);
  const [busy, setBusy] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpToken, setMcpToken] = useState('');
  const loadSyncs = async () => { if (!projectId) return; const result = await attempt(notify, () => api.workLibrarySyncs(projectId)); if (result) setSyncs(result.syncs); };
  useEffect(() => { setPreview(null); setSyncs([]); void loadSyncs(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);
  if (!projectId) return <p className="sa-empty">先导入一个项目。</p>;
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>目标</dt><dd>CLAUDE.md、AGENTS.md、.cursor/rules/lagent.mdc</dd></div><div><dt>写入方式</dt><dd>只替换托管块，保留你自己的内容；每次写入先备份</dd></div></dl>
    <div className="sa-ops-form"><label>可选：写入 .mcp.json 的 Lagent 服务地址<input value={mcpUrl} placeholder="https://your-lagent.example" onChange={event => setMcpUrl(event.target.value)} /></label><label>MCP 令牌（仅写入，不预览不回显）<input type="password" autoComplete="new-password" value={mcpToken} placeholder="Bearer 令牌，可留空" onChange={event => setMcpToken(event.target.value)} /></label></div>
    <div className="sa-ops-actions">
      <button type="button" className="sa-button" disabled={busy === 'preview'} onClick={() => void attempt(notify, async () => { setBusy('preview'); const result = await api.workLibraryPreview(projectId, mcpUrl.trim() ? { mcpUrl: mcpUrl.trim(), targets: ['claude', 'agents', 'cursor', 'mcp'] } : undefined); setPreview(result); return result; }).finally(() => setBusy(''))}>{busy === 'preview' ? <Spinner size={14} /> : <BookOpen size={14} />}预览差异</button>
      <button type="button" className="sa-button sa-primary" disabled={busy === 'apply'} onClick={() => void attempt(notify, async () => { setBusy('apply'); const result = await api.workLibraryApply(projectId, { ...(mcpUrl.trim() ? { mcpUrl: mcpUrl.trim(), ...(mcpToken.trim() ? { mcpToken: mcpToken.trim() } : {}), targets: ['claude', 'agents', 'cursor', 'mcp'] } : {}) }); notify(`已同步 ${result.sync.changed} 个文件。`); await loadSyncs(); return result; }).finally(() => setBusy(''))}>写入项目</button>
    </div>
    {preview && <div className="sa-ops-preview">{preview.targets.map(row => <details key={row.id} open={row.changed && !row.error}><summary><span>{row.label}</span><code>{row.path}</code><em className={row.error ? 'is-error' : row.changed ? 'is-changed' : ''}>{row.error || (row.changed ? '有变化' : '无变化')}</em></summary>{row.error ? <p className="sa-inline-note">{row.error}</p> : <><div className="sa-ops-diff"><div><strong>当前</strong><pre>{row.before || '（文件不存在）'}</pre></div><div><strong>同步后</strong><pre>{row.after}</pre></div></div></>}</details>)}</div>}
    <div className="sa-ops-list"><div className="sa-section-head"><h3>同步记录</h3><button type="button" className="sa-link" onClick={() => void loadSyncs()}>刷新</button></div>
      {syncs.length ? syncs.slice(0, 5).map(sync => <div className="sa-ops-row" key={sync.id}><div><strong>{new Date(sync.createdAt).toLocaleString()}</strong><span>{sync.changedFiles?.length ? sync.changedFiles.join('、') : '无改动'}{sync.rolledBackAt ? ` · 已于 ${new Date(sync.rolledBackAt).toLocaleString()} 回滚` : ''}</span></div>{!sync.rolledBackAt && sync.changed > 0 && <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workLibraryRollback(projectId, sync.id); notify('已回滚到同步前的内容。'); await loadSyncs(); })}>回滚</button>}</div>) : <p className="sa-inline-note">还没有同步记录。</p>}
    </div>
  </div>;
}

function RoutinesPanel({ projectId, projects, executors, notify }: { projectId: string; projects: WorkProject[]; executors: string[]; notify: Notify }) {
  const [routines, setRoutines] = useState<WorkRoutine[]>([]);
  const [busy, setBusy] = useState('');
  const [webhookToken, setWebhookToken] = useState('');
  const [draft, setDraft] = useState({ name: '', executorId: executors[0] || '', kind: 'task' as WorkRoutineKind, prompt: '', schedule: 'interval' as WorkRoutineSchedule['kind'], intervalMinutes: 60, at: '09:00', filePath: '', debounceMinutes: 1, mode: 'suggest', projectId: '' });
  const targetProject = draft.projectId || projectId;
  const load = async () => { const result = await attempt(notify, () => api.workRoutines()); if (result) setRoutines(result.routines); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const schedule: WorkRoutineSchedule = draft.schedule === 'interval'
    ? { kind: 'interval', intervalMs: Math.max(5, draft.intervalMinutes) * 60000 }
    : draft.schedule === 'daily' ? { kind: 'daily', at: draft.at }
      : draft.schedule === 'webhook' ? { kind: 'webhook' }
        : draft.schedule === 'git' ? { kind: 'git' }
          : draft.schedule === 'file' ? { kind: 'file', path: draft.filePath.trim(), debounceMs: Math.max(0, draft.debounceMinutes) * 60000 }
            : { kind: 'manual' };
  const scheduleReady = draft.schedule !== 'file' || Boolean(draft.filePath.trim());
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>默认行为</dt><dd>只创建「待确认」建议工单，不会自动执行</dd></div><div><dt>可用触发</dt><dd>固定间隔、每天定时、手动、签名 Webhook、Git 提交、文件变化</dd></div></dl>
    <div className="sa-ops-form">
      <label>名称<input value={draft.name} maxLength={80} placeholder="例如：每日项目巡检" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>项目<select value={targetProject} onChange={event => setDraft({ ...draft, projectId: event.target.value })}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>执行器<select value={draft.executorId} onChange={event => setDraft({ ...draft, executorId: event.target.value })}>{executors.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>类型<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as WorkRoutineKind })}><option value="task">通用任务</option><option value="daily-brief">每日简报</option><option value="stall-followup">停滞跟进</option></select></label>
      <label>触发<select value={draft.schedule} onChange={event => setDraft({ ...draft, schedule: event.target.value as WorkRoutineSchedule['kind'] })}><option value="interval">固定间隔</option><option value="daily">每天定时</option><option value="manual">仅手动</option><option value="webhook">Webhook</option><option value="git">Git 提交</option><option value="file">文件变化</option></select></label>
      {draft.schedule === 'interval' ? <label>间隔（分钟，至少 5）<input type="number" min={5} value={draft.intervalMinutes} onChange={event => setDraft({ ...draft, intervalMinutes: event.target.valueAsNumber })} /></label> : draft.schedule === 'daily' ? <label>每天时间<input type="time" value={draft.at} onChange={event => setDraft({ ...draft, at: event.target.value })} /></label> : draft.schedule === 'file' ? <><label>监视文件（项目内相对路径）<input value={draft.filePath} maxLength={300} placeholder="例如：docs/status.md" onChange={event => setDraft({ ...draft, filePath: event.target.value })} /></label><label>防抖（分钟）<input type="number" min={0} max={1} value={draft.debounceMinutes} onChange={event => setDraft({ ...draft, debounceMinutes: event.target.valueAsNumber || 0 })} /></label></> : <span />}
      <label>模式<select value={draft.mode} onChange={event => setDraft({ ...draft, mode: event.target.value })}><option value="suggest">建议后人工批准</option><option value="auto">低风险时自动执行</option></select></label>
      {draft.kind !== 'stall-followup' && <label className="sa-ops-wide">任务说明<textarea rows={3} value={draft.prompt} maxLength={3000} placeholder="支持 {{project}}、{{date}}、{{time}} 占位符" onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></label>}
    </div>
    <div className="sa-ops-actions"><button type="button" className="sa-button sa-primary" disabled={busy === 'save' || !draft.name.trim() || !targetProject || !draft.executorId || !scheduleReady} onClick={() => void attempt(notify, async () => { setBusy('save'); const result = await api.workSaveRoutine({ name: draft.name.trim(), projectId: targetProject, executorId: draft.executorId, kind: draft.kind, mode: draft.mode as 'suggest' | 'auto', schedule, promptTemplate: draft.prompt, enabled: true }); setWebhookToken(result.webhookToken || ''); setDraft({ ...draft, name: '' }); notify('例行任务已创建。'); await load(); return result; }).finally(() => setBusy(''))}>{busy === 'save' ? '保存中…' : '创建例行任务'}</button></div>
    {webhookToken && <p className="sa-inline-note sa-tag-ok"><ShieldCheck size={13} />Webhook 令牌只显示一次：<code>{webhookToken}</code></p>}
    <div className="sa-ops-list">{routines.map(routine => <div className="sa-ops-row" key={routine.id}><div><strong>{routine.name}</strong><span>{projectName(projects, routine.projectId)} · {routine.executorId} · {routine.kind} · {scheduleText(routine.schedule)} · {routine.enabled ? '已启用' : '已停用'}{routine.nextAt ? ` · 下次 ${new Date(routine.nextAt).toLocaleString()}` : ''}{routine.lastError ? ` · ${routine.lastError}` : ''}</span></div><div className="sa-ops-row-actions"><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.workRunRoutine(routine.id); notify(result.autoApproved ? '已自动批准执行。' : '已创建建议工单。'); await load(); })}>立即运行</button><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workUpdateRoutine(routine.id, { enabled: !routine.enabled }); await load(); })}>{routine.enabled ? '停用' : '启用'}</button><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workDeleteRoutine(routine.id); await load(); })}>删除</button></div></div>)}</div>
    {!routines.length && <p className="sa-inline-note">还没有例行任务。</p>}
  </div>;
}

function McpPanel({ notify }: { notify: Notify }) {
  const [servers, setServers] = useState<WorkMcpServer[]>([]);
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState({ name: '', command: 'npx', args: '', env: '' });
  const [testResult, setTestResult] = useState('');
  const load = async () => { const result = await attempt(notify, () => api.workMcpServers()); if (result) setServers(result.servers); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  const input = () => ({
    name: draft.name.trim(),
    command: draft.command.trim(),
    args: draft.args.split(/\s+/).filter(Boolean),
    env: Object.fromEntries(draft.env.split(/\s+/).filter(Boolean).map(item => { const index = item.indexOf('='); return index > 0 ? [item.slice(0, index), item.slice(index + 1)] : ['', '']; }).filter(([key]) => key))
  });
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>安全边界</dt><dd>只启动你显式添加的服务器；命令限制为 node/npx/python/uvx 等，cwd 必须在工作区内</dd></div><div><dt>工具命名</dt><dd>模型看到的是 <code>mcp__服务器__工具</code>，只读权限下不会调用</dd></div></dl>
    <div className="sa-ops-form"><label>名称<input value={draft.name} maxLength={40} placeholder="例如：filesystem" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>命令<input value={draft.command} onChange={event => setDraft({ ...draft, command: event.target.value })} /></label><label className="sa-ops-wide">参数（空格分隔）<input value={draft.args} placeholder="-y @modelcontextprotocol/server-filesystem D:\shared" onChange={event => setDraft({ ...draft, args: event.target.value })} /></label><label className="sa-ops-wide">环境变量（KEY=VAL 空格分隔）<input value={draft.env} placeholder="TOKEN=..." onChange={event => setDraft({ ...draft, env: event.target.value })} /></label></div>
    <div className="sa-ops-actions"><button type="button" className="sa-button" disabled={busy === 'test' || !draft.name.trim()} onClick={() => void attempt(notify, async () => { setBusy('test'); const result = await api.testWorkMcpServer(input()); const failed = (result.servers || []).find(server => !server.ok); setTestResult(result.ok ? `连接成功，发现 ${result.tools || 0} 个工具${result.schemas?.length ? `：${result.schemas.join('、')}` : ''}` : failed?.error || result.error || '连接失败'); return result; }).finally(() => setBusy(''))}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button type="button" className="sa-button sa-primary" disabled={busy === 'save' || !draft.name.trim()} onClick={() => void attempt(notify, async () => { setBusy('save'); await api.addWorkMcpServer(input()); setDraft({ ...draft, name: '' }); notify('MCP 服务器已保存。'); await load(); }).finally(() => setBusy(''))}>保存服务器</button></div>
    {testResult && <p className="sa-inline-note">{testResult}</p>}
    <div className="sa-ops-list">{servers.map(server => <div className="sa-ops-row" key={server.id}><div><strong>{server.name}</strong><span>{server.command} {server.args.join(' ')} · {server.enabled ? '已启用' : '已停用'}{server.tools.length ? ` · 白名单：${server.tools.join('、')}` : ''}{server.envKeys.length ? ` · 环境变量：${server.envKeys.join('、')}` : ''}</span></div><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.removeWorkMcpServer(server.id); await load(); })}>删除</button></div>)}</div>
    {!servers.length && <p className="sa-inline-note">还没有配置 MCP 客户端服务器。</p>}
  </div>;
}

function ImPanel({ notify }: { notify: Notify }) {
  const [config, setConfig] = useState<WorkImConfig | null>(null);
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState({ name: '', kind: 'slack' as WorkImChannel['kind'], webhookUrl: '', events: ['ticket'], baseUrl: '' });
  const load = async () => { const result = await attempt(notify, () => api.workImConfig()); if (result) setConfig(result); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>审批链接</dt><dd>HMAC 签名、24 小时有效、只能使用一次；链接打开后还要再点一次确认</dd></div><div><dt>隐私</dt><dd>Webhook 地址只保存不回显；接口只返回域名</dd></div></dl>
    <div className="sa-ops-form"><label>渠道名<input value={draft.name} maxLength={40} placeholder="例如：研发群" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label>类型<select value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as WorkImChannel['kind'] })}>{(config?.kinds || ['slack', 'teams', 'feishu', 'wecom', 'dingtalk', 'generic']).map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label><label className="sa-ops-wide">Webhook（HTTPS）<input value={draft.webhookUrl} placeholder="https://hooks.example.com/..." onChange={event => setDraft({ ...draft, webhookUrl: event.target.value })} /></label><label className="sa-ops-wide">外部访问地址（用于生成审批链接，可留空）<input value={draft.baseUrl} placeholder="https://your-lagent.example" onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label><label className="sa-ops-wide">通知事件<select multiple value={draft.events} onChange={event => setDraft({ ...draft, events: [...event.target.selectedOptions].map(option => option.value) })}><option value="ticket">工单待确认 / 失败</option><option value="usage-alert">用量告警</option></select></label></div>
    <div className="sa-ops-actions"><button type="button" className="sa-button sa-primary" disabled={busy === 'save' || !draft.name.trim() || !draft.webhookUrl.trim()} onClick={() => void attempt(notify, async () => { setBusy('save'); await api.saveWorkImChannel({ name: draft.name.trim(), kind: draft.kind, webhookUrl: draft.webhookUrl.trim(), events: draft.events, baseUrl: draft.baseUrl.trim() || undefined }); setDraft({ ...draft, name: '', webhookUrl: '' }); notify('通知渠道已保存。'); await load(); }).finally(() => setBusy(''))}>保存渠道</button></div>
    <div className="sa-ops-list">{(config?.channels || []).map(channel => <div className="sa-ops-row" key={channel.id}><div><strong>{channel.name}</strong><span>{channel.kind} · {channel.webhookHost} · {channel.events.join('、')} · {channel.enabled ? '已启用' : '已停用'}</span></div><div className="sa-ops-row-actions"><button type="button" className="sa-link" disabled={busy === channel.id} onClick={() => void attempt(notify, async () => { setBusy(channel.id); await api.testWorkImChannel(channel.id); notify('测试通知已发送。'); }).finally(() => setBusy(''))}>发送测试</button><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.deleteWorkImChannel(channel.id); await load(); })}>删除</button></div></div>)}</div>
    {config && !config.channels.length && <p className="sa-inline-note">还没有通知渠道。</p>}
  </div>;
}

function RoomsPanel({ projectId, projects, notify }: { projectId: string; projects: WorkProject[]; notify: Notify }) {
  const [rooms, setRooms] = useState<WorkTeamRoom[]>([]);
  const [active, setActive] = useState<WorkTeamRoom | null>(null);
  const [busy, setBusy] = useState('');
  const [title, setTitle] = useState('');
  const [planId, setPlanId] = useState('');
  const [message, setMessage] = useState('');
  const load = async () => { if (!projectId) return; const result = await attempt(notify, () => api.workTeamRooms(projectId)); if (result) setRooms(result.rooms); };
  useEffect(() => { setActive(null); void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [projectId]);
  if (!projectId) return <p className="sa-empty">先导入一个项目。</p>;
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>用途</dt><dd>把一条计划里的步骤、工单状态、报告、消息、认领和决定放在同一个现场</dd></div><div><dt>执行</dt><dd>房间只做聚合，真正执行仍复用计划与工单</dd></div></dl>
    <div className="sa-ops-form"><label>房间标题<input value={title} maxLength={100} placeholder="例如：发布前联调" onChange={event => setTitle(event.target.value)} /></label><label>关联计划 id（可选）<input value={planId} placeholder="从「运行」页复制的计划 id" onChange={event => setPlanId(event.target.value)} /></label></div>
    <div className="sa-ops-actions"><button type="button" className="sa-button sa-primary" disabled={busy === 'create' || (!title.trim() && !planId.trim())} onClick={() => void attempt(notify, async () => { setBusy('create'); const result = await api.workCreateTeamRoom(projectId, { title: title.trim() || undefined, planId: planId.trim() || undefined }); setTitle(''); setPlanId(''); setActive(result.room); notify('团队房间已创建。'); await load(); }).finally(() => setBusy(''))}>创建房间</button></div>
    <div className="sa-ops-list">{rooms.map(room => <button type="button" className={`sa-ops-row sa-ops-row-button${active?.id === room.id ? ' is-on' : ''}`} key={room.id} onClick={() => void attempt(notify, async () => { const result = await api.workTeamRoom(room.id); setActive(result.room); }).then(() => {})}><div><strong>{room.title}</strong><span>{projectName(projects, room.projectId)} · {room.members.join('、') || '无成员'} · {statusNames[room.status] || room.status} · {room.messages.length} 条消息</span></div></button>)}</div>
    {active && <div className="sa-room">
      <div className="sa-section-head"><h3>{active.title}</h3><div className="sa-ops-row-actions"><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.workTeamRoom(active.id); setActive(result.room); })}>刷新</button><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workDeleteTeamRoom(active.id); setActive(null); await load(); })}>删除</button></div></div>
      <p className="sa-inline-note">{active.goal || '没有填写目标'} · 负责人 {active.lead || '未指定'}</p>
      <div className="sa-room-steps">{active.steps.map(step => <div key={step.ticketId} className="sa-room-step"><span>{step.index + 1}</span><div><strong>{step.title}</strong><em>{step.executorId} · {statusNames[step.status] || step.status}{step.attention ? ` · ${step.attention}` : ''}{step.claimedBy ? ` · 认领：${step.claimedBy}` : ''}</em></div>{!step.claimedBy && <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.workClaimTeamRoomTicket(active.id, { ticketId: step.ticketId, member: '我' }); setActive(result.room); })}>认领</button>}</div>)}</div>
      <div className="sa-room-messages">{active.messages.slice(-30).map(item => <p key={item.id}><time>{new Date(item.at).toLocaleTimeString()}</time><strong>{item.agent || item.kind}</strong><span>{item.text}</span></p>)}</div>
      <div className="sa-ops-actions"><input value={message} placeholder="给房间留一条消息" onChange={event => setMessage(event.target.value)} /><button type="button" className="sa-button" disabled={!message.trim()} onClick={() => void attempt(notify, async () => { const result = await api.workPostTeamRoomMessage(active.id, { text: message.trim(), agent: '我' }); setMessage(''); setActive(result.room); })}>发送</button></div>
      {active.decisions.length > 0 && <div className="sa-ops-list"><h4>决定日志</h4>{active.decisions.slice(-8).map(item => <div className="sa-ops-row" key={item.id}><div><strong>{item.by}</strong><span>{item.decision}</span></div></div>)}</div>}
    </div>}
  </div>;
}

function LivePanel({ windows, notify }: { windows: { handle: number; process: string; title: string }[]; notify: Notify }) {
  const [session, setSession] = useState<WorkLiveSession | null>(null);
  const [frame, setFrame] = useState('');
  const [busy, setBusy] = useState('');
  const [handle, setHandle] = useState(windows[0]?.handle || 0);
  useEffect(() => { if (!handle && windows[0]) setHandle(windows[0].handle); }, [windows, handle]);
  useEffect(() => {
    if (!session || session.status !== 'live') return;
    let alive = true;
    const pull = async () => {
      try {
        const result = await api.workLiveFrame(session.id);
        if (alive) setFrame(result.frame.image);
      } catch {
        // 暂停/接管或敏感标题触发后，同步会话状态并清掉最后一帧，避免界面继续显示旧画面。
        try {
          const current = await api.workLiveSession(session.id);
          if (!alive) return;
          setSession(current.session);
          if (current.session.status !== 'live') setFrame('');
        } catch { /* 会话已删除或网络中断，下一轮再试。 */ }
      }
    };
    void pull();
    const timer = setInterval(pull, 1000);
    return () => { alive = false; clearInterval(timer); };
  }, [session?.id, session?.status]);
  const selected = windows.find(item => item.handle === handle);
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>隐私门</dt><dd>窗口标题出现支付、密码、验证码、身份证等词时立即暂停并清空画面</dd></div><div><dt>接管</dt><dd>点「我接管」立即停止截图；画面只留在内存，不落盘</dd></div></dl>
    <div className="sa-ops-form"><label>窗口<select value={handle} onChange={event => setHandle(Number(event.target.value))}>{windows.length ? windows.map(window => <option key={window.handle} value={window.handle}>{window.title || window.process} · {window.process} · {window.handle}</option>) : <option value={0}>没有可用窗口</option>}</select></label></div>
    <div className="sa-ops-actions"><button type="button" className="sa-button sa-primary" disabled={busy === 'start' || !handle} onClick={() => void attempt(notify, async () => { setBusy('start'); const result = await api.startWorkLive({ handle, process: selected?.process, title: selected?.title }); setSession(result.session); setFrame(''); return result; }).finally(() => setBusy(''))}>开始观察</button></div>
    {!windows.length && <p className="sa-inline-note">没有检测到白名单窗口，请先在「团队」页刷新窗口列表。</p>}
    {session && <div className="sa-live">
      <div className="sa-section-head"><h3>{session.title || session.process} · {statusNames[session.status] || session.status}</h3><div className="sa-ops-row-actions">
        {session.status === 'live' && <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.pauseWorkLive(session.id); setSession(result.session); })}>暂停</button>}
        {session.status === 'paused' && <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.resumeWorkLive(session.id); setSession(result.session); })}>继续</button>}
        <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.takeoverWorkLive(session.id); setSession(result.session); setFrame(''); notify('已接管，截图停止。'); })}>我接管</button>
        <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.stopWorkLive(session.id); setSession(null); setFrame(''); })}>停止</button>
      </div></div>
      <p className="sa-inline-note">{session.pausedReason === 'sensitive-title' ? '标题包含敏感信息，采集已暂停。切换到普通页面后点「继续」。' : session.lastError || `每 ${session.intervalMs / 1000} 秒一帧 · 已采集 ${session.frames} 帧`}</p>
      {frame ? <img className="sa-live-frame" src={frame} alt="窗口实时画面" /> : <div className="sa-live-placeholder"><Square size={20} />{session.status === 'paused' ? '画面已暂停' : session.status === 'takeover' ? '已接管，不再显示远程画面' : '等待首帧…'}</div>}
    </div>}
  </div>;
}

