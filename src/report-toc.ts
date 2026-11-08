import type { Report } from './types';

export interface ReportTocItem { id: string; label: string }

export const REPORT_TOC_IDS = {
  summary: 'report-summary',
  metrics: 'report-metrics',
  trend: 'report-trend',
  charts: 'report-charts',
  channels: 'report-channels',
  figures: 'report-figures',
  findings: 'report-findings',
  actions: 'report-actions',
  quality: 'report-quality',
  source: 'report-source',
} as const;

export function reportToc(report: Report, hasScope = false): ReportTocItem[] {  const labels = report.labels || {};
  const items: ReportTocItem[] = [
    { id: REPORT_TOC_IDS.summary, label: labels.summaryTitle || '运营摘要' },
    { id: REPORT_TOC_IDS.source, label: '来源与审查记录' },
    { id: REPORT_TOC_IDS.metrics, label: '关键指标' },
    { id: REPORT_TOC_IDS.trend, label: labels.trendTitle || '玩家与收入趋势' },
    { id: REPORT_TOC_IDS.charts, label: '图表查看' },
    { id: REPORT_TOC_IDS.channels, label: labels.channelTitle || '渠道表现' },
  ];
  if (!hasScope && report.charts?.length) items.push({ id: REPORT_TOC_IDS.figures, label: '补充图表' });
  if (report.findings.length) items.push({ id: REPORT_TOC_IDS.findings, label: '主要发现' });
  if (report.recommendations.length) items.push({ id: REPORT_TOC_IDS.actions, label: '下一步行动' });
  items.push({ id: REPORT_TOC_IDS.quality, label: '数据质量与方法' });
  return items;
}

export function activeTocId(items: ReportTocItem[], tops: Record<string, number>, offset: number): string {
  let current = items.length ? items[0].id : '';
  for (const item of items) {
    const top = tops[item.id];
    if (typeof top === 'number' && top <= offset) current = item.id;
  }
  return current;
}
