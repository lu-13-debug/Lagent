import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_WINDOW_PROCESSES = Object.freeze([
  'codex',
  'ChatGPT',
  'claude',
  'WindowsTerminal',
  'wt',
  'opencode',
  'DSH Desktop',
  'DeepSeek Harness',
  'DeepSeek'
]);

export const MAX_SEND_TEXT = 8000;
export const MAX_READ_TEXT = 20000;
export const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_WINDOWS = 50;
const MAX_STDERR_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 12000;
const MAX_TIMEOUT_MS = 60000;

const ERROR_DEFINITIONS = Object.freeze({
  invalid_handle: { status: 400, message: '窗口句柄无效' },
  invalid_process: { status: 400, message: '进程名无效' },
  text_invalid: { status: 400, message: '发送内容必须是字符串' },
  text_empty: { status: 400, message: '发送内容不能为空' },
  text_too_long: { status: 400, message: '发送内容超过长度限制' },
  process_not_allowed: { status: 403, message: '进程不在窗口桥允许列表内' },
  process_mismatch: { status: 409, message: '窗口进程与预期不符' },
  window_not_ready: { status: 409, message: '窗口未就绪：未找到消息输入框，请先把该窗口切到会话页面' },
  window_busy: { status: 409, message: '目标窗口输入框已有未发送内容，请先发送或清空后再试' },
  window_not_found: { status: 404, message: '窗口不存在或不可访问' },
  timeout: { status: 504, message: '窗口操作超时' },
  output_too_large: { status: 502, message: '窗口桥输出超过限制' },
  invalid_json: { status: 502, message: '窗口桥返回格式无效' },
  invalid_result: { status: 502, message: '窗口桥返回结果无效' },
  read_failed: { status: 502, message: '窗口文本读取失败' },
  send_failed: { status: 502, message: '窗口文本发送失败' },
  bridge_failed: { status: 502, message: '窗口操作失败' },
  operation_failed: { status: 502, message: '窗口操作失败' },
  spawn_failed: { status: 503, message: '无法启动窗口桥' }
});

export class WindowBridgeError extends Error {
  constructor(code = 'operation_failed') {
    const known = Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, code);
    const definition = known ? ERROR_DEFINITIONS[code] : ERROR_DEFINITIONS.operation_failed;
    super(definition.message);
    this.name = 'WindowBridgeError';
    this.code = known ? code : 'operation_failed';
    this.status = definition.status;
  }
}

function cleanText(value, max = 500) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeAllowedProcesses(value) {
  if (!Array.isArray(value)) return [...DEFAULT_WINDOW_PROCESSES];
  const result = [];
  const seen = new Set();
  for (const item of value.slice(0, 64)) {
    if (typeof item !== 'string') continue;
    const name = cleanText(item, 80);
    if (!name || name.includes(',') || name.includes('|')) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(name);
  }
  return result;
}

function normalizeHandle(value) {
  let handle = value;
  if (typeof handle === 'string') {
    const trimmed = handle.trim();
    if (!/^[1-9]\d{0,15}$/.test(trimmed)) throw new WindowBridgeError('invalid_handle');
    handle = Number(trimmed);
  }
  if (!Number.isSafeInteger(handle) || handle <= 0) throw new WindowBridgeError('invalid_handle');
  return handle;
}

function normalizeExpectProcess(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new WindowBridgeError('invalid_process');
  const name = cleanText(value, 80);
  if (!name) throw new WindowBridgeError('invalid_process');
  return name;
}

function assertProcessAllowed(name, allowedProcesses) {
  if (!name) return;
  const key = name.toLowerCase();
  if (!allowedProcesses.some(item => item.toLowerCase() === key)) {
    throw new WindowBridgeError('process_not_allowed');
  }
}

function parseHandleLoose(value) {
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk), 'utf8');
}

