import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, ChevronRight, Download, FileText, RefreshCw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mobileRequest } from './mobile-api';
import { FILE_KIND_LABELS, fileSize, statusNames, time } from './display';
import type { MobileAgent, MobileDetail, MobileFile, MobileFileLink, MobileFilePreview, MobileFileTable, MobileTicket } from './types';

export function TicketDetail({ detail, ticket, token, busy, agents, allowed, onBack, onOpen, onAct, onHandoff }: {
  detail: MobileDetail | null; ticket?: MobileTicket; token: string; busy: boolean; agents: MobileAgent[]; allowed: string[]; onBack: () => void; onOpen: (id: string) => void;
  onAct: (ticketId: string, action: string, input?: Record<string, unknown>) => Promise<void>;
  onHandoff: (ticketId: string, executorId: string, text?: string) => Promise<void>;
}) {
  // 交接是两个 Agent 之间的事：终端这类工具不参与接力。
  const available = agents.filter(agent => allowed.includes(agent.id) && agent.status === 'available' && ['codex', 'claude-code'].includes(agent.id) && ['model', 'cli', 'window'].includes(agent.kind || ''));
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { if (!target && available.length) setTarget(available[0].id); }, [available, target]);
  if (!ticket) return <section className="mob-page"><button type="button" className="mob-back" onClick={onBack}><ArrowLeft size={16} />返回</button><p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在载入详情…</p></section>;
  const reports = detail?.reports || [];
  const team = detail?.team;
  const canStop = ['working', 'queued', 'awaiting_review', 'waiting'].includes(ticket.status);
  const canRetry = ['failed', 'cancelled', 'blocked'].includes(ticket.status);
  return <section className="mob-page mob-detail">
    <button type="button" className="mob-back" onClick={onBack}><ArrowLeft size={16} />返回</button>
    <div className="mob-detail-head"><span className={`mob-status mob-status-${ticket.status}`}>{statusNames[ticket.status] || ticket.status}</span><time>{time(ticket.updatedAt || ticket.createdAt)}</time></div>
    <h1>{ticket.title || '任务详情'}</h1>
    {ticket.summary && <p className="mob-lead">{ticket.summary}</p>}
    {ticket.planId && ticket.planTotal ? <p className="mob-hint">多步计划第 {(ticket.planStep ?? 0) + 1}/{ticket.planTotal} 步</p> : null}
    <dl className="mob-meta"><div><dt>执行器</dt><dd>{ticket.executor || '—'}</dd></div><div><dt>阶段</dt><dd>{ticket.stage || '—'}</dd></div><div><dt>来源</dt><dd>{ticket.source || '—'}</dd></div></dl>
    {ticket.attention?.question && <div className="mob-callout"><AlertTriangle size={16} /><div><strong>需要确认</strong><p>{ticket.attention.question}</p></div></div>}
    <div className="mob-detail-actions">
      {ticket.attention?.options?.map(option => <button type="button" key={option.id || option.action} className={option.action === 'approve' ? 'mob-primary' : 'mob-secondary'} disabled={busy} onClick={() => void onAct(ticket.id, option.action || 'approve')}>{option.label || option.action}</button>)}
      {canStop && <button type="button" className="mob-secondary" disabled={busy} onClick={() => void onAct(ticket.id, 'stop')}>停止任务</button>}
      {canRetry && <button type="button" className="mob-secondary" disabled={busy} onClick={() => void onAct(ticket.id, 'retry')}>重试</button>}
    </div>
    <TicketFiles ticketId={ticket.id} token={token} />
    {ticket.status === 'completed' && <section className="mob-handoff">
      <h2 className="mob-section-title">交给另一个 Agent</h2>
      {ticket.handoffChildId ? <button type="button" className="mob-secondary" onClick={() => onOpen(ticket.handoffChildId!)}>查看下一棒<ChevronRight size={14} /></button> : <div className="mob-handoff-form">
        <label>目标执行器<select value={target} onChange={event => setTarget(event.target.value)}>{available.length ? available.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>) : <option value="">没有可用执行器</option>}</select></label>
        <label>补充说明<input value={note} onChange={event => setNote(event.target.value)} placeholder="可选：希望下一棒关注什么" /></label>
        <button type="button" className="mob-primary" disabled={busy || !target} onClick={() => void onHandoff(ticket.id, target, note.trim() || undefined)}>交接</button>
      </div>}
    </section>}
    {ticket.parentTicketId && <div className="mob-lineage"><p>来自上一棒工单 {ticket.parentTicketId.slice(0, 8)}，当前为第 {ticket.handoffDepth ?? 1} 棒。</p>{ticket.handoffSummary && <p>上一棒摘要：{ticket.handoffSummary}</p>}</div>}
    <h2 className="mob-section-title">进展</h2>
    {reports.length ? <ul className="mob-reports">{reports.map(report => <li key={report.id}><div><strong>{report.kind || 'report'}</strong>{report.summary && <p>{report.summary}</p>}</div><time>{time(report.createdAt)}</time></li>)}</ul> : <p className="mob-hint">还没有可展示的报告。</p>}
    {team?.nodes?.length ? <><h2 className="mob-section-title">团队</h2><ul className="mob-team">{team.nodes.map(node => <li key={node.id}><span>{'　'.repeat(Math.max(0, (node.depth || 1) - 1))}{node.status === 'completed' ? '✓' : '·'} {node.proposals?.[0]?.kind || '节点'}</span><span className={`mob-status mob-status-${node.status || 'pending'}`}>{statusNames[node.status || 'pending'] || node.status}</span></li>)}</ul></> : null}
  </section>;
}

