import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from '../version.js';

// MCP 客户端：换行分隔 JSON-RPC 2.0，stdio 传输。
// 只由显式配置的服务器启动子进程；参数直接传给 spawn，不经过 shell。
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOOLS = 200;
const MAX_SERVERS = 10;
const SAFE_ENV = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'NODE_PATH'];
const COMMAND_ALLOWLIST = new Set(['node', 'node.exe', 'npx', 'npx.cmd', 'python', 'python.exe', 'python3', 'py', 'uv', 'uv.exe', 'uvx', 'uvx.exe', 'deno', 'bun', 'docker']);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,80}$/;

const error = (message, status = 400) => Object.assign(new Error(message), { status });

export function sanitizeMcpToolName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function allowedEnv(extra = {}) {
  const env = {};
  for (const key of SAFE_ENV) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(key)) continue;
      if (typeof value === 'string' && value.length <= 4096 && !value.includes('\u0000')) env[key] = value;
    }
  }
  return env;
}

function commandAllowed(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 500 || /[\r\n\0]/.test(command)) return false;
  const base = path.basename(command).toLowerCase();
  return COMMAND_ALLOWLIST.has(base) || path.isAbsolute(command);
}

export function normalizeMcpServers(input, { workspace, env } = {}) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const servers = [];
  for (const raw of input.slice(0, MAX_SERVERS)) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || raw.id || '').trim();
    if (!name || name.length > 40 || !TOOL_NAME.test(name) || seen.has(name)) continue;
    const command = String(raw.command || '').trim();
    if (!commandAllowed(command)) continue;
    const args = Array.isArray(raw.args) ? raw.args.filter(item => typeof item === 'string' && item.length <= 500).slice(0, 30) : [];
    const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? path.resolve(workspace || '.', raw.cwd.trim()) : workspace;
    if (cwd && workspace) {
      const root = path.resolve(workspace);
      const resolved = path.resolve(cwd);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    }
    const tools = Array.isArray(raw.tools) ? raw.tools.filter(item => typeof item === 'string' && TOOL_NAME.test(item)).slice(0, 100) : [];
    seen.add(name);
    servers.push({
      id: name,
      name,
      command,
      args,
      cwd,
      env: allowedEnv(raw.env),
      ...(tools.length ? { tools } : {}),
      enabled: raw.enabled !== false
    });
  }
  return servers;
}

export function loadMcpServers({ store, ownerId = 'local', workspace, env = process.env, includeProject = true } = {}) {
  const managed = store?.config?.(`mcp-servers-v1:${ownerId}`) || [];
  const rows = [...(Array.isArray(managed) ? managed : [])];
  // 项目级 .mcp.json 属于可执行配置，默认关闭；显式 LAGENT_MCP_PROJECT_CONFIG=1 才读取。
  if (includeProject && workspace && env.LAGENT_MCP_PROJECT_CONFIG === '1' && env.LAGENT_MCP_CLIENT !== '0') {
    try {
      const file = path.join(workspace, '.mcp.json');
      if (fs.existsSync(file) && fs.statSync(file).size <= 256 * 1024) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const servers = parsed?.mcpServers;
        if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
          for (const [name, value] of Object.entries(servers).slice(0, MAX_SERVERS)) {
            if (!value || typeof value !== 'object') continue;
            rows.push({ name, ...value });
          }
        }
      }
    } catch { /* 配置损坏时不影响其它服务器。 */ }
  }
  return normalizeMcpServers(rows, { workspace, env });
}

