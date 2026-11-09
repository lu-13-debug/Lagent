import process from 'node:process';
import { createCliExecutor, normalizeCliInput, sanitizeText } from './cli.js';
import { resolveLocalCommand } from '../providers.js';

const MAX_SUMMARY = 6000;
const MAX_ERROR = 4000;

/**
 * 本机 Agent 适配器：把「探测到的命令行 Agent」变成可派活的执行器。
 *
 * 这些 CLI 的机器接口不像 codex/claude 那样统一（有的 NDJSON、有的纯文本），
 * 所以这里只依赖它们在非交互模式下打印的最终答复：stdout 归为结论，
 * 非零退出时用 stderr 报错。权限差异通过各 CLI 自己的开关表达：
 * 只在 write 模式下加自动批准参数，只读模式一律不自动批准。
 */
export const LOCAL_AGENT_PROFILES = Object.freeze({
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    commands: ['opencode'],
    capability: 'run --dir',
    capabilities: ['cli', 'opencode', 'text-output', 'read-only', 'project-write', 'multi-provider'],
    buildArgs(input, workspace) {
      const args = ['run'];
      if (input.write === true) args.push('--auto');
      args.push('--dir', workspace, input.prompt);
      return args;
    }
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    commands: ['gemini'],
    capability: '-p',
    capabilities: ['cli', 'gemini', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      const args = ['-p', input.prompt, '--output-format', 'text'];
      if (input.write === true) args.push('--yolo');
      return args;
    }
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen Code',
    commands: ['qwen'],
    capability: '-p',
    capabilities: ['cli', 'qwen', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      const args = ['-p', input.prompt, '--output-format', 'text'];
      if (input.write === true) args.push('--yolo');
      return args;
    }
  },
  'cursor-agent': {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    commands: ['cursor-agent'],
    capability: '-p',
    capabilities: ['cli', 'cursor', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      const args = ['-p', input.prompt, '--output-format', 'text'];
      if (input.write === true) args.push('--force');
      return args;
    }
  },
  dsh: {
    id: 'dsh',
    name: 'DeepSeek Harness CLI',
    commands: ['dsh'],
    capability: '--profile headless',
    capabilities: ['cli', 'dsh', 'text-output', 'headless'],
    buildArgs(input) {
      return ['--profile', 'headless', input.prompt];
    }
  }
});

export const LOCAL_AGENT_IDS = Object.freeze(Object.keys(LOCAL_AGENT_PROFILES));

function errorText(stdout, stderr, exitCode) {
  // 只有非零退出才算失败：DeepSeek Harness 这类 CLI 会把推理过程写到 stderr，
  // stdout 里才是最终答复，按 stderr 判失败会把成功当成失败。
  if (exitCode === 0) return '';
  const stderrText = typeof stderr === 'string' ? stderr.trim() : '';
  if (stderrText) return sanitizeText(stderrText, MAX_ERROR);
  const stdoutText = typeof stdout === 'string' ? stdout.trim() : '';
  return sanitizeText(stdoutText.slice(-MAX_ERROR) || `CLI 退出码 ${exitCode}`, MAX_ERROR);
}

/**
 * 纯文本 Agent 的输出就是结论本身。若它以非零码退出，说明这段文本大概率是
 * 报错信息（例如 OpenCode 的 APIError），同时计入 error 与 summary，方便界面直接展示。
 */
export function parseTextOutput({ stdout, stderr, exitCode }) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  const error = errorText(text, stderr, exitCode);
  return {
    summary: sanitizeText(text, MAX_SUMMARY),
    usage: {},
    error,
    artifacts: [],
    stats: {
      events: 0,
      stdoutBytes: Buffer.byteLength(stdout || ''),
      stderrBytes: Buffer.byteLength(stderr || '')
    }
  };
}

function resolveProfileBinary(profile, environment) {
  for (const command of profile.commands) {
    const resolved = resolveLocalCommand(command, environment);
    if (resolved) return { binary: resolved.command, prefix: resolved.args || [] };
  }
  return null;
}

export function localAgentExecutor(profileName, {
  store,
  cwd,
  binary,
  timeoutMs = 900_000,
  maxOutputBytes = 8 * 1024 * 1024,
  spawnImpl,
  environment = process.env
}) {
  const profile = LOCAL_AGENT_PROFILES[profileName];
  if (!profile) throw new TypeError(`未知的本机 Agent 档位：${profileName}`);
  const detected = binary ? { binary, prefix: [] } : resolveProfileBinary(profile, environment);
  const buildArgs = (input, workspace) => profile.buildArgs(input, workspace);
  const executor = createCliExecutor({
    id: profile.id,
    name: profile.name,
    kind: 'cli',
    store,
    cwd,
    binary: detected?.binary,
    binaryPrefix: detected?.prefix || [],
    timeoutMs,
    maxOutputBytes,
    spawnImpl,
    environment,
    validateInput: input => normalizeCliInput(input, { defaultMaxTurns: 8, maxTurns: 60 }),
    buildArgs,
    parseOutput: parseTextOutput,
    capabilities: profile.capabilities
  });
  executor.buildArgs = buildArgs;
  executor.parseOutput = parseTextOutput;
  executor.profile = profile.id;
  return executor;
}

export function localAgentExecutors(options) {
  return LOCAL_AGENT_IDS.map(id => localAgentExecutor(id, options));
}
