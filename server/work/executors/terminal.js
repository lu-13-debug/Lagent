import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { workError } from '../domain.js';

const PROGRAMS = new Set(['git', 'npm', 'ls', 'pwd']);
const META = /[;&|><`$\r\n\0]/;
const WINDOWS_VARIABLE = /%[A-Za-z_][A-Za-z0-9_]*%/;
const SAFE_LS_FLAGS = new Set(['-a', '-A', '-l', '-la', '-al', '--all', '--almost-all', '--color=never']);
const SAFE_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'cat-file', 'describe', 'shortlog', '--version']);
const UNSAFE_GIT_OPTIONS = /^(?:-C|-c|-O|--git-dir(?:=|$)|--work-tree(?:=|$)|--output(?:=|$)|--no-index(?:=|$)|--ext-diff(?:=|$)|--textconv(?:=|$)|--exec-path(?:=|$)|--open-files-in-pager(?:=|$)|--upload-pack(?:=|$)|--receive-pack(?:=|$))/;
const SAFE_NPM_COMMANDS = new Set(['--version', '--versions', 'ls', 'list']);
const SAFE_NPM_FLAGS = new Set(['--json', '--long', '--parseable', '--all', '--prod', '--development', '--omit=dev', '--depth=0', '--depth=1']);

const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.length > 500) return false;
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || value.startsWith('~')) return false;
  const normalized = value.replaceAll('\\', '/');
  return !normalized.split('/').includes('..');
}

function validateLs(args) {
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (!SAFE_LS_FLAGS.has(arg)) throw statusError(`ls 参数不受支持：${arg}`);
    } else if (!safeRelative(arg)) {
      throw statusError('ls 路径必须位于当前工作区');
    }
  }
}

function validateGit(args) {
  // 用户的项目一般在自己目录下的子目录里，不允许 -C 就永远只有一个「不是 git 仓库」的结果。
  // 只放行工作区内的相对路径：绝对路径和 .. 一律拒绝，避免跳出工作区去读别的仓库。
  let start = 0;
  if (args[0] === '-C') {
    if (!safeRelative(args[1])) throw statusError('git -C 只接受工作区内的相对路径');
    start = 2;
  }
  const command = args[start];
  if (!command || !SAFE_GIT_COMMANDS.has(command)) throw statusError('git 子命令不在只读白名单内');
  for (const arg of args.slice(start + 1)) {
    if (UNSAFE_GIT_OPTIONS.test(arg)) throw statusError(`git 参数不受支持：${arg}`);
    if (arg.startsWith('--no-pager=')) throw statusError('git 参数不受支持');
  }
}

function validateNpm(args) {
  const command = args[0];
  if (!command || !SAFE_NPM_COMMANDS.has(command)) throw statusError('npm 子命令不在只读白名单内');
  for (const arg of args.slice(1)) {
    if (arg.startsWith('-')) {
      if (!SAFE_NPM_FLAGS.has(arg)) throw statusError(`npm 参数不受支持：${arg}`);
    } else if (!safeRelative(arg)) {
      throw statusError('npm 路径参数必须位于当前工作区');
    }
  }
}

export function validateTerminalInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('executorInput 必须为结构化对象');
  const { program, args } = input;
  if (typeof program !== 'string' || !PROGRAMS.has(program)) throw statusError('terminal program 仅支持 git、npm、ls、pwd');
  if (!Array.isArray(args) || args.length > 32) throw statusError('terminal args 必须是最多 32 项的字符串数组');
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.length > 1000) throw statusError('terminal 参数必须是非空字符串且不超过 1000 字');
    if (META.test(arg) || WINDOWS_VARIABLE.test(arg)) throw statusError('terminal 参数不允许 shell 元字符、重定向或变量展开');
  }
  if (program === 'pwd' && args.length) throw statusError('pwd 不接受参数');
  if (program === 'ls') validateLs(args);
  if (program === 'git') validateGit(args);
  if (program === 'npm') validateNpm(args);
  const normalized = { program, args: [...args] };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 16 * 1024) throw statusError('terminal 输入过大');
  return normalized;
}

function sanitizedPath(value, cwd) {
  const fallback = path.dirname(process.execPath);
  const entries = String(value || '').split(path.delimiter).filter(Boolean).filter(entry => {
    if (!path.isAbsolute(entry)) return false;
    return path.resolve(entry) !== path.resolve(cwd);
  });
  return [...new Set(entries.length ? entries : [fallback])].join(path.delimiter);
}

function safeEnvironment(source, cwd) {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'TZ', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of allowed) if (typeof source?.[key] === 'string') env[key] = source[key];
  if (env.PATH) env.PATH = sanitizedPath(env.PATH, cwd);
  if (env.Path) env.Path = sanitizedPath(env.Path, cwd);
  env.GIT_PAGER = 'cat'; env.PAGER = 'cat'; env.GIT_TERMINAL_PROMPT = '0';
  env.npm_config_yes = 'false'; env.NO_COLOR = '1'; env.CI = '1';
  return env;
}

function findExecutable(program, environment, cwd) {
  const pathValue = environment.PATH || environment.Path || '';
  const extensions = process.platform === 'win32'
    ? String(environment.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${program}${extension}`);
      if (!existsSync(candidate)) continue;
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
        if (path.resolve(path.dirname(candidate)) === path.resolve(cwd)) continue;
        return candidate;
      } catch { /* Keep looking for a trusted executable. */ }
    }
  }
  throw statusError(`找不到可信的 ${program} 可执行文件`, 503);
}

