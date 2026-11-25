import { useEffect, useRef, useState } from 'react';
import { Check, LockKeyhole, RefreshCw, Zap } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth-context';
import type { ModelOption, Settings } from '../types';
import { Modal, Spinner } from './ui';
import { profileKey, readProfiles, writeProfiles, modelDiagnosis } from '../model-profiles';
import { providerByUrl, protocolLabel, suggestedModels } from '../model-providers';
import { ProviderCatalog } from './ProviderCatalog';
import type { ModelProfile } from '../model-profiles';
import './model-settings.css';
import { ModelHubSettings } from './WorkflowSettings';
import { ModelPicker } from './ModelPicker';

export { ModelHubSettings } from './WorkflowSettings';

function endpoint(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '');
    if ((!url.pathname || url.pathname === '/') && ['api.openai.com', 'api.anthropic.com'].includes(url.hostname)) url.pathname = '/v1';
    return { url, baseUrl: url.toString().replace(/\/+$/, '') };
  } catch { return null; }
}

export function SettingsModal({ settings, close, onSaved, notify }: {
  settings: Settings; close: () => void; onSaved: (settings: Settings) => void; notify: (text: string, error?: boolean) => void;
}) {
  const { runtime, user } = useAuth();
  const cloud = runtime.mode === 'cloud';
  const modelHosts = runtime.modelHosts || [];
  const aiAllowed = !cloud || modelHosts.length > 0;
  const [provider, setProvider] = useState(settings.provider || '自定义兼容接口');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl || 'https://api.openai.com/v1');
  const [model, setModel] = useState(settings.model || '');
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(settings.sessionHasKey ?? (settings.workflowEnabled ? false : settings.hasKey));
  const [savedBaseUrl, setSavedBaseUrl] = useState(settings.baseUrl);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState('');
  const [diagnostic, setDiagnostic] = useState<ReturnType<typeof modelDiagnosis> | null>(null);
  const profilesKey = profileKey(runtime.mode, user?.id, window.location.origin);
  const [profiles, setProfiles] = useState<ModelProfile[]>(() => { try { return readProfiles(localStorage, profilesKey); } catch { return []; } });
  useEffect(() => { try { writeProfiles(localStorage, profilesKey, profiles); } catch { /* 存储不可用时仅使用内存档案。 */ } }, [profilesKey, profiles]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [catalogError, setCatalogError] = useState('');
  const [partial, setPartial] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [manual, setManual] = useState(false);
  const manualRef = useRef(false);
  const parsed = endpoint(baseUrl);
  const canonical = parsed?.baseUrl || '';
  const addressError = !parsed ? '请填写有效的 API 地址。' : cloud && (parsed.url.protocol !== 'https:' || parsed.url.port || !modelHosts.includes(parsed.url.hostname.toLowerCase()))
    ? '请选择管理员允许的 HTTPS 模型主机。' : '';
  const canReuseKey = hasKey && canonical === endpoint(savedBaseUrl)?.baseUrl;
  const keyReady = Boolean(key.trim()) || canReuseKey;
  // 供应商没实现 /models 时，用目录里的常见型号兜底，至少让人有得选。
  const fallbackModels = suggestedModels(canonical);
  const showingFallback = keyReady && !addressError && models.length === 0 && fallbackModels.length > 0 && catalogStatus !== 'loading';

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setModels([]); setCatalogError(''); setPartial(false);
    if (!aiAllowed || addressError || !keyReady) {
      setCatalogStatus('idle');
      return () => { active = false; controller.abort(); };
    }
    setCatalogStatus('loading');
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.models({ baseUrl: canonical, ...(key.trim() ? { apiKey: key.trim() } : {}) }, controller.signal);
        if (!active) return;
        setModels(result.models); setPartial(result.partial); setCatalogStatus('ready');
        if (!manualRef.current) setModel(current => result.models.some(item => item.id === current) ? current : result.models.length === 1 ? result.models[0].id : '');
      } catch (e) {
        if (!active) return;
        setCatalogStatus('error'); setCatalogError((e as Error).message);
      }
    }, 650);
    return () => { active = false; controller.abort(); window.clearTimeout(timer); };
  }, [canonical, addressError, key, keyReady, aiAllowed, refresh]);

  function changeAddress(value: string, presetModel?: string) {
    if (endpoint(value)?.baseUrl !== endpoint(baseUrl)?.baseUrl) setKey('');
    setDiagnostic(null);
    setBaseUrl(value); setModel(presetModel || ''); setTestResult(''); setError('');
    const preset = providerByUrl(endpoint(value)?.baseUrl || value);
    if (preset) setProvider(preset.name);
  }
  function toggleManual() { manualRef.current = !manual; setManual(!manual); setTestResult(''); }

  function applyProfile(profile: ModelProfile) { changeAddress(profile.baseUrl); setProvider(profile.provider); setModel(profile.model); manualRef.current = true; setManual(true); }
  function saveProfile() {
    if (addressError || !canonical || !model.trim()) { setError('请先填写允许的 API 地址与模型名称。'); return; }
    setProfiles(previous => [{ baseUrl: canonical, model: model.trim(), provider }, ...previous.filter(profile => profile.baseUrl !== canonical || profile.model !== model.trim())].slice(0, 12));
    notify('已保存非敏感配置档案，不包含 Key。');
  }
  async function save(test = false) {
    if (!aiAllowed) { setError('管理员尚未开放 AI 模型接口，确定性分析仍可使用。'); return; }
    if (addressError) { setError(addressError); return; }
    if (!model.trim()) { setError('请从检测结果中选择模型，或手动填写模型名称。'); return; }
    if (!keyReady && hasKey) { setError('更换 API 地址后请填写对应的 API Key。'); return; }
    setBusy(test ? 'test' : 'save'); setDiagnostic(null); setError(''); setTestResult('');
    try {
      const { settings: next } = await api.settings({ provider, baseUrl: canonical, model: model.trim(), ...(key.trim() ? { apiKey: key.trim() } : {}) });
      setKey(''); setHasKey(next.sessionHasKey ?? (next.workflowEnabled ? false : next.hasKey)); setSavedBaseUrl(next.baseUrl); onSaved(next);
      if (test) { const result = await api.testSettings(); setTestResult(result.message || '连接成功，可以开始 AI 辅助分析。'); }
      else { notify(cloud ? '模型设置已保存，Key 仅用于当前登录会话。' : '模型设置已保存，Key 仅用于当前服务进程。'); close(); }
    } catch (e) { setError((e as Error).message); setDiagnostic(modelDiagnosis(e as { code?: string; message?: string })); }
    finally { setBusy(''); }
  }
  async function clear() {
    setBusy('clear'); setError(''); setTestResult('');
    try { const { settings: next } = await api.settings({ clearKey: true }); setKey(''); setHasKey(false); onSaved(next); notify('已移除 API Key。'); }
    catch (e) { setError((e as Error).message); setDiagnostic(modelDiagnosis(e as { code?: string; message?: string })); }
    finally { setBusy(''); }
  }

  const hubEnabled = runtime.capabilities?.modelHub === true;
  return <Modal title="模型设置" subtitle={hubEnabled ? '管理密钥、模型与 Skill；规划模型决定任务怎么拆分。' : '填写连接信息后可开始 AI 辅助分析。'} close={close} dismissible={!busy} wide>
    <div className="modal-body">
      <ModelHubSettings onWorkflowChanged={async () => {
        const result = await api.getSettings().catch(() => { throw new Error('工作流已保存，但未能刷新模型状态，请关闭设置后刷新页面。'); });
        onSaved(result.settings);
      }} />
      {!hubEnabled && <>
      <section className="legacy-model-settings" aria-label="会话级模型设置"><h3>会话级模型设置</h3><p>此处的 Key 仅保留在当前服务进程，重启后需要重新填写；凭据库的 Key 独立加密保存。</p></section>
      <section className="provider-presets" aria-label="供应商目录"><h3>供应商目录</h3>
        <ProviderCatalog disabled={!!busy} allowed={preset => !cloud || modelHosts.includes(new URL(preset.baseUrl).hostname)} onPick={preset => { changeAddress(preset.baseUrl, preset.models[0]); setProvider(preset.name); }} />
        <p>协议：{protocolLabel(providerByUrl(canonical)?.protocol || 'chat-completions')}；模型列表会按 Key 权限自动检测，检测不到时可手动填写模型 ID。</p>
      </section>
      {parsed?.url.hostname === 'opencode.ai' && <p className="field-help" role="note">OpenCode Go 主要面向编码代理；本产品是否符合套餐使用范围，请向 OpenCode 确认。各模型的数据保留与训练政策不同，请先核对供应商的隐私说明。</p>}
      <section className="model-profiles" aria-label="模型配置档案"><div className="model-picker-heading"><h3>配置档案</h3><button className="text-button" disabled={!!busy || !!addressError || !model.trim()} onClick={saveProfile}>保存当前档案</button></div><label className="field">切换档案<select aria-label="切换模型配置档案" disabled={!!busy || !profiles.length} value="" onChange={event => { const profile = profiles[Number(event.target.value)]; if (event.target.value !== '' && profile) applyProfile(profile); }}><option value="">{profiles.length ? '选择地址与模型档案' : '尚无保存的档案'}</option>{profiles.map((profile, index) => <option key={profile.baseUrl + profile.model} value={index}>{profile.provider} · {profile.model}</option>)}</select></label><p>仅保存在此设备的当前账号下，不保存 Key；切换地址后需填写对应的 Key。</p>{profiles.length > 0 && <details><summary>管理档案（{profiles.length}）</summary>{profiles.map((profile, index) => <div className="profile-row" key={profile.baseUrl + profile.model}><span>{profile.provider} · {profile.model}<small>{profile.baseUrl}</small></span><button className="text-button" disabled={!!busy} onClick={() => setProfiles(previous => previous.filter((_, itemIndex) => itemIndex !== index))} aria-label={'删除档案 ' + profile.model}>删除</button></div>)}</details>}</section>
      <div className="settings-notice"><LockKeyhole size={19} /><p>{cloud ? 'API Key 仅保留在云端本次登录会话的内存中，退出或服务重启后需重新填写。' : 'API Key 仅保留在本机服务内存中。'}分析时只发送业务背景与聚合指标，不发送用户标识。</p></div>
      {cloud && <div className={`model-host-notice ${aiAllowed ? '' : 'model-unavailable'}`} role={aiAllowed ? 'note' : 'status'}><strong>{aiAllowed ? '允许的模型主机' : '管理员尚未开放 AI'}</strong><p>{aiAllowed ? modelHosts.join('、') : '当前服务未配置模型主机白名单。确定性分析和报告导出仍可使用。'}</p></div>}
      <label className="field">供应商名称<input value={provider} onChange={e => setProvider(e.target.value)} maxLength={80} disabled={!!busy} /></label>
      <label className="field">API 地址<input aria-label="API 地址" value={baseUrl} onChange={e => changeAddress(e.target.value)} placeholder="https://api.deepseek.com" type="url" disabled={!!busy} /><small className="field-help">填写基础地址；也支持粘贴完整的 Chat Completions 地址。</small></label>
      <label className="field"><span>API Key {canReuseKey && <span className="saved-key"><Check size={12} />已配置</span>}</span><input aria-label="API Key" type="password" autoComplete="off" value={key} onChange={e => { setKey(e.target.value); setTestResult(''); }} placeholder={canReuseKey ? '留空使用当前会话的 Key' : '输入此供应商的 API Key'} disabled={!!busy} /><small className="field-help">地址和 Key 填写完整后自动检测模型。检测只读取模型列表，测试连接会产生模型用量。</small></label>
      <div className="field">
        <div className="model-picker-heading"><label htmlFor="model-name">模型名称</label><button type="button" className="text-button" disabled={!aiAllowed || !!addressError || !keyReady || !!busy || catalogStatus === 'loading'} onClick={() => setRefresh(value => value + 1)} aria-label="重新检测模型">{catalogStatus === 'loading' ? <Spinner size={13} /> : <RefreshCw size={13} />}重新检测</button></div>
        {manual ? <input id="model-name" value={model} onChange={e => { setModel(e.target.value); setTestResult(''); }} maxLength={200} placeholder="填写供应商提供的完整模型 ID" disabled={!!busy} />
          : <ModelPicker id="model-name" models={showingFallback ? fallbackModels.map(id => ({ id, name: '目录常见型号' })) : canReuseKey && model === settings.model && !models.some(item => item.id === model) ? [{ id: model, name: '当前已保存' }, ...models] : models} value={model} onChange={next => { setModel(next); setTestResult(''); }} disabled={!!busy} loading={catalogStatus === 'loading'} />}
        <div className={`model-catalog-status ${catalogStatus === 'error' ? 'catalog-error' : ''}`} role={catalogStatus === 'error' ? 'alert' : 'status'}>
          {addressError || (!keyReady ? '填写当前地址对应的 API Key 后，自动获取可用模型。' : catalogStatus === 'loading' ? '正在向供应商获取模型列表…' : catalogStatus === 'error' ? catalogError : catalogStatus === 'ready' ? models.length ? `已检测到 ${models.length} 个模型${partial ? '（部分列表，可手动填写其他模型）' : ''}。` : '供应商未返回模型列表，已列出目录里的常见型号，请确认 Key 对它们的权限。' : '准备检测模型。')}
        </div>
        <div className="model-picker-footer"><small className="field-help">选择支持文本对话的模型；模型权限以供应商为准。</small><button type="button" className="text-button" disabled={!!busy} onClick={toggleManual}>{manual ? '从列表选择' : '手动填写'}</button></div>
      </div>
      {hasKey && <button className="text-button danger-text" onClick={() => void clear()} disabled={!!busy}>{busy === 'clear' && <Spinner size={13} />}移除当前 Key</button>}
      {error && <p className="form-error" role="alert">{error}</p>}{diagnostic && <aside className="model-diagnosis" role="note"><strong>{diagnostic.title}</strong><p>{diagnostic.action}</p></aside>}
      {testResult && <p className="form-success" role="status"><Check size={15} />{testResult}</p>}
      <p className="settings-test-note">模型调用费用从你的供应商账户扣除，与平台服务额度分开。</p>
      </>}
    </div>
    {!hubEnabled && <div className="modal-footer"><button className="button secondary" onClick={() => void save(true)} disabled={!!busy || !aiAllowed || !keyReady || !model.trim()}>{busy === 'test' ? <Spinner size={15} /> : <Zap size={15} />}测试连接</button><button className="button primary" disabled={!!busy || !aiAllowed} onClick={() => void save()}>{busy === 'save' && <Spinner size={15} />}保存设置</button></div>}
  </Modal>;
}
