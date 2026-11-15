import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ArrowRight, Database, LockKeyhole, LogOut, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { api, onSessionExpired, resetSessionBoundary } from './api';
import { registrationError } from './account-validation';
import { AuthContext } from './auth-context';
import { setDesktopState } from './desktop-tray';
import { AppearanceProvider } from './appearance-context';
import type { Runtime, User } from './types';
import { Logo, Spinner } from './components/ui';

export function AuthRoot({ children, attribution }: { children: ReactNode; attribution?: { shareToken: string; visitorToken: string } }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [session, setSession] = useState(0);
  const endSession = useCallback((message: string) => {
    resetSessionBoundary();
    setDesktopState(window.lagentDesktop, 'login');
    setUser(null);
    setNotice(message);
    setSession(value => value + 1);
  }, []);

  useEffect(() => onSessionExpired(() => {
    if (runtime?.mode === 'cloud') endSession('登录已失效，请重新登录。');
  }), [runtime?.mode, endSession]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    async function connect() {
      try {
        const next = await api.runtime();
        if (next.serviceName !== 'Lagent' || !['local', 'cloud'].includes(next.mode) || next.authRequired !== (next.mode === 'cloud')) throw new Error('该地址未提供兼容的 Lagent 服务，请确认服务配置。');
        const current = next.mode === 'cloud' ? (await api.session()).user : null;
        if (!alive) return;
        resetSessionBoundary();
        setRuntime(next);
        setUser(current);
      } catch (cause) { if (alive) setError((cause as Error).message); }
      finally { if (alive) setLoading(false); }
    }
    void connect();
    return () => { alive = false; };
  }, [attempt]);

  useEffect(() => {
    if (!loading && runtime?.mode === 'cloud' && !user) setDesktopState(window.lagentDesktop, 'login');
  }, [loading, runtime, user]);

  if (loading || error || !runtime) return <div className="app-loading" aria-busy={loading}>
    <div className="loading-brand"><Logo /><strong>Lagent.</strong></div>
    {error ? <><h2>连接 Lagent 服务时遇到问题</h2><p role="alert">{error}</p><button className="button primary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />重试连接</button><small>请检查网络和所连接的服务地址；服务管理员可检查部署状态。</small></> : <><Spinner size={24} /><p role="status">正在连接你的 Lagent 服务…</p></>}
  </div>;

  if (runtime.mode === 'cloud' && !user) return <AuthPage runtime={runtime} notice={notice} attribution={attribution} onAuthenticated={next => {
    resetSessionBoundary();
    if (attribution) window.history.replaceState(null, '', '/');
    setNotice('');
    setUser(next);
    setSession(value => value + 1);
  }} />;

  // 强制绑定模式下，账号虽然登录成功，但只能进入绑定页；绑定完成前不加载工作台。
  if (runtime.mode === 'cloud' && user && runtime.phoneRequired && !user.phoneVerified) return <PhoneBindPage runtime={runtime} user={user} onBound={next => {
    setUser(next);
    setSession(value => value + 1);
  }} onLogout={() => { void api.logout().finally(() => endSession('已退出登录。')); }} />;

  return <AuthContext.Provider key={session} value={{ runtime, user, endSession }}><AppearanceProvider userId={user?.id}>{children}</AppearanceProvider></AuthContext.Provider>;
}

function useCooldown() {
  const [until, setUntil] = useState(0);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return { remaining: Math.max(0, Math.ceil((until - tick) / 1000)), start: (seconds: number) => { setTick(Date.now()); setUntil(Date.now() + Math.max(1, seconds) * 1000); } };
}