export function createMcpClient({ id, name, command, args = [], cwd, env, timeoutMs = 30000, toolTimeoutMs = 120000, spawnImpl = spawn } = {}) {
  if (!id || !command) throw error('MCP 服务器缺少名称或命令');
  let child = null;
  let buffer = '';
  let stderr = '';
  let sequence = 0;
  let initialized = false;
  const pending = new Map();
  const closed = new Set();

  function rejectAll(reason) {
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(reason), { code: 'MCP_CLOSED' }));
      pending.delete(requestId);
    }
  }

  function ensure() {
    if (child) return child;
    child = spawnImpl(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stdout?.setEncoding?.('utf8');
    child.stdin?.on?.('error', () => {});
    child.on('error', errorValue => rejectAll(`MCP 服务器「${name || id}」启动失败：${errorValue.message}`));
    child.on('exit', code => {
      const detail = stderr.trim() ? `：${stderr.trim().slice(-400)}` : '';
      const reason = `MCP 服务器「${name || id}」已退出${code === null ? '' : `（退出码 ${code}）`}${detail}`;
      rejectAll(reason);
      child = null;
      initialized = false;
    });
    child.stdout?.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_BYTES) {
        buffer = '';
        rejectAll('MCP 服务器输出过大，已断开');
        try { child?.kill(); } catch { /* ignore */ }
        return;
      }
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object') continue;
        if (message.id !== undefined && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error) entry.reject(Object.assign(new Error(String(message.error.message || 'MCP 调用失败').slice(0, 500)), { code: message.error.code, mcp: true }));
          else entry.resolve(message.result);
        }
        // 服务端主动通知（tools/list_changed 等）目前只需丢弃，工具列表由 bridge 重新拉取。
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    return child;
  }

  function write(message) {
    const process = ensure();
    process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params = {}, timeout = timeoutMs) {
    const requestId = ++sequence;
    return new Promise((resolve, reject) => {
      if (closed.has(id)) { reject(error('MCP 客户端已关闭', 409)); return; }
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error(`MCP 请求超时：${method}`), { code: 'MCP_TIMEOUT' }));
      }, Math.max(1000, Math.min(timeout, toolTimeoutMs)));
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(requestId, { resolve, reject, timer, method });
      try {
        write({ jsonrpc: '2.0', id: requestId, method, params });
      } catch (cause) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(Object.assign(new Error(`MCP 写入失败：${cause.message}`), { code: 'MCP_WRITE' }));
      }
    });
  }

  async function initialize() {
    if (initialized) return { serverInfo: { name: name || id } };
    const result = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'Lagent', version: APP_VERSION }
    }, timeoutMs);
    try { write({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }); } catch { /* 部分服务端不要求。 */ }
    initialized = true;
    return result || { serverInfo: { name: name || id } };
  }

  async function listTools() {
    await initialize();
    const tools = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await request('tools/list', cursor ? { cursor } : {}, timeoutMs);
      const rows = Array.isArray(result?.tools) ? result.tools : [];
      for (const row of rows) {
        const toolName = typeof row?.name === 'string' ? row.name.trim() : '';
        if (!toolName || !TOOL_NAME.test(toolName)) continue;
        tools.push({
          name: toolName,
          description: typeof row.description === 'string' ? row.description.slice(0, 600) : '',
          inputSchema: row.inputSchema && typeof row.inputSchema === 'object' && !Array.isArray(row.inputSchema) ? row.inputSchema : { type: 'object', properties: {} }
        });
      }
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : '';
      if (!cursor || tools.length >= MAX_TOOLS) break;
    }
    return tools.slice(0, MAX_TOOLS);
  }

  async function callTool(toolName, args = {}, { timeout = toolTimeoutMs } = {}) {
    await initialize();
    const result = await request('tools/call', { name: toolName, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {} }, timeout);
    const parts = [];
    for (const item of Array.isArray(result?.content) ? result.content : []) {
      if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else if (item?.type === 'image') parts.push('[图片结果已省略]');
      else if (item?.type === 'resource' && typeof item.resource?.text === 'string') parts.push(item.resource.text);
    }
    if (result?.structuredContent && typeof result.structuredContent === 'object') parts.push(JSON.stringify(result.structuredContent));
    const text = parts.join('\n').trim().slice(0, 12000);
    if (result?.isError) throw Object.assign(new Error(text || 'MCP 工具返回错误'), { code: 'MCP_TOOL_ERROR' });
    return { server: id, tool: toolName, content: text || '(空结果)', ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}) };
  }

  async function close() {
    closed.add(id);
    rejectAll('MCP 客户端已关闭');
    if (child) {
      try { child.stdin?.end?.(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
      child = null;
    }
    initialized = false;
  }

  return { id, name: name || id, initialize, listTools, callTool, close, get stderr() { return stderr; } };
}

// 工具桥：把多个 MCP 服务器的工具映射成 model.js 能识别的 function schema。
export function createMcpBridge({ servers = [], spawnImpl = spawn, timeoutMs = 30000, toolTimeoutMs = 120000, onEvent } = {}) {
  const clients = new Map();
  const mapping = new Map();
  const health = [];

  async function connect() {
    for (const server of servers) {
      if (!server.enabled) continue;
      const client = createMcpClient({ ...server, id: server.id || server.name, spawnImpl, timeoutMs, toolTimeoutMs });
      clients.set(server.id, client);
      try {
        await client.initialize();
        const tools = await client.listTools();
        const allowed = new Set(server.tools || []);
        for (const tool of tools) {
          if (allowed.size && !allowed.has(tool.name)) continue;
          const exposed = `mcp__${sanitizeMcpToolName(server.id)}__${sanitizeMcpToolName(tool.name)}`;
          if (mapping.has(exposed)) continue;
          mapping.set(exposed, { serverId: server.id, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema });
        }
        health.push({ id: server.id, name: server.name, ok: true, tools: tools.length });
        onEvent?.({ type: 'mcp', server: server.id, ok: true, tools: tools.length });
      } catch (failure) {
        health.push({ id: server.id, name: server.name, ok: false, error: String(failure?.message || failure).slice(0, 300) });
        onEvent?.({ type: 'mcp', server: server.id, ok: false, error: String(failure?.message || failure).slice(0, 300) });
      }
    }
    return { health, tools: mapping.size };
  }

  function schemas() {
    const rows = [];
    for (const [name, entry] of mapping) {
      rows.push({
        type: 'function',
        function: {
          name,
          description: `MCP ${entry.serverId} · ${entry.description || entry.tool}`.slice(0, 700),
          // inputSchema 由服务器提供；限制体积，避免把超大 schema 塞进每一次模型请求。
          parameters: JSON.stringify(entry.inputSchema || {}).length <= 20000 ? entry.inputSchema : { type: 'object', properties: {} }
        }
      });
    }
    return rows;
  }

  function owns(name) { return mapping.has(name); }

  async function call(name, args) {
    const entry = mapping.get(name);
    if (!entry) throw error(`未知 MCP 工具：${name}`, 404);
    const client = clients.get(entry.serverId);
    if (!client) throw error('MCP 服务器已断开', 409);
    return client.callTool(entry.tool, args);
  }

  async function close() {
    await Promise.all([...clients.values()].map(client => client.close().catch(() => {})));
    clients.clear();
    mapping.clear();
  }

  return { connect, schemas, owns, call, close, health: () => health.slice(), toolCount: () => mapping.size };
}
