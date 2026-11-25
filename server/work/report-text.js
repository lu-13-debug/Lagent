// 报告正文的唯一提取实现：桌面详情、移动裁剪、报告全文路由都走这里，避免三处不一致。
const textOf = value => (typeof value === 'string' ? value.trim() : '');

export function reportTextOfReport(report) {
  const source = report && typeof report === 'object' && !Array.isArray(report) ? report : {};
  const artifacts = source.artifacts && typeof source.artifacts === 'object' ? source.artifacts : {};
  return textOf(artifacts?.acp?.text)
    || textOf(artifacts?.cli?.summary)
    || textOf(artifacts?.window?.text)
    || textOf(artifacts?.report?.summary)
    || textOf(source.summary);
}

export function clipReportText(value, max) {
  const text = typeof value === 'string' ? value : '';
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 20000;
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false };
}
