import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, Inbox, ListChecks, MessageSquare, Moon, RefreshCw, Settings2, ShieldCheck, Sun, Unplug } from 'lucide-react';
import { mobileApi, mobileRequest, MobileApiError } from './mobile-api';
import { MobileChat } from './MobileChat';
import { MobileCapabilities } from './MobileCapabilities';
import { TicketDetail } from './MobileTickets';
import { statusNames, time } from './display';
import type { MobileBootstrap, MobileDevice, MobileDetail, MobileEvent, MobileNotification, MobileTicket } from './types';
import './mobile.css';

const DEVICE_KEY = 'lagent:mobile:device:v1';
const BOOT_APPEARANCE_KEY = 'lagent:appearance:boot:v1';

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

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.dataset.themeFix = '';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#0b0d0c' : '#f3f1ea');
    try { localStorage.setItem(BOOT_APPEARANCE_KEY, JSON.stringify({ theme: next, view: 'concise' })); } catch { /* 忽略。 */ }
    setTheme(next);
  };
  return { theme, toggle };
}

function useServerEvents(token: string, onEvent: (event: MobileEvent | null) => void, onUnauthorized: () => void) {
  const [online, setOnline] = useState(false);
  const handler = useRef(onEvent);
  const unauthorized = useRef(onUnauthorized);
  useEffect(() => { handler.current = onEvent; unauthorized.current = onUnauthorized; }, [onEvent, onUnauthorized]);
  useEffect(() => {
    let stopped = false;
    const controller = new AbortController();
    // 断线重连带 after_seq：服务端按 run-event 序号补发；游标过期会收到 reset。
    const lastSeq = { current: 0 };
    const run = async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          const suffix = lastSeq.current > 0 ? `?after_seq=${lastSeq.current}` : '';
          const response = await fetch(`/api/mobile/events${suffix}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal, cache: 'no-store' });
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
              const eventName = chunk.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
              const data = chunk.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
              if (eventName === 'reset') {
                // 服务端已裁掉游标之前的日志；记下最新序号，重连时从 reset 之后继续补发。
                let latestSeq = 0;
                try { latestSeq = Number(JSON.parse(data)?.latestSeq) || 0; } catch { /* 保留 0，下次全量重拉。 */ }
                lastSeq.current = Number.isSafeInteger(latestSeq) && latestSeq > 0 ? latestSeq : 0;
                handler.current({ type: 'reset', ticketId: null, payload: {} });
              } else if (data) {
                let parsed: MobileEvent | null = null;
                try { parsed = JSON.parse(data) as MobileEvent; } catch { /* 通知与心跳不是 Work 事件。 */ }
                if (parsed && Number.isSafeInteger(parsed.seq)) lastSeq.current = parsed.seq as number;
                handler.current(parsed);
              }
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
    return () => { document.title = 'Lagent · 指挥台'; };
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
    <header className="mob-brand"><span className="brand-dot" /><strong>Lagent</strong><small>个人 Agent</small></header>
    <section className="mob-pair-card"><p className="mob-eyebrow">远程指挥</p><h1>手机指挥尚未启用</h1><p>请在电脑端启用 Work 指挥服务后再打开本页。云端账号版默认提供此能力。</p><p className="mob-note"><ShieldCheck size={13} />本地服务默认启用；若被显式关闭，可设置 <code>LAGENT_WORK_ENABLED=1</code>。</p></section>
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
    <header className="mob-brand"><span className="brand-dot" /><strong>Lagent</strong><small>个人 Agent</small></header>
    <section className="mob-pair-card">
      <p className="mob-eyebrow">远程指挥</p>
      <h1>连接你的指挥台</h1>
      <p>在电脑端打开「设置 → 手机指挥」生成配对码，然后在这里输入。配对后即可对话、查看任务与审批。</p>
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
  const [tab, setTab] = useState<'chat' | 'inbox' | 'tickets' | 'settings'>(() => {
    const raw = new URLSearchParams(window.location.search).get('tab');
    return raw === 'inbox' || raw === 'tickets' || raw === 'settings' ? raw : 'chat';
  });
  // 深链：电脑上复制的 ?ticket= 链接在手机上直接落到同一个工单。
  const [detailId, setDetailId] = useState(() => new URLSearchParams(window.location.search).get('ticket') || '');
  const [detail, setDetail] = useState<MobileDetail | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState('');
  const [notifications, setNotifications] = useState<MobileNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [lastEvent, setLastEvent] = useState<MobileEvent | null>(null);
  const [acting, setActing] = useState('');
  const { theme, toggle } = useTheme();
  const reloadTimer = useRef<number | null>(null);

  const unauthorized = useCallback(() => onSignOut(), [onSignOut]);
  const reload = useCallback(() => setRefreshKey(value => value + 1), []);
  const onEvent = useCallback((event: MobileEvent | null) => {
    if (!event) return;
    setLastEvent(event);
    if (event.type === 'reset') { reload(); return; }
    if (event.type === 'ticket' || event.type === 'report' || event.type === 'approval') {
      if (reloadTimer.current !== null) return;
      reloadTimer.current = window.setTimeout(() => { reloadTimer.current = null; reload(); }, 1500);
    }
  }, [reload]);
  const online = useServerEvents(device.deviceToken, onEvent, unauthorized);

  useEffect(() => () => { if (reloadTimer.current !== null) window.clearTimeout(reloadTimer.current); }, []);

  // 手机端深链：tab 与工单写回地址栏，刷新、分享、换设备都能落到同一处。
  useEffect(() => {
    const url = new URL(window.location.href);
    if (tab === 'chat') url.searchParams.delete('tab'); else url.searchParams.set('tab', tab);
    if (detailId) url.searchParams.set('ticket', detailId); else url.searchParams.delete('ticket');
    window.history.replaceState(null, '', url);
  }, [tab, detailId]);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError('');
    mobileApi.bootstrap(device.deviceToken)
      .then(value => { if (alive) setBootstrap(value); })
      .catch(cause => {
        if (!alive) return;
        if (cause instanceof MobileApiError && cause.status === 401) { onSignOut(); return; }
        setError((cause as Error).message);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [device.deviceToken, refreshKey, onSignOut]);

  // 对话页靠 SSE 与发送后刷新；其它 tab 保留 15 秒兜底轮询。
  useEffect(() => {
    if (tab === 'chat') return;
    const timer = setInterval(() => setRefreshKey(value => value + 1), 15000);
    return () => clearInterval(timer);
  }, [tab]);

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
    if (acting) return;
    setActing(ticketId);
    try {
      await mobileRequest(`/tickets/${encodeURIComponent(ticketId)}/actions`, device.deviceToken, { method: 'POST', body: JSON.stringify({ action, ...(input ? { input } : {}) }) });
      setNotice('操作已提交。'); reload();
    } catch (cause) { setNotice((cause as Error).message); }
    finally { setActing(''); }
  };
  const handoff = async (ticketId: string, executorId: string, text?: string) => {
    if (acting) return;
    setActing(ticketId);
    try {
      const source = tickets.find(ticket => ticket.id === ticketId);
      const executorInput = ['codex', 'claude-code'].includes(executorId) ? { prompt: text || source?.title || '继续处理上一棒任务' } : undefined;
      const result = await mobileRequest<{ ticket: MobileTicket }>(`/tickets/${encodeURIComponent(ticketId)}/actions`, device.deviceToken, {
        method: 'POST', body: JSON.stringify({ action: 'handoff', input: { executorId, ...(text ? { text } : {}), ...(executorInput ? { executorInput } : {}) } })
      });
      setNotice('已交给下一棒 Agent。'); setDetailId(result.ticket.id); reload();
    } catch (cause) { setNotice((cause as Error).message); }
    finally { setActing(''); }
  };

  const tickets = bootstrap?.tickets || [];
  const attention = bootstrap?.attention || [];
  const agents = bootstrap?.agents || [];
  const allowed = bootstrap?.policy?.allowedExecutors || [];
  const detailTicket = detail?.ticket || tickets.find(ticket => ticket.id === detailId);
  const leaveDetail = () => setDetailId('');

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
      {detailId ? <TicketDetail detail={detail} ticket={detailTicket} token={device.deviceToken} busy={Boolean(acting)} agents={agents} allowed={allowed} onBack={leaveDetail} onOpen={setDetailId} onAct={act} onHandoff={handoff} />
        : tab === 'chat' ? <MobileChat
          token={device.deviceToken} bootstrap={bootstrap} event={lastEvent} refreshKey={refreshKey}
          onOpenTicket={setDetailId} onToast={setNotice} onUnauthorized={onSignOut} onReload={reload}
        />
          : tab === 'inbox' ? <InboxView attention={attention} tickets={tickets} notifications={notifications} unread={unread} onOpen={setDetailId} onAct={act} onReadAll={markAllNotificationsRead} onOpenNotification={id => { void markNotificationRead(id); setDetailId(id); }} />
            : tab === 'tickets' ? <TicketsView tickets={tickets} plans={bootstrap?.plans || []} loading={loading} onOpen={setDetailId} />
              : <SettingsView device={device} theme={theme} onTheme={toggle} onSignOut={onSignOut} token={device.deviceToken} onToast={setNotice} />}
      {tab === 'chat' && error && !bootstrap && <p className="mob-error" role="alert">{error}</p>}
    </main>

    {notice && <div className="mob-toast" role="status">{notice}</div>}
    {!detailId && <nav className="mob-nav" aria-label="主导航">
      <button type="button" className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><MessageSquare size={19} /><span>对话</span></button>
      <button type="button" className={tab === 'inbox' ? 'active' : ''} onClick={() => setTab('inbox')}><Inbox size={19} /><span>收件箱</span>{(attention.length || unread) > 0 && <em>{attention.length || unread}</em>}</button>
      <button type="button" className={tab === 'tickets' ? 'active' : ''} onClick={() => setTab('tickets')}><ListChecks size={19} /><span>任务</span></button>
      <button type="button" className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings2 size={19} /><span>设置</span></button>
    </nav>}
  </div>;
}

function InboxView({ attention, tickets, notifications, unread, onOpen, onAct, onReadAll, onOpenNotification }: {
  attention: MobileBootstrap['attention']; tickets: MobileTicket[]; notifications: MobileNotification[]; unread: number;
  onOpen: (id: string) => void; onAct: (ticketId: string, action: string, input?: Record<string, unknown>) => Promise<void>;
  onReadAll: () => Promise<void>; onOpenNotification: (id: string) => void;
}) {
  return <section className="mob-page">
    <p className="mob-eyebrow">需要你</p><h1>收件箱</h1><p className="mob-lead">只有需要你决定的工单会出现在这里。</p>
    {attention.length ? <div className="mob-attention-list">{attention.map(item => {
      const ticket = tickets.find(candidate => candidate.id === item.ticketId);
      return <article className="mob-attention" key={item.ticketId}>
        <div className="mob-attention-head"><AlertTriangle size={16} /><div><strong>{item.title || '需要确认'}</strong><p>{item.question || '请确认后继续。'}</p></div><time>{time(item.createdAt)}</time></div>
        <div className="mob-attention-actions">
          {(item.options || []).map(option => <button type="button" key={option.id || option.action} className={option.action === 'approve' ? 'mob-primary' : 'mob-secondary'} onClick={() => void onAct(item.ticketId, option.action || 'approve')}>{option.label || option.action}</button>)}
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
  if (!tickets.length) return <section className="mob-empty"><MessageSquare size={22} /><h2>还没有任务</h2><p>在「对话」里发出第一条消息开始。</p></section>;
  return <section className="mob-page">
    <p className="mob-eyebrow">队列</p><h1>任务</h1>
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

function SettingsView({ device, theme, onTheme, onSignOut, token, onToast }: { device: MobileDevice; theme: string; onTheme: () => void; onSignOut: () => void; token: string; onToast: (message: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    try { await mobileRequest(`/devices/${encodeURIComponent(device.deviceId)}`, device.deviceToken, { method: 'DELETE' }); } catch { /* 本地仍退出。 */ }
    finally { setBusy(false); onSignOut(); }
  };
  return <section className="mob-page">
    <p className="mob-eyebrow">偏好</p><h1>设置</h1>
    <div className="mob-settings-card">
      <h2>{device.name || '我的手机'}</h2>
      <p>已与电脑端指挥台配对。设备凭证只保存在本机浏览器。</p>
      <p className="mob-hint">凭证有效期至 {time(device.expiresAt)}</p>
      <button type="button" className="mob-secondary" onClick={onTheme}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}{theme === 'dark' ? '切换到浅色' : '切换到深色'}</button>
    </div>
    <MobileCapabilities token={token} onToast={onToast} />
    <div className="mob-settings-card">
      <h2>撤销这台设备</h2>
      <p>撤销后手机立即失去访问权限，需在电脑端重新生成配对码。</p>
      <button type="button" className="mob-danger" disabled={busy} onClick={() => void revoke()}><Unplug size={15} />{busy ? '正在撤销…' : '撤销并退出'}</button>
    </div>
    <p className="mob-note"><ShieldCheck size={13} />可为会话选择 Lagent 模型与各 Agent 思考强度；仍不能管理凭据、策略或项目。</p>
  </section>;
}
