import { access } from 'node:fs/promises';
import { buildReportHtml } from './report-document.js';

const MAX_CONCURRENT = 2;
let active = 0;
const queue = [];
const fail = (message, code) => Object.assign(new Error(message), { code });

async function acquire(signal) {
  signal.throwIfAborted();
  if (active < MAX_CONCURRENT) { active++; return; }
  if (queue.length >= 8) throw fail('PDF 导出队列繁忙，请稍后重试', 'PDF_BUSY');
  await new Promise((resolve, reject) => {
    const entry = { resolve: () => { signal.removeEventListener('abort', cancel); resolve(); } };
    const cancel = () => { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    queue.push(entry);
    if (signal.aborted) cancel();
  });
}
function release() { const next = queue.shift(); if (next) next.resolve(); else active--; }

async function executablePath(configured) {
  if (configured) { await access(configured); return configured; }
  // The production image installs Playwright Chromium. Windows development can
  // use its installed Edge without triggering an unbounded browser download.
  if (process.platform === 'win32') {
    for (const path of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
      try { await access(path); return path; } catch { /* Try next known browser. */ }
    }
  }
  return undefined;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function buildReportPdf(task, { signal, timeoutMs = 60000, browserExecutablePath = process.env.LAGENT_CHROMIUM_EXECUTABLE_PATH } = {}) {
  signal?.throwIfAborted();
  const html = buildReportHtml(task);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(fail('PDF 导出超时，可仅重试导出', 'PDF_TIMEOUT')), Math.max(1, Math.min(Number(timeoutMs) || 60000, 120000)));
  const combined = AbortSignal.any([timeout.signal, ...(signal ? [signal] : [])]);
  let acquired = false, browser;
  try {
    await acquire(combined); acquired = true;
    const { chromium } = await import('playwright');
    combined.throwIfAborted();
    const path = await executablePath(browserExecutablePath);
    // If cancellation wins during launch, close the late browser too.
    const launch = chromium.launch({ headless: true, executablePath: path, timeout: Math.min(Number(timeoutMs) || 60000, 60000), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run'] });
    launch.then(instance => { if (combined.aborted && browser !== instance) void instance.close().catch(() => {}); }, () => {});
    browser = await abortable(launch, combined);
    const closeOnAbort = () => { void browser.close().catch(() => {}); };
    combined.addEventListener('abort', closeOnAbort, { once: true });
    try {
      const context = await abortable(browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true, locale: 'zh-CN' }), combined);
      await context.route('**/*', route => route.request().url().startsWith('data:image/') ? route.continue() : route.abort('blockedbyclient'));
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      await abortable(page.setContent(html, { waitUntil: 'load', timeout: 30000 }), combined);
      await abortable(page.emulateMedia({ media: 'print' }), combined);
      const pdf = await abortable(page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:9px;color:#65767c;width:100%;padding:0 17mm;text-align:center;font-family:Arial,sans-serif">Lagent · <span class="pageNumber"></span> / <span class="totalPages"></span></div>', margin: { top: '18mm', right: '17mm', bottom: '19mm', left: '17mm' }, timeout: 30000 }), combined);
      combined.throwIfAborted();
      if (pdf.length > 24 * 1024 * 1024) throw fail('生成 PDF 超过 24MB 上限', 'PDF_TOO_LARGE');
      return Buffer.from(pdf);
    } finally { combined.removeEventListener('abort', closeOnAbort); }
  } catch (error) {
    if (combined.aborted) throw combined.reason;
    if (error.code?.startsWith('PDF_')) throw error;
    throw fail('PDF 排版失败，请检查 Playwright/Chromium 和中文字体运行环境', 'PDF_RENDER_FAILED');
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
    if (acquired) release();
  }
}
