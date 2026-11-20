import { useEffect, useRef, useState } from 'react';
import { Download, File, FileCode, FileSpreadsheet, FileText, Folder, FolderOpen, Image as ImageIcon, Presentation } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api';
import type { WorkProjectFileKind, WorkProjectFilePreview, WorkProjectFileTable } from '../superagent';

export const FILE_KIND_LABELS: Record<string, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  pdf: 'PDF',
  docx: 'Word 文档',
  doc: '旧版 Word',
  pptx: 'PowerPoint',
  ppt: '旧版 PPT',
  csv: '表格',
  sheet: 'Excel 表格',
  image: '图片',
  code: '代码',
  text: '文本',
  legacy: '旧版 Office',
  unsupported: '文件'
};

export function formatFileSize(bytes?: number) {
  if (bytes === undefined || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatFileTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const EXT_KINDS: Record<string, WorkProjectFileKind> = {
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html',
  pdf: 'pdf',
  docx: 'docx', doc: 'doc',
  pptx: 'pptx', ppt: 'ppt',
  csv: 'csv', tsv: 'csv',
  xls: 'sheet', xlsx: 'sheet',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', svg: 'image',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code', json: 'code', css: 'code', scss: 'code',
  py: 'code', go: 'code', rs: 'code', java: 'code', c: 'code', h: 'code', cpp: 'code', sh: 'code', yml: 'code', yaml: 'code', toml: 'code'
};

// 产物列表只有路径，先按扩展名选图标；预览返回后再用服务端的 kind。
export function fileKindFromPath(value: string): WorkProjectFileKind {
  const ext = value.split('.').pop()?.toLowerCase() || '';
  return EXT_KINDS[ext] || 'unsupported';
}

export function FileKindIcon({ kind, open = false }: { kind: WorkProjectFileKind; open?: boolean }) {
  if (kind === 'dir') return open ? <FolderOpen size={15} /> : <Folder size={15} />;
  if (kind === 'image') return <ImageIcon size={15} />;
  if (kind === 'pptx' || kind === 'ppt') return <Presentation size={15} />;
  if (kind === 'csv' || kind === 'sheet') return <FileSpreadsheet size={15} />;
  if (kind === 'code') return <FileCode size={15} />;
  if (kind === 'markdown' || kind === 'text' || kind === 'docx' || kind === 'doc' || kind === 'pdf') return <FileText size={15} />;
  return <File size={15} />;
}

const DOC_STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 34px 42px 60px; color: #111; background: #fff; font: 14px/1.8 "IBM Plex Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  h1 { font-size: 24px; line-height: 1.3; margin: 0 0 18px; }
  h2 { font-size: 19px; line-height: 1.35; margin: 28px 0 12px; }
  h3 { font-size: 16px; line-height: 1.4; margin: 22px 0 10px; }
  p { margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
  th, td { border: 1px solid #d6d3cc; padding: 7px 9px; text-align: left; vertical-align: top; }
  th { background: #f2f1ee; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 14px 0; padding-left: 14px; border-left: 2px solid #111; color: #4a4842; }
  code { padding: 1px 4px; background: #f2f1ee; font: 13px "IBM Plex Mono", Consolas, monospace; }
`;

function docDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_STYLE}</style></head><body>${html || '<p>文档没有可显示的内容。</p>'}</body></html>`;
}

function TableView({ table }: { table: WorkProjectFileTable }) {
  if (!table.headers.length && !table.rows.length) return <p className="pjf-empty">这张表没有可显示的内容。</p>;
  return <div className="pjf-table-wrap">
    <table className="pjf-table">
      <thead><tr>{table.headers.map((header, index) => <th key={`${index}-${header}`}>{header || '—'}</th>)}</tr></thead>
      <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {table.truncated && <p className="pjf-note">表格较大，仅显示前 200 行。</p>}
  </div>;
}

// 预览请求单独封装：文件页与产物页共用，切换路径时丢弃过期响应。
export function useProjectFilePreview(projectId: string, path: string | null, version = 0) {
  const [preview, setPreview] = useState<WorkProjectFilePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);
  useEffect(() => {
    const current = ++seq.current;
    setPreview(null);
    setError('');
    if (!path) { setLoading(false); return; }
    setLoading(true);
    void api.workProjectFilePreview(projectId, path)
      .then(result => { if (current === seq.current) setPreview(result); })
      .catch((cause: Error) => { if (current === seq.current) setError(cause.message); })
      .finally(() => { if (current === seq.current) setLoading(false); });
    return () => { seq.current += 1; };
  }, [projectId, path, version]);
  return { preview, loading, error };
}

export function FilePreviewBody({ projectId, preview }: { projectId: string; preview: WorkProjectFilePreview }) {
  const rawUrl = api.workProjectFileUrl(projectId, preview.path);
  switch (preview.kind) {
    case 'markdown':
      return <div className="pjf-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{preview.text || ''}</ReactMarkdown>{preview.truncated && <p className="pjf-note">文件较大，仅显示前 2MB。</p>}</div>;
    case 'text':
    case 'code':
      return <pre className={`pjf-text${preview.kind === 'code' ? ' is-code' : ''}`}>{preview.text || ''}{preview.truncated ? '\n\n…（文件较大，仅显示前 2MB）' : ''}</pre>;
    case 'html':
      return <iframe className="pjf-frame" title={preview.name} src={rawUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" />;
    case 'pdf':
      return <iframe className="pjf-frame" title={preview.name} src={`${rawUrl}#view=FitH`} />;
    case 'image':
      return <div className="pjf-image-box"><img className={preview.ext === 'svg' ? 'is-vector' : ''} src={rawUrl} alt={preview.name} /></div>;
    case 'docx':
      return <iframe className="pjf-frame pjf-doc" title={preview.name} sandbox="" srcDoc={docDocument(preview.html || '')} />;
    case 'pptx':
      return <div className="pjf-slides">
        {(preview.slides || []).length ? preview.slides!.map(slide => <article className="pjf-slide" key={slide.index}>
          <header><span>第 {slide.index} 页</span><strong>{slide.title}</strong></header>
          <pre>{slide.text || '（这一页没有文字）'}</pre>
        </article>) : <p className="pjf-empty">这个演示文稿没有可提取的文字。</p>}
        <p className="pjf-note">PPT 以文字方式预览，版式与图片请下载后查看。</p>
      </div>;
    case 'sheet':
      return <div className="pjf-sheets">{preview.sheets?.length ? preview.sheets.map(sheet => <section key={sheet.name}>
        <h3>{sheet.name}</h3>
        <TableView table={sheet} />
      </section>) : <p className="pjf-empty">这个工作簿没有可显示的内容。</p>}</div>;
    case 'csv':
      return <div className="pjf-table-page"><TableView table={{ headers: preview.headers || [], rows: preview.rows || [], truncated: preview.truncated }} /></div>;
    case 'doc':
    case 'ppt':
    case 'legacy':
    case 'unsupported':
      return <div className="pjf-empty pjf-empty-preview">
        <FileKindIcon kind={preview.kind} />
        <strong>{FILE_KIND_LABELS[preview.kind] || '文件'}暂不支持在线预览</strong>
        <span>{preview.message || '可以下载后用本机应用打开。'}</span>
        <a className="pj-btn" href={api.workProjectFileUrl(projectId, preview.path, true)} download>下载文件</a>
      </div>;
    default:
      return <div className="pjf-empty pjf-empty-preview"><span>这个格式暂不支持预览。</span></div>;
  }
}