function parseJsonPayload(output) {
  const raw = String(output ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .trim();
  if (!raw) throw new WindowBridgeError('invalid_json');
  const objectIndex = raw.indexOf('{');
  const arrayIndex = raw.indexOf('[');
  let start = -1;
  if (objectIndex < 0) start = arrayIndex;
  else if (arrayIndex < 0) start = objectIndex;
  else start = Math.min(objectIndex, arrayIndex);
  if (start < 0) throw new WindowBridgeError('invalid_json');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch {
    throw new WindowBridgeError('invalid_json');
  }
  if (!parsed || typeof parsed !== 'object') throw new WindowBridgeError('invalid_json');
  return parsed;
}

function failureFromPayload(payload) {
  if (!payload || payload.ok !== false) return null;
  const code = typeof payload.error?.code === 'string' ? cleanText(payload.error.code, 40) : '';
  return new WindowBridgeError(code);
}

function runPowerShell({
  command,
  handle,
  input,
  submit,
  expectProcess,
  spawnImpl,
  scriptPath,
  timeoutMs,
  allowedProcesses
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Command',
      command
    ];
    if (handle !== undefined) args.push('-Handle', String(handle));
    if (input !== undefined) {
      if (/^\s*-/.test(input)) args.push(`-Text:${input}`);
      else args.push('-Text', input);
    }
    if (submit) args.push('-Submit');
    if (expectProcess) args.push('-Expect', expectProcess);
    args.push('-Allow', allowedProcesses.join('|'));
    args.push('-MaxText', String(MAX_SEND_TEXT));
    args.push('-MaxRead', String(MAX_READ_TEXT));
    args.push('-MaxOutput', String(MAX_OUTPUT_BYTES));
    args.push('-TimeoutMs', String(Math.max(1000, Math.trunc(timeoutMs))));

    let child;
    try {
      child = spawnImpl('powershell.exe', args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      reject(new WindowBridgeError('spawn_failed'));
      return;
    }
    if (!child || typeof child.once !== 'function') {
      reject(new WindowBridgeError('spawn_failed'));
      return;
    }

    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const chunks = [];

    const stop = () => {
      try { child.kill?.('SIGKILL'); } catch { /* ignore */ }
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const budget = Math.max(1, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
    const timer = setTimeout(() => {
      stop();
      finish(new WindowBridgeError('timeout'));
    }, budget);

    child.stdout?.on?.('data', chunk => {
      if (settled) return;
      const buffer = toBuffer(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stop();
        finish(new WindowBridgeError('output_too_large'));
        return;
      }
      chunks.push(buffer);
    });

    child.stderr?.on?.('data', chunk => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      stderrBytes = Math.min(MAX_STDERR_BYTES, stderrBytes + toBuffer(chunk).length);
    });

    child.once('error', () => {
      stop();
      finish(new WindowBridgeError('spawn_failed'));
    });

    child.once('close', code => {
      if (settled) return;
      const output = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        try {
          const payload = parseJsonPayload(output);
          finish(failureFromPayload(payload) || new WindowBridgeError('bridge_failed'));
        } catch {
          finish(new WindowBridgeError('bridge_failed'));
        }
        return;
      }
      try {
        const payload = parseJsonPayload(output);
        finish(failureFromPayload(payload), payload);
      } catch (error) {
        finish(error);
      }
    });
  });
}

