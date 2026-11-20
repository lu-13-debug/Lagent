import process from 'node:process';
import { createCliExecutor, normalizeCliInput, sanitizeText } from './cli.js';
import { resolveLocalCommand } from '../providers.js';

const MAX_SUMMARY = 6000;
const MAX_ERROR = 4000;
const promptPlaceholder = '{prompt}';

function customArgs(id) {
  const key = `LAGENT_CLI_ARGS_${id.toUpperCase().replace(/-/g, '_')}`;
  const raw = process.env[key];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 各家 CLI 至少都要一个「只读问答」参数，写入时再追加它们自己的自动批准开关。
 * 允许用 LAGENT_CLI_ARGS_<ID>（JSON 数组，`{prompt}` 代表提示词）覆盖默认模板：
 * 这些国产 CLI 的参数并未完全统一，改参数不该等发版。
 */
function argTemplate(id, input, readArgs, writeArgs) {
  const custom = customArgs(id);
  const template = custom || (input.write === true ? [...readArgs, ...writeArgs] : readArgs);
  return template.map(item => item.replaceAll(promptPlaceholder, input.prompt));
}

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
  },
  // 国产 Agent：这批 CLI 多数沿用 Claude Code 的非交互约定（-p 后跟提示词、stdout 出结论），
  // 所以按同一套参数接入；各家若改过参数，可用 LAGENT_CLI_ARGS_<ID> 覆盖（见 argTemplate）。
  codebuddy: {
    id: 'codebuddy',
    name: 'CodeBuddy Code（腾讯）',
    commands: ['codebuddy', 'codebuddy-code'],
    capability: '-p',
    capabilities: ['cli', 'codebuddy', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      return argTemplate('codebuddy', input, ['-p', promptPlaceholder], ['--dangerously-skip-permissions']);
    }
  },
  qoder: {
    id: 'qoder',
    name: 'Qoder CLI（阿里）',
    commands: ['qoder', 'qodercli'],
    capability: '-p',
    capabilities: ['cli', 'qoder', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      return argTemplate('qoder', input, ['-p', promptPlaceholder], ['--dangerously-skip-permissions']);
    }
  },
  iflow: {
    id: 'iflow',
    name: 'iFlow CLI（心流）',
    commands: ['iflow'],
    capability: '-p',
    capabilities: ['cli', 'iflow', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      return argTemplate('iflow', input, ['-p', promptPlaceholder], ['--dangerously-skip-permissions']);
    }
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi CLI（月之暗面）',
    commands: ['kimi'],
    capability: '--print',
    capabilities: ['cli', 'kimi', 'text-output', 'read-only', 'project-write'],
    buildArgs(input) {
      return argTemplate('kimi', input, ['--print', promptPlaceholder], ['--yes']);
    }
  }
});

export const LOCAL_AGENT_IDS = Object.freeze(Object.keys(LOCAL_AGENT_PROFILES));

// CLI 自带 provider 配置时常常要某个 API Key 环境变量。我们默认不把密钥透传给
// 子进程（见 cli.js 的 CLI_ENV_PASSTHROUGH），于是它只会报一句「Missing environment
// variable: X」。这里补一句人话，否则用户看不懂该去改什么。
function envHint(text) {
  const match = /Missing environment variable:?\s*`?([A-Z][A-Z0-9_]*)`?/i.exec(String(text || ''));
  if (!match) return '';
  const name = match[1].toUpperCase();
  return `（${name} 没有被传给 CLI：启动服务前先在环境里设置它，或用 LAGENT_CLI_ENV_PASSTHROUGH=${name} 启动一次。）`;
}

function errorText(stdout, stderr, exitCode) {
  // 只有非零退出才算失败：DeepSeek Harness 这类 CLI 会把推理过程写到 stderr，
  // stdout 里才是最终答复，按 stderr 判失败会把成功当成失败。
  if (exitCode === 0) return '';
  const stderrText = typeof stderr === 'string' ? stderr.trim() : '';
  if (stderrText) return sanitizeText(stderrText + envHint(stderrText), MAX_ERROR);
  const stdoutText = typeof stdout === 'string' ? stdout.trim() : '';
  const text = stdoutText.slice(-MAX_ERROR) || `CLI 退出码 ${exitCode}`;
  return sanitizeText(text + envHint(text), MAX_ERROR);
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
  timeoutMs = Number(process.env.LAGENT_CLI_TIMEOUT_MS) || 3_600_000,
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
    validateInput: input => normalizeCliInput(input, { defaultMaxTurns: 8, maxTurns: 120, maxPromptBytes: 64 * 1024 }),
    buildArgs,
    parseOutput: parseTextOutput,
    // 这些 CLI 只输出纯文本结论，没有结构化事件；把 stdout 当成它正在写的东西记录下来，
    // 面板里才看得见「它在动」，而不是一直停在「Agent 正在思考…」。
    streamText: true,
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
