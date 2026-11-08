import { useEffect, useState } from 'react';
import { BookOpen, Check, FileUp, KeyRound, Layers3, Plus, RefreshCw, Save, Settings2, X, Zap } from 'lucide-react';
import { completeWorkflow, EFFORT_LABELS, effortOptions, normalizeEffort, validateSkillFile, validateWorkflow, WORKFLOW_STAGES } from '../workflow-types';
import type { CredentialInput, HubModelCatalog, HubModelProfile, ModelHubState, ModelProfileInput, WorkflowConfig, WorkflowSkill, WorkflowSkillInput, WorkflowStageConfig } from '../workflow-types';
import { CredentialManager } from './CredentialManager';
import { Spinner } from './ui';
import '../workflow-settings.css';

async function hubRequest<T>(path: string, method = 'GET', input?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(30000);
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    if (signal?.aborted) throw new Error('请求已停止。');
    throw new Error(timeout.aborted ? '请求超时，请刷新核对服务端状态后重试。' : '无法连接服务，请检查网络后重试。');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.error || (response.status === 401 ? '登录已过期，请重新登录。' : `请求失败（${response.status}）。`)), { status: response.status, code: body?.code });
  }
  try { return await response.json() as T; }
  catch { throw new Error('服务返回了无法读取的结果，请刷新后重试。'); }
}

