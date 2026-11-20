import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exposedWorkError, workError } from '../domain.js';
import { findClaudeCodeCli } from '../executors/discover.js';

const RUN_TIMEOUT_MS = 120_000;
const CACHE_MS = 30_000;

function runClaude(entry, args, { timeoutMs = RUN_TIMEOUT_MS, environment = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(entry.binary, [...(entry.prefix || []), ...args], {
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      finish(exposedWorkError('Claude Code 插件命令超时，请稍后重试', 504));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    child.on('error', error => finish(error.code === 'ENOENT' ? exposedWorkError('未找到 Claude Code CLI，无法管理插件', 503) : error));
    child.on('close', code => {
      const text = stdout.trim();
      if (code !== 0) {
        const detail = (stderr || text || `退出码 ${code}`).trim().slice(0, 600);
        return finish(Object.assign(exposedWorkError(`插件命令失败：${detail}`, 502), { code: 'plugin_command_failed', exitCode: code, stdout: text.slice(-4000), stderr: stderr.slice(-4000) }));
      }
      finish(null, { stdout: text, stderr: stderr.trim() });
    });
  });
}

function lastJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // 新版 CLI 的 --json 输出是多行缩进 JSON，先整体解析。
  try { return JSON.parse(raw); } catch { /* 前面可能混有人类可读输出 */ }
  const start = raw.search(/[[{]/);
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* 继续按行找 */ }
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* 可能是人类可读输出 */ }
  }
  return null;
}

let zhDescriptions = null;
// 官方 marketplace 只有英文说明；内置中文映射让中文界面直接可读，未收录的新插件回退原文。
function zhMap() {
  if (zhDescriptions) return zhDescriptions;
  try { zhDescriptions = JSON.parse(readFileSync(new URL('./plugin-zh.json', import.meta.url), 'utf8')); }
  catch { zhDescriptions = {}; }
  return zhDescriptions;
}

function localize(plugin) {
  const name = String(plugin?.name || plugin?.pluginId || plugin?.id || '').split('@')[0];
  const zh = zhMap()[name];
  return zh ? { ...plugin, descriptionZh: zh } : plugin;
}

function catalogOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.plugins)) return payload.plugins;
  if (payload && Array.isArray(payload.available)) return payload.available;
  return [];
}

export function createPluginService({ environment = process.env, now = Date.now, spawnImpl } = {}) {
  let cache = null;
  const entry = () => {
    const found = findClaudeCodeCli(environment);
    if (!found) throw workError('未找到 Claude Code CLI，请先安装并登录 Claude Code', 503);
    return found;
  };
  const resolveEntry = () => (spawnImpl ? { binary: 'claude', prefix: [] } : entry());
  const invoke = async (args, options) => runClaude(resolveEntry(), args, { environment, spawnImpl, ...options });

  async function list({ refresh = false } = {}) {
    if (!refresh && cache && now() - cache.at < CACHE_MS) return cache.value;
    let binary = null;
    try { binary = resolveEntry(); } catch (error) { return { available: false, reason: error.message, installed: [], catalog: [], marketplaces: [] }; }
    try {
      const [installedRaw, availableRaw, marketplaceRaw] = await Promise.all([
        invoke(['plugin', 'list', '--json']).catch(() => ({ stdout: '[]' })),
        invoke(['plugin', 'list', '--json', '--available']).catch(() => ({ stdout: '[]' })),
        invoke(['plugin', 'marketplace', 'list', '--json']).catch(() => ({ stdout: '[]' })),
      ]);
      const installed = catalogOf(lastJson(installedRaw.stdout)).map(localize);
      const available = catalogOf(lastJson(availableRaw.stdout)).map(localize);
      const marketplaces = catalogOf(lastJson(marketplaceRaw.stdout));
      const value = { available: true, binary: binary.binary, installed, catalog: available, marketplaces };
      cache = { at: now(), value };
      return value;
    } catch (error) {
      return { available: false, reason: error.message || '插件列表读取失败', installed: [], catalog: [], marketplaces: [] };
    }
  }

  async function details(name) {
    const plugin = typeof name === 'string' ? name.trim() : '';
    if (!plugin) throw workError('插件名称不能为空', 400);
    const result = await invoke(['plugin', 'details', plugin]);
    return { name: plugin, text: result.stdout };
  }

  async function addMarketplace(source, { scope = 'user' } = {}) {
    const value = typeof source === 'string' ? source.trim() : '';
    if (!value || value.length > 500) throw workError('请填写 marketplace 地址或 owner/repo', 400);
    const result = await invoke(['plugin', 'marketplace', 'add', value, '--json', '--scope', scope]);
    cache = null;
    return { marketplace: lastJson(result.stdout) || { source: value }, raw: result.stdout };
  }

  async function removeMarketplace(name) {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!value) throw workError('marketplace 名称不能为空', 400);
    await invoke(['plugin', 'marketplace', 'remove', value]);
    cache = null;
    return { ok: true, name: value };
  }

  async function install(name, { marketplace = '', scope = 'user', acceptCommand = '' } = {}) {
    const plugin = typeof name === 'string' ? name.trim() : '';
    if (!plugin) throw workError('插件名称不能为空', 400);
    const target = marketplace ? `${plugin}@${marketplace}` : plugin;
    const args = ['plugin', 'install', target, '--scope', scope, '--json'];
    if (acceptCommand) args.push('--accept-command', String(acceptCommand));
    args.push('-y');
    const result = await invoke(args);
    cache = null;
    return { plugin: lastJson(result.stdout) || { id: target }, raw: result.stdout };
  }

  async function setEnabled(name, enabled, { scope = 'user' } = {}) {
    const plugin = typeof name === 'string' ? name.trim() : '';
    if (!plugin) throw workError('插件名称不能为空', 400);
    const args = ['plugin', enabled ? 'enable' : 'disable', plugin, '--json'];
    if (scope) args.push('--scope', scope);
    const result = await invoke(args);
    cache = null;
    return { plugin: lastJson(result.stdout) || { id: plugin }, raw: result.stdout };
  }

  async function update(name) {
    const plugin = typeof name === 'string' ? name.trim() : '';
    if (!plugin) throw workError('插件名称不能为空', 400);
    const result = await invoke(['plugin', 'update', plugin, '--json']);
    cache = null;
    return { plugin: lastJson(result.stdout) || { id: plugin }, raw: result.stdout };
  }

  async function uninstall(name) {
    const plugin = typeof name === 'string' ? name.trim() : '';
    if (!plugin) throw workError('插件名称不能为空', 400);
    const result = await invoke(['plugin', 'uninstall', plugin, '--json']);
    cache = null;
    return { ok: true, plugin: lastJson(result.stdout) || { id: plugin } };
  }

  return { available: () => { try { entry(); return true; } catch { return false; } }, list, details, addMarketplace, removeMarketplace, install, enable: (name, scope) => setEnabled(name, true, scope), disable: (name, scope) => setEnabled(name, false, scope), update, uninstall };
}
