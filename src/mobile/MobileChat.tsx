import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Menu, MoreHorizontal, Plus, RefreshCw, Send, Terminal, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mobileApi, MobileApiError } from './mobile-api';
import { MobileCommand } from './MobileCommand';
import { MobileThinking } from './MobileThinking';
import {
  assistantReport, collaboratorEfforts, conversationTitle, groupConversations, lagentEfforts,
  mergeActivity, removeEffort, sanitizeEfforts, sanitizeSettings, setEffort, thinkingGroups, ticketIdsOfTurn,
  type ThinkingGroup
} from './mobile-chat-model';
import { effortLabel, isAgentKind, statusNames, time } from './display';
import type {
  MobileAgent, MobileBootstrap, MobileChatSettings, MobileConversation, MobileEfforts, MobileEvent,
  MobileModelProfile, MobileProject, MobileReport, MobileThinkingStep, MobileTicketState, MobileTurn
} from './types';
import './mobile-chat.css';

const SETTINGS_KEY = (id: string) => `lagent:mobile:chatmodel:v1:${id}`;
const LAST_KEY = 'lagent:mobile:chatmodel:last:v1';
const PROJECT_KEY = 'lagent:mobile:newproject:v1';
const MAX_LENGTH = 3000;

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : null;
  } catch { return null; }
}
function writeJson(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存储不可用时只保留本次会话。 */ }
}

function mergeTurns(existing: MobileTurn[], incoming: MobileTurn[]): MobileTurn[] {
  const map = new Map(existing.map(turn => [turn.id, turn]));
  for (const turn of incoming) map.set(turn.id, turn);
  return [...map.values()].sort((left, right) => left.index - right.index);
}

type StoredModel = { profileId?: string; effort?: string; efforts?: MobileEfforts };

