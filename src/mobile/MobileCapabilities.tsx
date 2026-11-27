import { useEffect, useState } from 'react';
import { Package, RefreshCw, Wrench } from 'lucide-react';
import { mobileApi } from './mobile-api';
import type { MobileCapabilities as Capabilities, MobileMarketBundle, MobileTool } from './types';

const SOURCE_LABELS: Record<string, string> = {
  builtin: '内置',
  executor: '执行器',
  mcp: 'MCP',
  skill: '技能'
};
const RISK_LABELS: Record<MobileTool['risk'], string> = { low: '低风险', medium: '中风险', high: '高风险' };

// 手机端不复制一份工具实现，只读电脑端同一份注册表与市场；
// 停用工具或安装配置档都会直接写回服务端，电脑端刷新后看到的是同一个状态。
export function MobileCapabilities({ token, onToast }: { token: string; onToast: (message: string, error?: boolean) => void }) {
  const [data, setData] = useState<Capabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setData(await mobileApi.capabilities(token));
    } catch (cause) {
      onToast((cause as Error).message || '读取工具与市场失败', true);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const toggle = async (tool: MobileTool) => {
    if (busy) return;
    setBusy(tool.id);
    try {
      const result = await mobileApi.setToolState(token, tool.id, !tool.enabled);
      setData(previous => previous ? {
        ...previous,
        tools: previous.tools.map(item => item.id === tool.id ? result.tool : item),
        summary: { ...previous.summary, enabled: previous.tools.filter(item => item.id === tool.id ? result.tool.enabled : item.enabled).length }
      } : previous);
      onToast(`${tool.name}已${result.tool.enabled ? '启用' : '停用'}`);
    } catch (cause) { onToast((cause as Error).message || '更新失败', true); }
    finally { setBusy(''); }
  };

  const install = async (bundle: MobileMarketBundle) => {
    if (busy) return;
    setBusy(bundle.id);
    try {
      const result = await mobileApi.installBundle(token, bundle.id);
      setData(previous => previous ? {
        ...previous,
        market: { ...previous.market, listings: previous.market.listings.map(item => item.id === bundle.id ? { ...item, installed: true } : item) }
      } : previous);
      onToast(`已安装为配置档「${result.profile.name}」`);
    } catch (cause) { onToast((cause as Error).message || '安装失败', true); }
    finally { setBusy(''); }
  };

  return <div className="mob-settings-card">
    <h2><Wrench size={16} />工具与配置市场</h2>
    <p>与电脑端共用同一份工具注册表和 Agent 市场。停用后模型不会再看到该工具；安装市场配置会生成一个本地配置档。</p>
    {loading && !data && <p className="mob-loading"><RefreshCw size={15} className="mob-spin" />正在读取工具清单…</p>}
    {data && <>
      <p className="mob-hint">{data.summary.enabled}/{data.summary.total} 个工具启用 · 点右侧按钮切换</p>
      <div className="mob-cap-list">
        {data.tools.map(tool => <div className="mob-cap-row" key={tool.id}>
          <div>
            <strong>{tool.name}</strong>
            <span>{SOURCE_LABELS[tool.source] || tool.source} · {RISK_LABELS[tool.risk]}{tool.available ? '' : ' · 不可用'}</span>
          </div>
          <button type="button" className={tool.enabled ? 'mob-tiny' : 'mob-tiny is-solid'} disabled={Boolean(busy)} onClick={() => void toggle(tool)}>
            {busy === tool.id ? '保存中…' : tool.enabled ? '停用' : '启用'}
          </button>
        </div>)}
        {!data.tools.length && <p className="mob-hint">当前没有可管理的工具。</p>}
      </div>

      <h3><Package size={16} />Agent 市场</h3>
      {data.market.remote.configured && <p className="mob-hint">远程清单：{data.market.remote.url}{data.market.remote.error ? ` · ${data.market.remote.error}` : ''}</p>}
      <div className="mob-cap-list">
        {data.market.listings.map(bundle => <div className="mob-cap-row" key={bundle.id}>
          <div>
            <strong>{bundle.name}{bundle.remote ? <em className="mob-cap-tag">远程</em> : bundle.builtin ? <em className="mob-cap-tag">内置</em> : null}</strong>
            <span>{bundle.executorId} · {bundle.permission === 'read' ? '只读' : bundle.permission === 'full' ? '完全权限' : '可写工作区'}{bundle.instructions ? ` · ${bundle.instructions} 条指令` : ''}</span>
          </div>
          {bundle.installed
            ? <span className="mob-hint">已安装</span>
            : <button type="button" className="mob-tiny is-solid" disabled={Boolean(busy)} onClick={() => void install(bundle)}>{busy === bundle.id ? '安装中…' : '安装'}</button>}
        </div>)}
        {!data.market.listings.length && <p className="mob-hint">市场暂时没有配置。</p>}
      </div>
      <button type="button" className="mob-secondary" disabled={loading} onClick={() => void load()}>{loading ? '刷新中…' : '刷新'}</button>
    </>}
  </div>;
}
