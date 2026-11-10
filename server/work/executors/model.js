import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workError } from '../domain.js';
import { modelRequest, readModelResponse, providerUsage, visibleReply } from '../../model-protocol.js';

// 模型 Agent：用已经接入的模型自己推理 + 调工具，把一个任务在项目目录里做完。
// 与 CLI 执行器不同，它的每一步都写进 task.activity，界面因此能像看 dsh 一样看到过程。
const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const MAX_STEPS = 12;
const READ_LIMIT = 8000;
const LIST_LIMIT = 120;
const HITS_LIMIT = 40;
const ACTIVITY_LIMIT = 60;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.dataagent', 'data', '.venv', '__pycache__', 'coverage']);
const WRITE_TOOLS = new Set(['write_file']);
const READ_COMMAND = /^(git\s+(status|diff|log|show|branch)\b[^|;&<>]*|node\s+--check\s+\S+)$/i;

const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

export function normalizeModelInput(input, { maxPromptBytes = 16 * 1024 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('executorInput 必须为结构化对象');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw statusError('模型 Agent 的 prompt 必须是非空字符串');
  if (prompt.includes('\0')) throw statusError('prompt 不允许 NUL 字符');
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw statusError(`prompt 不能超过 ${maxPromptBytes} 字节`);
  const steps = input.maxSteps === undefined ? 8 : input.maxSteps;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) throw statusError(`maxSteps 必须是 1-${MAX_STEPS} 的整数`);
  const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
  if (workspace && (!path.isAbsolute(workspace) || workspace.length > 500)) throw statusError('workspace 必须是有效的工作目录绝对路径');
  // 会话级模型：可以指定用哪个已保存的模型配置，不传则用工作流默认模型。
  const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : '';
  if (profileId && !/^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) throw statusError('profileId 无效');
  return {
    prompt,
    maxSteps: steps,
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
    ...(profileId ? { profileId } : {}),
    write: input.write === true,
  };
}

// 所有文件操作都必须落在工作目录内：先解析绝对路径再比对相对路径，避免 ../ 与链接逃逸。
function resolveInside(workspace, target) {
  const raw = typeof target === 'string' ? target.trim() : '';
  if (!raw) throw new Error('path 不能为空');
  const absolute = path.resolve(workspace, raw);
  const relative = path.relative(workspace, absolute);
  // relative 为空字符串表示就是工作目录本身；只有越界（../ 或另一个盘符）才拒绝。
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('只能访问工作目录内的文件');
  return absolute;
}

const relativeTo = (workspace, absolute) => path.relative(workspace, absolute).split(path.sep).join('/');

function listFiles(workspace, target) {
  const start = target ? resolveInside(workspace, target) : workspace;
  const stat = fs.statSync(start);
  if (!stat.isDirectory()) return { entries: [{ name: path.basename(start), type: 'file', size: stat.size }] };
  const entries = [];
  for (const entry of fs.readdirSync(start, { withFileTypes: true }).slice(0, LIST_LIMIT)) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(start, entry.name);
    let size = 0;
    try { size = fs.statSync(absolute).size; } catch { size = 0; }
    entries.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', size });
  }
  return { path: relativeTo(workspace, start) || '.', entries };
}

function readFile(workspace, target, offset, limit) {
  const absolute = resolveInside(workspace, target);
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('只能读取文件');
  if (stat.size > 400 * 1024) throw new Error('文件超过 400KB，请改用 search_code 定位');
  const content = fs.readFileSync(absolute, 'utf8');
  const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, READ_LIMIT) : READ_LIMIT;
  return {
    path: relativeTo(workspace, absolute),
    size: stat.size,
    offset: from,
    content: content.slice(from, from + take),
    truncated: content.length > from + take,
  };
}

function searchCode(workspace, pattern, target) {
  const start = target ? resolveInside(workspace, target) : workspace;
  const expression = new RegExp(pattern, 'i');
  const hits = [];
  const walk = directory => {
    if (hits.length >= HITS_LIMIT) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= HITS_LIMIT) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      let stat;
      try { stat = fs.statSync(absolute); } catch { continue; }
      if (!stat.isFile() || stat.size > 200 * 1024) continue;
      let content;
      try { content = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      content.split(/\r?\n/).forEach((line, index) => {
        if (hits.length >= HITS_LIMIT || !expression.test(line)) return;
        hits.push({ file: relativeTo(workspace, absolute), line: index + 1, text: line.trim().slice(0, 200) });
      });
    }
  };
  walk(start);
  return { pattern, count: hits.length, hits };
}