function defaultResolveProgram(program, environment, cwd) {
  if (program === 'git') return findExecutable('git', environment, cwd);
  if (program === 'npm') {
    const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(cli)) return { executable: process.execPath, prefix: [cli] };
    throw statusError('当前运行时无法在不启用 shell 的情况下启动 npm', 503);
  }
  return process.execPath;
}

function lsScript(args) {
  const options = args.filter(arg => arg.startsWith('-'));
  const targets = args.filter(arg => !arg.startsWith('-'));
  return `const fs=require('node:fs');const paths=${JSON.stringify(targets.length ? targets : ['.'])};const all=${options.includes('-a')||options.includes('--all')};const long=${options.includes('-l')||options.includes('-la')||options.includes('-al')};for(const target of paths){let entries;try{entries=fs.readdirSync(target,{withFileTypes:true});}catch(e){console.error(e.message);process.exitCode=1;continue}entries=entries.filter(e=>all||!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name));if(paths.length>1)console.log(target+':');for(const entry of entries){if(long){const stat=fs.lstatSync(require('node:path').join(target,entry.name));console.log((entry.isDirectory()?'d':'-')+String(stat.size).padStart(8)+' '+entry.name)}else console.log(entry.name)}}`;
}

const executionFor = (command, resolveProgram, environment, cwd) => {
  if (command.program === 'pwd') return { executable: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'] };
  if (command.program === 'ls') return { executable: process.execPath, args: ['-e', lsScript(command.args)] };
  const resolved = resolveProgram(command.program, environment, cwd);
  if (typeof resolved === 'string') return { executable: resolved, args: command.args };
  return { executable: resolved.executable, args: [...(resolved.prefix || []), ...command.args] };
};

export function terminalExecutor({
  store,
  cwd,
  timeoutMs = 60_000,
  maxOutputBytes = 200 * 1024,
  maxConcurrent = 2,
  spawnImpl = spawn,
  resolveProgram = defaultResolveProgram,
  environment = process.env
}) {
  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError('terminal 执行器需要 store 和 cwd');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs 必须为正数');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes 必须为正整数');
  const workspace = path.resolve(cwd);
  const controllers = new Map();

  const terminalArtifact = (task, extra = {}) => ({
    program: task.terminalInput?.program,
    args: task.terminalInput?.args || [],
    ...(task._terminalOutput || {}),
    ...extra
  });

  const persist = task => { store.put('task', task); return task; };

  const addOutput = (controller, target, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const remaining = Math.max(0, maxOutputBytes - controller.outputBytes);
    if (remaining) target.push(bytes.subarray(0, remaining));
    if (bytes.length > remaining) controller.truncated = true;
    controller.outputBytes += Math.min(bytes.length, remaining);
  };

  function finalize(task, controller, { code = null, signal = null, error } = {}) {
    if (controller.done) return task;
    controller.done = true;
    clearTimeout(controller.timer);
    controllers.delete(task.id);
    const finishedAt = Date.now();
    const output = {
      stdout: Buffer.concat(controller.stdout).toString('utf8'),
      stderr: Buffer.concat(controller.stderr).toString('utf8'),
      truncated: controller.truncated,
      exitCode: Number.isInteger(code) ? code : null,
      signal: signal || null,
      timedOut: controller.timedOut,
      durationMs: finishedAt - controller.startedAt
    };
    const success = !controller.timedOut && !error && code === 0;
    task.status = success ? 'completed' : 'failed';
    task.endedAt = new Date(finishedAt).toISOString();
    task.updatedAt = task.endedAt;
    task.error = success ? undefined : controller.timedOut ? '终端命令执行超时' : error ? `终端命令启动失败：${error.message}` : `终端命令退出码 ${code ?? 'unknown'}`;
    task._terminalOutput = output;
    task.artifacts = { ...(task.artifacts || {}), terminal: terminalArtifact(task) };
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

  function launch(task, command) {
    task.executionStarted = true;
    task.startedAt = new Date().toISOString();
    task.updatedAt = task.startedAt;
    task.terminalInput = command;
    persist(task);
    const env = safeEnvironment(environment, workspace);
    let execution;
    try { execution = executionFor(command, resolveProgram, env, workspace); }
    catch (error) { return finalize(task, { done:false, stdout:[], stderr:[], outputBytes:0, truncated:false, timedOut:false, startedAt:Date.now(), timer:null }, { error }); }
    let child;
    try {
      child = spawnImpl(execution.executable, execution.args, {
        cwd: workspace,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      return finalize(task, { done:false, stdout:[], stderr:[], outputBytes:0, truncated:false, timedOut:false, startedAt:Date.now(), timer:null }, { error });
    }
    const controller = { child, stdout: [], stderr: [], outputBytes: 0, truncated: false, timedOut: false, done: false, startedAt: Date.now(), timer: null };
    controllers.set(task.id, controller);
    child.stdout?.on('data', chunk => addOutput(controller, controller.stdout, chunk));
    child.stderr?.on('data', chunk => addOutput(controller, controller.stderr, chunk));
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
    id: 'terminal', name: '受控终端', kind: 'terminal', available: true, requiresDataset: false,
    capabilities: ['terminal', 'controlled-command', 'git', 'npm', 'ls', 'pwd', 'human-approval'],
    validateInput: validateTerminalInput,
    start(ticket, assignment, input) {
      const command = validateTerminalInput(input?.executorInput ?? input);
      const prior = store.get('task', assignment.id);
      if (prior) return prior;
      if (controllers.size >= maxConcurrent) throw statusError('终端并发执行已达上限', 429);
      const stamp = new Date().toISOString();
      const task = { id: assignment.id, workAssignmentId: assignment.id, executorId: 'terminal', goal: ticket.command, status: 'running', createdAt: stamp, updatedAt: stamp, artifacts: {} };
      persist(task);
      return launch(task, command);
    },
    get: id => id && store.get('task', id),
    resume(task) {
      if (!task || task.status !== 'running' || controllers.has(task.id)) return;
      if (task.executionStarted) {
        task.status = 'failed'; task.error = '服务已重启，终端命令已中断'; task.endedAt = new Date().toISOString();
        task.artifacts = { ...(task.artifacts || {}), terminal: terminalArtifact(task, { interrupted: true }) };
        persist(task);
        return;
      }
      launch(task, task.terminalInput || {});
    },
    stop(task) {
      if (!task) return;
      const controller = controllers.get(task.id);
      if (controller) {
        controller.done = true; clearTimeout(controller.timer); kill(controller.child); controllers.delete(task.id);
      }
      task.status = 'cancelled'; task.endedAt = new Date().toISOString(); task.updatedAt = task.endedAt;
      task.artifacts = { ...(task.artifacts || {}), terminal: terminalArtifact(task, { cancelled: true }) };
      persist(task);
    },
    close() {
      for (const [id, controller] of controllers) {
        controller.done = true; clearTimeout(controller.timer); kill(controller.child); controllers.delete(id);
      }
    }
  };
}