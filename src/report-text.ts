import type { WorkReport, WorkTicketDetail } from './superagent';

const textOf = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');

// 一份报告可能有多种产物形态：ACP 文本、CLI 摘要、窗口输出、验收报告。
// 会话线程与报告中心必须用同一套优先级，否则同一份结论会在两个页面显示成不同内容。
export function reportTextOfReport(report?: WorkReport | null): string {
  if (!report) return '';
  const artifacts = report.artifacts as Record<string, any> | undefined;
  return textOf(artifacts?.acp?.text)
    || textOf(artifacts?.cli?.summary)
    || textOf(artifacts?.window?.text)
    || textOf(artifacts?.report?.summary)
    || textOf(report.summary);
}

export function reportTextOf(detail?: WorkTicketDetail | null): string {
  if (!detail) return '';
  const reports = detail.reports || [];
  // 服务端 Store.list 按写入倒序返回，reports[0] 是最新一份；重试/返工后必须优先展示它。
  for (let index = 0; index < reports.length; index += 1) {
    const value = reportTextOfReport(reports[index]);
    if (value) return value;
  }
  return textOf(reports[0]?.summary) || textOf(detail.ticket.summary);
}