export function createWindowBridge({
  scriptPath = path.join(root, 'scripts', 'window-bridge.ps1'),
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowedProcesses = process.env.DATAAGENT_WINDOW_PROCESSES ? process.env.DATAAGENT_WINDOW_PROCESSES.split(',') : DEFAULT_WINDOW_PROCESSES
} = {}) {
  const allow = normalizeAllowedProcesses(allowedProcesses);
  const budget = Math.max(1, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const call = (command, options = {}) => runPowerShell({
    command,
    handle: options.handle,
    input: options.input,
    submit: options.submit,
    expectProcess: options.expectProcess,
    spawnImpl,
    scriptPath,
    timeoutMs: budget,
    allowedProcesses: allow
  });

  async function listWindows() {
    const payload = await call('list');
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.windows) ? payload.windows : [];
    const result = [];
    const seen = new Set();
    for (const item of rows.slice(0, 200)) {
      const handle = parseHandleLoose(item?.handle);
      const pid = Number(item?.pid);
      const process = cleanText(item?.process, 80);
      if (handle <= 0 || !process || seen.has(handle)) continue;
      if (!allow.some(name => name.toLowerCase() === process.toLowerCase())) continue;
      seen.add(handle);
      result.push({
        id: String(handle),
        handle,
        pid: Number.isSafeInteger(pid) && pid >= 0 ? pid : 0,
        process,
        title: cleanText(item?.title, 200)
      });
      if (result.length >= MAX_WINDOWS) break;
    }
    return result;
  }

  async function relocateHandle(handle, expectProcess, titleHint) {
    if (!expectProcess && !titleHint) return null;
    let rows;
    try { rows = await listWindows(); } catch { return null; }
    const same = rows.filter(row => row.handle !== handle && (!expectProcess || row.process.toLowerCase() === expectProcess.toLowerCase()));
    const titled = titleHint ? same.filter(row => row.title === titleHint) : [];
    const pool = titled.length ? titled : same;
    return pool.length === 1 ? pool[0] : null;
  }

  async function readWindow(handle, { process: processName, title: titleHint } = {}) {
    const id = normalizeHandle(handle);
    const expectProcess = normalizeExpectProcess(processName);
    assertProcessAllowed(expectProcess, allow);
    const read = target => call('read', { handle: target, expectProcess });
    let payload;
    let usedHandle = id;
    try {
      payload = await read(id);
    } catch (error) {
      if (error?.code !== 'window_not_found') throw error;
      const next = await relocateHandle(id, expectProcess, titleHint);
      if (!next) throw error;
      usedHandle = next.handle;
      payload = await read(next.handle);
    }
    if (typeof payload?.text !== 'string') throw new WindowBridgeError('invalid_result');
    const reported = cleanText(payload.process, 80);
    if (expectProcess && reported && reported.toLowerCase() !== expectProcess.toLowerCase()) {
      throw new WindowBridgeError('process_mismatch');
    }
    return { text: payload.text.slice(-MAX_READ_TEXT), handle: usedHandle, relocated: usedHandle !== id };
  }

  async function sendToWindow(handle, content, { submit = false, process: processName, title: titleHint } = {}) {
    const id = normalizeHandle(handle);
    if (typeof content !== 'string') throw new WindowBridgeError('text_invalid');
    if (content.includes('\u0000')) throw new WindowBridgeError('text_invalid');
    if (!content.trim()) throw new WindowBridgeError('text_empty');
    if (content.length > MAX_SEND_TEXT) throw new WindowBridgeError('text_too_long');
    const expectProcess = normalizeExpectProcess(processName);
    assertProcessAllowed(expectProcess, allow);

    const send = target => call('send', {
      handle: target,
      input: content,
      submit: submit === true,
      expectProcess
    });
    let payload;
    let usedHandle = id;
    try {
      payload = await send(id);
    } catch (error) {
      if (error?.code !== 'window_not_found') throw error;
      const next = await relocateHandle(id, expectProcess, titleHint);
      if (!next) throw error;
      usedHandle = next.handle;
      payload = await send(next.handle);
    }
    if (payload?.ok !== true) throw failureFromPayload(payload) || new WindowBridgeError('invalid_result');
    const reported = cleanText(payload.process, 80);
    if (expectProcess && reported && reported.toLowerCase() !== expectProcess.toLowerCase()) {
      throw new WindowBridgeError('process_mismatch');
    }
    if (reported) assertProcessAllowed(reported, allow);
    return { ok: true, process: reported, submitted: payload.submitted === true, handle: usedHandle, relocated: usedHandle !== id };
  }

  return { listWindows, readWindow, sendToWindow };
}

const defaultBridge = createWindowBridge();

export function listWindows() {
  return defaultBridge.listWindows();
}

export function readWindow(handle, options) {
  return defaultBridge.readWindow(handle, options);
}

export function sendToWindow(handle, content, options) {
  return defaultBridge.sendToWindow(handle, content, options);
}

export default {
  DEFAULT_WINDOW_PROCESSES,
  WindowBridgeError,
  createWindowBridge,
  listWindows,
  readWindow,
  sendToWindow
};