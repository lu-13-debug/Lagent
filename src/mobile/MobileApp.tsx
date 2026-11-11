import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Inbox, ListChecks, Moon, RefreshCw, Send, Settings2, ShieldCheck, Sun, Terminal, Unplug } from 'lucide-react';
import './mobile.css';

type MobileDevice = { deviceId: string; deviceToken: string; expiresAt: string; name?: string };
type MobileOption = { id?: string; label?: string; action?: string };
type MobileAttention = { question?: string; createdAt?: string; options?: MobileOption[] };
type MobileTicket = {
  id: string; title?: string; summary?: string; status: string; stage?: string; source?: string;
  executor?: string; datasetId?: string; createdAt?: string; updatedAt?: string; attention?: MobileAttention;
  parentTicketId?: string | null; chainRootId?: string | null; handoffDepth?: number; handoffSummary?: string; handoffChildId?: string | null;
  planId?: string | null; planStep?: number | null; planTotal?: number | null;
};
type MobileReport = { id: string; ticketId?: string; assignmentId?: string; kind?: string; summary?: string; createdAt?: string };
type MobileTeamNode = { id: string; parentId?: string | null; depth?: number; status?: string; proposals?: { id: string; kind: string; status: string }[] };
type MobileDetail = { ticket: MobileTicket; assignments: { id: string; executor?: string; status?: string }[]; reports: MobileReport[]; team?: { nodes: MobileTeamNode[]; cancelled?: boolean } };
type MobileDataset = { id: string; name: string; rowCount?: number; source?: string };
type MobileAgent = { id: string; name: string; kind?: string; status?: string; capabilities?: string[] };
type MobileNotification = { id: string; ticketId?: string; title: string; status: string; summary: string; createdAt: string; unread: boolean };
type MobileBootstrap = {
  tickets: MobileTicket[]; attention: { ticketId: string; title?: string; question?: string; createdAt?: string; options?: MobileOption[] }[];
  datasets: MobileDataset[]; agents: MobileAgent[]; policy?: { allowedExecutors?: string[] }; notifications?: { unread?: number };
  plans?: { id: string; goal: string; status: string; currentStep: number; totalSteps: number; updatedAt?: string }[];
};

const DEVICE_KEY = 'lagent:mobile:device:v1';
const BOOT_APPEARANCE_KEY = 'lagent:appearance:boot:v1';
const statusNames: Record<string, string> = {
  queued: '排队中', working: '执行中', awaiting_review: '待确认', blocked: '受阻', failed: '失败',
  waiting: '等待触发', completed: '已完成', cancelled: '已停止', pending: '待执行', running: '执行中', accepted: '已接受'
};
const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

class MobileApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }

function readDevice(): MobileDevice | null {
  try {
    const raw = localStorage.getItem(DEVICE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MobileDevice>;
    return typeof parsed.deviceToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(parsed.deviceToken) && typeof parsed.deviceId === 'string'
      ? { deviceId: parsed.deviceId, deviceToken: parsed.deviceToken, expiresAt: String(parsed.expiresAt || ''), name: parsed.name }
      : null;
  } catch { return null; }
}

function saveDevice(device: MobileDevice) { try { localStorage.setItem(DEVICE_KEY, JSON.stringify(device)); } catch { /* 存储不可用时仅保留本次会话。 */ } }
function clearDevice() { try { localStorage.removeItem(DEVICE_KEY); } catch { /* 忽略清理失败。 */ } }

async function mobileRequest<T>(path: string, token: string, options: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(30000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`/api/mobile${path}`, {
    ...options,
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    credentials: 'same-origin', cache: 'no-store',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new MobileApiError(body?.error || `请求失败（${response.status}）`, response.status);
  return body as T;
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.dataset.themeFix = '';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#0d1110' : '#f2f4f3');
    try { localStorage.setItem(BOOT_APPEARANCE_KEY, JSON.stringify({ theme: next, view: 'concise' })); } catch { /* 忽略。 */ }
    setTheme(next);
  };
  return { theme, toggle };
}

function useServerEvents(token: string, onEvent: () => void, onUnauthorized: () => void) {
  const [online, setOnline] = useState(false);
  const handler = useRef(onEvent);
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { handler.current = onEvent; unauthorized.current = onUnauthorized; }, [onEvent, onUnauthorized]);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    const run = async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          const response = await fetch('/api/mobile/events', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' });
          if (response.status === 401) { unauthorized.current(); return; }
          if (!response.ok || !response.body) throw new Error('events unavailable');
          setOnline(true); delay = 1000;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let split = buffer.indexOf('\n\n');
            while (split >= 0) {
              const chunk = buffer.slice(0, split); buffer = buffer.slice(split + 2);
              const data = chunk.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (data) handler.current();
              split = buffer.indexOf('\n\n');
            }
          }
        } catch { if (stopped || controller.signal.aborted) return; }
        if (stopped) return;
        setOnline(false);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 10000);
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); };
  }, [token]);
  return online;
}

