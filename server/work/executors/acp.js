import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { workError } from '../domain.js';
import { resolveLocalCommand } from '../providers.js';
import { withChineseOutput } from './cli.js';

// 单条 ACP 事件可能包含很大的工具输出；256KiB 连一次目录列举都能撑爆，
// 结果是整段复审被判失败。缓冲区放到 8MiB，只对「保留的正文」设小上限。
const MAX_OUTPUT = 8 * 1024 * 1024;
// 结论最多保留 64KiB：最终只取 8KiB，留够余地又不让数组无限增长。
const MAX_TEXT = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024;

// 把 ACP 请求的绝对路径限制在项目目录内，越界一律拒绝。
// 除了词法比较，还要跟随已存在的祖先做 realpath：项目内指向外部的符号链接
// 不能成为读写通道（node_modules 或恶意仓库里都可能带这种链接）。
export function resolveInside(workspace, target) {
  if (typeof target !== 'string' || !target) return null;
  const base = path.resolve(workspace);
  const resolved = path.resolve(base, target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let baseReal;
  try { baseReal = realpathSync(base); } catch { baseReal = base; }
  let probe = resolved;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  if (!existsSync(probe)) return null;
  let probeReal;
  try { probeReal = realpathSync(probe); } catch { return null; }
  const real = path.resolve(probeReal, path.relative(probe, resolved));
  const realRelative = path.relative(baseReal, real);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
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
  timeoutMs = Number(process.env.LAGENT_CLI_TIMEOUT_MS) || 1_800_000,
  // 交互授权最多等人 30 秒；无人值守时自动拒绝，避免整个任务挂死。
  permissionTimeoutMs = Number(process.env.LAGENT_ACP_PERMISSION_TIMEOUT_MS) || 30_000,
  spawnImpl,
  capabilities = ['acp', 'agent', 'chat']
} = {}) {
  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError('ACP 执行器需要 store 和 cwd');
  const resolved = command ? resolveLocalCommand(command, environment) : null;
  const available = Boolean(resolved && existsSync(resolved.command));
  const controllers = new Map();
  const tasks = new Map();
  // 长期运行时只保留最近的任务快照；已结束的记录以 store 为准。
  const trimTasks = () => { if (tasks.size <= 200) return; for (const [idValue, row] of tasks) { if (tasks.size <= 200) break; if (!['running', 'awaiting_approval'].includes(row.status)) tasks.delete(idValue); } };

  function removeController(idValue) {
    const controller = controllers.get(idValue);
    if (!controller) return;
    for (const pending of controller.permissions?.values?.() || []) clearTimeout(pending.timer);
    controllers.delete(idValue);
    try { controller.child?.kill?.(); } catch { /* ignore */ }
  }

  function start(ticket, assignment, input) {
    if (!available) throw workError('ACP Agent 未安装或不在 PATH', 503);
    const request = normalizeInput(input?.executorInput ?? input);
    const task = { id: assignment.id, ticketId: ticket.id, status: 'running', startedAt: new Date().toISOString(), acp: { agent: id } };
    tasks.set(task.id, task);
    store.put('task', task);

    const controller = { child: null, done: false, buffer: '', nextId: 1, pending: new Map(), permissions: new Map(), updates: [], textBytes: 0, oversized: false, sessionId: null, timer: null };
    const pushUpdate = text => {
      controller.updates.push(text);
      controller.textBytes += text.length;
      // 只保留尾部：结论在最后，早期的大段工具输出没有保留价值。
      while (controller.textBytes > MAX_TEXT && controller.updates.length > 1) {
        controller.textBytes -= controller.updates[0].length;
        controller.updates.shift();
      }
    };
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
      trimTasks();
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
        // 只开放「文件类」授权：带 terminal 的权限请求继续拒绝，避免无人值守时跑命令。
        const options = Array.isArray(params.options) ? params.options : [];
        const allowsCommand = JSON.stringify(params).includes('terminal');
        const allowOption = allowFiles && !allowsCommand ? options.find(option => option.kind === 'allow_once' || option.kind === 'allow_always') : null;
        if (!allowOption) {
          send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
          return true;
        }
        const requestId = randomUUID();
        const title = String(params.toolCall?.title || '请求访问项目文件').slice(0, 120);
        const target = String(params.toolCall?.locations?.[0]?.path || params.toolCall?.rawInput?.path || '').slice(0, 200);
        const text = target && !title.includes(target) ? `${title}：${target}` : title;
        const seconds = Math.max(1, Math.round(permissionTimeoutMs / 1000));
        const row = {
          at: new Date().toISOString(),
          kind: 'permission',
          text: text.slice(0, 600),
          detail: `允许一次只对这次操作生效；${seconds} 秒内未处理会自动拒绝。`,
          requestId
        };
        task.activity = [...(Array.isArray(task.activity) ? task.activity : []), row].slice(-60);
        task.updatedAt = row.at;
        store.put('task', task);
        const respond = (allowed, reason) => {
          const pending = controller.permissions.get(requestId);
          if (!pending) return false;
          controller.permissions.delete(requestId);
          clearTimeout(pending.timer);
          const current = tasks.get(task.id) || task;
          const rows = Array.isArray(current.activity) ? current.activity : [];
          const entry = rows.find(item => item.requestId === requestId);
          if (entry) {
            entry.decided = allowed ? 'allow' : 'deny';
            entry.detail = allowed ? '已允许这一次操作。' : reason === 'timeout' ? '超时未处理，已自动拒绝。' : '已拒绝这次操作。';
            // 时间戳也换一下：引擎按「条数 + 最后一条时间」判断要不要推 SSE。
            entry.at = new Date().toISOString();
          }
          current.updatedAt = new Date().toISOString();
          tasks.set(current.id, current);
          store.put('task', current);
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: allowed ? { outcome: { outcome: 'selected', optionId: allowOption.optionId } } : { outcome: { outcome: 'cancelled' } }
          });
          return true;
        };
        const timer = setTimeout(() => respond(false, 'timeout'), permissionTimeoutMs);
        timer.unref?.();
        controller.permissions.set(requestId, { respond, timer });
        return true;
      }
      if (message.method?.startsWith('terminal/')) {
        send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } });
        return true;
      }
      return false;
    };
    // ACP 的思考块和工具调用以前整段丢掉，界面只能看到「在做什么」的最终文本。
    // 这里逐条写进 activity，界面就能像看模型 Agent 一样看到它现在在想什么。
    const record = entry => {
      // 思考是分片来的，直接 trim 会把英文单词之间的空格吃掉（拼出来变成 Theuser asks）；
      // 追加型条目只去 ANSI，保留原始空白。
      const raw = String(entry?.text ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
      const text = entry?.append === true ? raw : raw.trim();
      if (!text || (text.trim() === '' && entry?.append !== true)) return;
      const kind = entry.kind || 'note';
      const list = Array.isArray(task.activity) ? task.activity : [];
      const last = list[list.length - 1];
      // 思考是逐字流下来的，半句话一条会让面板变成一堆碎片；同类相邻的就往后接。
      if (entry.append === true && last && last.kind === kind && last.text.length < 800) {
        last.text = `${last.text}${text}`.slice(0, 4000);
        last.at = new Date().toISOString();
        task.updatedAt = last.at;
        store.put('task', task);
        return;
      }
      if (last && last.kind === kind && last.text === text.slice(0, 600)) return;
      task.activity = [...list, { at: new Date().toISOString(), kind, text: text.slice(0, 600) }].slice(-60);
      task.updatedAt = new Date().toISOString();
      store.put('task', task);
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
        const kind = String(update.sessionUpdate || update.type || '');
        // 思考块：不同实现分别用 sessionUpdate 或 content.type 标记，两种都认。
        if (kind === 'agent_thought_chunk' || update.content?.type === 'thinking') {
          record({ kind: 'thought', text: update.content?.thinking || update.content?.text || '', append: true });
          return;
        }
        if (kind === 'tool_call' || kind === 'tool_call_update') {
          const title = update.title || update.toolName || update.content?.title || '';
          const status = String(update.status || '');
          // 没有名字的工具调用只是一条「调用了工具」的噪声，记「完成」也没信息量，跳过。
          if (title) {
            if (status === 'completed' || status === 'failed') record({ kind: status === 'failed' ? 'error' : 'observation', text: `${title} ${status === 'failed' ? '失败' : '完成'}` });
            else record({ kind: 'tool', text: title });
          }
          return;
        }
        if (kind === 'plan' && Array.isArray(update.entries) && update.entries.length) {
          record({ kind: 'note', text: `计划更新：${update.entries.length} 步` });
          return;
        }
        const text = update.content?.type === 'text' ? update.content.text : kind === 'agent_message_chunk' ? update.content?.text : '';
        if (typeof text === 'string' && text) {
          pushUpdate(text);
          // 正文也是分片流下来的：同样合并，否则结论会被拆成「name:」「`lagent` version:」这样一串碎片。
          record({ kind: 'note', text, append: true });
        }
      }
    };
    child.stdout?.on('data', chunk => {
      if (controller.done) return;
      controller.buffer += String(chunk);
      let newline;
      while ((newline = controller.buffer.indexOf('\n')) >= 0) {
        const line = controller.buffer.slice(0, newline).trim();
        controller.buffer = controller.buffer.slice(newline + 1);
        // 单条事件过大时丢掉这条，而不是让整段任务失败；后续事件仍可正常解析。
        if (line.length > MAX_OUTPUT) {
          if (!controller.oversized) record({ kind: 'note', text: 'ACP 单条事件过大，已忽略该条输出' });
          controller.oversized = true;
          continue;
        }
        if (line) handleLine(line);
      }
      if (controller.buffer.length > MAX_OUTPUT) {
        // 迟迟没有换行说明这条事件本身超大；丢弃半截缓冲，避免无上限占用内存。
        if (!controller.oversized) record({ kind: 'note', text: 'ACP 单条事件过大，已忽略该条输出' });
        controller.oversized = true;
        controller.buffer = '';
      }
    });
    child.stderr?.on('data', () => { /* 诊断不落库，避免密钥/路径泄漏。 */ });
    child.once?.('error', () => finish('failed', { error: 'ACP Agent 启动失败' }));
    child.once?.('close', code => {
      // 正常完成时 session/prompt 已返回并调用 finish('completed')；走到这里仍未 finish，
      // 说明会话没拿到结果，即使退出码为 0 也只能算失败。
      if (!controller.done) finish('failed', { error: `ACP Agent 退出（${code ?? 'unknown'}）` });
    });
    controller.timer = setTimeout(() => finish('failed', { error: 'ACP Agent 执行超时' }), Math.max(1, timeoutMs));
    controller.timer.unref?.();

    void (async () => {
      try {
        await requestRpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: allowFiles, writeTextFile: allowFiles }, terminal: false } });
        const session = await requestRpc('session/new', { cwd: request.workspace || cwd, mcpServers: [] });
        if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('ACP session/new 未返回 sessionId');
        controller.sessionId = session.sessionId;
        // 语言要求只加在真正发送的正文上，输入校验仍按用户原文计算上限。
        const result = await requestRpc('session/prompt', { sessionId: controller.sessionId, prompt: [{ type: 'text', text: withChineseOutput(request.prompt) }] });
        finish('completed', {
          report: { id: `acp-${assignment.id}`, summary: controller.updates.join('').slice(0, 4000) || 'ACP Agent 已完成', stopReason: result?.stopReason || null },
          artifacts: { acp: { agent: id, stopReason: result?.stopReason || null, cwd: request.workspace || cwd, text: controller.updates.join('').slice(-8000) } }
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
    // 界面上的「允许一次 / 拒绝」通过引擎转到这里；找不到请求说明已超时或任务已结束。
    resolvePermission(task, requestId, decision) {
      if (decision !== 'allow' && decision !== 'deny') return false;
      const idValue = typeof task === 'string' ? task : task?.id;
      const pending = controllers.get(idValue)?.permissions?.get(requestId);
      if (!pending) return false;
      return pending.respond(decision === 'allow');
    },
    stop(task) {
      const controller = controllers.get(task?.id);
      if (controller?.sessionId) {
        try { controller.child?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: controller.sessionId } })}\n`); } catch { /* ignore */ }
      }
      if (controller?.child) { try { controller.child.kill?.(); } catch { /* ignore */ } }
      if (task) {
        const stopped = { ...task, status: 'cancelled', completedAt: new Date().toISOString() };
        tasks.set(task.id, stopped);
        trimTasks();
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
    { id: 'codex-acp', name: 'Codex ACP', commands: ['codex-acp'], envKey: 'LAGENT_CODEX_ACP' },
    { id: 'claude-acp', name: 'Claude ACP', commands: ['claude-agent-acp', 'claude-code-acp', 'claude-acp'], envKey: 'LAGENT_CLAUDE_ACP' },
    { id: 'dsh-acp', name: 'DeepSeek Harness ACP', commands: ['dsh-acp'], envKey: 'LAGENT_DSH_ACP' }
  ];
  return definitions.map(definition => {
    const override = environment[definition.envKey];
    const candidates = override ? [override, ...definition.commands] : definition.commands;
    // 探测不到也注册：界面要能显示「未安装」，而不是让它从列表里静默消失。
    const command = candidates.find(candidate => resolveLocalCommand(candidate, environment)) || null;
    return createAcpExecutor({ id: definition.id, name: definition.name, command, store, cwd, environment });
  });
}