export function MobileChat({ token, bootstrap, event, refreshKey, onOpenTicket, onToast, onUnauthorized, onReload }: {
  token: string;
  bootstrap: MobileBootstrap | null;
  event: MobileEvent | null;
  refreshKey: number;
  onOpenTicket: (id: string) => void;
  onToast: (message: string) => void;
  onUnauthorized: () => void;
  onReload: () => void;
}) {
  const [activeId, setActiveId] = useState('');
  const [conversation, setConversation] = useState<MobileConversation | null>(null);
  const [ticketStates, setTicketStates] = useState<Record<string, MobileTicketState>>({});
  const [liveSteps, setLiveSteps] = useState<Record<string, MobileThinkingStep[]>>({});
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState<'' | 'model' | 'agents' | 'project'>('');
  const [menuId, setMenuId] = useState('');
  const [tools, setTools] = useState(false);
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<'auto' | 'multi'>('auto');
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [efforts, setEfforts] = useState<MobileEfforts>({});
  const [settings, setSettings] = useState<MobileChatSettings | null>(null);
  const [projectId, setProjectId] = useState('');
  const [models, setModels] = useState<MobileModelProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [modelNotice, setModelNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [acting, setActing] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [fullText, setFullText] = useState<Record<string, string>>({});
  const clientRequestId = useRef('');
  const lastLoaded = useRef('');
  const loadedTickets = useRef(new Set<string>());

  const agents = bootstrap?.agents || [];
  const projects = bootstrap?.projects || [];
  const agentNames = useMemo(() => Object.fromEntries(agents.map(agent => [agent.id, agent.name])), [agents]);

  // 新会话默认项目与上次的模型选择。
  useEffect(() => {
    const storedProject = readJson<string>(PROJECT_KEY);
    if (typeof storedProject === 'string' && storedProject) setProjectId(storedProject);
    const stored = readJson<StoredModel>(LAST_KEY);
    if (stored) {
      setSettings(sanitizeSettings(stored));
      setEfforts(stored.efforts || {});
    }
  }, []);

  // 打开模型列表：只在需要时拉一次。
  useEffect(() => {
    if (sheet !== 'model' || models.length) return;
    let alive = true;
    mobileApi.models(token)
      .then(result => { if (!alive) return; setModels(result.profiles); setDefaultProfileId(result.defaultProfileId); })
      .catch(cause => { if (alive) onToast((cause as Error).message); });
    return () => { alive = false; };
  }, [sheet, models.length, token, onToast]);

  const applyStored = useCallback((id: string, next: MobileConversation | null) => {
    const stored = (id ? readJson<StoredModel>(SETTINGS_KEY(id)) : null) || readJson<StoredModel>(LAST_KEY);
    const nextSettings = sanitizeSettings(stored);
    if (nextSettings?.profileId && models.length) {
      const profile = models.find(item => item.id === nextSettings.profileId);
      if (!profile || !profile.available) {
        setSettings(nextSettings.effort ? { effort: nextSettings.effort } : null);
        setModelNotice('原模型不可用，已改用默认模型');
      } else setSettings(nextSettings);
    } else setSettings(nextSettings);
    setEfforts(stored?.efforts || {});
    if (!next) return;
    const last = next.turns[next.turns.length - 1];
    if (!last) return;
    if (last.mode === 'multi' || (last.agentIds || []).some(agentId => agentId !== 'model')) {
      setMode('multi');
      setCollaborators((last.agentIds || []).filter(agentId => agentId !== 'model').slice(0, 3));
    } else setMode('auto');
  }, [models]);

  const loadConversation = useCallback(async (id: string, options: { append?: boolean } = {}) => {
    if (!id) return;
    if (options.append) setLoadingMore(true); else setLoading(true);
    try {
      const result = await mobileApi.conversation(token, id, options.append && conversation?.nextBefore !== null
        ? { limit: 30, before: conversation?.nextBefore }
        : { limit: 30 });
      setConversation(previous => previous && previous.id === id
        ? {
          ...result.conversation,
          turns: options.append ? mergeTurns(previous.turns, result.conversation.turns) : mergeTurns(result.conversation.turns, previous.turns.filter(turn => !result.conversation.turns.some(fresh => fresh.id === turn.id))),
          hasMore: result.conversation.hasMore,
          nextBefore: result.conversation.nextBefore
        }
        : result.conversation);
      if (lastLoaded.current !== id) {
        lastLoaded.current = id;
        applyStored(id, result.conversation);
        if (result.conversation.projectId) setProjectId(result.conversation.projectId);
      }
      setError('');
    } catch (cause) {
      if (cause instanceof MobileApiError && cause.status === 401) { onUnauthorized(); return; }
      if (cause instanceof MobileApiError && cause.status === 404) {
        onToast('会话已不存在');
        setActiveId(''); setConversation(null);
        return;
      }
      setError((cause as Error).message);
    } finally {
      setLoading(false); setLoadingMore(false);
    }
  }, [applyStored, conversation?.nextBefore, onToast, onUnauthorized, token]);

  useEffect(() => {
    if (!activeId) { setConversation(null); setTicketStates({}); setLiveSteps({}); loadedTickets.current.clear(); return; }
    void loadConversation(activeId);
  }, [activeId]);

  useEffect(() => {
    if (!activeId || lastLoaded.current !== activeId) return;
    void loadConversation(activeId);
  }, [refreshKey]);

  // 只拉最近 12 个 ticket 详情，避免一次打满限流；其余在展开时再取。
  const visibleTicketIds = useMemo(() => {
    const ids: string[] = [];
    for (const turn of conversation?.turns || []) {
      for (const id of ticketIdsOfTurn(turn)) if (!ids.includes(id)) ids.push(id);
    }
    return ids.slice(-12);
  }, [conversation]);
  const ticketKey = visibleTicketIds.join(',');

  useEffect(() => {
    if (!ticketKey) return;
    let alive = true;
    const missing = visibleTicketIds.filter(id => !loadedTickets.current.has(id));
    if (!missing.length) return;
    void Promise.all(missing.map(id => mobileApi.ticket(token, id)
      .then(detail => [id, detail] as const)
      .catch(() => null)))
      .then(entries => {
        if (!alive) return;
        setTicketStates(previous => {
          const next = { ...previous };
          for (const entry of entries) {
            if (!entry) continue;
            loadedTickets.current.add(entry[0]);
            next[entry[0]] = { ticket: entry[1].ticket, activity: entry[1].activity || [], reports: entry[1].reports || [] };
          }
          return next;
        });
      });
    return () => { alive = false; };
  }, [ticketKey, refreshKey, token]);

  useEffect(() => {
    const ticketId = event?.ticketId;
    const steps = event?.payload?.activity;
    if (!ticketId || !Array.isArray(steps)) return;
    if (!visibleTicketIds.includes(ticketId)) return;
    setLiveSteps(previous => ({
      ...previous,
      [ticketId]: mergeActivity(previous[ticketId] || [], steps.map(step => ({ ...step, ticketId })))
    }));
  }, [event]);

  const persist = (nextSettings: MobileChatSettings | null, nextEfforts: MobileEfforts) => {
    const body: StoredModel = { ...(nextSettings || {}), efforts: nextEfforts };
    writeJson(LAST_KEY, body);
    if (activeId) writeJson(SETTINGS_KEY(activeId), body);
  };

  const chooseProfile = (profileId: string) => {
    const profile = models.find(item => item.id === profileId);
    const supported = lagentEfforts(profile);
    const effort = settings?.effort && supported.includes(settings.effort) ? settings.effort : 'default';
    const next: MobileChatSettings = { ...(profileId ? { profileId } : {}), ...(effort !== 'default' ? { effort } : {}) };
    setSettings(Object.keys(next).length ? next : null);
    setModelNotice('');
    persist(Object.keys(next).length ? next : null, efforts);
  };

  const chooseLagentEffort = (effort: string) => {
    const next: MobileChatSettings = { ...(settings || {}), ...(effort === 'default' ? {} : { effort }) };
    if (effort === 'default') delete next.effort;
    setSettings(Object.keys(next).length ? next : null);
    persist(Object.keys(next).length ? next : null, efforts);
  };

  const chooseProject = (id: string) => {
    setProjectId(id);
    writeJson(PROJECT_KEY, id);
    setSheet('');
  };

  const toggleAgent = (id: string) => {
    if (collaborators.includes(id)) {
      const next = collaborators.filter(item => item !== id);
      setCollaborators(next);
      setEfforts(previous => removeEffort(previous, id));
      return;
    }
    if (collaborators.length >= 3) { onToast('最多选择 3 个协作 Agent'); return; }
    setCollaborators([...collaborators, id]);
    setEfforts(previous => setEffort(previous, id, 'default'));
  };

  const chooseAgentEffort = (id: string, effort: string) => {
    setEfforts(previous => setEffort(previous, id, effort));
    persist(settings, setEffort(efforts, id, effort));
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    if (text.length > MAX_LENGTH) { setError(`消息不能超过 ${MAX_LENGTH} 字`); return; }
    if (mode === 'multi' && collaborators.length === 0) { setError('多 Agent 模式至少选择一个协作 Agent'); return; }
    if (bootstrap?.lagent && !bootstrap.lagent.ready) { setError('Lagent 尚未配置模型，请到电脑端设置'); return; }
    if (!clientRequestId.current) clientRequestId.current = `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    setBusy(true); setError('');
    try {
      let id = activeId;
      if (!id) {
        const created = await mobileApi.createConversation(token, {
          goal: text,
          ...(mode === 'multi' ? { agentIds: collaborators } : {}),
          ...(projectId ? { projectId } : {})
        });
        id = created.conversation.id;
        setActiveId(id);
        lastLoaded.current = id;
        setConversation({ ...created.conversation, turns: [], hasMore: false, nextBefore: null });
      }
      const agentIds = mode === 'multi' ? ['model', ...collaborators] : ['model'];
      const effortMap = sanitizeEfforts(agentIds, mode === 'multi'
        ? { ...efforts, ...(settings?.effort ? { model: settings.effort } : {}) }
        : (settings?.effort ? { model: settings.effort } : undefined));
      const result = await mobileApi.sendMessage(token, id, {
        text, mode,
        ...(mode === 'multi' ? { agentIds: collaborators } : {}),
        ...(settings ? { settings } : {}),
        ...(effortMap ? { efforts: effortMap } : {}),
        clientRequestId: clientRequestId.current
      });
      setDraft('');
      clientRequestId.current = '';
      setConversation(previous => previous && previous.id === id
        ? { ...previous, ...result.conversation, turns: mergeTurns(previous.turns, [result.turn]) }
        : { ...result.conversation, turns: [result.turn], hasMore: false, nextBefore: null });
      setTicketStates(previous => {
        const next = { ...previous };
        for (const ticket of result.tickets || []) {
          next[ticket.id] = next[ticket.id] || { ticket, activity: [], reports: [] };
        }
        return next;
      });
      onReload();
      window.setTimeout(() => { void loadConversation(id); }, 600);
    } catch (cause) {
      setError((cause as Error).message);
    } finally { setBusy(false); }
  };

  const decidePermission = async (ticketId: string, requestId: string, decision: 'allow' | 'deny') => {
    if (acting) return;
    setActing(`${ticketId}:${requestId}`);
    try {
      await mobileApi.permission(token, ticketId, requestId, decision);
      setTicketStates(previous => {
        const state = previous[ticketId];
        if (!state) return previous;
        return {
          ...previous,
          [ticketId]: {
            ...state,
            activity: state.activity.map(step => step.requestId === requestId ? { ...step, decided: true } : step)
          }
        };
      });
      setLiveSteps(previous => ({
        ...previous,
        [ticketId]: (previous[ticketId] || []).map(step => step.requestId === requestId ? { ...step, decided: true } : step)
      }));
      onToast('已提交确认');
      const detail = await mobileApi.ticket(token, ticketId);
      setTicketStates(previous => ({ ...previous, [ticketId]: { ticket: detail.ticket, activity: detail.activity || [], reports: detail.reports || [] } }));
    } catch (cause) {
      onToast((cause as Error).message || '这次确认已失效');
    } finally { setActing(''); }
  };

  const loadFullText = async (report: MobileReport) => {
    try {
      const result = await mobileApi.reportText(token, report.id);
      setFullText(previous => ({ ...previous, [report.id]: result.text }));
    } catch (cause) { onToast((cause as Error).message); }
  };

  const renameConversation = async (id: string, title: string) => {
    const next = window.prompt('重命名会话', title);
    if (!next || !next.trim() || next.trim() === title) return;
    try {
      await mobileApi.renameConversation(token, id, next.trim());
      onToast('已重命名');
      onReload();
      if (id === activeId) void loadConversation(id);
    } catch (cause) { onToast((cause as Error).message); }
    finally { setMenuId(''); }
  };

  const deleteConversation = async (id: string) => {
    if (!window.confirm('只删除会话记录，已派出的任务会继续在电脑端执行。确定删除？')) return;
    try {
      await mobileApi.deleteConversation(token, id);
      onToast('会话已删除');
      if (id === activeId) { setActiveId(''); setConversation(null); setTicketStates({}); }
      onReload();
    } catch (cause) { onToast((cause as Error).message); }
    finally { setMenuId(''); }
  };

  const newConversation = () => {
    setActiveId(''); setConversation(null); setTicketStates({}); setLiveSteps({});
    setDraft(''); setError(''); setMode('auto'); setCollaborators([]);
    lastLoaded.current = '';
    setDrawer(false);
  };

  const projectName = (id?: string | null) => id ? (projects.find(project => project.id === id)?.name || '项目') : '';
  const activeProfile = settings?.profileId ? models.find(item => item.id === settings.profileId) : null;
  const modelLabel = activeProfile?.name || '默认模型';
  const canSend = Boolean(draft.trim() && draft.trim().length <= MAX_LENGTH && !busy && (mode === 'auto' || collaborators.length > 0));

  return <div className="mob-chat">
    <header className="mob-chat-head">
      <button type="button" className="mob-icon" aria-label="会话列表" onClick={() => setDrawer(true)}><Menu size={18} /></button>
      <button type="button" className="mob-chat-title" onClick={() => setSheet('model')}>
        <strong>{conversation ? conversationTitle(conversation) : '新对话'}</strong>
        <span className="mob-chip">{modelLabel}{settings?.effort && settings.effort !== 'default' ? ` · ${effortLabel(settings.effort)}` : ''}</span>
      </button>
      <button type="button" className="mob-icon" aria-label="会话操作" onClick={() => setDrawer(true)}><MoreHorizontal size={18} /></button>
    </header>
    {modelNotice && <p className="mob-banner">{modelNotice}</p>}
    {bootstrap?.lagent && !bootstrap.lagent.ready && <p className="mob-banner">Lagent 尚未配置模型，请到电脑端设置</p>}
    <main className="mob-chat-body">
      {conversation?.hasMore && <button type="button" className="mob-load-more" disabled={loadingMore} onClick={() => void loadConversation(activeId, { append: true })}>{loadingMore ? '正在加载…' : '加载更早'}</button>}
      {!conversation && !loading && <div className="mob-chat-empty"><h1>今天想让我做什么？</h1><p>选择工作文件夹，或直接开始；需要时再切换多 Agent。</p></div>}
      {loading && !conversation && <p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在载入会话…</p>}
      {conversation?.turns.map(turn => {
        const groups: ThinkingGroup[] = thinkingGroups(turn, ticketStates, liveSteps, agentNames);
        const running = groups.some(group => group.status === 'working' || group.status === 'queued');
        const open = expanded[turn.id] ?? running;
        const report = assistantReport(turn, ticketStates);
        const body = report ? (fullText[report.id] ?? report.text ?? report.summary ?? '') : '';
        const truncated = Boolean(report?.truncated && fullText[report.id] === undefined);
        return <article className="mob-turn" key={turn.id}>
          <p className="mob-msg user">{turn.prompt}</p>
          <MobileThinking
            groups={groups} running={running} open={open}
            onToggle={() => setExpanded(previous => ({ ...previous, [turn.id]: !open }))}
            busy={Boolean(acting)} onDecide={decidePermission}
          />
          {body && <div className="mob-msg assistant">
            <div className="mob-md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown></div>
            <div className="mob-msg-actions">
              <button type="button" className="mob-tiny" onClick={() => { void navigator.clipboard?.writeText(body); onToast('已复制'); }}>复制</button>
              {truncated && <button type="button" className="mob-tiny" onClick={() => void loadFullText(report!)}>展开全文</button>}
            </div>
          </div>}
        </article>;
      })}
      {error && <p className="mob-error" role="alert">{error}</p>}
    </main>
    <div className="mob-composer-bar">
      <div className="mob-mode-tabs" role="group" aria-label="Agent 模式">
        <button type="button" className={mode === 'auto' ? 'active' : ''} onClick={() => setMode('auto')}>单 Agent</button>
        <button type="button" className={mode === 'multi' ? 'active' : ''} onClick={() => setMode('multi')}>多 Agent</button>
        {mode === 'multi' && <button type="button" className={collaborators.length ? 'active' : ''} onClick={() => setSheet('agents')}>协作 Agent ({collaborators.length})</button>}
        {!conversation && <button type="button" className={projectId ? 'active' : ''} onClick={() => setSheet('project')}>{projectId ? projectName(projectId) : '工作文件夹'}</button>}
        {conversation?.projectId && <span className="mob-chip">{projectName(conversation.projectId)}</span>}
      </div>
      <div className="mob-composer-input">
        <textarea
          value={draft} rows={1} aria-label="消息"
          onChange={input => setDraft(input.target.value)}
          placeholder={mode === 'multi' ? '描述任务，协作 Agent 会按分工执行…' : '输入消息…'}
        />
        <button type="button" className="mob-send" aria-label="发送" disabled={!canSend} onClick={() => void send()}>
          {busy ? <RefreshCw size={17} className="mob-spin" /> : <Send size={17} />}
        </button>
      </div>
      {draft.length > MAX_LENGTH && <p className="mob-error">已超过 {MAX_LENGTH} 字，请删减后再发送。</p>}
      {mode === 'multi' && collaborators.length === 0 && <p className="mob-hint">多 Agent 模式至少选择一个协作 Agent。</p>}
    </div>

    {drawer && <div className="mob-drawer-layer" role="dialog" aria-modal="true" aria-label="会话列表">
      <button type="button" className="mob-drawer-backdrop" aria-label="关闭会话列表" onClick={() => { setDrawer(false); setMenuId(''); }} />
      <aside className="mob-drawer">
        <header className="mob-sheet-head"><div><strong>会话</strong><span>最近的对话</span></div><button type="button" className="mob-icon" aria-label="关闭" onClick={() => { setDrawer(false); setMenuId(''); }}><X size={18} /></button></header>
        <div className="mob-drawer-body">
          <button type="button" className="mob-primary mob-drawer-new" onClick={newConversation}><Plus size={15} />新对话</button>
          {groupConversations(bootstrap?.conversations || []).map(group => <div key={group.label}>
            <p className="mob-drawer-group">{group.label}</p>
            {group.items.map(item => <div key={item.id}>
              <div className={`mob-drawer-item ${item.id === activeId ? 'active' : ''}`}>
                <button type="button" className="mob-drawer-open" onClick={() => { setActiveId(item.id); setDrawer(false); setMenuId(''); }}>
                  <span className={`mob-dot mob-dot-${item.status}`} aria-hidden="true" />
                  <span>{conversationTitle(item)}</span>
                  {item.projectId && <small>{projectName(item.projectId)}</small>}
                  <time>{time(item.updatedAt)}</time>
                </button>
                <button type="button" className="mob-icon" aria-label={`操作 ${conversationTitle(item)}`} onClick={() => setMenuId(menuId === item.id ? '' : item.id)}><MoreHorizontal size={16} /></button>
              </div>
              {menuId === item.id && <div className="mob-drawer-menu">
                <button type="button" className="mob-tiny" onClick={() => void renameConversation(item.id, conversationTitle(item))}>重命名</button>
                <button type="button" className="mob-tiny ghost" onClick={() => void deleteConversation(item.id)}>删除</button>
              </div>}
            </div>)}
          </div>)}
          {!bootstrap?.conversations?.length && <p className="mob-hint">还没有会话。发出第一条消息就会创建。</p>}
        </div>
        <div className="mob-drawer-actions">
          <button type="button" className="mob-secondary" onClick={() => { setDrawer(false); setTools(true); }}><Terminal size={15} />工具指令</button>
        </div>
      </aside>
    </div>}

    {sheet === 'model' && <ModelSheet
      profiles={models} settings={settings} defaultProfileId={defaultProfileId} onClose={() => setSheet('')}
      onProfile={chooseProfile} onEffort={chooseLagentEffort} running={conversation?.status === 'working'}
    />}
    {sheet === 'agents' && <AgentsSheet
      agents={agents} allowed={bootstrap?.policy?.allowedExecutors || []} selected={collaborators} efforts={efforts}
      onClose={() => setSheet('')} onToggle={toggleAgent} onEffort={chooseAgentEffort}
    />}
    {sheet === 'project' && <ProjectSheet projects={projects} selected={projectId} onClose={() => setSheet('')} onChoose={chooseProject} />}

    {tools && <div className="mob-sheet-layer" role="dialog" aria-modal="true" aria-label="工具指令">
      <button type="button" className="mob-sheet-backdrop" aria-label="关闭" onClick={() => setTools(false)} />
      <div className="mob-sheet mob-sheet-full">
        <header className="mob-sheet-head"><div><strong>工具指令</strong><span>只执行一次具体操作</span></div><button type="button" className="mob-icon" aria-label="关闭" onClick={() => setTools(false)}><X size={18} /></button></header>
        <div className="mob-sheet-body">
          <MobileCommand
            token={token} bootstrap={bootstrap} loading={false} error="" allowed={bootstrap?.policy?.allowedExecutors || []} agents={agents}
            onSent={ticket => { setTools(false); onToast('指令已提交'); onOpenTicket(ticket.id); onReload(); }}
          />
        </div>
      </div>
    </div>}
  </div>;
}

function Sheet({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="mob-sheet-layer" role="dialog" aria-modal="true" aria-label={title}>
    <button type="button" className="mob-sheet-backdrop" aria-label="关闭" onClick={onClose} />
    <div className="mob-sheet">
      <header className="mob-sheet-head"><div><strong>{title}</strong>{subtitle && <span>{subtitle}</span>}</div><button type="button" className="mob-icon" aria-label="关闭" onClick={onClose}><X size={18} /></button></header>
      <div className="mob-sheet-body">{children}</div>
    </div>
  </div>;
}

function ModelSheet({ profiles, settings, defaultProfileId, onProfile, onEffort, onClose, running }: {
  profiles: MobileModelProfile[]; settings: MobileChatSettings | null; defaultProfileId: string | null;
  onProfile: (id: string) => void; onEffort: (effort: string) => void; onClose: () => void; running: boolean;
}) {
  const active = profiles.find(profile => profile.id === settings?.profileId);
  const options = lagentEfforts(active || null);
  return <Sheet title="Lagent 模型" subtitle="只作用于主控 Lagent" onClose={onClose}>
    <button type="button" className="mob-sheet-option" disabled={!profiles.length} onClick={() => onProfile('')}>
      <span className="mob-radio">{settings?.profileId ? '' : <Check size={13} />}</span>
      <span>默认模型<small>{!profiles.length ? '尚未配置模型中心' : '跟随桌面默认配置'}</small></span>
    </button>
    {profiles.map(profile => <button type="button" key={profile.id} className="mob-sheet-option" disabled={!profile.available} onClick={() => onProfile(profile.id)}>
      <span className="mob-radio">{settings?.profileId === profile.id ? <Check size={13} /> : ''}</span>
      <span>{profile.name}<small>{profile.model}{profile.id === defaultProfileId ? ' · 桌面默认' : ''}{!profile.available ? ' · 当前不可用' : ''}</small></span>
    </button>)}
    <div className="mob-sheet-section">
      <p className="mob-drawer-group">Lagent 思考强度</p>
      <div className="mob-effort-row">
        {options.map(effort => <button type="button" key={effort} className={settings?.effort === effort || (effort === 'default' && !settings?.effort) ? 'active' : ''} onClick={() => onEffort(effort)}>{effortLabel(effort)}</button>)}
      </div>
      {running && <p className="mob-hint">运行中切换会在下一轮生效。</p>}
      {!active?.efforts?.length && <p className="mob-hint">当前模型没有声明强度档位，只显示标准档并标注「未验证」。</p>}
    </div>
  </Sheet>;
}

function AgentsSheet({ agents, allowed, selected, efforts, onToggle, onEffort, onClose }: {
  agents: MobileAgent[]; allowed: string[]; selected: string[]; efforts: MobileEfforts;
  onToggle: (id: string) => void; onEffort: (id: string, effort: string) => void; onClose: () => void;
}) {
  const list = agents.filter(agent => isAgentKind(agent.kind) && agent.id !== 'model' && (!allowed.length || allowed.includes(agent.id)));
  return <Sheet title="协作 Agent" subtitle="最多 3 个；模型沿用电脑端默认" onClose={onClose}>
    {list.map(agent => {
      const checked = selected.includes(agent.id);
      const available = agent.status === 'available';
      return <div className="mob-agent-row" key={agent.id}>
        <label className="mob-agent-main">
          <input type="checkbox" checked={checked} disabled={!available} onChange={() => onToggle(agent.id)} />
          <span>{agent.name}{!available ? '（不可用）' : ''}</span>
        </label>
        <select
          aria-label={`${agent.name} 思考强度`} value={efforts[agent.id] || 'default'} disabled={!checked}
          onChange={event => onEffort(agent.id, event.target.value)}
        >
          {collaboratorEfforts().map(effort => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
        </select>
      </div>;
    })}
    {!list.length && <p className="mob-hint">没有可协作的 Agent。请确认电脑端已启用并允许外部 Agent。</p>}
    <p className="mob-hint">外部 Agent 没有能力声明，强度档位标为「未验证」；被拒时会回落到模型默认。</p>
  </Sheet>;
}

function ProjectSheet({ projects, selected, onChoose, onClose }: {
  projects: MobileProject[]; selected: string; onChoose: (id: string) => void; onClose: () => void;
}) {
  const tail = (path?: string) => (path || '').replaceAll('\\', '/').split('/').filter(Boolean).slice(-2).join('/');
  return <Sheet title="工作文件夹" subtitle="只包含电脑端已导入的项目" onClose={onClose}>
    <button type="button" className="mob-sheet-option" onClick={() => onChoose('')}>
      <span className="mob-radio">{selected ? '' : <Check size={13} />}</span>
      <span>不绑定项目<small>使用默认工作区</small></span>
    </button>
    {projects.map(project => <button type="button" key={project.id} className="mob-sheet-option" onClick={() => onChoose(project.id)}>
      <span className="mob-radio">{selected === project.id ? <Check size={13} /> : ''}</span>
      <span>{project.name}<small>{tail(project.path)}{project.gitBranch ? ` · ${project.gitBranch}` : ''}</small></span>
    </button>)}
    {!projects.length && <p className="mob-hint">电脑端还没有导入项目。先开始对话，之后再绑定也可以。</p>}
  </Sheet>;
}