export function MobileApp() {
  useEffect(() => {
    document.title = 'Lagent 指挥台';
    return () => { document.title = 'Lagent · 数据分析工作台'; };
  }, []);
  const [capability, setCapability] = useState<'checking' | 'ready' | 'off'>('checking');
  useEffect(() => {
    let alive = true;
    fetch('/api/runtime', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) })
      .then(response => response.json())
      .then(value => { if (alive) setCapability(value?.capabilities?.superagent ? 'ready' : 'off'); })
      .catch(() => { if (alive) setCapability('ready'); });
    return () => { alive = false; };
  }, []);
  const [device, setDevice] = useState<MobileDevice | null>(() => readDevice());
  if (capability === 'checking') return <main className="mob-pair"><p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在确认指挥服务…</p></main>;
  if (capability === 'off') return <main className="mob-pair">
    <header className="mob-brand"><span className="brand-dot" /><strong>Lagent</strong><small>PERSONAL AGENT</small></header>
    <section className="mob-pair-card"><p className="mob-eyebrow">REMOTE CONTROL</p><h1>手机指挥尚未启用</h1><p>请在电脑端启用 Work 指挥服务后再打开本页。云端账号版默认提供此能力。</p><p className="mob-note"><ShieldCheck size={13} />本地开发可设置 <code>LAGENT_WORK_ENABLED=1</code>。</p></section>
  </main>;
  if (!device) return <PairScreen onPaired={device => { saveDevice(device); setDevice(device); }} />;
  return <MobileHome device={device} onSignOut={() => { clearDevice(); setDevice(null); }} />;
}

function PairScreen({ onPaired }: { onPaired: (device: MobileDevice) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('我的手机');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(code) || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/mobile/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, deviceName: name.trim() || '我的手机' }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error || '配对失败，请重新生成配对码。');
      onPaired({ deviceId: body.deviceId, deviceToken: body.deviceToken, expiresAt: body.expiresAt, name: name.trim() || '我的手机' });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <main className="mob-pair">
    <header className="mob-brand"><span className="brand-dot" /><strong>Lagent</strong><small>PERSONAL AGENT</small></header>
    <section className="mob-pair-card">
      <p className="mob-eyebrow">REMOTE CONTROL</p>
      <h1>连接你的指挥台</h1>
      <p>在电脑端打开「设置 → 手机指挥」生成配对码，然后在这里输入。配对后即可远程查看任务、审批和下达指令。</p>
      <form onSubmit={submit}>
        <label>配对码<input value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="6 位数字" aria-label="六位配对码" /></label>
        <label>设备名称<input value={name} onChange={event => setName(event.target.value.slice(0, 64))} maxLength={64} placeholder="我的手机" /></label>
        {error && <p className="mob-error" role="alert">{error}</p>}
        <button type="submit" className="mob-primary" disabled={busy || !/^\d{6}$/.test(code)}>{busy ? <RefreshCw size={16} className="mob-spin" /> : <ShieldCheck size={16} />}{busy ? '正在配对' : '连接'}</button>
      </form>
      <p className="mob-note">配对码 5 分钟内有效，只能使用一次。设备丢失时请在电脑端撤销。</p>
    </section>
  </main>;
}

