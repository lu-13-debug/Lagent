import inputContract from './input-contract.json' with { type: 'json' };
import type { Dataset } from './types';

export const UPLOAD_LIMITS = Object.freeze({ maxFiles: inputContract.maxFiles, maxBytes: 20 * 1024 * 1024, maxRows: 200000 });
// 基准见 server/datasets.js：20 万行三表 CSV 约 7.2MB、解析 7.1 秒，折算约 36 字节/行、1MB/秒。
const CSV_BYTES_PER_ROW = 36;
const PARSE_BYTES_PER_SECOND = 1024 * 1024;

export interface UploadEstimate {
  files: number;
  bytes: number;
  rows: number | null;
  seconds: number;
  overBytes: boolean;
  overRows: boolean;
}

export function estimateUpload(files: Pick<File, 'name' | 'size'>[]): UploadEstimate {
  const bytes = files.reduce((total, file) => total + file.size, 0);
  const csvBytes = files.filter(file => /\.csv$/i.test(file.name)).reduce((total, file) => total + file.size, 0);
  const rows = csvBytes ? Math.max(1, Math.round(csvBytes / CSV_BYTES_PER_ROW)) : null;
  return {
    files: files.length,
    bytes,
    rows,
    seconds: Math.max(1, Math.round(bytes / PARSE_BYTES_PER_SECOND)),
    overBytes: bytes > UPLOAD_LIMITS.maxBytes,
    overRows: rows !== null && rows > UPLOAD_LIMITS.maxRows,
  };
}

const sizeText = (bytes: number) => `${(bytes / 1048576).toFixed(1)}MB`;
export const overSizeMessage = (bytes: number) => `文件总大小不能超过 20MB（当前 ${sizeText(bytes)}）；请按时间范围拆分文件、只导出必要列，或压缩日期范围后重试。`;

export interface UploadOptions { domain?: string; completeness?: { declared: 'full' | 'partial' | 'unknown'; shardNote?: string }; timezone?: string; signal?: AbortSignal; onProgress?: (percent: number | null) => void; onUnauthorized?: () => void }
export function uploadFiles(files: File[], options: UploadOptions = {}, createRequest: () => XMLHttpRequest = () => new XMLHttpRequest()): Promise<{ dataset: Dataset }> {
  return new Promise((resolve, reject) => {
    if (!files.length) { reject(new Error(inputContract.description)); return; }
    if (files.length > UPLOAD_LIMITS.maxFiles) { reject(new Error(`最多上传 ${UPLOAD_LIMITS.maxFiles} 个文件；请合并同表文件或按时间范围拆分后分批上传。`)); return; }
    const totalBytes = files.reduce((size, file) => size + file.size, 0);
    if (totalBytes > UPLOAD_LIMITS.maxBytes) { reject(new Error(overSizeMessage(totalBytes))); return; }
    if (options.signal?.aborted) { reject(new DOMException('上传已取消', 'AbortError')); return; }
    const xhr = createRequest(); let settled = false;
    const cleanup = () => options.signal?.removeEventListener('abort', cancel);
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const cancel = () => { xhr.abort(); fail(new DOMException('上传已取消', 'AbortError')); };
    xhr.open('POST', '/api/datasets/upload'); xhr.withCredentials = true; xhr.timeout = 180000;
    xhr.upload.onprogress = event => options.onProgress?.(event.lengthComputable ? Math.min(100, Math.round(event.loaded / event.total * 100)) : null);
    xhr.upload.onload = () => options.onProgress?.(100);
    xhr.onerror = () => fail(new Error('上传连接中断，请检查网络后重试；文件尚未确认导入成功。'));
    xhr.ontimeout = () => fail(new Error('上传或识别超时（已等待 3 分钟），请缩小文件或按时间范围拆分后重试。'));
    xhr.onabort = () => fail(new DOMException('上传已取消', 'AbortError'));
    xhr.onload = () => {
      if (settled || options.signal?.aborted) return;
      let body; try { body = JSON.parse(xhr.responseText); } catch { fail(new Error('服务未返回有效的识别结果，请重试。')); return; }
      if (xhr.status < 200 || xhr.status >= 300) {
        if (xhr.status === 401) options.onUnauthorized?.();
        const error = Object.assign(new Error(body?.error || `上传失败（${xhr.status}）。`), { issues: Array.isArray(body?.issues) ? body.issues : [] }); fail(error); return;
      }
      if (!body?.dataset?.id) { fail(new Error('服务未返回有效的数据集，请重试。')); return; }
      settled = true; cleanup(); resolve(body);
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const body = new FormData(); if (options.domain) body.append('domain', options.domain); if (options.completeness) body.append('completeness', JSON.stringify(options.completeness)); if (options.timezone) body.append('timezone', options.timezone); files.forEach(file => body.append('files', file));
    try { xhr.send(body); } catch { fail(new Error('无法发起上传，请检查文件和网络后重试。')); }
  });
}