export function ModelHubSettings({ onWorkflowChanged, compact = false }: { onWorkflowChanged?: () => void | Promise<void>; compact?: boolean }) {
  const [hub, setHub] = useState<ModelHubState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [section, setSection] = useState('workflow');
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setUnavailable(false);
    void hubRequest<ModelHubState>('/model-hub', 'GET', undefined, controller.signal).then(state => {
      if (!controller.signal.aborted) setHub(state);
    }).catch((e: Error & { status?: number }) => {
      if (controller.signal.aborted) return;
      if (e.status === 404 || e.status === 405 || e.status === 501) setUnavailable(true);
      else setError(e.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function refresh() {
    const next = await hubRequest<ModelHubState>('/model-hub');
    setHub(next);
  }
  async function saveCredential(input: CredentialInput, id?: string) {
    await hubRequest(id ? `/model-credentials/${encodeURIComponent(id)}` : '/model-credentials', id ? 'PUT' : 'POST', input);
    await refresh();
  }
  async function removeCredential(id: string) { await hubRequest(`/model-credentials/${encodeURIComponent(id)}`, 'DELETE'); await refresh(); }
  async function saveProfile(input: ModelProfileInput, id?: string) {
    await hubRequest(id ? `/model-profiles/${encodeURIComponent(id)}` : '/model-profiles', id ? 'PUT' : 'POST', input);
    await refresh(); await onWorkflowChanged?.();
  }
  async function removeProfile(id: string) { await hubRequest(`/model-profiles/${encodeURIComponent(id)}`, 'DELETE'); await refresh(); await onWorkflowChanged?.(); }
  async function saveWorkflow(workflow: WorkflowConfig) {
    const result = await hubRequest<{ workflow: WorkflowConfig }>('/workflow-config', 'PUT', workflow);
    setHub(previous => previous && { ...previous, workflow: result.workflow });
    await onWorkflowChanged?.();
  }
  async function saveSkill(input: WorkflowSkillInput, id?: string) {
    await hubRequest(id ? `/workflow-skills/${encodeURIComponent(id)}` : '/workflow-skills', id ? 'PUT' : 'POST', input);
    await refresh();
  }
  async function removeSkill(id: string) { await hubRequest(`/workflow-skills/${encodeURIComponent(id)}`, 'DELETE'); await refresh(); }

  const sections = [{ id: 'workflow', name: '阶段工作流', icon: Layers3 }, { id: 'credentials', name: '凭据库', icon: KeyRound }, { id: 'profiles', name: '模型配置', icon: Settings2 }, { id: 'skills', name: 'Skill 指令', icon: BookOpen }];
  return <section className="model-hub" aria-label="模型中心与工作流">
    <div className="hub-title"><div><h3>{compact ? '阶段模型与 Skill' : '模型中心与工作流'}</h3><p>为每个阶段选择模型和 Skill，设置影响后续创建的任务。</p></div></div>
    {loading && <p className="hub-loading" role="status"><Spinner size={16} />正在读取账号配置…</p>}
    {unavailable && <p className="hub-notice" role="status">当前服务尚未开放模型中心。可使用下方旧会话设置连接模型。</p>}
    {error && <div className="hub-notice" role="alert"><p>{error}</p><button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />重新读取</button></div>}
    {hub && !loading && !error && <>
      {!hub.vault.available && <p className="hub-notice" role="status">{hub.vault.reason || '持久凭据库当前不可用，请联系管理员检查部署主密钥。'}</p>}
      {!compact && <nav className="hub-nav" aria-label="模型中心分区">{sections.map(item => <button key={item.id} type="button" aria-pressed={section === item.id} onClick={() => setSection(item.id)}><item.icon size={15} />{item.name}</button>)}</nav>}
      <div hidden={!compact && section !== 'workflow'}><WorkflowSettings workflow={hub.workflow} profiles={hub.profiles} skills={hub.skills} onSave={saveWorkflow} /></div>
      {!compact && <><div hidden={section !== 'credentials'}><CredentialManager credentials={hub.credentials} profiles={hub.profiles} writable={hub.vault.available} vaultReason={hub.vault.reason} onSave={saveCredential} onDelete={removeCredential} onDetect={id => hubRequest<HubModelCatalog>(`/model-credentials/${encodeURIComponent(id)}/models`, 'POST', {})} /></div>
      <div hidden={section !== 'profiles'}><ProfileManager hub={hub} onSave={saveProfile} onDelete={removeProfile} onDetect={id => hubRequest<HubModelCatalog>(`/model-credentials/${encodeURIComponent(id)}/models`, 'POST', {})} /></div>
      <div hidden={section !== 'skills'}><SkillManager skills={hub.skills} workflow={hub.workflow} onSave={saveSkill} onDelete={removeSkill} /></div></>}
    </>}
  </section>;
}

export function StageWorkflowSettings({ onChanged }: { onChanged?: () => void | Promise<void> }) { return <ModelHubSettings compact onWorkflowChanged={onChanged} />; }

export function WorkflowSettings({ workflow, profiles, skills, onSave }: { workflow: WorkflowConfig; profiles: HubModelProfile[]; skills: WorkflowSkill[]; onSave: (workflow: WorkflowConfig) => Promise<void> }) {
  const [draft, setDraft] = useState(() => completeWorkflow(workflow, skills));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const persisted = JSON.stringify(workflow);
  useEffect(() => { setDraft(completeWorkflow(workflow, skills)); setShowErrors(false); }, [persisted]); // 仅工作流保存改变时更新草稿，其他分区操作保留未保存编辑。
  const errors = validateWorkflow(draft, profiles, skills);
  const dirty = JSON.stringify(draft) !== JSON.stringify(completeWorkflow(workflow, skills));
  function update(id: string, next: Partial<WorkflowStageConfig>) { setDraft(previous => ({ ...previous, stages: { ...previous.stages, [id]: { ...previous.stages[id], ...next } } })); setMessage(''); setError(''); }
  async function save() {
    setShowErrors(true); setError(''); setMessage('');
    if (errors.length) return;
    setBusy(true);
    try { await onSave(draft); setMessage(draft.defaultProfileId ? '工作流已保存，将用于后续 AI 分析任务。' : '已保存配置并关闭阶段模型工作流，后续任务可使用旧会话设置。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="hub-section" aria-label="阶段工作流配置">
    <div className="hub-section-heading"><div><h3>阶段工作流</h3><p>阶段顺序固定；每次任务冻结模型、强度和 Skill 版本。</p></div><span className="hub-badge">13 个阶段</span></div>
    <label className="field">工作流默认模型<select aria-label="工作流默认模型" value={draft.defaultProfileId || ''} disabled={busy} onChange={event => { setDraft({ ...draft, defaultProfileId: event.target.value || null }); setMessage(''); }}><option value="">关闭阶段模型工作流，使用旧会话设置</option>{draft.defaultProfileId && !profiles.some(item => item.id === draft.defaultProfileId) && <option value={draft.defaultProfileId}>模型已删除，请重新选择</option>}{profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select><small>{profiles.length ? '阶段选择「继承默认模型」时使用此配置；更换模型后需核对支持的强度。' : '先在凭据库保存 Key，再到模型配置添加模型。'}</small></label>
    <p className="hub-notice">{draft.defaultProfileId ? '阶段模型工作流已启用。各阶段可独立覆盖默认模型。' : '当前未启用阶段模型工作流。你仍可编辑并保存阶段配置。'} 思考强度越高，耗时和供应商费用可能增加。</p>
    <div className="hub-stage-list">{WORKFLOW_STAGES.map((stage, index) => {
      const config = draft.stages[stage.id];
      const profile = profiles.find(item => item.id === (config.profileId || draft.defaultProfileId));
      const options = effortOptions(profile);
      const reviewerCandidate = profiles.find(p => !p.unavailable && p.id !== (config.profileId ?? draft.defaultProfileId));
      const skillOptions = skills.filter(item => item.stageId === stage.id && item.enabled);
      const unsupported = Boolean(profile) && !options.some(option => option.value === normalizeEffort(config.effort) && option.supported);
      return <article key={stage.id} className="hub-stage"><div className="hub-stage-heading"><span className="hub-step-number">{String(index + 1).padStart(2, '0')}</span><div><h4>{stage.name}</h4><p>{stage.description}</p></div>{stage.tool && <span className="hub-badge">工具执行</span>}</div>
        <div className="hub-stage-fields"><label className="field">Skill<select value={config.skillId} disabled={busy} onChange={event => update(stage.id, { skillId: event.target.value })}>{!skillOptions.some(item => item.id === config.skillId) && <option value={config.skillId}>{config.skillId ? 'Skill 不可用，请重新选择' : '请选择 Skill'}</option>}{skillOptions.map(skill => <option key={skill.id} value={skill.id}>{skill.name} · v{skill.version}</option>)}</select></label>
          {!stage.tool && <><label className="field">模型<select value={config.profileId || ''} disabled={busy} onChange={event => update(stage.id, { profileId: event.target.value || null })}><option value="">继承默认模型</option>{config.profileId && !profiles.some(item => item.id === config.profileId) && <option value={config.profileId}>模型已删除，请重新选择</option>}{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.model}</option>)}</select></label><label className="field">思考强度<select value={config.effort} disabled={busy} aria-invalid={unsupported} onChange={event => update(stage.id, { effort: event.target.value })}>{!options.some(option => option.value === config.effort) && <option value={config.effort} disabled>{config.effort}（不支持）</option>}{options.map(option => <option key={option.value} value={option.value} disabled={!option.supported}>{option.label}{option.supported ? '' : profile ? '（不支持）' : '（待选择模型）'}</option>)}</select></label></>}
        </div>
        {!stage.tool && <p className={unsupported ? 'hub-field-error' : 'hub-field-hint'}>{unsupported ? '所选模型不支持此强度，请明确改选可用档位。' : profile ? `${profile.model} · ${profile.capabilities.tools ? '支持原生工具调用' : '使用受控结构化工具协议'}` : '启用工作流后，此阶段将继承默认模型。'}</p>}
        {['insights','report'].includes(stage.id) && <details><summary>子智能体（可选）</summary><label><input type="checkbox" checked={!!config.team?.enabled} disabled={busy} onChange={e=>update(stage.id,{team:{enabled:e.target.checked}})}/>启用分层团队模式</label><p>团队模式：最多3层、3个并发模型请求、累计12个子任务（根节点不计），共享48次模型调用与65536 Token预算。等待子任务不会占用模型执行槽。</p><p>由主 Agent 按需调用，最多3次；子智能体只读，不递归，可能增加模型费用。</p>{(config.subagents||[]).map((child,index)=><fieldset key={child.id}><legend>子智能体 {index+1}</legend><label>角色 Skill<select value={child.skillId||''} onChange={e=>update(stage.id,{subagents:config.subagents!.map((s,i)=>i===index?{...s,skillId:e.target.value||undefined}:s)})}><option value="">继承父阶段</option>{skills.filter(s=>s.enabled&&s.stageId===stage.id).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>角色思考强度<select value={child.effort||''} onChange={e=>update(stage.id,{subagents:config.subagents!.map((s,i)=>i===index?{...s,effort:e.target.value||undefined}:s)})}><option value="">继承父阶段</option>{(profiles.find(p=>p.id===child.profileId)?.capabilities.efforts||['default']).map(e=><option key={e} value={e}>{e}</option>)}</select></label><label>模型<select value={child.profileId} disabled={busy} onChange={e=>update(stage.id,{subagents:config.subagents!.map((s,i)=>i===index?{...s,profileId:e.target.value}:s)})}>{profiles.filter(p=>!p.unavailable&&p.id!==(config.profileId??draft.defaultProfileId)).map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>名称<input value={child.name} maxLength={100} onChange={e=>update(stage.id,{subagents:config.subagents!.map((s,i)=>i===index?{...s,name:e.target.value}:s)})}/></label><label>职责<input value={child.role} maxLength={300} onChange={e=>update(stage.id,{subagents:config.subagents!.map((s,i)=>i===index?{...s,role:e.target.value}:s)})}/></label><button type="button" disabled={busy} onClick={()=>update(stage.id,{subagents:config.subagents!.filter((_,i)=>i!==index)})}>删除子智能体</button></fieldset>)}<button type="button" disabled={busy||!reviewerCandidate||(config.subagents?.length||0)>=3} onClick={()=>reviewerCandidate&&update(stage.id,{subagents:[...(config.subagents||[]),{id:crypto.randomUUID(),profileId:reviewerCandidate.id,name:'只读核查',role:'核查提供的证据和限制'}]})}>添加子智能体</button>{!reviewerCandidate&&<p>没有可用的其他模型配置</p>}</details>}
{stage.id === 'insights' && <details className="hub-review"><summary>多模型评审（可选）</summary><p>裁判由本阶段模型担任；每位评审员增加 1 次模型调用，耗时和供应商费用可能增加。</p><label className="hub-checkbox"><input type="checkbox" aria-label="启用洞察多模型评审" disabled={busy || !reviewerCandidate} checked={!!config.review?.reviewerProfileIds.length} onChange={event => update(stage.id,{review:{reviewerProfileIds:event.target.checked && reviewerCandidate ? [reviewerCandidate.id] : []}})} />启用洞察多模型评审</label>{!reviewerCandidate && <p>没有可用的其他模型配置</p>}{!!config.review?.reviewerProfileIds.length && <div className="hub-form-grid">{[0,1,2].map(slot => {const selected=config.review?.reviewerProfileIds || [];return <label className="field" key={slot}>评审员 {slot+1}<select aria-label={`评审员 ${slot+1}`} disabled={busy} value={selected[slot] || ''} onChange={event => {const next=[...selected];next[slot]=event.target.value;update(stage.id,{review:{reviewerProfileIds:next.filter(Boolean)}});}}><option value="">{slot===0?'请选择评审员':'不使用'}</option>{selected[slot] && !profiles.some(p=>p.id===selected[slot]) && <option value={selected[slot]}>模型已不可用，请重新选择</option>}{profiles.filter(p=>!p.unavailable && p.id!==(config.profileId ?? draft.defaultProfileId) && (!selected.includes(p.id)||selected[slot]===p.id)).map(p=><option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}</select></label>;})}</div>}</details>}
        <details className="hub-budget"><summary>{stage.tool ? '工具超时' : '输出预算与超时'}<span>{stage.tool ? '' : `${config.maxTokens.toLocaleString()} Token · `}{config.timeoutMs / 1000} 秒</span></summary><div className="hub-form-grid">{!stage.tool && <label className="field">最多输出 Token<input type="number" min={256} max={32768} step={1} value={Number.isNaN(config.maxTokens) ? '' : config.maxTokens} disabled={busy} onChange={event => update(stage.id, { maxTokens: event.target.valueAsNumber })} /></label>}<label className="field">超时（秒）<input type="number" min={1} max={600} step={1} value={Number.isNaN(config.timeoutMs) ? '' : config.timeoutMs / 1000} disabled={busy} onChange={event => update(stage.id, { timeoutMs: event.target.valueAsNumber * 1000 })} /></label></div></details>
      </article>;
    })}</div>
    {showErrors && errors.length > 0 && <div className="hub-validation" role="alert"><p>请先修正以下配置：</p><ul>{errors.map(item => <li key={item}>{item}</li>)}</ul></div>}
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="hub-feedback" role="status"><Check size={15} />{message}</p>}
    <div className="hub-save-bar"><span>{dirty ? '有未保存的工作流修改' : '当前配置已保存'}</span><button type="button" className="button primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? <Spinner size={15} /> : <Save size={15} />}保存工作流</button></div>
  </section>;
}

function ProfileManager({ hub, onSave, onDelete, onDetect }: { hub: ModelHubState; onSave: (input: ModelProfileInput, id?: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onDetect: (id: string) => Promise<HubModelCatalog> }) {
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState<string>();
  const [draft, setDraft] = useState<ModelProfileInput>({ name: '', credentialId: '', model: '' });
  const [catalog, setCatalog] = useState<HubModelCatalog>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState('');
  function edit(profile?: HubModelProfile) { setId(profile?.id); setDraft(profile ? { name: profile.name, credentialId: profile.credentialId, model: profile.model } : { name: '', credentialId: hub.credentials[0]?.id || '', model: '' }); setCatalog(undefined); setError(''); setMessage(''); setEditing(true); setDeleting(''); }
  async function act(name: string, action: () => Promise<void>) { setBusy(name); setError(''); setMessage(''); try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } }
  async function save() {
    if (!draft.name.trim() || !draft.model.trim() || !draft.credentialId) { setError('请填写名称、选择凭据和完整模型 ID。'); return; }
    await act('save', async () => { await onSave({ ...draft, name: draft.name.trim(), model: draft.model.trim() }, id); setEditing(false); setMessage('模型配置已保存。能力由服务端按模型和协议确认。'); });
  }
  return <section className="hub-section" aria-label="模型配置">
    <div className="hub-section-heading"><div><h3>模型配置</h3><p>每个配置绑定一组凭据和完整模型 ID。</p></div><button type="button" className="button secondary" disabled={!!busy || !hub.credentials.length || !hub.vault.available} onClick={() => edit()}><Plus size={15} />新增模型</button></div>
    {!hub.credentials.length && <p className="hub-empty">请先在「凭据库」添加模型供应商凭据。</p>}
    {editing && <form className="hub-editor" onSubmit={event => { event.preventDefault(); void save(); }}><div className="hub-editor-heading"><h4>{id ? '编辑模型配置' : '新增模型配置'}</h4><button type="button" className="hub-icon-button" aria-label="取消编辑模型" disabled={!!busy} onClick={() => setEditing(false)}><X size={17} /></button></div>
      <label className="field">配置名称<input required maxLength={80} value={draft.name} disabled={!!busy} placeholder="例如：报告撰写模型" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field">使用凭据<select required value={draft.credentialId} disabled={!!busy} onChange={event => { setDraft({ ...draft, credentialId: event.target.value, model: '' }); setCatalog(undefined); }}><option value="">请选择凭据</option>{hub.credentials.map(item => <option key={item.id} value={item.id}>{item.name} · {item.provider} · {item.keyHint || '已保存'}</option>)}</select></label>
      <label className="field">完整模型 ID<input required maxLength={200} value={draft.model} disabled={!!busy} placeholder="填写供应商提供的完整模型 ID" onChange={event => setDraft({ ...draft, model: event.target.value })} /></label>
      <button type="button" className="text-button" disabled={!!busy || !draft.credentialId || !hub.vault.available} onClick={() => void act('detect', async () => { setCatalog(await onDetect(draft.credentialId)); })}>{busy === 'detect' ? <Spinner size={14} /> : <RefreshCw size={14} />}检测此凭据的可用模型</button>
      {catalog && <label className="field">从检测结果填入<select aria-label="从检测结果填入" value="" disabled={!!busy} onChange={event => { if (event.target.value) setDraft({ ...draft, model: event.target.value }); }}><option value="">{catalog.models.length ? `选择模型（${catalog.models.length} 个）` : '未返回模型，可手动填写'}</option>{catalog.models.map(item => <option key={item.id} value={item.id}>{item.name && item.name !== item.id ? `${item.name} · ` : ''}{item.id}</option>)}</select><small>{catalog.partial ? '供应商仅返回部分列表，仍可手动填写其他模型。' : '模型目录不代表当前 Key 已获全部调用权限。'}</small></label>}
      <p className="hub-field-hint">未知模型仅开放默认强度。保存不会自动发起付费连接测试。</p><div className="hub-actions"><button className="button primary" type="submit" disabled={!!busy || !hub.vault.available}>{busy === 'save' ? <Spinner size={15} /> : <Save size={15} />}保存模型</button><button className="button secondary" type="button" disabled={!!busy} onClick={() => setEditing(false)}>取消</button></div>
    </form>}
    <div className="hub-card-list">{hub.profiles.map(profile => {
      const credential = hub.credentials.find(item => item.id === profile.credentialId);
      const used = hub.workflow.defaultProfileId === profile.id || Object.values(hub.workflow.stages).some(stage => stage.profileId === profile.id);
      return <article className="hub-card" key={profile.id}><div className="hub-card-heading"><div><h4>{profile.name}</h4><p>{profile.model}</p></div>{hub.workflow.defaultProfileId === profile.id && <span className="hub-badge">默认模型</span>}</div><p>{credential?.name || '凭据已不可用'} · 强度：{effortOptions(profile).filter(item => item.supported).map(item => item.label).join(' / ')}</p><div className="hub-actions"><button className="text-button" type="button" disabled={!!busy || !hub.vault.available} onClick={() => void act(profile.id, async () => { const result = await hubRequest<{ ok: boolean; message: string }>(`/model-profiles/${encodeURIComponent(profile.id)}/test`, 'POST', {}); if (!result.ok) throw new Error(result.message || '连接测试失败。'); setMessage(`${profile.name}：${result.message || '连接成功。'}`); })}>{busy === profile.id ? <Spinner size={14} /> : <Zap size={14} />}测试连接</button><button className="text-button" type="button" disabled={!!busy} onClick={() => edit(profile)}>编辑</button><button className="text-button danger-text" type="button" disabled={!!busy} onClick={() => setDeleting(profile.id)}>删除</button></div>{deleting === profile.id && <div className="hub-delete-confirm"><p>{used ? '此模型正在用于工作流，请先在阶段工作流中更换引用并保存。' : `确认删除「${profile.name}」？关联凭据将保留。`}</p><div className="hub-actions"><button className="button secondary" type="button" disabled={!!busy || used} onClick={() => void act(profile.id, async () => { await onDelete(profile.id); setDeleting(''); setMessage('模型配置已删除。'); })}>确认删除</button><button className="text-button" type="button" disabled={!!busy} onClick={() => setDeleting('')}>取消</button></div></div>}</article>;
    })}</div>
    <p className="hub-field-hint">检测只读取模型目录；点击「测试连接」会发起一次模型请求，可能产生供应商费用。</p>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="hub-feedback" role="status">{message}</p>}
  </section>;
}

function SkillManager({ skills, workflow, onSave, onDelete }: { skills: WorkflowSkill[]; workflow: WorkflowConfig; onSave: (input: WorkflowSkillInput, id?: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [editor, setEditor] = useState(false);
  const [id, setId] = useState<string>();
  const [draft, setDraft] = useState<WorkflowSkillInput>({ name: '', description: '', category: 'private', enabled: true, stageId: 'quality', content: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [deleting, setDeleting] = useState('');
  const contentBytes = new TextEncoder().encode(draft.content).byteLength;
  function edit(skill?: WorkflowSkill, copy = false) {
    setId(copy ? undefined : skill?.id); setDraft(skill ? { name: skill.name + (copy ? '（私人副本）' : ''), description: skill.description, category: 'private', enabled: skill.enabled, stageId: skill.stageId, content: skill.content } : { name: '', description: '', category: 'private', enabled: true, stageId: 'quality', content: '' });
    setEditor(true); setError(''); setMessage(''); setDeleting('');
  }
  async function save() {
    setError(''); setMessage('');
    if (!draft.name.trim() || !draft.content.trim()) { setError('请填写 Skill 名称和 Markdown 指令内容。'); return; }
    if (contentBytes > 64 * 1024) { setError('Skill 内容不能超过 64KB。'); return; }
    setBusy(true);
    try { await onSave({ ...draft, name: draft.name.trim() }, id); setEditor(false); setMessage('私人 Skill 已保存。请在阶段工作流中选择后保存。'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="hub-section" aria-label="Skill 指令管理"><div className="hub-section-heading"><div><h3>Skill 指令</h3><p>内置指令只读，可复制为当前账号的私人版本。</p></div><button type="button" className="button secondary" disabled={busy} onClick={() => edit()}><Plus size={15} />新增 Skill</button></div>
    {editor && <form className="hub-editor" onSubmit={event => { event.preventDefault(); void save(); }}><div className="hub-editor-heading"><h4>{id ? '编辑私人 Skill' : '新增私人 Skill'}</h4><button type="button" className="hub-icon-button" disabled={busy} aria-label="取消编辑 Skill" onClick={() => setEditor(false)}><X size={17} /></button></div>
      <div className="hub-form-grid"><label className="field">Skill 名称<input required maxLength={80} value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label><label className="field">适用阶段<select value={draft.stageId} disabled={busy} onChange={event => setDraft({ ...draft, stageId: event.target.value })}>{WORKFLOW_STAGES.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label></div>
      <label className="field">描述<input maxLength={500} value={draft.description} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></label><label className="hub-checkbox"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />启用此 Skill</label>
      <label className="hub-file-import"><span><FileUp size={15} />导入 Markdown 文件（最多 64KB）</span><input type="file" accept=".md,.markdown,text/markdown" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; const problem = validateSkillFile(file); if (problem) { setError(problem); return; } setBusy(true); setError(''); void file.text().then(content => { setDraft(previous => ({ ...previous, content, name: previous.name || file.name.replace(/\.(md|markdown)$/i, '') })); }).catch(() => setError('无法读取此文件，请重新选择。')).finally(() => setBusy(false)); }} /></label>
      <label className="field">Markdown 指令<textarea aria-label="Markdown 指令" rows={14} spellCheck={false} value={draft.content} disabled={busy} onChange={event => setDraft({ ...draft, content: event.target.value })} placeholder={'# 阶段目标\n说明输入、允许的分析步骤、输出格式与核验要求。'} /><small className={contentBytes > 65536 ? 'hub-field-error' : ''}>{(contentBytes / 1024).toFixed(1)} / 64KB。内容作为模型指令使用；工具权限仍由服务器控制。</small></label>
      <div className="hub-actions"><button className="button primary" type="submit" disabled={busy || contentBytes > 65536}>{busy ? <Spinner size={15} /> : <Save size={15} />}保存 Skill</button><button className="button secondary" type="button" disabled={busy} onClick={() => setEditor(false)}>取消</button></div>
    </form>}
    <div className="hub-card-list">{skills.map(skill => {
      const used = Object.values(workflow.stages).some(stage => stage.skillId === skill.id);
      return <article className="hub-card" key={skill.id}><div className="hub-card-heading"><div><h4>{skill.name}</h4><p>{WORKFLOW_STAGES.find(stage => stage.id === skill.stageId)?.name || skill.stageId} · v{skill.version}</p></div><span className="hub-badge">{skill.builtin ? '内置' : '私人'} · {skill.enabled ? '已启用' : '已停用'}</span></div><p>{skill.description}</p><details className="hub-skill-content"><summary>查看 Markdown 指令</summary><pre>{skill.content}</pre></details><div className="hub-actions"><button type="button" className="text-button" disabled={busy} onClick={() => edit(skill, true)}>创建私人副本</button>{!skill.builtin && <><button type="button" className="text-button" disabled={busy} onClick={() => edit(skill)}>编辑</button><button type="button" className="text-button danger-text" disabled={busy} onClick={() => setDeleting(skill.id)}>删除</button></>}</div>{deleting === skill.id && <div className="hub-delete-confirm"><p>{used ? '此 Skill 正在用于工作流，请先更换阶段 Skill 并保存。' : `确认删除私人 Skill「${skill.name}」？已有任务保留冻结版本。`}</p><div className="hub-actions"><button className="button secondary" type="button" disabled={busy || used} onClick={() => { setBusy(true); setError(''); void onDelete(skill.id).then(() => { setDeleting(''); setMessage('私人 Skill 已删除。'); }).catch((e: Error) => setError(e.message)).finally(() => setBusy(false)); }}>确认删除</button><button className="text-button" type="button" disabled={busy} onClick={() => setDeleting('')}>取消</button></div></div>}</article>;
    })}</div>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="hub-feedback" role="status">{message}</p>}
  </section>;
}
