import inputContract from '../input-contract.json';
import { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Plus, UploadCloud } from 'lucide-react';
import type { Dataset } from '../types';
import { useUpload } from '../use-upload';
import { UPLOAD_LIMITS, estimateUpload, overSizeMessage } from '../upload';
import { pasteToCsv } from '../data-inspection';
import { QualityIssues } from './DatasetInspection';
import { Spinner } from './ui';

export function UploadControl({ onSuccess, compact = false, onStart, onBusyChange, domain = 'game' }: { onSuccess: (dataset: Dataset) => void; compact?: boolean; onStart?: () => void; onBusyChange?: (busy: boolean) => void; domain?: string }) {
  const input = useRef<HTMLInputElement>(null); const [drag, setDrag] = useState(false); const [paste, setPaste] = useState(false); const [text, setText] = useState(''); const [pasteError, setPasteError] = useState('');
  const [timeZone, setTimeZone] = useState('');
  const [estimate, setEstimate] = useState<ReturnType<typeof estimateUpload> | null>(null); const [fileError, setFileError] = useState('');
  const upload = useUpload(onSuccess);
  useEffect(() => { onBusyChange?.(upload.busy); }, [upload.busy, onBusyChange]);
  function startFiles(files: File[]) {
    if (!files.length || upload.busy) return;
    const next = estimateUpload(files);
    setEstimate(next); setFileError('');
    if (next.overBytes) { setFileError(overSizeMessage(next.bytes)); return; }
    onStart?.(); void upload.start(files, { timezone: timeZone || undefined, domain });
  }
  function uploadPaste() {
    setPasteError('');
    try { const csv = pasteToCsv(text); startFiles([new File([csv], '粘贴运营数据.csv', { type: 'text/csv;charset=utf-8' })]); }
    catch (error) { setPasteError((error as Error).message); }
  }
  return <section className={`upload-control ${compact ? 'upload-compact' : 'upload-zone'} ${drag ? 'dragging' : ''}`} aria-label="上传并识别数据" onDragOver={event => { event.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={event => { event.preventDefault(); setDrag(false); if (!upload.busy) startFiles(Array.from(event.dataTransfer.files)); }}>
    {!compact && <><span className="upload-icon"><UploadCloud size={27} /></span><h3>上传数据，先确认识别结果</h3><p>{inputContract.description}</p></>}
    <div className="upload-actions"><button className="button primary" disabled={upload.busy} onClick={() => input.current?.click()}><Plus size={15} />{compact ? '上传数据' : '选择文件'}</button><button className="button secondary" disabled={upload.busy} onClick={() => setPaste(!paste)} aria-expanded={paste}><ClipboardPaste size={15} />粘贴表格</button></div>
    <input ref={input} type="file" accept={inputContract.supportedFormats.join(',')} multiple hidden onChange={event => { startFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <label className="field upload-timezone"><span>数据时区</span><select value={timeZone} onChange={event => setTimeZone(event.target.value)} disabled={upload.busy}><option value="">未确认（按 Asia/Shanghai 解释）</option><option value="Asia/Shanghai">Asia/Shanghai（UTC+08:00）</option><option value="UTC">UTC（UTC+00:00）</option><option value="UTC+09:00">UTC+09:00</option><option value="UTC-05:00">UTC-05:00</option></select></label>
    <small className="field-help">最多 {UPLOAD_LIMITS.maxFiles} 个文件、总大小不超过 20MB、解析后不超过 {UPLOAD_LIMITS.maxRows.toLocaleString()} 行；超出请按时间范围拆分后分批上传。时间戳自带偏移时按自身换算；未带时区的时间按所选时区解释，并持续显示在报告中。</small>
    {estimate && (upload.busy || estimate.overRows) && <p className={`upload-estimate${estimate.overRows ? ' warn' : ''}`}>{estimate.rows !== null ? `按体积估算约 ${estimate.rows.toLocaleString()} 行，` : ''}识别约需 {estimate.seconds} 秒（实际取决于机器与列数）。{estimate.overRows ? `可能超过 ${UPLOAD_LIMITS.maxRows.toLocaleString()} 行上限，建议按时间范围拆分文件。` : ''}</p>}
    {fileError && <p className="form-error" role="alert">{fileError}</p>}
    {paste && <div className="paste-table"><label className="field">粘贴表头和数据<textarea onKeyDown={event => { if (event.key === 'Enter') event.stopPropagation(); }} rows={5} value={text} onChange={event => setText(event.target.value)} placeholder={'玩家ID\t注册日期\t渠道\nplayer_001\t2026-10-01\t自然'} disabled={upload.busy} /></label><button className="button secondary" onClick={uploadPaste} disabled={upload.busy || !text.trim()}>识别粘贴内容</button>{pasteError && <p className="form-error" role="alert">{pasteError}</p>}</div>}
    <div className="upload-status" role="status" aria-live="polite">{upload.busy && <><div className="upload-progress"><progress max={100} value={upload.progress ?? undefined} aria-label="文件传输进度" /><span>{upload.status === 'processing' ? '传输完成，服务器正在识别…' : upload.progress == null ? '正在传输…' : `正在传输 ${upload.progress}%`}</span></div><button className="text-button" onClick={upload.cancel}>取消上传</button></>}{upload.status === 'success' && '数据已导入，请确认识别结果。'}{upload.status === 'cancelled' && '上传已取消；若服务端已完成识别，请刷新后核对数据列表。'}</div>
    {upload.error && <p className="form-error" role="alert">{upload.error}</p>}{upload.issues.length > 0 && <QualityIssues issues={upload.issues} />}
    {upload.busy && <span className="sr-only"><Spinner />上传或识别中</span>}
  </section>;
}
