import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { KeyRound, LogOut, ShieldCheck, Smartphone } from 'lucide-react';
import { api } from '../api';
import { passwordChangeError } from '../account-validation';
import { useAuth } from '../auth-context';
import { Modal, Spinner } from './ui';

export function AccountModal({ close }: { close: () => void }) {
  const { user, endSession } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [phoneMasked, setPhoneMasked] = useState(user?.phoneMasked || '');
  const [changingPhone, setChangingPhone] = useState(false);
  const [oldCode, setOldCode] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newCode, setNewCode] = useState('');
  const [bindPhone, setBindPhone] = useState('');
  const [bindCode, setBindCode] = useState('');
  const [revokeCode, setRevokeCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown > 0]);

  const phoneVerified = Boolean(phoneMasked);

  async function sendCode(purpose: 'change' | 'bind', target: 'password' | 'old' | 'new' | 'bind' | 'revoke', phone?: string) {
    if (busy || cooldown > 0) return;
    setBusy(`code:${target}`);
    setError('');
    setNotice('');
    try {
      const result = await api.sendSms({ purpose, ...(phone ? { phone } : {}) });
      setCooldown(result.retryAfter || 60);
      // 开发/测试环境没有真实短信，自动填入验证码，避免流程走不通。
      if (result.devCode) {
        if (target === 'password') setCode(result.devCode);
        else if (target === 'old') setOldCode(result.devCode);
        else if (target === 'new') setNewCode(result.devCode);
        else if (target === 'revoke') setRevokeCode(result.devCode);
        else setBindCode(result.devCode);
        setNotice(`开发环境验证码：${result.devCode}`);
      } else {
        setNotice(result.message || '验证码已发送。');
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const validation = passwordChangeError(currentPassword, newPassword, confirmPassword);
    if (validation) { setError(validation); return; }
    if (phoneVerified && !/^\d{6}$/.test(code)) { setError('请输入 6 位短信验证码。'); return; }
    setBusy('password');
    setError('');
    try {
      await api.changePassword({ currentPassword, newPassword, ...(phoneVerified ? { code } : {}) });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword(''); setCode('');
      endSession('密码已修改，所有设备的会话均已退出。请使用新密码登录。');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function changePhone(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(oldCode) || !/^\d{6}$/.test(newCode)) { setError('请填写原号码与新号码的 6 位验证码。'); return; }
    setBusy('phone');
    setError('');
    try {
      const result = await api.changePhone({ oldCode, newPhone: newPhone.trim(), newCode });
      setPhoneMasked(result.user.phoneMasked || '');
      setChangingPhone(false);
      setOldCode(''); setNewPhone(''); setNewCode('');
      setNotice('手机号已更换，其他设备的会话已退出。');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function bindPhoneNumber(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6}$/.test(bindCode)) { setError('请输入 6 位短信验证码。'); return; }
    setBusy('bind');
    setError('');
    try {
      const result = await api.bindPhone({ phone: bindPhone.trim(), code: bindCode });
      setPhoneMasked(result.user.phoneMasked || '');
      setBindPhone(''); setBindCode('');
      setNotice('手机号绑定成功。');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function revokeDevices() {
    if (busy) return;
    if (phoneVerified && !/^\d{6}$/.test(revokeCode)) { setError('撤销设备需要输入短信验证码。'); return; }
    setBusy('revoke');
    setError('');
    try {
      const result = await api.revokeDevices(phoneVerified ? { code: revokeCode } : {});
      setRevokeCode('');
      setNotice(`已退出 ${result.sessions} 个其他会话，撤销 ${result.devices} 台可信设备。`);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  async function logout() {
    if (busy) return;
    setBusy('logout');
    setError('');
    try { await api.logout(); endSession('你已安全退出当前账号。'); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  }

  const send = (purpose: 'change' | 'bind', target: 'password' | 'old' | 'new' | 'bind' | 'revoke', phone?: string) => <button type="button" className="link-button" onClick={() => void sendCode(purpose, target, phone)} disabled={!!busy || cooldown > 0}>{cooldown > 0 ? `${cooldown} 秒后重发` : busy === `code:${target}` ? '发送中…' : '发送验证码'}</button>;

  return <Modal title="账号与安全" subtitle="管理当前账号的登录、手机号与密码。" close={close}>
    <div className="modal-body account-modal-body">
      <div className="account-summary"><span className="avatar">{user?.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{user?.displayName}</strong><span>@{user?.username}{phoneMasked ? ` · ${phoneMasked}` : ''}</span></div><ShieldCheck size={20} /></div>

      <section className="account-section" aria-label="手机号">
        <h3 className="account-section-title"><Smartphone size={16} />手机号</h3>
        {phoneVerified ? <>
          <p className="field-help">已绑定 {phoneMasked}。修改手机号需要原号码和新号码各一次验证码；完成后其他设备会退出登录。</p>
          {changingPhone ? <form onSubmit={event => void changePhone(event)} noValidate aria-busy={busy === 'phone'}>
            <label className="field" htmlFor="account-old-code">原号码验证码<input id="account-old-code" inputMode="numeric" autoComplete="one-time-code" value={oldCode} onChange={event => setOldCode(event.target.value.replace(/\D/g, '').slice(0, 6))} disabled={!!busy} required /></label>
            <div className="code-row">{send('change', 'old')}</div>
            <label className="field" htmlFor="account-new-phone">新手机号<input id="account-new-phone" inputMode="tel" autoComplete="tel" value={newPhone} onChange={event => setNewPhone(event.target.value)} disabled={!!busy} required /></label>
            <label className="field" htmlFor="account-new-code">新号码验证码<input id="account-new-code" inputMode="numeric" autoComplete="one-time-code" value={newCode} onChange={event => setNewCode(event.target.value.replace(/\D/g, '').slice(0, 6))} disabled={!!busy} required /></label>
            <div className="code-row">{send('bind', 'new', newPhone.trim())}</div>
            <div className="account-inline-actions"><button type="submit" className="button primary" disabled={!!busy}>{busy === 'phone' ? <Spinner size={15} /> : null}{busy === 'phone' ? '正在更换…' : '确认更换'}</button><button type="button" className="button secondary" onClick={() => setChangingPhone(false)} disabled={!!busy}>取消</button></div>
          </form> : <div className="account-inline-actions"><button type="button" className="button secondary" onClick={() => setChangingPhone(true)} disabled={!!busy}>更换手机号</button></div>}
          <div className="account-revoke">
            <label className="field" htmlFor="account-revoke-code">撤销其他设备<input id="account-revoke-code" aria-label="撤销其他设备验证码" inputMode="numeric" autoComplete="one-time-code" value={revokeCode} onChange={event => setRevokeCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="输入短信验证码" disabled={!!busy} /></label>
            <div className="code-row">{send('change', 'revoke')}<button type="button" className="button secondary" onClick={() => void revokeDevices()} disabled={!!busy}>{busy === 'revoke' ? <Spinner size={15} /> : null}{busy === 'revoke' ? '正在撤销…' : '退出其他设备'}</button></div>
          </div>
        </> : <form onSubmit={event => void bindPhoneNumber(event)} noValidate aria-busy={busy === 'bind'}>
          <p className="field-help">绑定后可使用手机号验证码登录，并在新设备登录与敏感操作时接收验证码。</p>
          <label className="field" htmlFor="account-bind-phone">手机号<input id="account-bind-phone" inputMode="tel" autoComplete="tel" value={bindPhone} onChange={event => setBindPhone(event.target.value)} disabled={!!busy} required /></label>
          <label className="field" htmlFor="account-bind-code">验证码<input id="account-bind-code" inputMode="numeric" autoComplete="one-time-code" value={bindCode} onChange={event => setBindCode(event.target.value.replace(/\D/g, '').slice(0, 6))} disabled={!!busy} required /></label>
          <div className="code-row">{send('bind', 'bind', bindPhone.trim())}</div>
          <button type="submit" className="button primary full-width" disabled={!!busy}>{busy === 'bind' ? <Spinner size={15} /> : <Smartphone size={15} />}{busy === 'bind' ? '正在绑定…' : '绑定手机号'}</button>
        </form>}
      </section>

      <form onSubmit={event => void changePassword(event)} noValidate aria-busy={busy === 'password'}>
        <h3 className="account-section-title"><KeyRound size={16} />修改密码</h3>
        <p className="field-help account-password-note">修改后，所有设备的登录会话都会失效，需要重新登录。{phoneVerified ? '需要同时输入短信验证码。' : ''}</p>
        <label className="field" htmlFor="account-current-password">当前密码<input id="account-current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={!!busy} required /></label>
        <label className="field" htmlFor="account-new-password">新密码<input id="account-new-password" aria-label="新密码" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={!!busy} required aria-describedby="account-password-help" /><small className="field-help" id="account-password-help">10–128 个字符，空格会原样保留。</small></label>
        <label className="field" htmlFor="account-confirm-password">确认新密码<input id="account-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={!!busy} required /></label>
        {phoneVerified && <><label className="field" htmlFor="account-password-code">短信验证码<input id="account-password-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} disabled={!!busy} required /></label><div className="code-row">{send('change', 'password')}</div></>}
        {error && <p ref={errorRef} className="form-error auth-error" role="alert" tabIndex={-1}>{error}</p>}
        {notice && <p className="field-help" role="status">{notice}</p>}
        <button type="submit" className="button primary full-width" disabled={!!busy}>{busy === 'password' ? <Spinner size={15} /> : <KeyRound size={15} />}{busy === 'password' ? '正在修改密码…' : '修改密码并重新登录'}</button>
      </form>
      <p className="account-admin-note">无法登录或需要账号协助，请联系本服务管理员。</p>
    </div>
    <div className="modal-footer"><span className="field-help">退出会清除本次登录会话的模型 Key。</span><button className="button secondary" type="button" onClick={() => void logout()} disabled={!!busy}>{busy === 'logout' ? <Spinner size={15} /> : <LogOut size={15} />}{busy === 'logout' ? '正在退出…' : '退出登录'}</button></div>
  </Modal>;
}
