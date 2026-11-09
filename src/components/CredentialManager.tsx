import { useEffect, useRef, useState } from 'react';
import { KeyRound, Plus, RefreshCw, Save, X } from 'lucide-react';
import { credentialPayload } from '../workflow-types';
import type { CredentialInput, HubModelCatalog, HubModelProfile, ModelCredential, ModelProtocol } from '../workflow-types';
import { Spinner } from './ui';
import { ProviderCatalog } from './ProviderCatalog';
import { suggestedModels } from '../model-providers';

const protocolNames: Record<ModelProtocol, string> = { 'chat-completions': 'Chat Completions', anthropic: 'Anthropic Messages', responses: 'OpenAI Responses' };
const emptyCredential: CredentialInput = { name: '', provider: '自定义兼容接口', baseUrl: 'https://api.openai.com/v1', protocol: 'chat-completions', apiKey: '' };

export function CredentialManager({ credentials, profiles, writable, vaultReason, onSave, onDelete, onDetect }: {
  credentials: ModelCredential[]; profiles: HubModelProfile[]; writable: boolean; vaultReason?: string | null;
  onSave: (input: CredentialInput, id?: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDetect: (id: string) => Promise<HubModelCatalog>;
}) {
  const [editor, setEditor] = useState(false);
  const [saved, setSaved] = useState<ModelCredential>();
  const [draft, setDraft] = useState<CredentialInput>(emptyCredential);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState('');
  const [catalog, setCatalog] = useState<{ id: string; result: HubModelCatalog }>();
  // 刚保存的凭据：等列表刷新后自动识别一次模型，省掉再点「检测模型」。
  const pending = useRef<{ name: string; baseUrl: string } | null>(null);
  useEffect(() => {
    if (!pending.current || !credentials.length) return;
    const match = credentials.find(item => item.name === pending.current!.name && item.baseUrl === pending.current!.baseUrl && item.hasKey);
    if (!match) return;
    pending.current = null;
    void detect(match.id);
  }, [credentials]);

  function edit(item?: ModelCredential) {
    setSaved(item); setDraft(item ? { name: item.name, provider: item.provider, baseUrl: item.baseUrl, protocol: item.protocol, apiKey: '' } : { ...emptyCredential });
    setError(''); setMessage(''); setEditor(true); setDeleting('');
    if (item?.hasKey && writable) void detect(item.id);
  }
  async function save() {
    setError(''); setMessage('');
    try {
      const input = credentialPayload(draft, saved);
      setBusy('save');
      if (!saved) pending.current = { name: input.name, baseUrl: input.baseUrl };
      await onSave(input, saved?.id);
      setDraft({ ...emptyCredential }); setSaved(undefined); setEditor(false); setMessage('凭据已加密保存到当前账号。');
    } catch (e) { pending.current = null; setError((e as Error).message); }
    finally { setBusy(''); }
  }
  async function remove(id: string) {
    setBusy(id); setError(''); setMessage('');
    try { await onDelete(id); setDeleting(''); if (catalog?.id === id) setCatalog(undefined); setMessage('凭据已删除。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }
  async function detect(id: string) {
    setBusy(id); setError(''); setMessage(''); setCatalog(undefined);
    try { setCatalog({ id, result: await onDetect(id) }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(''); }
  }

  return <section className="hub-section" aria-label="凭据库">
    <div className="hub-section-heading"><div><h3>凭据库</h3><p>同一供应商可保存多组凭据，供不同模型配置使用。</p></div><button type="button" className="button secondary" disabled={!writable || !!busy} onClick={() => edit()}><Plus size={15} />新增凭据</button></div>
    {!writable && <p className="hub-notice" role="status">{vaultReason || '服务端未启用加密凭据库，请联系管理员配置部署主密钥。'} 可继续使用下方旧会话设置。</p>}
    {editor && <form className="hub-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="hub-editor-heading"><h4>{saved ? '编辑凭据' : '新增凭据'}</h4><button type="button" className="hub-icon-button" disabled={!!busy} aria-label="取消编辑凭据" onClick={() => { setEditor(false); setDraft({ ...emptyCredential }); setSaved(undefined); }}><X size={17} /></button></div>
      <ProviderCatalog compact disabled={!!busy} onPick={preset => setDraft({ ...draft, provider: preset.name, baseUrl: preset.baseUrl, protocol: preset.protocol, apiKey: '' })} />
      <div className="hub-form-grid"><label className="field">凭据名称<input required maxLength={80} value={draft.name} placeholder="例如：工作账号" disabled={!!busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label className="field">供应商名称<input required maxLength={80} value={draft.provider} disabled={!!busy} onChange={event => setDraft({ ...draft, provider: event.target.value })} /></label></div>
      <label className="field">API 基础地址<input aria-label="API 基础地址" required type="url" value={draft.baseUrl} placeholder="https://api.example.com/v1" disabled={!!busy} onChange={event => setDraft({ ...draft, baseUrl: event.target.value, apiKey: '' })} /><small>云端地址需在管理员允许的主机范围内。</small></label>
      <label className="field">接口协议<select value={draft.protocol} disabled={!!busy} onChange={event => setDraft({ ...draft, protocol: event.target.value as ModelProtocol, apiKey: '' })}>{Object.entries(protocolNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="field">API Key<input aria-label="API Key" type="password" autoComplete="off" spellCheck={false} value={draft.apiKey || ''} disabled={!!busy} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={saved?.hasKey ? '留空保留已保存的 Key' : '输入此地址对应的 Key'} /><small>{saved ? '修改地址或协议需要重新输入 Key。保存后不返回明文。' : 'Key 仅发往本站服务，由服务端加密保存。'}</small></label>
      <div className="hub-actions"><button className="button primary" type="submit" disabled={!!busy || !writable}>{busy === 'save' ? <Spinner size={15} /> : <Save size={15} />}保存凭据</button><button type="button" className="button secondary" disabled={!!busy} onClick={() => { setEditor(false); setDraft({ ...emptyCredential }); }}>取消</button></div>
      <p className="hub-field-hint">保存后会自动用这条 Key 识别可用模型，供「模型配置」直接选择。</p>
    </form>}
    {!credentials.length && !editor && <p className="hub-empty">尚无保存的凭据。添加后即可为不同分析阶段分配模型。</p>}
    <div className="hub-card-list">{credentials.map(item => {
      const count = profiles.filter(profile => profile.credentialId === item.id).length;
      return <article className="hub-card" key={item.id}><div className="hub-card-heading"><div><h4><KeyRound size={15} />{item.name}</h4><p>{item.provider} · {protocolNames[item.protocol]}</p></div><span className="hub-badge">{item.hasKey ? `已保存 ${item.keyHint || ''}` : '未配置 Key'}</span></div><p className="hub-endpoint">{item.baseUrl}</p><div className="hub-card-footer"><small>用于 {count} 个模型配置 · 版本 {item.version}</small><div className="hub-actions"><button type="button" className="text-button" disabled={!!busy || !item.hasKey || !writable} onClick={() => void detect(item.id)}>{busy === item.id ? <Spinner size={13} /> : <RefreshCw size={13} />}检测模型</button><button type="button" className="text-button" disabled={!!busy || !writable} onClick={() => edit(item)}>编辑</button><button type="button" className="text-button danger-text" disabled={!!busy || !writable} onClick={() => setDeleting(item.id)}>删除</button></div></div>
        {deleting === item.id && <div className="hub-delete-confirm"><p>确认删除「{item.name}」？{count ? '请先删除或更换引用此凭据的模型配置。' : '此凭据将无法继续用于模型请求。'}</p><div className="hub-actions"><button type="button" className="button secondary" disabled={!!busy || count > 0} onClick={() => void remove(item.id)}>确认删除</button><button type="button" className="text-button" disabled={!!busy} onClick={() => setDeleting('')}>取消</button></div></div>}
        {catalog?.id === item.id && <div className="hub-catalog" role="status"><p>{catalog.result.models.length ? `检测到 ${catalog.result.models.length} 个模型${catalog.result.partial ? '（部分列表，可手动填写其他模型 ID）' : ''}。请在「模型配置」中选择或填写。` : '供应商没有返回模型列表，下面是目录里的常见型号，权限仍以供应商控制台为准。'}</p><div>{(catalog.result.models.length ? catalog.result.models.map(model => model.id) : suggestedModels(item.baseUrl)).map(model => <code key={model}>{model}</code>)}</div></div>}
      </article>;
    })}</div>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="hub-feedback" role="status">{message}</p>}
  </section>;
}