function MobileHome({ device, onSignOut }: { device: MobileDevice; onSignOut: () => void }) {
  const [bootstrap, setBootstrap] = useState<MobileBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'command' | 'inbox' | 'tickets' | 'settings'>('command');
  const [detailId, setDetailId] = useState('');
  const [detail, setDetail] = useState<MobileDetail | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState<MobileNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const { theme, toggle } = useTheme();

  const unauthorized = useCallback(() => onSignOut(), [onSignOut]);
  const reload = useCallback(() => setRefreshKey(value => value + 1), []);
  const online = useServerEvents(device.deviceToken, reload, unauthorized);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    mobileRequest<MobileBootstrap>('/bootstrap', device.deviceToken)
      .then(value => { if (alive) setBootstrap(value); })
      .catch(cause => {
        if (!alive) return;
        if (cause instanceof MobileApiError && cause.status === 401) { onSignOut(); return; }
        setError((cause as Error).message);
      })
      .finally(() => { if (alive) setLoading(false); });
    const timer = setInterval(() => setRefreshKey(value => value + 1), 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [device.deviceToken, refreshKey, onSignOut]);

  useEffect(() => {
    if (typeof bootstrap?.notifications?.unread === 'number') setUnread(bootstrap.notifications.unread);
  }, [bootstrap]);

  useEffect(() => {
    if (tab !== 'inbox') return;
    let alive = true;
    mobileRequest<{ notifications: MobileNotification[]; unread: number }>('/notifications?limit=50', device.deviceToken)
      .then(value => { if (alive) { setNotifications(value.notifications); setUnread(value.unread); } })
      .catch(cause => {
        if (!alive) return;
        if (cause instanceof MobileApiError && cause.status === 401) onSignOut();
      });
    return () => { alive = false; };
  }, [tab, refreshKey, device.deviceToken, onSignOut]);

  const markNotificationRead = async (id: string) => {
    try {
      const result = await mobileRequest<{ unread: number }>(`/notifications/${encodeURIComponent(id)}/read`, device.deviceToken, { method: 'POST', body: '{}' });
      setNotifications(previous => previous.map(item => item.id === id ? { ...item, unread: false } : item));
      setUnread(result.unread);
    } catch { /* 打开详情优先于已读状态。 */ }
  };
  const markAllNotificationsRead = async () => {
    try {
      await mobileRequest('/notifications/read-all', device.deviceToken, { method: 'POST', body: '{}' });
      setNotifications(previous => previous.map(item => ({ ...item, unread: false })));
      setUnread(0);
    } catch (cause) { setNotice((cause as Error).message); }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!detailId) { setDetail(null); return; }
    let alive = true;
    mobileRequest<MobileDetail>(`/tickets/${encodeURIComponent(detailId)}`, device.deviceToken)
      .then(value => { if (alive) setDetail(value); })
      .catch(cause => { if (alive) setNotice((cause as Error).message); });
    return () => { alive = false; };
  }, [detailId, device.deviceToken, refreshKey]);

  const act = async (ticketId: string, action: string, input?: Record<string, unknown>) => {
    try {
      await mobileRequest(`/tickets/${encodeURIComponent(ticketId)}/actions`, device.deviceToken, { method: 'POST', body: JSON.stringify({ action, ...(input ? { input } : {}) }) });
      setNotice('操作已提交。'); reload();
    } catch (cause) { setNotice((cause as Error).message); }
  };
  const handoff = async (ticketId: string, executorId: string, text?: string) => {
    try {
      const source = tickets.find(ticket => ticket.id === ticketId);
      const executorInput = ['codex', 'claude-code'].includes(executorId) ? { prompt: text || source?.title || '继续处理上一棒任务' } : undefined;
      const result = await mobileRequest<{ ticket: MobileTicket }>(`/tickets/${encodeURIComponent(ticketId)}/actions`, device.deviceToken, {
        method: 'POST', body: JSON.stringify({ action: 'handoff', input: { executorId, ...(text ? { text } : {}), ...(executorInput ? { executorInput } : {}) } }),
      });
      setNotice('已交给下一棒 Agent。'); setDetailId(result.ticket.id); reload();
    } catch (cause) { setNotice((cause as Error).message); }
  };

  const tickets = bootstrap?.tickets || [];
  const attention = bootstrap?.attention || [];
  const datasets = bootstrap?.datasets || [];
  const agents = bootstrap?.agents || [];
  const allowed = bootstrap?.policy?.allowedExecutors || ['analysis'];
  const detailTicket = detail?.ticket || tickets.find(ticket => ticket.id === detailId);

  return <div className="mob-shell">
    <header className="mob-topbar">
      <div className="mob-brand"><span className="brand-dot" /><strong>Lagent</strong></div>
      <div className="mob-topbar-actions">
        <span className={`mob-online ${online ? 'is-online' : ''}`} role="status"><span className="online-dot" />{online ? '在线' : '重连中'}</span>
        <button type="button" className="mob-icon" onClick={toggle} aria-label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}>{theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}</button>
        <button type="button" className="mob-icon" onClick={() => { setTab('settings'); setDetailId(''); }} aria-label="设置"><Settings2 size={17} /></button>
      </div>
    </header>

    <main className="mob-content">
      {detailId ? <TicketDetail detail={detail} ticket={detailTicket} busy={false} agents={agents} allowed={allowed} datasets={datasets} onBack={() => setDetailId('')} onOpen={setDetailId} onAct={act} onHandoff={handoff} /> : tab === 'command' ? <CommandView
        token={device.deviceToken}
        bootstrap={bootstrap} loading={loading} error={error} allowed={allowed} agents={agents} datasets={datasets}
        onSent={ticket => { setNotice('指令已提交，Agent 正在处理。'); setDetailId(ticket.id); setTab('tickets'); reload(); }}
      /> : tab === 'inbox' ? <InboxView attention={attention} tickets={tickets} datasets={datasets} notifications={notifications} unread={unread} onOpen={setDetailId} onAct={act} onReadAll={markAllNotificationsRead} onOpenNotification={id => { void markNotificationRead(id); setDetailId(id); }} />
        : tab === 'tickets' ? <TicketsView tickets={tickets} plans={bootstrap?.plans || []} loading={loading} onOpen={setDetailId} />
          : <SettingsView device={device} theme={theme} onTheme={toggle} onSignOut={onSignOut} />}
    </main>

    {notice && <div className="mob-toast" role="status">{notice}</div>}
    <nav className="mob-nav" aria-label="主导航">
      <button type="button" className={tab === 'command' && !detailId ? 'active' : ''} onClick={() => { setTab('command'); setDetailId(''); }}><Terminal size={19} /><span>指挥</span></button>
      <button type="button" className={tab === 'inbox' && !detailId ? 'active' : ''} onClick={() => { setTab('inbox'); setDetailId(''); }}><Inbox size={19} /><span>收件箱</span>{(attention.length || unread) > 0 && <em>{attention.length || unread}</em>}</button>
      <button type="button" className={tab === 'tickets' && !detailId ? 'active' : ''} onClick={() => { setTab('tickets'); setDetailId(''); }}><ListChecks size={19} /><span>任务</span></button>
      <button type="button" className={tab === 'settings' && !detailId ? 'active' : ''} onClick={() => { setTab('settings'); setDetailId(''); }}><Settings2 size={19} /><span>设置</span></button>
    </nav>
  </div>;
}

