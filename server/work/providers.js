import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { findClaudeCodeCli, findCodexBinary } from './executors/discover.js';

const VERSION_TIMEOUT_MS = 5000;
const MAX_OUTPUT = 16 * 1024;
const CACHE_TTL_MS = 60 * 1000;

// executorId 把「探测到的本机程序」和「真正可被调度的执行器」对上：
// 有值才能开关（开关写 policy.allowedExecutors）；null 表示只做识别，暂无可调用适配器。
const PROVIDERS = Object.freeze([
  { id: 'codex', name: 'Codex CLI', executorId: 'codex', commands: ['codex'], versionArgs: ['--version'], authArgs: ['login', 'status'], authKind: 'codex' },
  // Codex 桌面版没有 CLI：只按运行中的窗口识别，发送走窗口 Agent。
  { id: 'codex-desktop', name: 'Codex 桌面版', executorId: 'window', commands: [], versionArgs: [], authArgs: [], authKind: 'generic', desktopOnly: true },
  { id: 'claude-code', name: 'Claude Code CLI', executorId: 'claude-code', commands: ['claude'], versionArgs: ['--version'], authArgs: ['auth', 'status'], authKind: 'claude' },
  { id: 'opencode', name: 'OpenCode', executorId: 'opencode', commands: ['opencode'], versionArgs: ['--version'], authArgs: ['auth', 'list'], authKind: 'opencode' },
  // 桌面版按运行中的窗口识别（走窗口 Agent）；同名 CLI 走 headless 一次性任务适配器。
  { id: 'dsh', name: 'DeepSeek Harness CLI', executorId: 'dsh', commands: ['dsh', 'deepseek'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'codex-acp', name: 'Codex ACP', executorId: 'codex-acp', commands: ['codex-acp'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'claude-acp', name: 'Claude ACP', executorId: 'claude-acp', commands: ['claude-agent-acp', 'claude-code-acp', 'claude-acp'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'dsh-acp', name: 'DeepSeek Harness ACP', executorId: 'dsh-acp', commands: ['dsh-acp'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  // 只做识别：常见编码 Agent CLI，暂未提供调用适配器（列表里标记为「仅识别」）。
  { id: 'gemini', name: 'Gemini CLI', executorId: 'gemini', commands: ['gemini'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'cursor-agent', name: 'Cursor Agent', executorId: 'cursor-agent', commands: ['cursor-agent'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'qwen', name: 'Qwen Code', executorId: 'qwen', commands: ['qwen'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'aider', name: 'Aider', executorId: null, commands: ['aider'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'amp', name: 'Amp', executorId: null, commands: ['amp'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  // 国产编码 Agent：前四个提供调用适配器（沿用 -p 问答约定），其余先做识别 + 窗口匹配。
  { id: 'codebuddy', name: 'CodeBuddy Code（腾讯）', executorId: 'codebuddy', commands: ['codebuddy', 'codebuddy-code'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'qoder', name: 'Qoder CLI（阿里）', executorId: 'qoder', commands: ['qoder', 'qodercli'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'iflow', name: 'iFlow CLI（心流）', executorId: 'iflow', commands: ['iflow'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'kimi', name: 'Kimi CLI（月之暗面）', executorId: 'kimi', commands: ['kimi'], versionArgs: ['--version'], authArgs: [], authKind: 'generic' },
  { id: 'trae-agent', name: 'Trae Agent（字节）', executorId: null, commands: ['trae-agent', 'trae'], versionArgs: ['--version'], authArgs: [], authKind: 'generic', desktopMatches: /trae/i },
  { id: 'comate', name: '文心快码 Comate（百度）', executorId: null, commands: ['comate', 'comate-cli'], versionArgs: ['--version'], authArgs: [], authKind: 'generic', desktopMatches: /comate|文心/i },
  { id: 'lingma', name: '通义灵码（阿里）', executorId: null, commands: ['lingma', 'lingma-cli'], versionArgs: ['--version'], authArgs: [], authKind: 'generic', desktopMatches: /lingma|通义/i },
  { id: 'codegeex', name: 'CodeGeeX（智谱）', executorId: null, commands: ['codegeex'], versionArgs: ['--version'], authArgs: [], authKind: 'generic', desktopMatches: /codegeex/i },
  // WorkBuddy 目前以桌面客户端为主：有 CLI 就认命令，没有就按运行中的窗口识别。
  { id: 'workbuddy', name: 'WorkBuddy', executorId: null, commands: ['workbuddy', 'work-buddy'], versionArgs: ['--version'], authArgs: [], authKind: 'generic', desktopMatches: /work\s*buddy/i }
]);

const pathValue = env => env.PATH ?? env.Path ?? env.path ?? '';
const pathExtensions = env => {
  const raw = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const values = raw.split(';').map(item => item.trim()).filter(Boolean).map(item => item.startsWith('.') ? item.toUpperCase() : `.${item.toUpperCase()}`);
  return values.length ? [...new Set(values)] : ['.COM', '.EXE', '.BAT', '.CMD'];
};

function isFile(candidate) {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

// npm 的 .cmd 垫片在中文用户名路径下会因代码页问题启动失败（cmd 无法表示 Unicode 路径）。
// 直接解析垫片里的 node 入口，用 node + 脚本路径启动，绕开 cmd。
function nodeShimTarget(shim) {
  if (!/\.(cmd|bat)$/i.test(shim)) return null;
  let content;
  try { content = readFileSync(shim, 'utf8'); } catch { return null; }
  const quoted = [...content.matchAll(/"([^"\r\n]+\.(?:js|mjs|cjs|exe))"/gi)].map(match => match[1]);
  for (const raw of quoted) {
    if (/\\node\.exe$/i.test(raw)) continue;
    const candidate = path.resolve(path.dirname(shim), raw.replace(/^%~?dp0%?\\?/i, ''));
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function withNodeShim(resolved) {
  if (!resolved?.shell) return resolved;
  const entry = nodeShimTarget(resolved.command);
  if (!entry) return resolved;
  if (/\.exe$/i.test(entry)) return { command: entry, args: [], shell: false, entry, via: resolved.command };
  return { command: process.execPath, args: [entry], shell: false, entry, via: resolved.command };
}

export function resolveLocalCommand(command, env = process.env) {
  if (typeof command !== 'string' || !command.trim() || command.length > 500) return null;
  const value = command.trim();
  const absolute = path.isAbsolute(value) || value.includes('/') || value.includes('\\');
  if (absolute) {
    const candidate = path.resolve(value);
    return isFile(candidate) ? withNodeShim({ command: candidate, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate) }) : null;
  }
  const extensions = process.platform === 'win32' ? pathExtensions(env) : [''];
  const names = process.platform === 'win32'
    ? [...extensions.map(extension => `${value}${extension}`), ...extensions.map(extension => `${value}${extension.toLowerCase()}`)]
    : [value];
  for (const entry of pathValue(env).split(path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    for (const name of [...new Set(names)]) {
      const candidate = path.join(directory, name);
      if (isFile(candidate)) return withNodeShim({ command: candidate, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(candidate) });
    }
  }
  return null;
}

function commandForProvider(def, env) {
  if (def.id === 'codex') {
    const known = findCodexBinary(env);
    if (known) return { command: known, shell: false };
  }
  if (def.id === 'claude-code') {
    const known = findClaudeCodeCli(env);
    if (known) return { command: known.prefix.length ? known.binary : known.binary, shell: false, prefix: known.prefix };
  }
  for (const candidate of def.commands) {
    const resolved = resolveLocalCommand(candidate, env);
    if (resolved) return resolved;
  }
  return null;
}

function run(command, args, { env, shell = false, timeoutMs = VERSION_TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawnImpl(command, args, { shell, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve({ code: null, stdout: '', stderr: '', error: true }); return; }
    const timer = setTimeout(() => {
      try { child.kill?.('SIGKILL'); } catch { /* ignore */ }
      finish({ code: null, stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT), timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', chunk => { if (stdout.length < MAX_OUTPUT) stdout += String(chunk); });
    child.stderr?.on('data', chunk => { if (stderr.length < MAX_OUTPUT) stderr += String(chunk); });
    child.once?.('error', () => finish({ code: null, stdout, stderr, error: true }));
    child.once?.('close', code => finish({ code: Number(code), stdout: stdout.slice(0, MAX_OUTPUT), stderr: stderr.slice(0, MAX_OUTPUT) }));
  });
}

function versionOf(output) {
  const match = String(output || '').match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] || null;
}

function authOf(kind, result) {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (kind === 'claude') {
    try {
      const parsed = JSON.parse(result.stdout.trim());
      return { loggedIn: parsed.loggedIn === true, method: typeof parsed.authMethod === 'string' ? parsed.authMethod : null, message: parsed.loggedIn === true ? '已登录' : '需要登录' };
    } catch { /* fall through */ }
  }
  if (kind === 'codex') {
    if (/not logged in/i.test(output)) return { loggedIn: false, method: null, message: 'Codex 未登录（自定义接口仍可能可用）' };
    if (/logged in|login successful/i.test(output)) return { loggedIn: true, method: null, message: '已登录' };
  }
  if (kind === 'opencode') {
    if (/no credentials|not logged in|0 credentials/i.test(output)) return { loggedIn: false, method: null, message: '需要登录' };
    if (output.trim()) return { loggedIn: true, method: null, message: '已配置凭据' };
  }
  return { loggedIn: null, method: null, message: '登录状态未知' };
}

function normalizeSnapshot(def, resolved, versionResult, authResult, error) {
  const installed = Boolean(resolved);
  const isAcp = def.id.endsWith('-acp');
  const version = versionResult ? versionOf(versionResult.stdout) || versionOf(versionResult.stderr) : null;
  const auth = isAcp ? { loggedIn: null, method: null, message: '登录状态由 ACP 适配器管理' } : authResult ? authOf(def.authKind, authResult) : { loggedIn: null, method: null, message: '未探测登录状态' };
  let status = installed ? 'ready' : 'not_installed';
  let message = installed ? '已安装' : '未安装或不在 PATH';
  if (!installed && def.desktopOnly) message = '未检测到桌面版窗口；打开应用后点「重新探测」';
  // 只能在桌面窗口里使用的执行器，即使未运行也按桌面类型展示，避免被当成 CLI。
  const kind = def.desktopOnly ? 'desktop' : 'cli';
  if (installed && versionResult?.error) { status = 'error'; message = '无法执行版本探测'; }
  // 部分 ACP 适配器不支持 --version 会一直挂住；命令存在就算可用，只是版本未知。
  if (installed && versionResult?.timedOut) { status = 'ready'; message = '版本探测超时（命令存在，可直接使用）'; }
  if (installed && auth.loggedIn === false && def.id !== 'codex') { status = 'needs_auth'; message = auth.message; }
  if (installed && def.id === 'codex' && auth.loggedIn === false) message = '未登录；执行器会使用 Codex 自定义 provider 配置（如已配置）';
  if (error) { status = 'error'; message = String(error).slice(0, 200); }
  return {
    id: def.id,
    name: def.name,
    executorId: def.executorId || null,
    kind,
    command: resolved?.via || resolved?.command || null,
    installed,
    version,
    status,
    message,
    auth,
    capabilities: isAcp ? ['acp', 'agent', 'chat'] : def.id === 'codex' || def.id === 'claude-code' ? ['cli', 'read-only', 'chat'] : ['cli', 'chat']
  };
}

// 桌面版 Agent 没有 CLI 命令，但仍可作为窗口 Agent 使用。
// 匹配运行中的窗口或显式安装路径，避免把已安装的桌面版误报成“未安装”。
const DESKTOP_MATCHES = Object.freeze({
  dsh: /deepseek|harness/i,
  'dsh-acp': /deepseek|harness/i,
  // 桌面版 Codex 的窗口进程/标题通常含 codex（Codex.exe / Codex Desktop / codex）。
  'codex-desktop': /codex/i
});

function desktopFor(def, desktops) {
  const pattern = def.desktopMatches || DESKTOP_MATCHES[def.id];
  if (!pattern || !Array.isArray(desktops)) return null;
  return desktops.find(row => row && pattern.test(`${row.process || ''} ${row.title || ''}`)) || null;
}

function desktopSnapshot(def, desktop) {
  const processName = String(desktop.process || '').slice(0, 80) || 'DeepSeek Harness';
  if (def.id === 'codex-desktop') {
    return {
      ...normalizeSnapshot(def, null, null, null, null),
      kind: 'desktop',
      command: processName,
      installed: true,
      version: null,
      status: 'ready',
      message: `已检出 Codex 桌面版「${processName}」；用「窗口 · ${processName}」新建对话即可发送指令`,
      auth: { loggedIn: null, method: null, message: '由桌面应用管理' },
      capabilities: ['desktop', 'window', 'chat']
    };
  }
  if (def.id === 'dsh-acp') {
    return {
      ...normalizeSnapshot(def, null, null, null, null),
      message: `未安装 ACP 适配器；已检出桌面版「${processName}」，可直接使用「窗口 · ${processName}」发送指令，无需安装 dsh-acp。`,
      capabilities: ['desktop', 'window']
    };
  }
  return {
    id: def.id,
    name: def.name,
    executorId: def.executorId || null,
    kind: 'desktop',
    command: processName,
    installed: true,
    version: null,
    status: 'ready',
    message: `已安装（桌面版运行中）；使用「窗口 · ${processName}」发送指令`,
    auth: { loggedIn: null, method: null, message: '由桌面应用管理' },
    capabilities: ['desktop', 'window', 'chat']
  };
}

export function createProviderRegistry({ env = process.env, spawnImpl = spawn, now = Date.now, desktopProbe = null } = {}) {
  let cache = null;
  let cacheAt = 0;
  let inflight = null;
  async function probe(def, desktops) {
    const resolved = commandForProvider(def, env);
    if (!resolved) {
      const desktop = desktopFor(def, desktops);
      if (desktop) return desktopSnapshot(def, desktop);
      return normalizeSnapshot(def, null, null, null, null);
    }
    const prefix = resolved.prefix || resolved.args || [];
    const versionResult = await run(resolved.command, [...prefix, ...def.versionArgs], { env, shell: resolved.shell, spawnImpl });
    const authResult = def.authArgs.length ? await run(resolved.command, [...prefix, ...def.authArgs], { env, shell: resolved.shell, spawnImpl }) : null;
    return normalizeSnapshot(def, resolved, versionResult, authResult, null);
  }
  async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      let desktops = [];
      if (desktopProbe) {
        try { desktops = await desktopProbe() || []; } catch { desktops = []; }
      }
      const snapshots = await Promise.all(PROVIDERS.map(def => probe(def, desktops)));
      cache = snapshots;
      cacheAt = now();
      return snapshots;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  return {
    async snapshots({ force = false } = {}) {
      if (!force && cache && now() - cacheAt < CACHE_TTL_MS) return cache;
      return refresh();
    },
    clear() { cache = null; cacheAt = 0; },
    providers: PROVIDERS.map(def => ({ id: def.id, name: def.name }))
  };
}
