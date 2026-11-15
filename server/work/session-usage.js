import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 历史会话成本：直接读 ~/.claude/projects 与 ~/.codex/sessions 的 JSONL，
// 只提取用量字段，不读取正文，也不把会话内容带进 Lagent 数据库。
// 结果按「文件 + 模型」聚合，避免一次把几万行原始记录塞进接口。
const MAX_FILES = 400;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4000;
const cache = new Map();

const int = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const token = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = value => typeof value === 'string' ? value.replace(/[\r\n]/g, '').slice(0, 200) : '';

function listFiles(dir, suffix, depth, collected = []) {
  if (depth < 0 || collected.length >= MAX_FILES) return collected;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return collected; }
  for (const entry of entries) {
    if (collected.length >= MAX_FILES) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, suffix, depth - 1, collected);
    else if (entry.isFile() && entry.name.endsWith(suffix)) collected.push(full);
  }
  return collected;
}

function readParsed(file, parser) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) return [];
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.entries;
    const entries = parser(readFileSync(file, 'utf8'), file, stat.mtimeMs);
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    return entries;
  } catch { return []; }
}

function bump(map, key, timestamp, delta) {
  if (!map.has(key)) map.set(key, { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, recordedAt: timestamp, calls: 0 });
  const row = map.get(key);
  row.tokensIn += int(delta.tokensIn);
  row.tokensOut += int(delta.tokensOut);
  row.cacheReadTokens += int(delta.cacheReadTokens);
  row.cacheWriteTokens += int(delta.cacheWriteTokens);
  row.totalTokens += int(delta.totalTokens || (delta.tokensIn + delta.tokensOut));
  row.calls += 1;
  if (timestamp && String(timestamp) > String(row.recordedAt)) row.recordedAt = timestamp;
}

function claudeFile(file) {
  return readParsed(file, (content, target, mtimeMs) => parseClaude(content, target, mtimeMs));
}

function parseClaude(content, file, mtimeMs) {
  let sessionId = path.basename(file, '.jsonl');
  let projectPath = '';
  const map = new Map();
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (typeof event.sessionId === 'string' && event.sessionId) sessionId = event.sessionId;
    if (typeof event.cwd === 'string' && event.cwd && !projectPath) projectPath = event.cwd;
    const usage = event.message?.usage || event.usage;
    if (!usage || typeof usage !== 'object') continue;
    const model = text(event.message?.model || event.model || '');
    const tokensIn = token(usage.input_tokens ?? usage.inputTokens);
    const tokensOut = token(usage.output_tokens ?? usage.outputTokens);
    const cacheReadTokens = token(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
    const cacheWriteTokens = token(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
    if (!tokensIn && !tokensOut && !cacheReadTokens && !cacheWriteTokens) continue;
    const timestamp = typeof event.timestamp === 'string' ? event.timestamp : new Date(mtimeMs).toISOString();
    bump(map, model || 'unknown', timestamp, { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, totalTokens: token(usage.total_tokens) || tokensIn + tokensOut });
  }
  return [...map.entries()].map(([model, row]) => ({
    sessionId, projectPath, projectName: projectPath ? path.basename(projectPath) : path.basename(path.dirname(file)),
    executorId: 'claude-code', model, source: 'history', ...row
  }));
}

function codexFile(file) {
  return readParsed(file, (content, target, mtimeMs) => parseCodex(content, target, mtimeMs));
}

function parseCodex(content, file, mtimeMs) {
  let sessionId = path.basename(file, '.jsonl');
  let projectPath = '';
  let model = 'unknown';
  const totals = new Map();
  let previous = { input: 0, output: 0, cacheRead: 0, total: 0 };
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    if (event.type === 'session_meta') {
      if (typeof payload.session_id === 'string' && payload.session_id) sessionId = payload.session_id;
      else if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
      if (typeof payload.cwd === 'string' && payload.cwd) projectPath = payload.cwd;
    }
    if (payload.type === 'turn_context') {
      if (typeof payload.cwd === 'string' && payload.cwd) projectPath = payload.cwd;
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
    }
    if (payload.type === 'token_count') {
      const info = payload.info || {};
      const cumulative = info.total_token_usage || info.last_token_usage;
      if (!cumulative || typeof cumulative !== 'object') continue;
      const current = {
        input: token(cumulative.input_tokens ?? cumulative.inputTokens),
        output: token(cumulative.output_tokens ?? cumulative.outputTokens),
        cacheRead: token(cumulative.cached_input_tokens ?? cumulative.cache_read_input_tokens),
        total: token(cumulative.total_tokens ?? cumulative.totalTokens)
      };
      // token_count 给的是累计值；同一文件里取增量，避免把总量重复累加。
      const delta = {
        tokensIn: Math.max(0, current.input - previous.input),
        tokensOut: Math.max(0, current.output - previous.output),
        cacheReadTokens: Math.max(0, current.cacheRead - previous.cacheRead),
        cacheWriteTokens: 0,
        totalTokens: current.total > previous.total ? current.total - previous.total : Math.max(0, current.input - previous.input) + Math.max(0, current.output - previous.output)
      };
      previous = current;
      if (!delta.tokensIn && !delta.tokensOut && !delta.cacheReadTokens && !delta.totalTokens) continue;
      const timestamp = typeof event.timestamp === 'string' ? event.timestamp : new Date(mtimeMs).toISOString();
      bump(totals, model, timestamp, delta);
    }
  }
  return [...totals.entries()].map(([name, row]) => ({
    sessionId, projectPath, projectName: projectPath ? path.basename(projectPath) : path.basename(path.dirname(file)),
    executorId: 'codex', model: name, source: 'history', ...row
  }));
}

export function scanHistoricalUsage({ home = os.homedir(), environment = process.env } = {}) {
  const claudeRoot = environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexRoot = environment.CODEX_HOME || path.join(home, '.codex');
  const claudeFiles = listFiles(path.join(claudeRoot, 'projects'), '.jsonl', 2);
  const codexFiles = listFiles(path.join(codexRoot, 'sessions'), '.jsonl', 3);
  const entries = [];
  for (const file of [...claudeFiles, ...codexFiles]) {
    if (entries.length >= MAX_ENTRIES) break;
    const rows = file.includes(`${path.sep}projects${path.sep}`) && file.startsWith(claudeRoot) ? claudeFile(file) : codexFile(file);
    for (const row of rows) {
      if (entries.length >= MAX_ENTRIES) break;
      if (!row.totalTokens) continue;
      entries.push({ ...row, projectId: '', costEstimate: 0 });
    }
  }
  // 缓存上限：避免长期运行时把大量文件路径和内容指纹留在内存里。
  if (cache.size > MAX_FILES * 2) {
    const keep = new Set([...claudeFiles, ...codexFiles]);
    for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key);
  }
  return {
    entries,
    scanned: { files: claudeFiles.length + codexFiles.length, claudeFiles: claudeFiles.length, codexFiles: codexFiles.length },
    // 历史 JSONL 里没有可靠的费用字段；费用仍由前端按模型单价估算。
    note: '历史会话只提供 Token 与缓存用量，费用按当前单价估算。'
  };
}