const DOC_STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 20px 18px 44px; color: #111; background: #fff; font: 15px/1.75 "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 16px; }
  h2 { font-size: 18px; margin: 24px 0 10px; }
  h3 { font-size: 16px; margin: 20px 0 9px; }
  p { margin: 0 0 11px; }
  table { width: 100%; border-collapse: collapse; margin: 14px 0; font-size: 13px; }
  th, td { border: 1px solid #d6d3cc; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #f2f1ee; font-weight: 600; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 12px 0; padding-left: 12px; border-left: 2px solid #111; color: #4a4842; }
  code { padding: 1px 4px; background: #f2f1ee; font: 13px "IBM Plex Mono", Consolas, monospace; }
`;

function docDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${DOC_STYLE}</style></head><body>${html || '<p>文档没有可显示的内容。</p>'}</body></html>`;
}

async function requestFileLink(ticketId: string, token: string, path: string, download: boolean) {
  return mobileRequest<MobileFileLink>(`/tickets/${encodeURIComponent(ticketId)}/file/link`, token, {
    method: 'POST', body: JSON.stringify({ path, download })
  });
}

async function downloadTicketFile(ticketId: string, token: string, file: MobileFile) {
  const link = await requestFileLink(ticketId, token, file.path, true);
  const bridge = (window as unknown as { LagentDownload?: { setFileName?: (value: string) => void } }).LagentDownload;
  try { bridge?.setFileName?.(link.name); } catch { /* 浏览器里没有桥接。 */ }
  const anchor = document.createElement('a');
  anchor.href = link.url;
  anchor.download = link.name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function TicketFiles({ ticketId, token }: { ticketId: string; token: string }) {
  const [files, setFiles] = useState<MobileFile[] | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState<MobileFile | null>(null);
  useEffect(() => {
    let live = true;
    setFiles(null); setMessage(''); setError('');
    mobileRequest<{ files: MobileFile[]; message?: string }>(`/tickets/${encodeURIComponent(ticketId)}/files`, token)
      .then(result => { if (!live) return; setFiles(Array.isArray(result.files) ? result.files : []); setMessage(result.message || ''); })
      .catch((cause: Error) => { if (!live) return; setFiles([]); setError(cause.message); });
    return () => { live = false; };
  }, [ticketId, token]);
  const download = async (file: MobileFile) => {
    if (busy) return;
    setBusy(file.path); setError('');
    try { await downloadTicketFile(ticketId, token, file); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(''); }
  };
  return <>
    <h2 className="mob-section-title">文件</h2>
    {files === null ? <p className="mob-hint"><RefreshCw size={14} className="mob-spin" />正在读取这次执行的文件…</p>
      : files.length ? <ul className="mob-files">{files.map(file => <li key={file.path}>
        <button type="button" className="mob-file-open" onClick={() => setOpen(file)}>
          <FileText size={16} />
          <span><strong>{file.name}</strong><small>{FILE_KIND_LABELS[file.kind] || '文件'}{file.size ? ` · ${fileSize(file.size)}` : ''} · {file.path}</small></span>
          <ChevronRight size={15} />
        </button>
        <button type="button" className="mob-icon" aria-label={`下载 ${file.name}`} disabled={busy === file.path} onClick={() => void download(file)}>
          {busy === file.path ? <RefreshCw size={16} className="mob-spin" /> : <Download size={16} />}
        </button>
      </li>)}</ul> : <p className="mob-hint">{message || '这次执行没有记录到可下载的文件。'}</p>}
    {error && <p className="mob-error">{error}</p>}
    {open && <FilePreviewSheet ticketId={ticketId} token={token} file={open} onClose={() => setOpen(null)} />}
  </>;
}

function FileTable({ table }: { table: MobileFileTable }) {
  if (!table.headers.length && !table.rows.length) return <p className="mob-hint">这张表没有可显示的内容。</p>;
  return <div className="mob-file-table-wrap">
    <table className="mob-file-table">
      <thead><tr>{table.headers.map((header, index) => <th key={`${index}-${header}`}>{header || '—'}</th>)}</tr></thead>
      <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
    </table>
    {table.truncated && <p className="mob-hint">表格较大，仅显示前 200 行。</p>}
  </div>;
}

function PdfPages({ url }: { url: string }) {
  const [pages, setPages] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [more, setMore] = useState(0);
  useEffect(() => {
    let live = true;
    setPages([]); setError(''); setMore(0);
    if (!url) return () => { live = false; };
    void (async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`PDF 读取失败（${response.status}）`);
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
      const limit = Math.min(pdf.numPages, 12);
      const rendered: string[] = [];
      try {
        for (let index = 1; index <= limit; index += 1) {
          if (!live) return;
          const page = await pdf.getPage(index);
          const ratio = Math.min(window.devicePixelRatio || 1, 2);
          const base = page.getViewport({ scale: 1 });
          const scale = Math.min(1.6, 1080 / Math.max(1, base.width));
          const viewport = page.getViewport({ scale: scale * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('手机浏览器不支持画布渲染');
          await page.render({ canvasContext: context, viewport }).promise;
          rendered.push(canvas.toDataURL('image/jpeg', 0.82));
          if (live) setPages([...rendered]);
        }
      } finally { void pdf.destroy(); }
      if (live) setMore(Math.max(0, pdf.numPages - limit));
    })().catch(cause => { if (live) setError((cause as Error).message || 'PDF 渲染失败'); });
    return () => { live = false; };
  }, [url]);
  if (error) return <p className="mob-preview-note">{error}。可以直接下载后用手机 PDF 阅读器打开。</p>;
  if (!pages.length) return <p className="mob-hint"><RefreshCw size={14} className="mob-spin" />正在渲染 PDF…</p>;
  return <div className="mob-pdf-pages">
    {pages.map((source, index) => <img key={index} src={source} alt={`第 ${index + 1} 页`} />)}
    {more > 0 && <p className="mob-preview-note">为保证手机流畅，仅预览前 12 页，还有 {more} 页请下载查看。</p>}
  </div>;
}

function FilePreviewBody({ preview, url }: { preview: MobileFilePreview; url: string }) {
  switch (preview.kind) {
    case 'markdown':
      return <div className="mob-preview-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{preview.text || ''}</ReactMarkdown>{preview.truncated && <p className="mob-preview-note">文件较大，仅显示前 2MB。</p>}</div>;
    case 'text':
    case 'code':
      return <pre className="mob-preview-text">{preview.text || ''}{preview.truncated ? '\n\n…（文件较大，仅显示前 2MB）' : ''}</pre>;
    case 'html':
      return url ? <iframe className="mob-preview-frame" title={preview.name} src={url} sandbox="allow-scripts" referrerPolicy="no-referrer" /> : <p className="mob-hint"><RefreshCw size={14} className="mob-spin" />正在打开网页…</p>;
    case 'pdf':
      return <PdfPages url={url} />;
    case 'image':
      return url ? <img className="mob-preview-image" src={url} alt={preview.name} /> : <p className="mob-hint"><RefreshCw size={14} className="mob-spin" />正在载入图片…</p>;
    case 'docx':
      return <iframe className="mob-preview-frame mob-preview-doc" title={preview.name} sandbox="" srcDoc={docDocument(preview.html || '')} />;
    case 'pptx':
      return <div className="mob-preview-slides">
        {(preview.slides || []).length ? preview.slides!.map(slide => <article key={slide.index}>
          <header><span>第 {slide.index} 页</span><strong>{slide.title}</strong></header>
          <pre>{slide.text || '（这一页没有文字）'}</pre>
        </article>) : <p className="mob-hint">这个演示文稿没有可提取的文字。</p>}
        <p className="mob-preview-note">PPT 以文字方式预览，版式和图片请下载后查看。</p>
      </div>;
    case 'sheet':
      return <div className="mob-preview-sheets">
        {preview.sheets?.length ? preview.sheets.map(sheet => <section key={sheet.name}>
          <h3>{sheet.name}</h3>
          <FileTable table={sheet} />
        </section>) : <p className="mob-hint">这个工作簿没有可显示的内容。</p>}
      </div>;
    case 'csv':
      return <FileTable table={{ headers: preview.headers || [], rows: preview.rows || [], truncated: preview.truncated }} />;
    case 'doc':
    case 'ppt':
    case 'legacy':
    case 'unsupported':
      return <p className="mob-preview-note">{preview.message || '这个格式暂不支持在线预览，可以下载后用手机应用打开。'}</p>;
    default:
      return <p className="mob-preview-note">这个格式暂不支持在线预览，可以下载查看。</p>;
  }
}

function FilePreviewSheet({ ticketId, token, file, onClose }: { ticketId: string; token: string; file: MobileFile; onClose: () => void }) {
  const [preview, setPreview] = useState<MobileFilePreview | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    setPreview(null); setUrl(''); setError(''); setNotice('');
    void (async () => {
      const data = await mobileRequest<MobileFilePreview>(`/tickets/${encodeURIComponent(ticketId)}/file/preview?path=${encodeURIComponent(file.path)}`, token);
      if (!live) return;
      setPreview(data);
      if (['pdf', 'image', 'html'].includes(data.kind)) {
        const link = await requestFileLink(ticketId, token, file.path, false);
        if (live) setUrl(link.url);
      }
    })().catch((cause: Error) => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [ticketId, token, file.path]);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', onKey); };
  }, [onClose]);
  const download = async () => {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      await downloadTicketFile(ticketId, token, file);
      setNotice('已开始下载，完成后可在手机的「下载」中打开。');
    } catch (cause) { setNotice((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="mob-sheet-layer" role="dialog" aria-modal="true" aria-label={`预览 ${file.name}`}>
    <button type="button" className="mob-sheet-backdrop" aria-label="关闭预览" onClick={onClose} />
    <div className="mob-sheet">
      <header className="mob-sheet-head">
        <div><strong>{file.name}</strong><span>{FILE_KIND_LABELS[preview?.kind || file.kind] || '文件'}{file.size ? ` · ${fileSize(file.size)}` : ''}</span></div>
        <button type="button" className="mob-icon" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="mob-sheet-body">
        {error ? <p className="mob-error">{error}</p>
          : !preview ? <p className="mob-hint"><RefreshCw size={14} className="mob-spin" />正在准备预览…</p>
            : <FilePreviewBody preview={preview} url={url} />}
      </div>
      <footer className="mob-sheet-foot">
        <button type="button" className="mob-primary" disabled={busy} onClick={() => void download()}>
          {busy ? <RefreshCw size={16} className="mob-spin" /> : <Download size={16} />}{busy ? '正在准备下载…' : '下载到手机'}
        </button>
        {notice && <p className="mob-hint">{notice}</p>}
      </footer>
    </div>
  </div>;
}