function CommandView({ token, bootstrap, loading, error, allowed, agents, datasets, onSent }: {
  token: string; bootstrap: MobileBootstrap | null; loading: boolean; error: string; allowed: string[]; agents: MobileAgent[]; datasets: MobileDataset[];
  onSent: (ticket: MobileTicket) => void;
}) {
  const available = useMemo(() => agents.filter(agent => allowed.includes(agent.id)), [agents, allowed]);
  const [text, setText] = useState('');
  const [executorId, setExecutorId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  const [program, setProgram] = useState('git');
  const [args, setArgs] = useState('status --short');
  const [url, setUrl] = useState('');
  const [githubAction, setGithubAction] = useState('repo');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [number, setNumber] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!available.length) { setExecutorId(''); return; }
    if (!available.some(agent => agent.id === executorId)) setExecutorId(available[0].id);
  }, [available, executorId]);
  useEffect(() => { if (datasets.length === 1) setDatasetId(datasets[0].id); }, [datasets]);

  const current = available.find(agent => agent.id === executorId);
  const needsDataset = executorId === 'analysis';
  const canSend = Boolean(text.trim() && executorId && current?.status === 'available' && (!needsDataset || datasetId) && !busy);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    let executorInput: Record<string, unknown> | undefined;
    if (executorId === 'terminal') executorInput = { program, args: args.trim().split(/\s+/).filter(Boolean) };
    else if (executorId === 'codex' || executorId === 'claude-code') executorInput = { prompt: text.trim().slice(0, 12000) };
    else if (executorId === 'browser') {
      if (!/^https?:\/\//i.test(url.trim())) { setMessage('请填写 http/https 页面地址。'); return; }
      executorInput = { url: url.trim() };
    } else if (executorId === 'github') {
      if (!owner.trim() || !repo.trim()) { setMessage('请填写 GitHub owner 和 repo。'); return; }
      executorInput = { action: githubAction, owner: owner.trim(), repo: repo.trim(), ...(number.trim() ? { number: Number(number) } : {}), ...(githubAction === 'file' ? { path: path.trim() } : {}) };
    }
    setBusy(true); setMessage('');
    try {
      const response = await mobileRequest<{ ticket: MobileTicket }>('/command', token, {
        method: 'POST',
        body: JSON.stringify({ text: text.trim(), clientRequestId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, executorId, executorInput, ...(needsDataset && datasetId ? { datasetId } : {}) }),
      });
      setText(''); onSent(response.ticket);
    } catch (cause) { setMessage((cause as Error).message); }
    finally { setBusy(false); }
  };

  if (loading && !bootstrap) return <p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在载入指挥台…</p>;
  if (error && !bootstrap) return <section className="mob-empty"><AlertTriangle size={22} /><h2>无法载入指挥台</h2><p>{error}</p></section>;

  return <section className="mob-page">
    <p className="mob-eyebrow">PERSONAL AGENT</p>
    <h1>今天想让我做什么？</h1>
    <p className="mob-lead">从手机下达指令，Agent 会处理并在需要你确认时进入收件箱。</p>
    <form className="mob-composer" onSubmit={submit}>
      <textarea value={text} onChange={event => setText(event.target.value)} rows={4} placeholder="例如：检查仓库 CI，修复失败项并总结结果" aria-label="指令" />
      <div className="mob-field-row">
        <label>执行器<select value={executorId} onChange={event => setExecutorId(event.target.value)}>{available.length ? available.map(agent => <option key={agent.id} value={agent.id} disabled={agent.status !== 'available'}>{agent.name}{agent.status !== 'available' ? '（不可用）' : ''}</option>) : <option value="">无可用执行器</option>}</select></label>
        {needsDataset && <label>数据集<select value={datasetId} onChange={event => setDatasetId(event.target.value)}><option value="">{datasets.length ? '请选择数据集' : '暂无数据集'}</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}{dataset.rowCount ? ` · ${dataset.rowCount.toLocaleString()} 行` : ''}</option>)}</select></label>}
      </div>
      {executorId === 'terminal' && <div className="mob-field-row">
        <label>程序<select value={program} onChange={event => setProgram(event.target.value)}><option value="git">git</option><option value="npm">npm</option><option value="ls">ls</option><option value="pwd">pwd</option></select></label>
        <label>参数<input value={args} onChange={event => setArgs(event.target.value)} placeholder="status --short" /></label>
      </div>}
      {executorId === 'browser' && <label className="mob-wide">页面地址<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/page" /></label>}
      {executorId === 'github' && <div className="mob-field-row">
        <label>动作<select value={githubAction} onChange={event => setGithubAction(event.target.value)}><option value="repo">仓库</option><option value="issues">Issues</option><option value="pulls">Pull Requests</option><option value="checks">CI Checks</option><option value="file">文件</option></select></label>
        <label>owner<input value={owner} onChange={event => setOwner(event.target.value)} placeholder="acme" /></label>
        <label>repo<input value={repo} onChange={event => setRepo(event.target.value)} placeholder="lagent" /></label>
        {['issues', 'pulls', 'checks'].includes(githubAction) && <label>编号<input inputMode="numeric" value={number} onChange={event => setNumber(event.target.value)} /></label>}
        {githubAction === 'file' && <label>文件路径<input value={path} onChange={event => setPath(event.target.value)} placeholder="docs/readme.md" /></label>}
      </div>}
      {(executorId === 'codex' || executorId === 'claude-code') && <p className="mob-hint"><ShieldCheck size={13} />只读执行，提示词使用上方指令。</p>}
      {message && <p className="mob-error" role="alert">{message}</p>}
      <button type="submit" className="mob-primary" disabled={!canSend}>{busy ? <RefreshCw size={16} className="mob-spin" /> : <Send size={16} />}{busy ? '提交中' : '发送指令'}</button>
    </form>
    <p className="mob-note"><ShieldCheck size={13} />只会执行你明确授权或规则允许的操作；危险动作会先请求确认。</p>
  </section>;
}

