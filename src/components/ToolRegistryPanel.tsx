import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../api';
import type { WorkToolEntry, WorkToolSummary } from '../superagent';

type Notify = (message: string, error?: boolean) => void;

const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置工具',
  executor: '执行器',
  mcp: 'MCP 工具',
  skill: '技能'
};
const RISK_LABELS: Record<WorkToolEntry['risk'], string> = { low: '低风险', medium: '中风险', high: '高风险' };

export function ToolRegistryPanel({ notify }: { notify: Notify }) {
  const [tools, setTools] = useState<WorkToolEntry[]>([]);
  const [summary, setSummary] = useState<WorkToolSummary | null>(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);

  const load = async (nextSource = source) => {
    setLoading(true);
    try {
      const result = await api.workToolsRegistry({ source: nextSource || undefined });
      setTools(result.tools);
      setSummary(result.summary);
    } catch (cause) {
      notify((cause as Error).message || '读取工具清单失败', true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [source]);

  const update = async (tool: WorkToolEntry, input: { enabled?: boolean; risk?: WorkToolEntry['risk'] }) => {
    setBusy(tool.id);
    try {
      const result = await api.workSetToolState(tool.id, input);
      setTools(previous => previous.map(item => item.id === tool.id ? result.tool : item));
      notify(`${tool.name}已更新。`);
    } catch (cause) {
      notify((cause as Error).message || '更新工具状态失败', true);
    } finally { setBusy(''); }
  };

  const reset = async (tool: WorkToolEntry) => {
    setBusy(tool.id);
    try {
      const result = await api.workResetToolState(tool.id);
      setTools(previous => previous.map(item => item.id === tool.id ? result.tool : item));
      notify(`${tool.name}已恢复默认。`);
    } catch (cause) {
      notify((cause as Error).message || '恢复默认失败', true);
    } finally { setBusy(''); }
  };

  const groups = ['builtin', 'executor', 'mcp', 'skill'].map(id => ({ id, rows: tools.filter(tool => tool.source === id) })).filter(group => group.rows.length);
  return <article className="sa-card sa-tool-registry">
    <div className="sa-section-head">
      <h2>工具注册表</h2>
      <span className="sa-tag">{summary ? `${summary.enabled}/${summary.total} 启用` : '载入中'}</span>
    </div>
    <p>执行器、MCP 工具、技能与内置工具的统一清单。这里只记录启停和风险级别，不修改执行器本身的实现；停用后模型不会再看到它。</p>
    <div className="sa-ops-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={!source} className={!source ? 'is-on' : ''} onClick={() => setSource('')}>全部</button>
      {Object.entries(SOURCE_LABELS).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={source === id} className={source === id ? 'is-on' : ''} onClick={() => setSource(id)}>{label}</button>)}
      <button type="button" className="sa-link" disabled={loading} onClick={() => void load()}><RefreshCw size={13} className={loading ? 'sa-spin' : ''} />刷新</button>
    </div>
    {summary && <p className="sa-inline-note">{`低风险 ${summary.byRisk.low || 0} · 中风险 ${summary.byRisk.medium || 0} · 高风险 ${summary.byRisk.high || 0}`}</p>}
    {groups.map(group => <section key={group.id} className="sa-tool-group">
      <h3>{SOURCE_LABELS[group.id] || group.id}<span>{group.rows.length}</span></h3>
      <div className="sa-ops-list">{group.rows.map(tool => <div className="sa-ops-row" key={tool.id}>
        <div>
          <strong>{tool.name}{tool.available === false ? <span className="sa-tag">不可用</span> : null}</strong>
          <span>{tool.description || tool.id} · {RISK_LABELS[tool.risk]}</span>
        </div>
        <div className="sa-ops-row-actions">
          <select aria-label={`${tool.name}风险级别`} value={tool.risk} disabled={busy === tool.id} onChange={event => void update(tool, { risk: event.target.value as WorkToolEntry['risk'] })}>
            <option value="low">低风险</option>
            <option value="medium">中风险</option>
            <option value="high">高风险</option>
          </select>
          <button type="button" className={tool.enabled ? 'sa-link' : 'sa-button sa-primary'} disabled={busy === tool.id} onClick={() => void update(tool, { enabled: !tool.enabled })}>
            {busy === tool.id ? '保存中…' : tool.enabled ? '停用' : '启用'}
          </button>
          <button type="button" className="sa-link" disabled={busy === tool.id} onClick={() => void reset(tool)}>恢复默认</button>
        </div>
      </div>)}</div>
    </section>)}
    {!groups.length && <p className="sa-empty">{loading ? '正在读取工具清单…' : '这个分类下还没有工具。'}</p>}
  </article>;
}
