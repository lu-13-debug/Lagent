import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { workError } from '../domain.js';
import { resolveLocalCommand } from '../providers.js';

const MAX_OUTPUT = 256 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

// 把 ACP 请求的绝对路径限制在项目目录内，越界一律拒绝。
function resolveInside(workspace, target) {
  if (typeof target !== 'string' || !target) return null;
  const base = path.resolve(workspace);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return resolved === base ? resolved : null;
  return resolved;
}

function normalizeInput(input) {
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : typeof input === 'string' ? input.trim() : '';
  if (!prompt) throw workError('ACP prompt 必须是非空字符串');
  if (Buffer.byteLength(prompt, 'utf8') > 16 * 1024) throw workError('ACP prompt 不能超过 16KB');
  // 项目工单会带上 workspace：ACP 的 session/new 以它为工作目录，并在该目录内开放文件读写。
  const workspace = typeof input?.workspace === 'string' ? input.workspace.trim() : '';
  if (workspace && !existsSync(workspace)) throw workError('ACP 工作目录不存在', 400);
  if (!workspace) return { prompt };
  return { prompt, workspace, write: input?.write === true };
}

function spawnCommand(command, baseArgs, shell) {
  if (shell === true) return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}" ${baseArgs.map(item => `"${String(item).replace(/"/g, '""')}"`).join(' ')}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
  return spawn(command, baseArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
}

export function createAcpExecutor({
  id = 'acp',
  name = 'ACP Agent',
  store,
  cwd,
  command,
  args = [],
  environment = process.env,
  timeoutMs = 300000,
  spawnImpl,
  capabilities = ['acp', 'agent', 'chat']
} = {}) {
  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError('ACP 执行器需要 store 和 cwd');
  const resolved = command ? resolveLocalCommand(command, environment) : null;
  const available = Boolean(resolved && existsSync(resolved.command));
  const controllers = new Map();
  const tasks = new Map();

  function removeController(idValue) {
    const controller = controllers.get(idValue);
    if (!controller) return;
    controllers.delete(idValue);
    try { controller.child?.kill?.(); } catch { /* ignore */ }
  }

  function start(ticket, assignment, input) {
    if (!available) throw workError('ACP Agent 未安装或不在 PATH', 503);
    const request = normalizeInput(input?.executorInput ?? input);
    const task = { id: assignment.id, status: 'running', startedAt: new Date().toISOString(), acp: { agent: id } };
    tasks.set(task.id, task);
    store.put('task', task);

    const controller = { child: null, done: false, buffer: '', nextId: 1, pending: new Map(), updates: [], sessionId: null, timer: null };
    controllers.set(task.id, controller);
    controller.child = (spawnImpl || spawnCommand)(resolved.command, [...(resolved.args || []), ...args], resolved.shell);
    const child = controller.child;

    const send = message => {
      if (!child.stdin?.writable) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const requestRpc = (method, params) => new Promise((resolve, reject) => {
      const idValue = controller.nextId++;
      controller.pending.set(idValue, { resolve, reject });
      send({ jsonrpc: '2.0', id: idValue, method, params });
    });
    const finish = (status, detail = {}) => {
      if (controller.done) return;
      controller.done = true;
      clearTimeout(controller.timer);
      const finished = { ...task, ...detail, status, completedAt: new Date().toISOString() };
      tasks.set(task.id, finished);
      store.put('task', finished);
      removeController(task.id);
    };
    // 项目工单（带 workspace）里，用户已经在工单上审过这批动作，所以把文件读写
    // 限定在项目目录内开放；终端、以及没有 workspace 的 ACP 工单一律保持只读。
    const workspace = request.workspace || '';
    const allowFiles = Boolean(workspace && request.write);
    const handleRequest = message => {
      const params = message.params || {};
      if (message.method === 'fs/read_text_file') {
        const target = allowFiles ? resolveInside(workspace, params.path) : null;
        if (!target) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'read_text_file is not enabled' } }); return true; }
        try {
          send({ jsonrpc: '2.0', id: message.id, result: { content: readFileSync(target, 'utf8').slice(0, MAX_FILE_BYTES) } });
        } catch (error) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error?.message || '读取失败').slice(0, 200) } });
        }
        return true;
      }
      if (message.method === 'fs/write_text_file') {
        const target = allowFiles ? resolveInside(workspace, params.path) : null;
        if (!target) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'write_text_file is not enabled' } }); return true; }
        try {
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, String(params.content ?? ''), 'utf8');
          send({ jsonrpc: '2.0', id: message.id, result: null });
        } catch (error) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error?.message || '写入失败').slice(0, 200) } });
        }
        return true;
      }
      if (message.method === 'session/request_permission') {
        // 只允许「文件类」授权：带 terminal 的权限请求继续拒绝，避免无人值守时跑命令。
        const options = Array.isArray(params.options) ? params.options : [];
        const allowsCommand = JSON.stringify(params).includes('terminal');
        const allowed = allowFiles && !allowsCommand ? options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always') : null;
        send({ jsonrpc: '2.0', id: message.id, result: allowed ? { outcome: { outcome: 'selected', optionId: allowed.optionId } } : { outcome: { outcome: 'cancelled' } } });
        return true;
      }
      if (message.method?.startsWith('terminal/')) {
        send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        return true;
      }
      return false;
    };
    const handleLine = line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && message.method) {
        if (!handleRequest(message)) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unsupported ACP client method' } });
        return;
      }
      if (message.id !== undefined && controller.pending.has(message.id)) {
        const pending = controller.pending.get(message.id);
        controller.pending.delete(message.id);
        if (message.error) pending.reject(new Error(String(message.error.message || 'ACP 请求失败').slice(0, 300)));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method === 'session/update') {
        const update = message.params?.update || {};
        const text = update.content?.type === 'text' ? update.content.text : update.type === 'agent_message_chunk' ? update.content?.text : '';
        if (typeof text === 'string' && text) controller.updates.push(text);
      }
    };
    child.stdout?.on('data', chunk => {
      if (controller.done) return;
      controller.buffer += String(chunk);
      if (controller.buffer.length > MAX_OUTPUT) { finish('failed', { error: 'ACP 输出超过上限' }); return; }
      let newline;
      while ((newline = controller.buffer.indexOf('\n')) >= 0) {
        const line = controller.buffer.slice(0, newline).trim();
        controller.buffer = controller.buffer.slice(newline + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on('data', () => { /* 诊断不落库，避免密钥/路径泄漏。 */ });
    child.once?.('error', () => finish('failed', { error: 'ACP Agent 启动失败' }));
    child.once?.('close', code => {
      if (!controller.done) finish(code === 0 ? 'failed' : 'failed', { error: `ACP Agent 退出（${code ?? 'unknown'}）` });
    });
    controller.timer = setTimeout(() => finish('failed', { error: 'ACP Agent 执行超时' }), Math.max(1, timeoutMs));
    controller.timer.unref?.();

    void (async () => {
      try {
        await requestRpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: allowFiles, writeTextFile: allowFiles }, terminal: false } });
        const session = await requestRpc('session/new', { cwd: request.workspace || cwd, mcpServers: [] });
        if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('ACP session/new 未返回 sessionId');
        controller.sessionId = session.sessionId;
        const result = await requestRpc('session/prompt', { sessionId: controller.sessionId, prompt: [{ type: 'text', text: request.prompt }] });
        finish('completed', {
          report: { id: `acp-${assignment.id}`, summary: controller.updates.join('\n').slice(0, 4000) || 'ACP Agent 已完成', stopReason: result?.stopReason || null },
          artifacts: { acp: { agent: id, stopReason: result?.stopReason || null, cwd: request.workspace || cwd, text: controller.updates.join('\n').slice(-8000) } }
        });
      } catch (error) {
        finish('failed', { error: String(error?.message || 'ACP 执行失败').slice(0, 300) });
      }
    })();
    return task;
  }

  return {
    id, name, kind: 'cli', available, requiresDataset: false, capabilities,
    validateInput: normalizeInput,
    defaultInput: text => normalizeInput({ prompt: text }),
    start,
    get: idValue => idValue && (tasks.get(idValue) || store.get('task', idValue)),
    stop(task) {
      const controller = controllers.get(task?.id);
      if (controller?.sessionId) {
        try { controller.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: controller.sessionId } })}\n`); } catch { /* ignore */ }
      }
      if (controller?.child) { try { controller.child.kill?.(); } catch { /* ignore */ } }
      if (task) {
        const stopped = { ...task, status: 'cancelled', completedAt: new Date().toISOString() };
        tasks.set(task.id, stopped);
        store.put('task', stopped);
      }
      if (task?.id) removeController(task.id);
    },
    close() {
      for (const idValue of [...controllers.keys()]) removeController(idValue);
      controllers.clear();
    }
  };
}

export function acpExecutors({ store, cwd, environment = process.env } = {}) {
  const definitions = [
    { id: 'codex-acp', name: 'Codex ACP', commands: ['codex-acp'], envKey: 'DATAAGENT_CODEX_ACP' },
    { id: 'claude-acp', name: 'Claude ACP', commands: ['claude-agent-acp', 'claude-code-acp', 'claude-acp'], envKey: 'DATAAGENT_CLAUDE_ACP' },
    { id: 'dsh-acp', name: 'DeepSeek Harness ACP', commands: ['dsh-acp'], envKey: 'DATAAGENT_DSH_ACP' }
  ];
  return definitions.map(definition => {
    const override = environment[definition.envKey];
    const candidates = override ? [override, ...definition.commands] : definition.commands;
    const command = candidates.find(candidate => resolveLocalCommand(candidate, environment));
    return command ? { definition, command } : null;
  }).filter(Boolean).map(({ definition, command }) => createAcpExecutor({ id: definition.id, name: definition.name, command, store, cwd, environment }));
}