function InboxView({ attention, tickets, datasets, notifications, unread, onOpen, onAct, onReadAll, onOpenNotification }: {
  attention: MobileBootstrap['attention']; tickets: MobileTicket[]; datasets: MobileDataset[]; notifications: MobileNotification[]; unread: number;
  onOpen: (id: string) => void; onAct: (ticketId: string, action: string, input?: Record<string, unknown>) => Promise<void>;
  onReadAll: () => Promise<void>; onOpenNotification: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  return <section className="mob-page">
    <p className="mob-eyebrow">ATTENTION</p><h1>收件箱</h1><p className="mob-lead">只有需要你决定的工单会出现在这里。</p>
    {attention.length ? <div className="mob-attention-list">{attention.map(item => {
      const ticket = tickets.find(candidate => candidate.id === item.ticketId);
      const needsDataset = !ticket?.executor || ticket.executor === 'analysis';
      const chosen = selected[item.ticketId] || ticket?.datasetId || (datasets.length === 1 ? datasets[0].id : '');
      return <article className="mob-attention" key={item.ticketId}>
        <div className="mob-attention-head"><AlertTriangle size={16} /><div><strong>{item.title || '需要确认'}</strong><p>{item.question || '请确认后继续。'}</p></div><time>{time(item.createdAt)}</time></div>
        {needsDataset && datasets.length > 1 && <label className="mob-wide">数据集<select value={chosen} onChange={event => setSelected(previous => ({ ...previous, [item.ticketId]: event.target.value }))}><option value="">请选择数据集</option>{datasets.map(dataset => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label>}
        {needsDataset && datasets.length === 0 && <p className="mob-hint">请先在电脑端上传数据集。</p>}
        <div className="mob-attention-actions">
          {(item.options || []).map(option => <button type="button" key={option.id || option.action} className={option.action === 'approve' ? 'mob-primary' : 'mob-secondary'} disabled={option.action === 'approve' && needsDataset && !chosen} onClick={() => void onAct(item.ticketId, option.action || 'approve', option.action === 'approve' && needsDataset && chosen ? { datasetId: chosen } : undefined)}>{option.label || option.action}</button>)}
          <button type="button" className="mob-link" onClick={() => onOpen(item.ticketId)}>查看详情<ChevronRight size={14} /></button>
        </div>
      </article>;
    })}</div> : <div className="mob-empty-inline"><Check size={18} /><span>没有需要你决定的事项。</span></div>}
    {notifications.length > 0 && <section className="mob-notice-section">
      <div className="mob-notice-head"><h2>最近提醒{unread > 0 ? ` · ${unread} 条未读` : ''}</h2>{unread > 0 && <button type="button" className="mob-link" onClick={() => void onReadAll()}>全部已读</button>}</div>
      <ul className="mob-notice-list">{notifications.map(item => <li key={item.id}>
        <button type="button" className={item.unread ? 'unread' : ''} onClick={() => onOpenNotification(item.ticketId || '')}>
          <span className="mob-notice-dot" aria-hidden="true" />
          <span className="mob-notice-main"><strong>{item.title || '任务提醒'}</strong><span>{item.summary || statusNames[item.status] || item.status}</span><small>{time(item.createdAt)}</small></span>
          <span className={`mob-status mob-status-${item.status}`}>{statusNames[item.status] || item.status}</span>
        </button>
      </li>)}</ul>
    </section>}
  </section>;
}

function TicketsView({ tickets, plans, loading, onOpen }: { tickets: MobileTicket[]; plans: NonNullable<MobileBootstrap['plans']>; loading: boolean; onOpen: (id: string) => void }) {
  if (loading && !tickets.length) return <p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在载入任务…</p>;
  if (!tickets.length) return <section className="mob-empty"><Terminal size={22} /><h2>还没有任务</h2><p>从指挥台发送第一条指令开始。</p></section>;
  return <section className="mob-page">
    <p className="mob-eyebrow">TICKETS</p><h1>任务</h1>
    {plans.length > 0 && <div className="mob-plan-list">{plans.slice(0, 4).map(plan => <div className="mob-plan-card" key={plan.id}><div><strong>{plan.goal}</strong><span>{plan.status === 'active' ? '进行中' : plan.status === 'completed' ? '已完成' : plan.status === 'cancelled' ? '已取消' : '已失败'} · 第 {Math.min(plan.currentStep + 1, plan.totalSteps)}/{plan.totalSteps} 步</span></div><span className="mob-plan-bar" aria-hidden="true"><i style={{ width: `${Math.round((Math.min(plan.currentStep + 1, plan.totalSteps) / Math.max(1, plan.totalSteps)) * 100)}%` }} /></span></div>)}</div>}
    <ul className="mob-ticket-list">{tickets.map(ticket => <li key={ticket.id}>
      <button type="button" onClick={() => onOpen(ticket.id)}>
        <span className="mob-ticket-main"><strong>{ticket.title || '未命名任务'}</strong><span>{ticket.summary || `${ticket.executor || 'Agent'} · ${ticket.source || 'manual'}`}</span><small>{ticket.planTotal ? `计划第 ${(ticket.planStep ?? 0) + 1}/${ticket.planTotal} 步 · ` : ''}{time(ticket.updatedAt || ticket.createdAt)}</small></span>
        <span className={`mob-status mob-status-${ticket.status}`}>{statusNames[ticket.status] || ticket.status}</span>
        <ChevronRight size={16} />
      </button>
    </li>)}</ul>
  </section>;
}

function TicketDetail({ detail, ticket, busy, agents, allowed, datasets, onBack, onOpen, onAct, onHandoff }: {
  detail: MobileDetail | null; ticket?: MobileTicket; busy: boolean; agents: MobileAgent[]; allowed: string[]; datasets: MobileDataset[]; onBack: () => void; onOpen: (id: string) => void;
  onAct: (ticketId: string, action: string, input?: Record<string, unknown>) => Promise<void>;
  onHandoff: (ticketId: string, executorId: string, text?: string) => Promise<void>;
}) {
  const available = agents.filter(agent => allowed.includes(agent.id) && agent.status === 'available' && ['analysis', 'codex', 'claude-code'].includes(agent.id) && (agent.id !== 'analysis' || datasets.length > 0 || Boolean(ticket?.datasetId)));
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (!target && available.length) setTarget(available[0].id); }, [available, target]);
  if (!ticket) return <section className="mob-page"><button type="button" className="mob-back" onClick={onBack}><ArrowLeft size={16} />返回</button><p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在载入详情…</p></section>;
  const reports = detail?.reports || [];
  const team = detail?.team;
  const canStop = ['working', 'queued', 'awaiting_review', 'waiting'].includes(ticket.status);
  const canRetry = ['failed', 'cancelled', 'blocked'].includes(ticket.status);
  return <section className="mob-page mob-detail">
    <button type="button" className="mob-back" onClick={onBack}><ArrowLeft size={16} />返回</button>
    <div className="mob-detail-head"><span className={`mob-status mob-status-${ticket.status}`}>{statusNames[ticket.status] || ticket.status}</span><time>{time(ticket.updatedAt || ticket.createdAt)}</time></div>
    <h1>{ticket.title || '任务详情'}</h1>
    {ticket.summary && <p className="mob-lead">{ticket.summary}</p>}
    {ticket.planId && <p className="mob-hint">多步计划第 {(ticket.planStep ?? 0) + 1}/{ticket.planTotal ?? 0} 步</p>}
    <dl className="mob-meta"><div><dt>执行器</dt><dd>{ticket.executor || '—'}</dd></div><div><dt>阶段</dt><dd>{ticket.stage || '—'}</dd></div><div><dt>来源</dt><dd>{ticket.source || '—'}</dd></div></dl>
    {ticket.attention?.question && <div className="mob-callout"><AlertTriangle size={16} /><div><strong>需要确认</strong><p>{ticket.attention.question}</p></div></div>}
    <div className="mob-detail-actions">
      {ticket.attention?.options?.map(option => <button type="button" key={option.id || option.action} className={option.action === 'approve' ? 'mob-primary' : 'mob-secondary'} disabled={busy} onClick={() => void onAct(ticket.id, option.action || 'approve')}>{option.label || option.action}</button>)}
      {canStop && <button type="button" className="mob-secondary" disabled={busy} onClick={() => void onAct(ticket.id, 'stop')}>停止任务</button>}
      {canRetry && <button type="button" className="mob-secondary" disabled={busy} onClick={() => void onAct(ticket.id, 'retry')}>重试</button>}
    </div>
    {ticket.status === 'completed' && <section className="mob-handoff">
      <h2 className="mob-section-title">交给另一个 Agent</h2>
      {ticket.handoffChildId ? <button type="button" className="mob-secondary" onClick={() => onOpen(ticket.handoffChildId!)}>查看下一棒<ChevronRight size={14} /></button> : <div className="mob-handoff-form">
        <label>目标执行器<select value={target} onChange={event => setTarget(event.target.value)}>{available.length ? available.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">没有可用执行器</option>}</select></label>
        <label>补充说明<input value={note} onChange={event => setNote(event.target.value)} placeholder="可选：希望下一棒关注什么" /></label>
        <button type="button" className="mob-primary" disabled={!target} onClick={() => void onHandoff(ticket.id, target, note.trim() || undefined)}>交接</button>
      </div>}
    </section>}
    {ticket.parentTicketId && <div className="mob-lineage"><p>来自上一棒工单 {ticket.parentTicketId.slice(0, 8)}，当前为第 {ticket.handoffDepth ?? 1} 棒。</p>{ticket.handoffSummary && <p>上一棒摘要：{ticket.handoffSummary}</p>}</div>}
    <h2 className="mob-section-title">进展</h2>
    {reports.length ? <ul className="mob-reports">{reports.map(report => <li key={report.id}><div><strong>{report.kind || 'report'}</strong>{report.summary && <p>{report.summary}</p>}</div><time>{time(report.createdAt)}</time></li>)}</ul> : <p className="mob-hint">还没有可展示的报告。</p>}
    {team?.nodes?.length ? <><h2 className="mob-section-title">团队</h2><ul className="mob-team">{team.nodes.map(node => <li key={node.id}><span>{'　'.repeat(Math.max(0, (node.depth || 1) - 1))}{node.status === 'completed' ? '✓' : '·'} {node.proposals?.[0]?.kind || '节点'}</span><span className={`mob-status mob-status-${node.status || 'pending'}`}>{statusNames[node.status || 'pending'] || node.status}</span></li>)}</ul></> : null}
  </section>;
}

function SettingsView({ device, theme, onTheme, onSignOut }: { device: MobileDevice; theme: string; onTheme: () => void; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    try { await mobileRequest(`/devices/${encodeURIComponent(device.deviceId)}`, device.deviceToken, { method: 'DELETE' }); } catch { /* 本地仍退出。 */ }
    finally { setBusy(false); onSignOut(); }
  };
  return <section className="mob-page">
    <p className="mob-eyebrow">SETTINGS</p><h1>设置</h1>
    <div className="mob-settings-card">
      <h2>{device.name || '我的手机'}</h2>
      <p>已与电脑端指挥台配对。设备凭证只保存在本机浏览器。</p>
      <p className="mob-hint">凭证有效期至 {time(device.expiresAt)}</p>
      <button type="button" className="mob-secondary" onClick={onTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}{theme === 'dark' ? '切换到浅色' : '切换到深色'}</button>
    </div>
    <div className="mob-settings-card">
      <h2>撤销这台设备</h2>
      <p>撤销后手机立即失去访问权限，需在电脑端重新生成配对码。</p>
      <button type="button" className="mob-danger" disabled={busy} onClick={() => void revoke()}><Unplug size={15} />{busy ? '正在撤销…' : '撤销并退出'}</button>
    </div>
    <p className="mob-note"><ShieldCheck size={13} />移动端不能修改模型、凭据、策略或删除数据集。</p>
  </section>;
}
