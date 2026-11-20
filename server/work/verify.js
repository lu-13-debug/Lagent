import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { workError } from './domain.js';
import { redactSecrets } from './risk.js';

const SAFE_NPM_SCRIPTS = new Set(['test', 'build', 'lint', 'typecheck', 'check', 'coverage']);
const SAFE_PROGRAMS = new Set(['npm', 'node', 'pytest', 'python', 'python3', 'go', 'cargo', 'dotnet', 'git']);
const META = /[;&|><`$\r\n\0]/;
const WINDOWS_VARIABLE = /%[A-Za-z_][A-Za-z0-9_]*%/;
const MAX_OUTPUT = 4000;

function splitCommand(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 500) throw workError('验收命令须为 1–500 字');
  if (META.test(command) || WINDOWS_VARIABLE.test(command)) throw workError('验收命令不允许 shell 元字符、重定向或变量展开');
  const parts = [];
  let current = '';
  let quote = '';
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += char;
    }
  }
  if (quote) throw workError('验收命令的引号未闭合');
  if (current) parts.push(current);
  return parts;
}

function allowed(program, args) {
  if (!SAFE_PROGRAMS.has(program)) return false;
  if (program === 'npm') {
    if (args[0] === '--version') return true;
    if (args[0] === 'test') return true;
    return args[0] === 'run' && SAFE_NPM_SCRIPTS.has(args[1]);
  }
  if (program === 'node') return args[0] === '--version' || args[0] === '--test';
  if (program === 'pytest') return true;
  if (program === 'python' || program === 'python3') return args[0] === '-m' && args[1] === 'pytest';
  if (program === 'go') return args[0] === 'test';
  if (program === 'cargo') return args[0] === 'test';
  if (program === 'dotnet') return args[0] === 'test';
  if (program === 'git') return args[0] === 'diff' && args.includes('--check');
  return false;
}

export function normalizeVerify(input) {
  if (input === undefined || input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('verify 必须是对象');
  const unknown = Object.keys(input).filter(key => !['command', 'cwd', 'expect', 'timeoutMs', 'program', 'args'].includes(key));
  if (unknown.length) throw workError(`verify 包含未知字段：${unknown.join('、')}`);
  const parts = splitCommand(input.command);
  if (!parts.length) throw workError('验收命令不能为空');
  const [program, ...args] = parts;
  if (!allowed(program, args)) throw workError(`验收命令不在白名单内：${program}`);
  for (const arg of args) {
    if (path.isAbsolute(arg) || path.win32.isAbsolute(arg) || arg.startsWith('~') || arg.split(/[\\/]/).includes('..')) throw workError('验收命令不能引用项目外的绝对路径或 ..');
  }
  const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : '.';
  if (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd) || cwd.startsWith('~')) throw workError('verify.cwd 必须是项目内的相对路径');
  if (cwd.split(/[\\/]/).includes('..')) throw workError('verify.cwd 不能跳出项目目录');
  const expect = input.expect === undefined ? 'exit=0' : String(input.expect).trim();
  if (!/^(?:exit=0|contains:.{1,200})$/.test(expect)) throw workError('verify.expect 仅支持 exit=0 或 contains:<文本>');
  const timeoutMs = input.timeoutMs === undefined ? 120000 : input.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw workError('verify.timeoutMs 须为 1000–600000 的整数');
  return { command: input.command.trim(), program, args, cwd, expect, timeoutMs };
}

function inside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(base, target || '.');
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return false;
  // 跟随已存在祖先的符号链接：项目内指向外部的链接不能当工作目录。
  let baseReal;
  try { baseReal = realpathSync(base); } catch { baseReal = base; }
  let probe = resolved;
  while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  if (!existsSync(probe)) return false;
  let probeReal;
  try { probeReal = realpathSync(probe); } catch { return false; }
  const real = path.resolve(probeReal, path.relative(probe, resolved));
  return real === baseReal || real.startsWith(baseReal + path.sep);
}

function tail(value) {
  const text = redactSecrets(String(value || ''));
  return text.length > MAX_OUTPUT ? `…${text.slice(-MAX_OUTPUT)}` : text;
}

// cmd.exe 按空格重新分词；带空格的参数必须重新加引号，否则会拆成多个参数。
const quoteWindowsArg = value => (/[\s"]/.test(value) ? `"${value}"` : value);

function run(program, args, options) {
  return new Promise(resolve => {
    const started = Date.now();
    // Windows 上只有 npm 是 .cmd，需要经 ComSpec；其它都是 exe，直接 execFile 才能
    // 保留参数边界（经 cmd 重新拼接会把带空格的参数拆开）。
    const viaCmd = process.platform === 'win32' && program === 'npm';
    const file = viaCmd ? (process.env.ComSpec || 'cmd.exe') : program;
    const argv = viaCmd ? ['/d', '/s', '/c', `npm ${args.map(quoteWindowsArg).join(' ')}`.trim()] : args;
    execFile(file, argv, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: (() => { const env = { ...process.env, CI: process.env.CI || '1' }; delete env.NODE_TEST_CONTEXT; return env; })()
    }, (error, stdout, stderr) => resolve({
      exitCode: Number.isInteger(error?.code) ? error.code : error ? 1 : 0,
      signal: typeof error?.signal === 'string' ? error.signal : null,
      stdout: tail(stdout),
      stderr: tail(stderr),
      durationMs: Date.now() - started
    }));
  });
}

/**
 * 在 Lagent 侧执行验收命令，不把“跑过了”交给执行器自证。
 * 只允许测试/构建/静态检查类命令；cwd 必须落在项目目录内。
 */
export async function runVerify({ verify, projectPath, now = () => new Date().toISOString() } = {}) {
  const parsed = normalizeVerify(verify);
  if (!parsed) throw workError('该任务没有配置验收命令');
  if (typeof projectPath !== 'string' || !projectPath.trim()) throw workError('该任务没有可验证的项目目录');
  if (!inside(projectPath, parsed.cwd)) throw workError('verify.cwd 必须位于项目目录内');
  const cwd = path.resolve(projectPath, parsed.cwd);
  const result = await run(parsed.program, parsed.args, { cwd, timeoutMs: parsed.timeoutMs });
  const combined = `${result.stdout}\n${result.stderr}`;
  const passed = parsed.expect === 'exit=0'
    ? result.exitCode === 0
    : combined.includes(parsed.expect.slice('contains:'.length));
  return {
    status: passed ? 'passed' : 'failed',
    command: parsed.command,
    cwd,
    expect: parsed.expect,
    exitCode: result.exitCode,
    signal: result.signal,
    output: tail(combined),
    durationMs: result.durationMs,
    at: now()
  };
}
