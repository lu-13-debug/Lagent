import completenessCopy from '../completeness-copy.json';
import { Activity, ArrowDownRight, ArrowUpRight, CircleHelp, Coins, TrendingUp, Users } from 'lucide-react';
import type { ExploreMetricComparison, Exploration, Metric, Report } from '../types';
import { number } from './ui';
const definitions = [{ id: 'dau', label: '日活跃玩家', icon: Users, fallback: 'DAU' }, { id: 'new_users', label: '新增玩家', icon: Activity, fallback: '新增' }, { id: 'd1_retention', label: '次日留存率', icon: TrendingUp, fallback: '次日' }, { id: 'revenue', label: '期间支付收入', icon: Coins, fallback: '收入' }];
const icons = definitions.map(definition => definition.icon);
function PeriodChange({ comparison, unit }: { comparison?: ExploreMetricComparison; unit: string }) {
  if (!comparison?.comparable) return <span className="metric-comparison-note">上期不可比：{comparison?.reason || '缺少可确认的比较结果'}</span>;
  return <span className="metric-comparison-note">较上期同口径：{comparison.absoluteChange! > 0 ? '+' : ''}{number(comparison.absoluteChange, 2)} {unit === '%' ? '个百分点' : unit}{unit !== '%' && <>，变化率 {comparison.percentChange! > 0 ? '+' : ''}{number(comparison.percentChange, 2)}%</>}</span>;
}
function MetricCard({ metric, label, icon: Icon, report, comparison, decimals }: { metric?: Metric; label: string; icon: typeof Users; report: Report; comparison?: ExploreMetricComparison; decimals: number }) {
  const money = metric?.id === 'revenue';
  return <section className="metric-card" aria-label={label}>
    <div className="metric-label"><span>{label}</span><Icon size={15} strokeWidth={1.6} /></div>
    <div className="metric-value">{money && metric?.value != null && <span className="currency">{report.currency === 'CNY' ? '¥' : `${report.currency} `}</span>}{number(metric?.value, decimals)}{metric?.unit === '%' && metric.value != null && <small>%</small>}</div>
    <div className="metric-bottom">{comparison ? <PeriodChange comparison={comparison} unit={metric?.unit || ''} /> : metric?.value != null && metric?.change == null && report.dataCompleteness && report.dataCompleteness.declared !== 'full' ? <span>{metric?.note?.includes('边界日') ? '头条为最近非边界日；边界日完整性未验证' : report.dataCompleteness.declared === 'partial' ? completenessCopy.noComparisonPartial : report.dataCompleteness.comparisonMessage || completenessCopy.noComparison}</span> : metric?.change != null ? <><span className={`metric-change ${metric.change >= 0 ? 'up' : 'down'}`}>{metric.change >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{Math.abs(metric.change).toFixed(1)}%</span><span>较前一自然日</span></> : <span>{metric?.note || '暂无足够数据'}</span>}<span className="metric-info" title={metric?.note || '展开下方指标口径说明'}><CircleHelp size={12} /></span></div>
  </section>;
}
export function MetricCards({ report, result }: { report: Report; result?: Exploration }) {
  if (report.domain && report.domain !== 'game') {
    return <div className="metrics-grid">{report.metrics.slice(0, 4).map((metric, index) => <MetricCard key={metric.id} metric={metric} label={metric.label} icon={icons[index]} report={report} comparison={result?.comparison.requested ? result.comparison.metrics.find(item => item.id === metric.id) : undefined} decimals={metric.unit === '%' ? 1 : metric.unit === report.currency || ['revenue', 'aov', 'arppu', 'arpdau', 'acv', 'cpa', 'spend', 'refund_amount', 'store_rank', 'product_revenue'].includes(metric.id) ? 2 : 0} />)}</div>;
  }
  return <div className="metrics-grid">{definitions.map(definition => {
    const metric = report.metrics.find(item => item.id === definition.id) || report.metrics.find(item => item.label.includes(definition.fallback));
    const comparison = result?.comparison.requested ? result.comparison.metrics.find(item => item.id === metric?.id) : undefined;
    return <MetricCard key={definition.id} metric={metric} label={definition.label} icon={definition.icon} report={report} comparison={comparison} decimals={definition.id === 'd1_retention' ? 1 : definition.id === 'revenue' ? 2 : 0} />;
  })}</div>;
}
