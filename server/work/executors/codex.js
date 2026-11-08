import {
  createCliExecutor,
  normalizeCliInput,
  parseJsonLines,
  readOnlyPrompt,
  safeArtifactPath,
  sanitizeText,
  writablePrompt
} from './cli.js';
import { findCodexBinary } from './discover.js';

const MAX_SUMMARY = 6000;

const eventError = event => {
  if (event?.type === 'error') return event.message || event.error?.message || event.error;
  if (['turn.failed', 'thread.failed', 'error'].includes(event?.type)) return event.error?.message || event.message || event.error;
  if (event?.item?.type === 'error') return event.item.message || event.item.error?.message;
  return '';
};

export function parseCodexOutput({ stdout, stderr, exitCode }) {
  const { events, malformed } = parseJsonLines(stdout);
  const summaries = [];
  const artifacts = [];
  const errors = [];
  const stats = { events: events.length, malformedLines: malformed, agentMessages: 0, commands: 0, fileChanges: 0, tools: 0 };
  let usage = {};
  let sessionId = '';

  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    if (typeof event.thread_id === 'string' && event.thread_id && !sessionId) sessionId = event.thread_id;
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
    const error = eventError(event);
    if (error) errors.push(sanitizeText(String(error), 2000));
    const item = event.item || event;
    if (event.type === 'item.completed' && item?.type === 'agent_message') {
      stats.agentMessages += 1;
      if (typeof item.text === 'string' && item.text.trim()) summaries.push(item.text.trim());
    }
    if (event.type === 'item.completed' && item?.type === 'command_execution') stats.commands += 1;
    if (event.type === 'item.completed' && item?.type === 'mcp_tool_call') stats.tools += 1;
    if (event.type === 'item.completed' && item?.type === 'file_change') {
      stats.fileChanges += 1;
      for (const change of Array.isArray(item.changes) ? item.changes : []) {
        if (change?.path) artifacts.push(change.path);
      }
      if (item.path) artifacts.push(item.path);
    }
  }

  if (!errors.length && exitCode !== 0) errors.push(sanitizeText(stderr, 2000));
  return {
    summary: sanitizeText(summaries.join('\n\n'), MAX_SUMMARY),
    usage,
    error: errors.find(Boolean) || '',
    artifacts,
    stats,
    ...(sessionId ? { sessionId } : {})
  };
}

export function codexExecutor({
  store,
  cwd,
  binary = process.env.DATAAGENT_CODEX_CLI,
  timeoutMs = 300_000,
  maxOutputBytes = 512 * 1024,
  spawnImpl,
  environment = process.env
}) {
  const validateInput = input => normalizeCliInput(input, { defaultMaxTurns: 5, maxTurns: 20 });
  const resolvedBinary = binary || findCodexBinary(environment);
  const buildArgs = (input, workspace) => {
    const write = input.write === true;
    const prompt = write ? writablePrompt(input) : readOnlyPrompt(input);
    if (input.resume) {
      return ['exec', 'resume', '--json', ...(write ? ['-c', 'sandbox_mode="workspace-write"'] : []), input.resume, prompt];
    }
    return ['exec', '--json', '--sandbox', write ? 'workspace-write' : 'read-only', '-C', workspace, prompt];
  };
  const executor = createCliExecutor({
    id: 'codex',
    name: 'Codex CLI',
    kind: 'cli',
    store,
    cwd,
    binary: resolvedBinary,
    timeoutMs,
    maxOutputBytes,
    spawnImpl,
    environment,
    validateInput,
    buildArgs,
    parseOutput: parseCodexOutput,
    capabilities: ['cli', 'codex', 'read-only', 'jsonl', 'human-approval', 'project-write', 'resume-session']
  });
  executor.buildArgs = buildArgs;
  executor.parseOutput = parseCodexOutput;
  executor.safeArtifactPath = value => safeArtifactPath(value, cwd);
  return executor;
}
