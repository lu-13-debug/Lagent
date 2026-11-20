import { useEffect, useState } from 'react';
import { request } from '../api';
import { filterMemory, memoryError, type MemoryItem } from '../memory';
import '../memory.css';

// 走统一的 API 层，会话过期与错误文案和其它页面保持一致。
const call = <T,>(path = '', method = 'GET', body?: unknown) => request<T>(`/memory${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

const scopeNames: Record<string, string> = { user: '用户', project: '项目' };
const typeNames: Record<string, string> = { preference: '偏好', glossary: '术语', decision: '决定', finding: '发现', constraint: '约束' };

export function MemoryPanel() {
  const [items, setItems] = useState<MemoryItem[]>([]), [scope, setScope] = useState(''), [type, setType] = useState(''), [error, setError] = useState(''), [editing, setEditing] = useState<MemoryItem | null>(null), [key, setKey] = useState(''), [value, setValue] = useState('');
  const load = () => call<{ memories: MemoryItem[] }>().then(data => setItems(data.memories)).catch(e => setError(e.message));
  useEffect(() => { void load(); }, []);
  const change = async (id: string, method: string, body?: unknown) => { try { await call<unknown>(`/${id}`, method, body); await load(); } catch (e) { setError((e as Error).message); } };
  const visible = filterMemory(items, scope, type);
  const reset = () => { setEditing(null); setKey(''); setValue(''); };

  return <section className="sa-memory">
    <div className="sa-memory-intro">
      <div>
        <h2>项目与用户记忆</h2>
        <p>记忆只在你确认后使用，可随时删除。偏好只影响表达与展示，不改变指标、合同或权限。</p>
      </div>
      <span className="sa-count">{items.length}</span>
    </div>

    <div className="sa-memory-filters">
      <label className="sa-field"><span>范围</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="">全部</option><option value="user">用户</option><option value="project">项目</option></select></label>
      <label className="sa-field"><span>类型</span><select value={type} onChange={e => setType(e.target.value)}><option value="">全部</option>{['preference', 'glossary', 'decision', 'finding', 'constraint'].map(t => <option key={t} value={t}>{typeNames[t]}</option>)}</select></label>
    </div>

    <form className="sa-memory-form" onSubmit={async e => {
      e.preventDefault();
      const message = memoryError(key, value);
      if (message) return setError(message);
      try {
        await call<unknown>(editing ? `/${editing.id}` : '', editing ? 'PATCH' : 'POST', { key, value, ...(!editing ? { scope: scope || 'user', type: type || 'preference' } : {}), status: 'confirmed' });
        reset();
        setError('');
        await load();
      } catch (err) { setError((err as Error).message); }
    }}>
      <div className="sa-memory-form-head">
        <h3>{editing ? '编辑记忆' : '新增记忆'}</h3>
        <p>{editing ? '修改后立即生效，旧版本不会保留。' : '写清楚「是什么」和「为什么」，之后对话里会优先参考。'}</p>
      </div>
      <label className="sa-field"><span>名称</span><input value={key} maxLength={120} placeholder="例如：数据口径 / 转化率定义" onChange={e => setKey(e.target.value)} /></label>
      <label className="sa-field"><span>内容</span><textarea value={value} maxLength={2000} placeholder="例如：转化率 = 付费人数 ÷ 活跃人数，按自然周统计。" onChange={e => setValue(e.target.value)} /></label>
      <div className="sa-memory-form-actions">
        <button type="submit" className="sa-button sa-primary">{editing ? '确认修改' : '确认添加'}</button>
        {editing && <button type="button" className="sa-button" onClick={reset}>取消编辑</button>}
      </div>
    </form>

    {error && <p className="sa-error" role="alert"><AlertIcon />{error}</p>}

    {visible.length ? <div className="sa-memory-list">{visible.map(m => <article key={m.id} className="sa-memory-item">
      <div className="sa-memory-item-head">
        <h3>{m.key}</h3>
        <div className="sa-memory-badges">
          <span className="sa-tag">{scopeNames[m.scope] || m.scope}</span>
          <span className="sa-tag">{typeNames[m.type] || m.type}</span>
          {!m.enabled && <span className="sa-tag sa-tag-off">已禁用</span>}
        </div>
      </div>
      <p>{m.value}</p>
      <div className="sa-memory-item-foot">
        <small>{m.status} · 更新于 {m.updatedAt}{m.sourceTaskId && ` · 来源任务 ${m.sourceTaskId}`}</small>
        <div className="sa-memory-item-actions">
          <button type="button" className="sa-link" onClick={() => { setEditing(m); setKey(m.key); setValue(m.value); }}>编辑</button>
          <button type="button" className="sa-link" onClick={() => void change(m.id, 'PATCH', { enabled: !m.enabled })}>{m.enabled ? '禁用' : '恢复'}</button>
          <button type="button" className="sa-link sa-link-danger" onClick={() => void change(m.id, 'DELETE')}>删除</button>
        </div>
      </div>
    </article>)}</div> : <div className="sa-empty-card sa-empty-card-stack"><h2>{items.length ? '没有符合筛选条件的记忆' : '还没有记忆'}</h2><p>{items.length ? '换一个范围或类型试试。' : '在上方添加一条，Agent 之后会按它来工作。'}</p></div>}
  </section>;
}

function AlertIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>;
}
