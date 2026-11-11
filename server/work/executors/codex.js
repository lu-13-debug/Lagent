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
  const fatal = [];
  const warnings = [];
  const stats = { events: events.length, malformedLines: malformed, agentMessages: 0, commands: 0, fileChanges: 0, tools: 0 };
  let usage = {};
  let sessionId = '';

  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    if (typeof event.thread_id === 'string' && event.thread_id && !sessionId) sessionId = event.thread_id;
    if (event.type === 'turn.completed' && event.usage) usage = event.usage;
    // codex 会把「配置项被忽略」这类无害提示也发成 error 事件；真正的失败是顶层 error 或 turn.failed。
    // 若不区分，用户只会看到噪音提示，看不到「Model is unavailable」这类真正的原因。
    const error = eventError(event);
    if (error) {
      const bucket = event?.item?.type === 'error' ? warnings : fatal;
      bucket.push(sanitizeText(String(error), 2000));
    }
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

  const stderrText = sanitizeText(stderr, 2000);
  const failure = exitCode !== 0 ? (fatal.find(Boolean) || stderrText || warnings.find(Boolean) || '') : '';
  return {
    summary: sanitizeText(summaries.join('\n\n'), MAX_SUMMARY),
    usage,
    error: failure,
    artifacts,
    stats,
    ...(sessionId ? { sessionId } : {})
  };
}

export function codexExecutor({
  store,
  cwd,
  binary = process.env.DATAAGENT_CODEX_CLI,
  timeoutMs = 900_000,
  maxOutputBytes = 8 * 1024 * 1024,
  spawnImpl,
  environment = process.env
}) {
  const validateInput = input => normalizeCliInput(input, { defaultMaxTurns: 12, maxTurns: 60 });
  const resolvedBinary = binary || findCodexBinary(environment);
  const buildArgs = (input, workspace) => {
    const write = input.write === true;
    // Windows 上 codex 的 apply_patch 是个 .bat 转发的，多行补丁经 cmd/PowerShell 转发时
    // 换行与引号会被吃掉，于是出现「Failed to write file …」这种假失败。明确让它改用
    // 直接写文件的方式，能省掉好几轮试错（实测同一任务从 14 分钟失败变成一次写成）。
    const windowsNote = process.platform === 'win32'
      ? '\n\n（Windows 环境：写多行文件不要用 apply_patch —— 这里的补丁会被 shell 的引号规则吃掉而写入失败。请直接用 shell 命令写文件，例如 powershell -NoProfile -Command "Set-Content -LiteralPath <路径> -Value <内容> -Encoding utf8"。）'
      : '';
    const prompt = (write ? writablePrompt(input) : readOnlyPrompt(input)) + windowsNote;
    // 项目目录不一定是 git 仓库（例如 D:\test），codex 默认会拒绝非受信目录并直接退出；
    // 写入范围已经由本软件的审批闸门与 sandbox 参数限制，这里放开仓库检查。
    const modelArgs = input.model ? ['-m', input.model] : [];
    if (input.resume) {
      return ['exec', 'resume', '--json', '--skip-git-repo-check', ...modelArgs, ...(write ? ['-c', 'sandbox_mode="workspace-write"'] : []), input.resume, prompt];
    }
    return ['exec', '--json', '--sandbox', write ? 'workspace-write' : 'read-only', '--skip-git-repo-check', ...modelArgs, '-C', workspace, prompt];
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
