import { STATUS_LABELS } from '../status';

// 与后端 roster 的分类一致：model/cli/window 才是能自己干活的 Agent，
// 受控终端、浏览器、GitHub 是被调用工具，界面上不能和 Agent 混在一个列表里。
export const AGENT_KINDS = new Set(['model', 'cli', 'window']);
export const isAgentKind = (kind?: string) => AGENT_KINDS.has(kind || '');

export const statusNames: Record<string, string> = { ...STATUS_LABELS, accepted: '已接受', budget_warning: '预算告警' };

export const FILE_KIND_LABELS: Record<string, string> = {
  markdown: 'Markdown', html: 'HTML', pdf: 'PDF', docx: 'Word 文档', doc: '旧版 Word',
  pptx: 'PowerPoint', ppt: '旧版 PPT', csv: '表格', sheet: 'Excel 表格', image: '图片',
  code: '代码', text: '文本', legacy: '旧版 Office', unsupported: '文件'
};

export const fileSize = (bytes?: number) => {
  if (bytes === undefined || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const time = (value?: string) => value
  ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—';

export const effortLabel = (effort?: string) => ({
  default: '模型默认', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高'
} as Record<string, string>)[effort || 'default'] || effort || '';