function CodeRow({ phone, code, setCode, purpose, username, disabled, onNotice, smsConfigured }: {
  phone: string; code: string; setCode: (value: string) => void;
  purpose: 'register' | 'login' | 'bind'; username?: string; disabled: boolean;
  onNotice: (message: string) => void; smsConfigured?: boolean;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const cooldown = useCooldown();
  async function send() {
    if (sending || cooldown.remaining > 0) return;
    setSending(true); setError('');
    try {
      const result = await api.sendSms({ ...(phone.trim() ? { phone: phone.trim() } : {}), ...(!phone.trim() && username ? { username } : {}), purpose });
      cooldown.start(result.retryAfter || 60);
      onNotice(result.devCode ? `开发模式验证码：${result.devCode}` : result.message);
      if (result.devCode) setCode(result.devCode);
    } catch (cause) { setError((cause as Error).message); }
    finally { setSending(false); }
  }
  return <div className="field code-field">
    <label htmlFor="auth-code">短信验证码</label>
    <div className="code-row">
      <input id="auth-code" name="code" aria-label="短信验证码" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" disabled={disabled} required />
      <button className="button" type="button" onClick={() => void send()} disabled={disabled || sending || cooldown.remaining > 0 || smsConfigured === false}>{cooldown.remaining > 0 ? `${cooldown.remaining} 秒后重发` : sending ? '发送中…' : '发送验证码'}</button>
    </div>
    {smsConfigured === false && <small className="field-help">短信服务尚未配置，请联系服务管理员。</small>}
    {error && <small className="form-error" role="alert">{error}</small>}
  </div>;
}

function AuthPage({ runtime, notice, onAuthenticated, attribution }: { runtime: Runtime; notice: string; onAuthenticated: (user: User) => void; attribution?: { shareToken: string; visitorToken: string } }) {
  const phoneAvailable = Boolean(runtime.phoneRequired || runtime.smsConfigured);
  const [mode, setMode] = useState<'login' | 'register'>(attribution ? 'register' : 'login');
  const [method, setMethod] = useState<'phone' | 'password'>(runtime.phoneRequired && phoneAvailable ? 'phone' : 'password');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const register = mode === 'register';
  const phoneMode = method === 'phone';
  useEffect(() => { (phoneMode ? phoneRef : usernameRef).current?.focus(); }, [mode, method]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  function switchMode(next: 'login' | 'register') { setMode(next); setError(''); setAuthNotice(''); setPassword(''); setConfirmPassword(''); setCode(''); setNeedCode(false); }
  function switchMethod(next: 'phone' | 'password') { setMethod(next); setError(''); setAuthNotice(''); setCode(''); setNeedCode(false); }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    let validation = '';
    if (phoneMode) {
      if (!/^1[3-9]\d{9}$/.test(phone.replace(/[\s-]/g, ''))) validation = '请输入有效的 11 位手机号。';
      else if (!/^\d{6}$/.test(code)) validation = '请输入 6 位短信验证码。';
      else if (register && password && (password.length < 10 || password.length > 128)) validation = '密码须为 10–128 个字符。';
    } else if (register) validation = registrationError({ username, displayName, password, confirmPassword });
    else if (!username || !password) validation = '请填写用户名和密码。';
    else if (password.length > 128) validation = '密码不能超过 128 个字符。';
    else if (needCode && !/^\d{6}$/.test(code)) validation = '新设备登录请输入 6 位短信验证码。';
    if (validation) { setError(validation); return; }
    setBusy(true); setError(''); setAuthNotice('');
    try {
      let result: { user: User };
      if (phoneMode) {
        result = register
          ? await api.register({ phone: phone.trim(), code, ...(displayName.trim() ? { displayName: displayName.trim() } : {}), ...(password ? { password } : {}), rememberDevice: true, ...(attribution || {}) })
          : await api.login({ phone: phone.trim(), code, rememberDevice: true });
      } else {
        result = register
          ? await api.register({ username, displayName: displayName.trim(), password, rememberDevice: true, ...(attribution || {}) })
          : await api.login({ username, password, ...(needCode ? { code } : {}), rememberDevice: true });
      }
      setPassword(''); setConfirmPassword(''); setCode('');
      onAuthenticated(result.user);
    } catch (cause) {
      const failure = cause as Error & { code?: string };
      if (failure.code === 'PHONE_CODE_REQUIRED') {
        setNeedCode(true);
        setError('这是新设备登录，需要短信验证码。请点击「发送验证码」。');
        setMethod('password');
      } else setError(failure.message);
    }
    finally { setBusy(false); }
  }
  const title = register ? '创建你的工作空间' : '欢迎回来';
  const subtitle = register
    ? phoneMode ? '用手机号验证码注册，用户名可以自动生成。' : '注册后即可使用指挥台，无需邮箱。'
    : phoneMode ? '用手机号验证码登录，新设备同样需要验证。' : '登录后，继续查看你的数据与分析报告。';
  return <main className="auth-page">
    <div className="auth-layout">
      <section className="auth-intro" aria-label="Lagent 账号介绍">
        <div className="auth-brand"><Logo /><span>Lagent<span className="brand-dot">.</span></span></div>
        <span className="auth-eyebrow">从数据出发，为决策而来</span>
        <h1>你的数据，<br />你的下一步<span>。</span></h1>
        <p>连接团队的分析服务，让每一次探索都留在自己的工作空间。</p>
        <div className="auth-features"><div><Database size={18} /><span>数据与报告按账号保存</span></div><div><ShieldCheck size={18} /><span>新账号获赠 500 试用额度</span></div><div><LockKeyhole size={18} /><span>同一服务，换电脑也能继续分析</span></div></div>
        <div className="auth-service"><span className="online-dot" /><span>已连接云端服务<strong>{window.location.host}</strong></span></div>
      </section>
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-switch" aria-label="账号操作"><button type="button" aria-pressed={!register} className={!register ? 'selected' : ''} onClick={() => switchMode('login')} disabled={busy}>登录</button><button type="button" aria-pressed={register} className={register ? 'selected' : ''} onClick={() => switchMode('register')} disabled={busy}>创建账号</button></div>
        {phoneAvailable && <div className="auth-switch auth-method-switch" aria-label="登录方式"><button type="button" aria-pressed={phoneMode} className={phoneMode ? 'selected' : ''} onClick={() => switchMethod('phone')} disabled={busy}>手机号验证码</button><button type="button" aria-pressed={!phoneMode} className={!phoneMode ? 'selected' : ''} onClick={() => switchMethod('password')} disabled={busy}>账号密码</button></div>}
        <h2 id="auth-title">{title}</h2><p className="auth-subtitle">{subtitle}</p>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        {authNotice && <p className="auth-notice" role="status">{authNotice}</p>}
        <form onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
          {phoneMode ? <>
            <label className="field" htmlFor="auth-phone">手机号<input id="auth-phone" name="phone" ref={phoneRef} aria-label="手机号" value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" disabled={busy} required /><small className="field-help">仅用于登录验证与账号找回，界面与日志只显示掩码。</small></label>
            <CodeRow phone={phone} code={code} setCode={setCode} purpose={register ? 'register' : 'login'} disabled={busy} onNotice={setAuthNotice} smsConfigured={runtime.smsConfigured} />
            {register && <label className="field" htmlFor="auth-display-name">显示名称（可选）<input id="auth-display-name" name="displayName" aria-label="显示名称" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="nickname" disabled={busy} /><small className="field-help">不填则使用「用户 + 手机尾号」，1–40 个字符。</small></label>}
            {register && <label className="field" htmlFor="auth-password">密码（可选）<input id="auth-password" name="password" aria-label="密码" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /><small className="field-help">设置后也可以使用账号密码登录；留空则只用手机号验证码。</small></label>}
          </> : <>
            <label className="field" htmlFor="auth-username">用户名<input id="auth-username" name="username" aria-label="用户名" ref={usernameRef} value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={busy} required aria-describedby="auth-username-help" /><small className="field-help" id="auth-username-help">3–32 个英文字母、数字或下划线，不区分大小写。</small></label>
            {register && <label className="field" htmlFor="auth-display-name">显示名称<input id="auth-display-name" name="displayName" aria-label="显示名称" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="nickname" disabled={busy} required /><small className="field-help">1–40 个字符，可以使用中文。</small></label>}
            <label className="field" htmlFor="auth-password">密码<input id="auth-password" name="password" aria-label="密码" type="password" autoComplete={register ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} disabled={busy} required aria-describedby={register ? 'auth-password-help' : undefined} />{register && <small className="field-help" id="auth-password-help">10–128 个字符，空格会原样保留。</small>}</label>
            {register && <label className="field" htmlFor="auth-confirm-password">确认密码<input id="auth-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={busy} required /></label>}
            {needCode && <CodeRow phone="" username={username} code={code} setCode={setCode} purpose="login" disabled={busy} onNotice={setAuthNotice} smsConfigured={runtime.smsConfigured} />}
          </>}
          {error && <p className="form-error auth-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
          <button className="button primary auth-submit" type="submit" disabled={busy}>{busy ? <Spinner size={17} /> : phoneMode ? <Smartphone size={17} /> : <ArrowRight size={17} />}{busy ? register ? '正在创建账号…' : '正在登录…' : register ? '注册并进入工作台' : '登录工作台'}</button>
        </form>
        <p className="auth-help">{register ? '注册即表示你同意仅将手机号用于登录验证与账号找回。' : '无法登录时，请联系本服务管理员。'}</p>
      </section>
    </div>
    <footer className="auth-footer">上传数据与报告保存在所连接的服务器，并按账号隔离。模型仅接收业务背景与聚合指标。</footer>
  </main>;
}

function PhoneBindPage({ runtime, user, onBound, onLogout }: { runtime: Runtime; user: User; onBound: (user: User) => void; onLogout: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const phoneRef = useRef<HTMLInputElement>(null);
  useEffect(() => { phoneRef.current?.focus(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^1[3-9]\d{9}$/.test(phone.replace(/[\s-]/g, ''))) { setError('请输入有效的 11 位手机号。'); return; }
    if (!/^\d{6}$/.test(code)) { setError('请输入 6 位短信验证码。'); return; }
    setBusy(true); setError('');
    try { const result = await api.bindPhone({ phone: phone.trim(), code }); onBound(result.user); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <main className="auth-page">
    <div className="auth-layout">
      <section className="auth-intro" aria-label="绑定手机号说明">
        <div className="auth-brand"><Logo /><span>Lagent<span className="brand-dot">.</span></span></div>
        <span className="auth-eyebrow">账号安全</span>
        <h1>绑定手机号，<br />才能开始工作<span>。</span></h1>
        <p>当前部署要求手机号验证。绑定后，登录、找回和敏感操作都会经过短信验证。</p>
        <div className="auth-features"><div><Smartphone size={18} /><span>手机号只用于登录验证</span></div><div><ShieldCheck size={18} /><span>新设备登录需要验证码</span></div><div><LockKeyhole size={18} /><span>界面与日志只显示掩码</span></div></div>
        <div className="auth-service"><span className="online-dot" /><span>已登录<strong>{user.displayName || user.username}</strong></span></div>
      </section>
      <section className="auth-card" aria-labelledby="bind-title">
        <h2 id="bind-title">绑定手机号</h2>
        <p className="auth-subtitle">{runtime.smsConfigured === false ? '短信服务尚未配置，请联系服务管理员。' : '绑定完成前无法创建任务或访问工作区数据。'}</p>
        {authNotice && <p className="auth-notice" role="status">{authNotice}</p>}
        <form onSubmit={event => void submit(event)} noValidate aria-busy={busy}>
          <label className="field" htmlFor="bind-phone">手机号<input id="bind-phone" ref={phoneRef} name="phone" aria-label="手机号" value={phone} onChange={event => setPhone(event.target.value)} inputMode="tel" autoComplete="tel" disabled={busy} required /></label>
          <CodeRow phone={phone} code={code} setCode={setCode} purpose="bind" disabled={busy} onNotice={setAuthNotice} smsConfigured={runtime.smsConfigured} />
          {error && <p className="form-error auth-error" role="alert">{error}</p>}
          <button className="button primary auth-submit" type="submit" disabled={busy || runtime.smsConfigured === false}>{busy ? <Spinner size={17} /> : <Smartphone size={17} />}{busy ? '正在绑定…' : '绑定并进入工作台'}</button>
        </form>
        <p className="auth-help"><button className="link-button" type="button" onClick={onLogout}><LogOut size={13} />退出登录</button></p>
      </section>
    </div>
    <footer className="auth-footer">手机号仅用于登录验证与账号找回，不会用于业务分析。</footer>
  </main>;
}
