import { createCliExecutor, normalizeCliInput, parseJsonLines, readOnlyPrompt, sanitizeText, writablePrompt } from './cli.js';
import { findClaudeCodeCli } from './discover.js';

const MAX_SUMMARY = 6000;

export function parseClaudeOutput({ stdout, stderr, exitCode }) {
  const { events, malformed } = parseJsonLines(stdout);
  const summaries = [];
  const errors = [];
  const stats = { events: events.length, malformedLines: malformed, assistantMessages: 0, resultMessages: 0, tools: 0 };
  let usage = {};
  let resultSummary = '';
  let sessionId = '';

  for (const event of events) {
    if (typeof event.session_id === 'string' && event.session_id) sessionId = event.session_id;
    if (event.type === 'system' && typeof event.session_id === 'string') sessionId = event.session_id;
    if (event.type === 'assistant') {
      stats.assistantMessages += 1;
      const content = Array.isArray(event.message?.content) ? event.message.content : Array.isArray(event.content) ? event.content : [];
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) summaries.push(block.text.trim());
        if (block?.type === 'tool_use') stats.tools += 1;
      }
      if (event.message?.usage) usage = event.message.usage;
    }
    if (event.type === 'result') {
      stats.resultMessages += 1;
      if (event.usage) usage = { ...event.usage };
      if (Number.isSafeInteger(event.num_turns) && event.num_turns >= 0) usage.num_turns = event.num_turns;
      if (Number.isSafeInteger(event.duration_ms) && event.duration_ms >= 0) usage.duration_ms = event.duration_ms;
      if (typeof event.result === 'string' && event.result.trim()) resultSummary = event.result.trim();
      if (event.is_error || event.subtype === 'error' || event.subtype === 'error_max_turns') {
        errors.push(sanitizeText(event.error || event.result || `Claude Code ${event.subtype || 'error'}`, 2000));
      }
    }
    if (event.type === 'error') errors.push(sanitizeText(event.error?.message || event.message || event.error, 2000));
  }

  if (!errors.length && exitCode !== 0) errors.push(sanitizeText(stderr, 2000));
  return {
    summary: sanitizeText(resultSummary || summaries.at(-1) || '', MAX_SUMMARY),
    usage,
    error: errors.find(Boolean) || '',
    artifacts: [],
    stats,
    ...(sessionId ? { sessionId } : {})
  };
}

// Claude Code 的 stream-json 每轮吐一条 assistant：thinking 块是它的思考，tool_use 是它要做什么。
// 逐条映射成 activity，界面就能边跑边看，而不是等进程退出才有东西。
const TOOL_HINT = { Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path', Glob: 'pattern', Grep: 'pattern', WebFetch: 'url', Task: 'description' };

export function claudeStreamActivity(event) {
  if (event?.type !== 'assistant') return null;
  const content = Array.isArray(event.message?.content) ? event.message.content : Array.isArray(event.content) ? event.content : [];
  const entries = [];
  for (const block of content) {
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      entries.push({ kind: 'thought', text: block.thinking });
      continue;
    }
    if (block?.type === 'tool_use') {
      const hint = TOOL_HINT[block.name] || '';
      const value = hint && block.input && typeof block.input[hint] === 'string' ? block.input[hint] : '';
      entries.push({ kind: 'tool', text: `${block.name || '工具'}${value ? ` · ${String(value).slice(0, 120)}` : ''}` });
      continue;
    }
    // 正文留给最终摘要，这里只留一句提示，避免把整段答案也当成「过程」。
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() && block.text.trim().length <= 300) {
      entries.push({ kind: 'note', text: block.text.trim() });
    }
  }
  return entries.length ? entries : null;
}

export function claudeCodeExecutor({
  store,
  cwd,
  binary = process.env.LAGENT_CLAUDE_CLI,
  timeoutMs = Number(process.env.LAGENT_CLI_TIMEOUT_MS) || 1_800_000,
  maxOutputBytes = 8 * 1024 * 1024,
  spawnImpl,
  environment = process.env
}) {
  const validateInput = input => normalizeCliInput(input, { defaultMaxTurns: 12, maxTurns: 60 });
  const detected = binary ? { binary, prefix: [] } : findClaudeCodeCli(environment);
  const resolvedBinary = binary || detected?.binary;
  const binaryPrefix = detected?.prefix || [];
  const buildArgs = (input, workspace) => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      String(input.maxTurns)
    ];
    if (input.resume) args.push('--resume', input.resume);
    if (input.model) args.push('--model', input.model);
    // Claude Code 原生支持 --effort（low/medium/high/xhigh/max）。
    if (input.effort && input.effort !== 'default') args.push('--effort', input.effort);
    args.push('--permission-mode', input.write === true ? 'acceptEdits' : 'plan');
    args.push(input.write === true ? writablePrompt(input) : readOnlyPrompt(input));
    return args;
  };
  const executor = createCliExecutor({
    id: 'claude-code',
    name: 'Claude Code CLI',
    kind: 'cli',
    store,
    cwd,
    binary: resolvedBinary,
    binaryPrefix,
    timeoutMs,
    maxOutputBytes,
    spawnImpl,
    environment,
    validateInput,
    buildArgs,
    parseOutput: parseClaudeOutput,
    streamActivity: claudeStreamActivity,
    capabilities: ['cli', 'claude-code', 'read-only', 'stream-json', 'human-approval', 'project-write', 'resume-session']
  });
  executor.buildArgs = buildArgs;
  executor.parseOutput = parseClaudeOutput;
  return executor;
}
