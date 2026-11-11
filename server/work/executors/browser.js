import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { workError } from '../domain.js';

const require = createRequire(import.meta.url);
const defaultPlaywright = (() => {
  try { return require('playwright'); } catch { return null; }
})();
const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const DEFAULT_MAX_CHARS = 8000;
const MAX_INPUT_CHARS = 50000;
const MAX_LINKS = 30;

function cleanHostname(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function ipv4Parts(value) {
  const parts = String(value).split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

function isPrivateIpv4(parts) {
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function ipv6Words(value) {
  let address = cleanHostname(value).split('%')[0].toLowerCase();
  if (!address.includes(':')) return null;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const ipv4 = ipv4Parts(address.slice(lastColon + 1));
    if (!ipv4) return null;
    address = `${address.slice(0, lastColon + 1)}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill('0'), ...right].map(word => Number.parseInt(word, 16));
  return words.length === 8 && words.every(word => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null;
}

function isPrivateIpv6(words) {
  if (!words) return true;
  if (words.every(word => word === 0)) return true;
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if ((words[0] & 0xffc0) === 0xfe80 || (words[0] & 0xffc0) === 0xfec0) return true;
  if ((words[0] & 0xff00) === 0xff00) return true;
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
  const ipv4Mapped = words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff;
  const ipv4Compatible = words.slice(0, 6).every(word => word === 0);
  if (ipv4Mapped || ipv4Compatible) {
    const ipv4 = [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff];
    return isPrivateIpv4(ipv4);
  }
  return false;
}

export function isPublicIp(value) {
  const host = cleanHostname(value);
  const family = isIP(host);
  if (family === 4) return !isPrivateIpv4(ipv4Parts(host));
  if (family === 6) return !isPrivateIpv6(ipv6Words(host));
  return false;
}

function hostnameIsObviouslyBlocked(hostname) {
  const host = cleanHostname(hostname);
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host)) return !isPublicIp(host);
  return false;
}

export function validateBrowserInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('浏览器执行器需要 URL');
  if (typeof input.url !== 'string' || !input.url.trim() || input.url.length > 2048) throw workError('浏览器 URL 无效');
  let parsed;
  try { parsed = new URL(input.url.trim()); } catch { throw workError('浏览器 URL 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw workError('浏览器仅支持 HTTP/HTTPS URL');
  if (parsed.username || parsed.password) throw workError('浏览器 URL 不能包含凭据');
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw workError('浏览器仅允许标准 HTTP/HTTPS 端口');
  if (hostnameIsObviouslyBlocked(parsed.hostname)) throw workError('浏览器 URL 指向本地或私网地址');
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_INPUT_CHARS) throw workError(`maxChars 必须为 1 至 ${MAX_INPUT_CHARS} 的整数`);
  return { url: parsed.href, maxChars };
}

async function assertPublicUrl(rawUrl, lookupHost, hostCache) {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw workError('已阻止非公开网络请求');
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw workError('已阻止非标准端口请求');
  const hostname = cleanHostname(parsed.hostname);
  if (hostnameIsObviouslyBlocked(hostname)) throw workError('已阻止本地或私网请求');
  if (isIP(hostname)) return parsed.href;
  let validation = hostCache.get(hostname);
  if (!validation) {
    validation = Promise.resolve().then(() => lookupHost(hostname, { all: true, verbatim: true })).then(records => {
      const addresses = (Array.isArray(records) ? records : [records]).map(record => record?.address).filter(Boolean);
      if (!addresses.length || addresses.some(address => !isPublicIp(address))) throw workError('已阻止解析到本地或私网的地址');
    });
    hostCache.set(hostname, validation);
  }
  await validation;
  return parsed.href;
}

function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function sanitizeText(value, limit = MAX_INPUT_CHARS) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, limit);
}

function safeLink(value) {
  try {
    const parsed = new URL(String(value));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href.slice(0, 2048) : null;
  } catch { return null; }
}

function pageSnapshot(page, maxChars) {
  return page.evaluate(maximum => {
    const raw = String(document.body?.innerText || '');
    const links = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (links.length >= 30) break;
      let url = '';
      try { url = new URL(anchor.href, location.href).href; } catch { /* Ignore malformed links. */ }
      if (/^https?:\/\//i.test(url)) links.push({ text: String(anchor.innerText || anchor.textContent || '').trim().slice(0, 300), url: url.slice(0, 2048) });
    }
    return { title: String(document.title || '').slice(0, 300), text: raw.slice(0, maximum), links, truncated: raw.length > maximum };
  }, maxChars);
}

async function closeSession(controller) {
  const context = controller.context;
  const browser = controller.browser;
  controller.context = null;
  controller.browser = null;
  if (context) await Promise.resolve(context.close?.()).catch(() => {});
  if (browser) await Promise.resolve(browser.close?.()).catch(() => {});
}

function finishFailure(task, controller) {
  if (controller.done || controller.cancelled) return;
  controller.done = true;
  clearTimeout(controller.timer);
  const timedOut = controller.timedOut;
  void closeSession(controller).finally(() => {
    if (controller.cancelled) return;
    task.status = 'failed';
    task.endedAt = new Date().toISOString();
    task.updatedAt = task.endedAt;
    task.error = timedOut ? '受控浏览器读取超时' : '受控浏览器读取失败';
    task.artifacts = { ...(task.artifacts || {}), browser: { ...(task.artifacts?.browser || {}), status: 'failed', timedOut, error: task.error } };
    controller.store.put('task', task);
  });
}

function findBrowserExecutable(environment = process.env) {
  const candidates = [
    environment.LAGENT_CHROMIUM_EXECUTABLE_PATH,
    (environment['ProgramFiles(x86)'] || environment['PROGRAMFILES(X86)']) && path.join(environment['ProgramFiles(x86)'] || environment['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];
  return candidates.find(candidate => typeof candidate === 'string' && candidate && existsSync(candidate)) || null;
}

export function browserExecutor({  store,
  environment = process.env,
  playwright: suppliedPlaywright,
  lookupHost = lookup,
  timeoutMs = 30000,
  chromiumExecutablePath = environment.LAGENT_CHROMIUM_EXECUTABLE_PATH
} = {}) {
  if (!store) throw new TypeError('browserExecutor 需要 store');
  const library = suppliedPlaywright ?? defaultPlaywright;
  const enabled = environment.LAGENT_BROWSER_ENABLED !== '0';
  const browserExecutable = chromiumExecutablePath || findBrowserExecutable(environment);
  const controllers = new Map();
  const timeout = Math.max(1, Number(timeoutMs) || 30000);

  function startTask(task, input) {
    const abortController = new AbortController();
    const controller = { abortController, context: null, browser: null, done: false, cancelled: false, timedOut: false, timer: null, store };
    controllers.set(task.id, controller);
    controller.timer = setTimeout(() => {
      if (controller.done) return;
      controller.timedOut = true;
      abortController.abort(new Error('浏览器读取超时'));
      void closeSession(controller);
    }, timeout);
    controller.timer.unref?.();
    void (async () => {
      const hostCache = new Map();
      try {
        if (!library?.chromium) throw statusError('Playwright 当前不可用', 503);
        await assertPublicUrl(input.url, lookupHost, hostCache);
        const launch = library.chromium.launch({ headless: true, timeout, ...(browserExecutable ? { executablePath: browserExecutable } : {}) });
        launch.then(instance => {
          if (controller.cancelled && instance !== controller.browser) void instance.close().catch(() => {});
        }, () => {});
        controller.browser = await abortable(launch, abortController.signal);
        controller.context = await abortable(controller.browser.newContext({
          javaScriptEnabled: false,
          serviceWorkers: 'block',
          acceptDownloads: false,
          locale: 'zh-CN'
        }), abortController.signal);
        await controller.context.route('**/*', async route => {
          try {
            await assertPublicUrl(route.request().url(), lookupHost, hostCache);
            await route.continue();
          } catch { await route.abort('blockedbyclient').catch(() => {}); }
        });
        const page = await abortable(controller.context.newPage(), abortController.signal);
        page.setDefaultTimeout?.(timeout);
        await abortable(page.goto(input.url, { waitUntil: 'domcontentloaded', timeout }), abortController.signal);
        abortController.signal.throwIfAborted();
        const finalUrl = await assertPublicUrl(page.url(), lookupHost, hostCache);
        const snapshot = await abortable(pageSnapshot(page, input.maxChars), abortController.signal);
        if (controller.done || controller.cancelled) return;
        controller.done = true;
        clearTimeout(controller.timer);
        await closeSession(controller);
        const links = (Array.isArray(snapshot?.links) ? snapshot.links : []).slice(0, MAX_LINKS).map(link => ({
          text: sanitizeText(link?.text, 300),
          url: safeLink(link?.url)
        })).filter(link => link.url);
        task.status = 'completed';
        task.endedAt = new Date().toISOString();
        task.updatedAt = task.endedAt;
        task.error = undefined;
        task.artifacts = { ...(task.artifacts || {}), browser: {
          title: sanitizeText(snapshot?.title, 300),
          url: finalUrl,
          text: sanitizeText(snapshot?.text, input.maxChars),
          links,
          truncated: snapshot?.truncated === true || String(snapshot?.text || '').length >= input.maxChars,
          fetchedAt: task.endedAt
        } };
        store.put('task', task);
      } catch {
        finishFailure(task, controller);
      } finally {
        controllers.delete(task.id);
      }
    })();
  }

  return {
    id: 'browser',
    name: '受控浏览器',
    kind: 'tool',
    available: enabled && Boolean(library),
    requiresDataset: false,
    capabilities: ['browser', 'read-only', 'http', 'https', 'text', 'links', 'human-approval'],
    validateInput: validateBrowserInput,
    start(ticket, assignment, input) {
      if (!enabled || !library) throw statusError('受控浏览器当前不可用', 503);
      const normalized = validateBrowserInput(input?.executorInput ?? input);
      const prior = store.get('task', assignment.id);
      if (prior) return prior;
      const stamp = new Date().toISOString();
      const task = { id: assignment.id, workAssignmentId: assignment.id, executorId: 'browser', goal: ticket.command, status: 'running', createdAt: stamp, updatedAt: stamp, executionStarted: true, browserInput: normalized, artifacts: {} };
      store.put('task', task);
      startTask(task, normalized);
      return task;
    },
    get: id => id && store.get('task', id),
    resume(task) {
      if (!task || task.status !== 'running' || controllers.has(task.id)) return;
      task.status = 'failed'; task.error = '服务已重启，浏览器读取已中断'; task.endedAt = new Date().toISOString(); task.updatedAt = task.endedAt;
      task.artifacts = { ...(task.artifacts || {}), browser: { ...(task.artifacts?.browser || {}), status: 'failed', interrupted: true, error: task.error } };
      store.put('task', task);
    },
    stop(task) {
      if (!task) return;
      const controller = controllers.get(task.id);
      if (controller) {
        controller.cancelled = true; controller.done = true; clearTimeout(controller.timer);
        controller.abortController.abort(new Error('浏览器读取已停止'));
        void closeSession(controller);
      }
      task.status = 'cancelled'; task.endedAt = new Date().toISOString(); task.updatedAt = task.endedAt;
      task.artifacts = { ...(task.artifacts || {}), browser: { ...(task.artifacts?.browser || {}), status: 'cancelled' } };
      store.put('task', task);
    },
    close() {
      for (const controller of controllers.values()) {
        controller.cancelled = true; controller.done = true; clearTimeout(controller.timer);
        controller.abortController.abort(new Error('浏览器执行器已关闭'));
        void closeSession(controller);
      }
      controllers.clear();
    }
  };
}
