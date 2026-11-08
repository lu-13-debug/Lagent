import type { Capability } from '../types';

const tableLabels: Record<string, string> = { users: '注册表', activity: '活跃表', payments: '支付表' };

export function AnalysisScope({ capability, title = '本次分析范围' }: { capability?: Capability; title?: string }) {
  if (!capability) return null;
  const computed = capability.computed.map(id => capability.metrics[id]);
  const unavailable = capability.unavailable.map(id => capability.metrics[id]);
  return <section className="analysis-scope" aria-label={title}>
    <div className="analysis-scope-heading">
      <strong>{title}</strong>
      <span className="tiny-tag">{computed.length} 项已计算 · {unavailable.length} 项不可计算</span>
    </div>
    <dl>
      <div><dt>已计算</dt><dd>{computed.length ? computed.map(metric => metric.label).join('、') : '暂无'}</dd></div>
      {unavailable.length > 0 && <div><dt>不可计算</dt><dd>{unavailable.map(metric => `${metric.label}（缺${metric.missing.map(table => tableLabels[table] || table).join('、')}）`).join('；')}</dd></div>}
      {capability.missingTables.length > 0 && <div><dt>补齐方式</dt><dd>{capability.missingTables.map(table => `补充${table.label}后可计算：${table.unlocks.join('、') || '暂无'}`).join('；')}</dd></div>}
    </dl>
  </section>;
}
