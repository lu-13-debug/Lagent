import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { workError } from '../domain.js';

const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const ALLOWED_ENVIRONMENT = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TEMP', 'TMP', 'TZ', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'TERM', 'NO_COLOR', 'CI'
];
const USAGE_KEYS = [
  'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'reasoning_output_tokens', 'total_tokens', 'total_cost_usd',
  'num_turns', 'duration_ms', 'duration_api_ms'
];
const ARTIFACT_PATH_LIMIT = 100;

function executableStatus(binary) {
  if (typeof binary !== 'string' || !binary.trim()) return { available: false, executable: null };
  if (!path.isAbsolute(binary.trim())) return { available: false, executable: null };
  const executable = path.resolve(binary.trim());
  try {
    if (!statSync(executable).isFile()) return { available: false, executable };
    if (process.platform !== 'win32') accessSync(executable, constants.X_OK);
    return { available: true, executable };
  } catch {
    return { available: false, executable };
  }
}

export function normalizeCliInput(input, { defaultMaxTurns = 5, maxTurns = 20, maxPromptBytes = 16 * 1024 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('executorInput 必须为结构化对象');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw statusError('CLI prompt 必须是非空字符串');
  if (prompt.includes('\0')) throw statusError('CLI prompt 不允许 NUL 字符');
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw statusError(`CLI prompt 不能超过 ${maxPromptBytes} 字节`);
  const turns = input.maxTurns === undefined ? defaultMaxTurns : input.maxTurns;
  if (!Number.isInteger(turns) || turns < 1 || turns > maxTurns) {
    throw statusError(`maxTurns 必须是 1-${maxTurns} 的整数`);
  }
  const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
  if (workspace && (!path.isAbsolute(workspace) || workspace.length > 500 || workspace.includes('\0'))) {
    throw statusError('workspace 必须是有效的工作目录绝对路径');
  }
  const resume = typeof input.resume === 'string' ? input.resume.trim() : '';
  if (resume && !/^[A-Za-z0-9._:-]{1,128}$/.test(resume)) throw statusError('resume 会话 id 无效');
  return {
    prompt,
    maxTurns: turns,
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
    ...(resume ? { resume } : {}),
    ...(input.write === true ? { write: true } : {})
  };
}

export function readOnlyPrompt(input) {
  return [
    '只读分析模式：不得修改、创建、删除或重命名文件；不得运行写入命令；不得安装依赖或发起网络请求；不得启动子智能体、后台任务或其他持久进程。',
    `只检查当前工作区已有内容，并在最多 ${input.maxTurns} 个回合内给出简洁摘要。`,
    '',
    '用户任务：',
    input.prompt
  ].join('\n');
}

export function writablePrompt(input) {
  return [
    '项目修改模式：你与用户共享当前项目目录。可以读取、编辑、创建文件；修改必须限定在当前项目目录内。',
    '不得删除项目目录之外的文件，不得执行 git push、发布、部署，不得安装全局依赖，不得发起与当前任务无关的网络请求。',
    '先阅读项目现状，再动手修改；完成后用简短摘要列出改动文件与验证方式。',
    `最多 ${input.maxTurns} 个回合。`,
    '',
    '用户任务：',
    input.prompt
  ].join('\n');
}

export function cliEnvironment(source = process.env) {
  const env = {};
  for (const key of ALLOWED_ENVIRONMENT) {
    if (typeof source?.[key] === 'string') env[key] = source[key];
  }
  env.NO_COLOR = '1';
  env.CI = '1';
  env.TERM = 'dumb';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

export function parseJsonLines(value) {
  const events = [];
  let malformed = 0;
  for (const line of String(value || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

export function sanitizeText(value, limit = 6000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:sk-|pk-|rk-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\0/g, '')
    .slice(0, limit);
}

export function sanitizeUsage(value) {
  const usage = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return usage;
  for (const key of USAGE_KEYS) {
    if (Number.isFinite(value[key])) usage[key] = value[key];
  }
  return usage;
}

export function safeArtifactPath(value, cwd) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null;
  const candidate = value.trim();
  if (!candidate) return null;
  let relative = candidate;
  if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    relative = path.relative(path.resolve(cwd), path.resolve(candidate));
    if (!relative || path.isAbsolute(relative) || relative.startsWith('..')) return null;
  }
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') return null;
  return normalized.length <= ARTIFACT_PATH_LIMIT ? normalized : null;
}

function safeStats(extra, parsed, controller) {
  const stats = {
    events: Number.isInteger(parsed.stats?.events) ? parsed.stats.events : 0,
    malformedLines: Number.isInteger(parsed.stats?.malformedLines) ? parsed.stats.malformedLines : 0,
    stdoutBytes: controller.stdoutBytes,
    stderrBytes: controller.stderrBytes
  };
  for (const [key, value] of Object.entries(extra || {})) {
    if (Number.isInteger(value) && value >= 0) stats[key] = value;
  }
  for (const [key, value] of Object.entries(parsed.stats || {})) {
    if (Number.isInteger(value) && value >= 0) stats[key] = value;
  }
  return stats;
}

export function createCliExecutor({
  id,
  name,
  kind = 'cli',
  store,
  cwd,
  binary,
  binaryPrefix = [],
  capabilities = [],
  timeoutMs = 300_000,
  maxOutputBytes = 512 * 1024,
  maxConcurrent = 2,
  spawnImpl = spawn,
  environment = process.env,
  validateInput,
  buildArgs,
  parseOutput
}) {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) throw new TypeError('CLI 执行器需要 id 和 name');
  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError(`${id} 执行器需要 store 和 cwd`);
  if (typeof validateInput !== 'function' || typeof buildArgs !== 'function' || typeof parseOutput !== 'function') {
    throw new TypeError(`${id} 执行器缺少输入、参数或输出解析函数`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正数');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes 必须为正整数');
  const workspace = path.resolve(cwd);
  const binaryInfo = executableStatus(binary);
  const prefixArgs = Array.isArray(binaryPrefix) ? binaryPrefix.filter(item => typeof item === 'string' && item && !item.includes('\0')) : [];
  const controllers = new Map();
  const persist = task => { store.put('task', task); return task; };

  const emptyController = () => ({
    done: false, stdout: [], stderr: [], outputBytes: 0, stdoutBytes: 0, stderrBytes: 0,
    truncated: false, timedOut: false, startedAt: Date.now(), timer: null, child: null
  });

  const addOutput = (controller, target, chunk, label) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    controller[`${label}Bytes`] += bytes.length;
    const remaining = Math.max(0, maxOutputBytes - controller.outputBytes);
    if (remaining) target.push(bytes.subarray(0, remaining));
    if (bytes.length > remaining) controller.truncated = true;
    controller.outputBytes += Math.min(bytes.length, remaining);
  };

  function artifact(task, controller, parsed, extra = {}, runWorkspace = workspace) {
    const error = sanitizeText(parsed.error, 2000);
    // 会话 id 与工作目录只在项目对话（显式 workspace）中回传，普通 CLI 任务不暴露本地路径与会话。
    const projectScoped = Boolean(task?.cliInput?.workspace);
    return {
      executorId: id,
      summary: sanitizeText(parsed.summary, 6000),
      usage: sanitizeUsage(parsed.usage),
      error: error || undefined,
      artifacts: Array.isArray(parsed.artifacts)
        ? [...new Set(parsed.artifacts.map(item => safeArtifactPath(item, runWorkspace)).filter(Boolean))]
        : [],
      stats: safeStats(parsed.stats, parsed, controller),
      exitCode: Number.isInteger(extra.exitCode) ? extra.exitCode : null,
      signal: extra.signal || null,
      timedOut: controller.timedOut,
      truncated: controller.truncated,
      durationMs: Date.now() - controller.startedAt,
      ...(projectScoped && parsed.sessionId ? { sessionId: String(parsed.sessionId).slice(0, 200) } : {}),
      ...(projectScoped && runWorkspace ? { workspace: runWorkspace } : {}),
      ...(extra.cancelled ? { cancelled: true } : {}),
      ...(extra.interrupted ? { interrupted: true } : {})
    };
  }

  function finalize(task, controller, { code = null, signal = null, error } = {}) {
    if (controller.done) return task;
    controller.done = true;
    clearTimeout(controller.timer);
    controllers.delete(task.id);
    const stdout = Buffer.concat(controller.stdout).toString('utf8');
    const stderr = Buffer.concat(controller.stderr).toString('utf8');
    let parsed;
    try {
      parsed = parseOutput({ stdout, stderr, exitCode: code, signal, timedOut: controller.timedOut, spawnError: error });
    } catch {
      parsed = { summary: '', usage: {}, error: 'CLI 结构化输出解析失败', artifacts: [], stats: {} };
    }
    if (!parsed || typeof parsed !== 'object') parsed = { summary: '', usage: {}, error: 'CLI 结构化输出无效', artifacts: [], stats: {} };
    if (!parsed.error && controller.timedOut) parsed.error = 'CLI 执行超时';
    if (!parsed.error && error) parsed.error = `CLI 启动失败：${error.message}`;
    if (!parsed.error && code !== 0) parsed.error = `CLI 退出码 ${code ?? 'unknown'}`;
    const success = !controller.timedOut && !error && code === 0 && !parsed.error;
    task.status = success ? 'completed' : 'failed';
    task.endedAt = new Date().toISOString();
    task.updatedAt = task.endedAt;
    task.error = success ? undefined : sanitizeText(parsed.error, 2000) || 'CLI 执行失败';
    task.artifacts = { ...(task.artifacts || {}), cli: artifact(task, controller, parsed, { exitCode: code, signal }, task.workspace || workspace) };
    return persist(task);
  }

  function kill(child) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* Process may have exited already. */ }
    }
  }

  function launch(task, input, runWorkspace = workspace) {
    if (!binaryInfo.available) throw statusError(`${name} 未配置可用的可执行文件`, 503);
    task.executionStarted = true;
    task.startedAt = new Date().toISOString();
    task.updatedAt = task.startedAt;
    task.cliInput = { ...input };
    task.workspace = runWorkspace;
    persist(task);
    let args;
    try {
      args = buildArgs(input, runWorkspace);
      if (!Array.isArray(args) || !args.every(item => typeof item === 'string' && !item.includes('\0'))) throw new Error('CLI 参数模板无效');
    } catch (error) {
      return finalize(task, emptyController(), { error });
    }
    let child;
    try {
      child = spawnImpl(binaryInfo.executable, [...prefixArgs, ...args], {
        cwd: runWorkspace,
        env: cliEnvironment(environment),
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      return finalize(task, emptyController(), { error });
    }
    const controller = { ...emptyController(), child };
    controllers.set(task.id, controller);
    child.stdout?.on('data', chunk => addOutput(controller, controller.stdout, chunk, 'stdout'));
    child.stderr?.on('data', chunk => addOutput(controller, controller.stderr, chunk, 'stderr'));
    child.once('error', error => finalize(task, controller, { error }));
    child.once('close', (code, signal) => finalize(task, controller, { code, signal }));
    controller.timer = setTimeout(() => {
      if (controller.done) return;
      controller.timedOut = true;
      kill(child);
    }, timeoutMs);
    controller.timer.unref?.();
    return task;
  }

  return {
    id,
    name,
    kind,
    available: binaryInfo.available,
    requiresDataset: false,
    capabilities,
    validateInput,
    start(ticket, assignment, input) {
      if (!binaryInfo.available) throw statusError(`${name} 未配置可用的可执行文件`, 503);
      const normalized = validateInput(input?.executorInput ?? input);
      const runWorkspace = normalized.workspace ? path.resolve(normalized.workspace) : workspace;
      try {
        if (!statSync(runWorkspace).isDirectory()) throw new Error('not a directory');
      } catch {
        throw statusError('项目工作目录不存在或不可访问', 400);
      }
      const prior = store.get('task', assignment.id);
      if (prior) return prior;
      if (controllers.size >= maxConcurrent) throw statusError(`${name} 并发执行已达上限`, 429);
      const stamp = new Date().toISOString();
      const task = {
        id: assignment.id,
        workAssignmentId: assignment.id,
        executorId: id,
        goal: ticket.command,
        status: 'running',
        createdAt: stamp,
        updatedAt: stamp,
        artifacts: {}
      };
      persist(task);
      return launch(task, normalized, runWorkspace);
    },
    get: taskId => taskId && store.get('task', taskId),
    resume(task) {
      if (!task || task.status !== 'running' || controllers.has(task.id)) return;
      if (task.executionStarted) {
        task.status = 'failed';
        task.error = '服务已重启，CLI 任务已中断';
        task.endedAt = new Date().toISOString();
        task.updatedAt = task.endedAt;
        task.artifacts = {
          ...(task.artifacts || {}),
          cli: artifact(task, emptyController(), {
            summary: '', usage: {}, error: task.error, artifacts: [], stats: {}
          }, { interrupted: true })
        };
        persist(task);
        return;
      }
      const cliInput = task.cliInput || { prompt: '', maxTurns: 1 };
      const runWorkspace = cliInput.workspace ? path.resolve(cliInput.workspace) : workspace;
      launch(task, cliInput, runWorkspace);
    },
    stop(task) {
      if (!task) return;
      const controller = controllers.get(task.id);
      if (controller) {
        controller.done = true;
        clearTimeout(controller.timer);
        kill(controller.child);
        controllers.delete(task.id);
      }
      task.status = 'cancelled';
      task.endedAt = new Date().toISOString();
      task.updatedAt = task.endedAt;
      task.error = 'CLI 任务已停止';
      task.artifacts = {
        ...(task.artifacts || {}),
        cli: artifact(task, controller || emptyController(), {
          summary: '', usage: {}, error: task.error, artifacts: [], stats: {}
        }, { cancelled: true })
      };
      persist(task);
    },
    close() {
      for (const [taskId, controller] of controllers) {
        controller.done = true;
        clearTimeout(controller.timer);
        kill(controller.child);
        controllers.delete(taskId);
      }
    }
  };
}

export const cliBinaryStatus = binary => executableStatus(binary);