function writeFile(workspace, target, content) {
  const absolute = resolveInside(workspace, target);
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  if (Buffer.byteLength(content) > 200 * 1024) throw new Error('单次写入不能超过 200KB');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const existed = fs.existsSync(absolute);
  const before = existed ? fs.readFileSync(absolute, 'utf8') : '';
  fs.writeFileSync(absolute, content, 'utf8');
  return {
    path: relativeTo(workspace, absolute),
    created: !existed,
    before: before.length,
    after: content.length,
  };
}

function runCommand(workspace, command) {
  const value = text(command, 300);
  if (!READ_COMMAND.test(value)) throw new Error('只允许只读的 git 命令（status/diff/log/show/branch）或 node --check');
  // 白名单命令本身不写文件；用 execFileSync 走 shell 之外，避免命令拼接。
  const parts = value.split(/\s+/);
  const output = execFileSync(parts[0], parts.slice(1), { cwd: workspace, timeout: 15000, encoding: 'utf8', windowsHide: true });
  return { command: value, output: String(output).slice(0, 4000) };
}

export function modelSystemPrompt({ maxSteps, write }) {
  return [
    '你是 DataAgent 的模型 Agent，在一个本地工作目录里独立完成任务。',
    '每一步只输出一个 JSON 对象，不要输出任何其它文字、不要用代码块包裹：',
    '· 调用工具：{"tool":"read_file","args":{"path":"src/app.tsx"}}',
    '· 结束任务：{"final":{"summary":"做了什么、结论是什么","files":["改动过的文件"]}}',
    '',
    `可用工具：list_files{path?}、read_file{path,offset?,limit?}、search_code{pattern,path?}${write ? '、write_file{path,content}' : ''}、run_command{command}。`,
    write
      ? '你被允许修改这个目录内的文件：先读再改，一次写一个文件，改动要小、要能说清理由。'
      : '你没有写权限：不要尝试 write_file，只读取与检索，最后给出结论和改动建议。',
    '规则：不要编造文件、函数或结论；只访问工作目录内的路径；读不懂就先 list_files / search_code。',
    `最多 ${maxSteps} 步，步数用完必须给出 final。`,
  ].join('\n');
}

export function parseModelStep(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.final && typeof parsed.final === 'object') {
    return { type: 'final', summary: text(parsed.final.summary, 4000), files: Array.isArray(parsed.final.files) ? parsed.final.files.filter(item => typeof item === 'string').slice(0, 40) : [] };
  }
  if (typeof parsed.tool === 'string' && parsed.tool.trim()) {
    const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args : {};
    return { type: 'tool', tool: parsed.tool.trim(), args };
  }
  return null;
}

// 过程流是给人看的：这里把工具调用与结果压成一句话，避免界面上出现整段原始 JSON。
const TOOL_LABELS = {
  list_files: '列目录',
  read_file: '读文件',
  search_code: '搜代码',
  write_file: '写文件',
  run_command: '运行命令',
};

function shortPath(value) {
  return String(value || '.').replace(/\\/g, '/').slice(0, 120);
}

export function describeCall(tool, args = {}) {
  const label = TOOL_LABELS[tool] || tool;
  if (tool === 'list_files') return `${label} ${shortPath(args.path || '.') === '.' ? '根目录' : shortPath(args.path)}`;
  if (tool === 'read_file') return `${label} ${shortPath(args.path)}`;
  if (tool === 'search_code') return `${label} ${String(args.pattern || '').slice(0, 60)}`;
  if (tool === 'write_file') return `${label} ${shortPath(args.path)}`;
  if (tool === 'run_command') return `${label} ${String(args.command || '').slice(0, 80)}`;
  return tool;
}

export function describeOutput(tool, output = {}) {
  if (tool === 'list_files') {
    const entries = Array.isArray(output.entries) ? output.entries : [];
    const names = entries.map(entry => `${entry.name}${entry.type === 'dir' ? '/' : ''}`);
    const head = names.slice(0, 8).join('、');
    return `${names.length} 项${head ? `：${head}` : ''}${names.length > 8 ? ' …' : ''}`;
  }
  if (tool === 'read_file') {
    const lines = String(output.content || '').split(/\r?\n/).length;
    return `${shortPath(output.path)} · ${lines} 行${output.truncated ? '（已截断）' : ''}`;
  }
  if (tool === 'search_code') {
    const hits = (Array.isArray(output.hits) ? output.hits : []).slice(0, 3).map(hit => `${hit.file}:${hit.line}`);
    return `${output.count || 0} 处命中${hits.length ? `：${hits.join('、')}` : ''}`;
  }
  if (tool === 'write_file') {
    return `${shortPath(output.path)} · ${output.created ? '新建' : '覆盖'} · ${output.after || 0} 字符`;
  }
  if (tool === 'run_command') {
    const first = String(output.output || '').trim().split(/\r?\n/)[0] || '';
    return `退出码 0${first ? `：${first.slice(0, 100)}` : ''}`;
  }
  return '';
}

export function modelExecutor({ store, cwd, context, contextFor, fetchImpl = fetch, perCallTimeoutMs = 60000, totalTimeoutMs = 300000 }) {  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError('model 执行器需要 store 和 cwd');
  const workspace = path.resolve(cwd);
  const running = new Map();
  const persist = task => { store.put('task', task); return task; };

  const pushActivity = (task, entry) => {
    const list = Array.isArray(task.activity) ? task.activity : [];
    list.push({ at: new Date().toISOString(), ...entry });
    task.activity = list.slice(-ACTIVITY_LIMIT);
    task.updatedAt = new Date().toISOString();
    persist(task);
  };

  async function askModel(messages, task, signal, profileId) {
    const ctx = profileId && typeof contextFor === 'function' ? contextFor(profileId) : (typeof context === 'function' ? context() : context);
    if (!ctx?.key || !ctx?.settings?.model) throw statusError('还没有可用的模型：请在「设置 → 规划设置」里配置并选择默认模型', 503);
    task.modelLabel = ctx.profileName || ctx.settings.model;
    const request = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, Math.min(4096, Number(ctx.maxTokens) || 4096), false, ctx.settings);
    let response;
    try {
      response = await fetchImpl(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw statusError('模型调用超时', 504);
      throw statusError(`模型接口无法访问：${error?.message || '网络错误'}`, 502);
    }
    if (!response.ok) throw statusError(`模型接口返回 HTTP ${response.status}`, 502);
    const payload = await readModelResponse(response);
    return { payload, protocol: request.protocol, usage: providerUsage(payload?.usage, request.protocol) };
  }

  function replyOf(payload, protocol) {
    return visibleReply(payload, protocol);
  }

  function runTool(name, args, runWorkspace, write) {
    if (name === 'list_files') return listFiles(runWorkspace, args?.path);
    if (name === 'read_file') return readFile(runWorkspace, args?.path, args?.offset, args?.limit);
    if (name === 'search_code') return searchCode(runWorkspace, text(args?.pattern, 200) || '.', args?.path);
    if (name === 'write_file') {
      if (!write) throw new Error('当前任务没有写权限');
      return writeFile(runWorkspace, args?.path, args?.content);
    }
    if (name === 'run_command') return runCommand(runWorkspace, args?.command);
    throw new Error(`未知工具：${name}`);
  }

  async function execute(task, input, runWorkspace) {
    const messages = [
      { role: 'system', content: modelSystemPrompt({ maxSteps: input.maxSteps, write: input.write }) },
      { role: 'user', content: `任务：${input.prompt}\n\n工作目录：${runWorkspace}` },
    ];
    const usage = {};
    let files = [];
    let summary = '';
    const deadline = Date.now() + totalTimeoutMs;
    for (let step = 0; step < input.maxSteps; step += 1) {
      if (task.cancelled) throw statusError('模型 Agent 已停止', 499);
      const remaining = deadline - Date.now();
      if (remaining <= 1000) throw statusError('模型 Agent 超出总时长限制', 504);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(perCallTimeoutMs, remaining));
      let reply = '';
      try {
        const result = await askModel(messages, task, controller.signal, input.profileId);
        for (const [key, value] of Object.entries(result.usage || {})) usage[key] = (usage[key] || 0) + (Number(value) || 0);
        reply = replyOf(result.payload, result.protocol);
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseModelStep(reply);
      if (!parsed) {
        messages.push({ role: 'assistant', content: reply.slice(0, 2000) });
        messages.push({ role: 'user', content: '你没有按要求输出 JSON。请只输出一个 JSON 对象：{"tool":"..."} 或 {"final":{...}}。' });
        pushActivity(task, { kind: 'error', text: '模型回复不是合法 JSON，已要求重试' });
        continue;
      }
      if (parsed.type === 'final') {
        summary = parsed.summary;
        files = [...new Set([...files, ...parsed.files])];
        pushActivity(task, { kind: 'result', text: summary || '模型 Agent 完成' });
        return { summary, files, usage, steps: step + 1 };
      }
      messages.push({ role: 'assistant', content: reply.slice(0, 4000) });
      pushActivity(task, { kind: 'tool', text: describeCall(parsed.tool, parsed.args) });
      let output;
      try {
        output = runTool(parsed.tool, parsed.args, runWorkspace, input.write);
        if (parsed.tool === 'write_file') files = [...new Set([...files, output.path])];
        messages.push({ role: 'user', content: `工具结果（${parsed.tool}）：\n${JSON.stringify(output).slice(0, 6000)}` });
        pushActivity(task, { kind: 'observation', text: `${TOOL_LABELS[parsed.tool] || parsed.tool} 完成`, detail: describeOutput(parsed.tool, output) });
      } catch (error) {
        const message = error?.message || '工具执行失败';
        messages.push({ role: 'user', content: `工具错误（${parsed.tool}）：${message}` });
        pushActivity(task, { kind: 'error', text: `${parsed.tool} 失败：${message}` });
      }
    }
    summary = summary || '已达到步数上限，任务未完全完成。';
    pushActivity(task, { kind: 'result', text: summary });
    return { summary, files, usage, steps: input.maxSteps, exhausted: true };
  }

  function finalize(task, { summary, error, usage, files, steps, startedAt }) {
    const stamp = new Date().toISOString();
    const cancelled = task.cancelled === true;
    const failed = Boolean(error);
    task.status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    task.endedAt = stamp;
    task.updatedAt = stamp;
    task.error = cancelled ? '模型 Agent 已停止' : failed ? String(error).slice(0, 2000) : undefined;
    task.artifacts = {
      ...(task.artifacts || {}),
      cli: {
        executorId: 'model',
        summary: String(summary || (failed ? '模型 Agent 执行失败' : '')).slice(0, 6000),
        usage: usage || {},
        error: failed ? String(error).slice(0, 2000) : undefined,
        artifacts: [...new Set(files || [])].slice(0, 100),
        stats: { steps: steps || 0 },
        exitCode: failed ? 1 : 0,
        durationMs: Date.now() - startedAt,
        workspace: task.workspace,
      },
    };
    persist(task);
    return task;
  }

  return {
    id: 'model',
    name: '模型 Agent',
    kind: 'cli',
    available: true,
    requiresDataset: false,
    capabilities: ['cli', 'model', 'text-output', 'project-write', 'tools'],
    validateInput: input => normalizeModelInput(input),
    defaultInput: value => normalizeModelInput({ prompt: value }),
    start(ticket, assignment, input) {
      const normalized = normalizeModelInput(input?.executorInput ?? input);
      // 没有可用模型时立刻报错：不要让用户以为任务在跑，结果几秒后才失败。
      const ctx = typeof context === 'function' ? context() : context;
      if (!ctx?.key || !ctx?.settings?.model) {
        throw statusError('还没有可用的模型：请在「设置 → 规划设置」里配置并选择默认模型', 503);
      }
      const runWorkspace = normalized.workspace ? path.resolve(normalized.workspace) : workspace;
      try {
        if (!fs.statSync(runWorkspace).isDirectory()) throw new Error('not a directory');
      } catch {
        throw statusError('项目工作目录不存在或不可访问', 400);
      }
      const prior = store.get('task', assignment.id);
      if (prior) return prior;
      const stamp = new Date().toISOString();
      const task = {
        id: assignment.id,
        workAssignmentId: assignment.id,
        executorId: 'model',
        goal: ticket.command,
        status: 'running',
        createdAt: stamp,
        updatedAt: stamp,
        workspace: runWorkspace,
        activity: [],
        artifacts: {},
      };
      persist(task);
      running.set(task.id, true);
      const startedAt = Date.now();
      const controller = new AbortController();
      task.controller = controller;
      void execute(task, normalized, runWorkspace)
        .then(result => finalize(task, { ...result, startedAt }))
        .catch(error => {
          const cancelled = task.cancelled === true;
          finalize(task, {
            summary: cancelled ? '模型 Agent 已停止' : '',
            error: cancelled ? '模型 Agent 已停止' : error?.message || '模型 Agent 执行失败',
            usage: {},
            files: [],
            steps: 0,
            startedAt,
          });
        })
        .finally(() => running.delete(task.id));
      return task;
    },
    get: taskId => (taskId && store.get('task', taskId)) || null,
    stop(task) {
      if (!task) return;
      task.cancelled = true;
      task.status = 'cancelled';
      task.endedAt = new Date().toISOString();
      task.updatedAt = task.endedAt;
      task.error = '模型 Agent 已停止';
      persist(task);
    },
    close() {
      for (const taskId of running.keys()) {
        const task = store.get('task', taskId);
        if (task && task.status === 'running') {
          task.status = 'cancelled';
          task.cancelled = true;
          task.error = '服务重启，模型 Agent 已中断';
          persist(task);
        }
      }
      running.clear();
    },
  };
}
