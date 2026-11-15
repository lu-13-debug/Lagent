import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { workError } from './domain.js';
import { ticketTokensUsed } from './usage.js';

// 外部 Agent 用的作用域令牌：绑定项目、只读/可写、工具白名单、调用与 Token 预算、并发、有效期。
// 明文令牌只在签发时返回一次；库里只保存 SHA-256 哈希。
export const MCP_TOKEN_PREFIX = 'lagent_mcp_';
const TOKEN_PATTERN = /^lagent_mcp_[A-Za-z0-9_-]{43}$/;
const TOKEN_KEY = 'work-mcp-token-records';
const LINK_KEY = 'work-mcp-token-links';
const MAX_TOKENS = 50;
const MAX_LINKS = 5000;

export const MCP_WRITE_TOOLS = Object.freeze([
  'work_send_command',
  'work_ticket_action',
  'work_ticket_handoff',
  'work_verify_ticket',
  'work_create_plan',
  'work_update_project_brief',
  'work_record_change',
  'work_send_window'
]);

const TICKET_TOOLS = Object.freeze([
  'work_get_ticket',
  'work_task_contract_read',
  'work_acceptance_read',
  'work_artifact_read',
  'work_get_report',
  'work_ticket_action',
  'work_ticket_handoff',
  'work_verify_ticket'
]);

export const mcpTokenHash = token => createHash('sha256').update(token).digest('hex');

const text = (value, label, max) => {
  if (typeof value !== 'string') throw workError(`${label}必须是字符串`, 400);
  const result = value.replace(/[\r\n]/g, ' ').trim();
  if (!result) throw workError(`${label}不能为空`, 400);
  if (result.length > max) throw workError(`${label}最长 ${max} 个字符`, 400);
  return result;
};

const integer = (value, label, min, max, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw workError(`${label}必须是 ${min} 到 ${max} 的整数`, 400);
  return value;
};

const stringList = (value, label, max) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw workError(`${label}必须是不超过 ${max} 项的数组`, 400);
  const result = value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (new Set(result).size !== result.length) throw workError(`${label}不能包含重复项`, 400);
  return result.slice(0, max);
};

const iso = value => new Date(value).toISOString();

export function createMcpTokenService({ store, engine, now = Date.now, onIssue, onRevoke } = {}) {
  if (!store) throw new TypeError('MCP 令牌服务需要 store');
  if (!engine) throw new TypeError('MCP 令牌服务需要 work engine');
  const active = new Map(); // tokenId -> 正在执行的请求数

  const rows = () => store.config(TOKEN_KEY) || [];
  const writeRows = next => store.config(TOKEN_KEY, next);
  const links = () => store.config(LINK_KEY) || [];
  const writeLinks = next => store.config(LINK_KEY, next.slice(0, MAX_LINKS));

  function prune(records) {
    const cutoff = now() - 90 * 86400000;
    return records.filter(row => {
      if (row.revokedAt && Date.parse(row.revokedAt) < cutoff) return false;
      if (!row.revokedAt && Date.parse(row.expiresAt) < now() - 86400000) return false;
      return true;
    });
  }

  function usedTokens(row) {
    const ticketIds = new Set(links().filter(link => link.tokenId === row.id).map(link => link.ticketId));
    let total = 0;
    for (const ticketId of ticketIds) total += ticketTokensUsed(store, ticketId);
    return total;
  }

  function publicRow(row) {
    return {
      id: row.id,
      name: row.name,
      projectId: row.projectId || null,
      readOnly: row.readOnly === true,
      tools: [...(row.tools || [])],
      budgetTokens: row.budgetTokens || 0,
      maxCalls: row.maxCalls || 0,
      maxConcurrency: row.maxConcurrency || 4,
      calls: row.calls || 0,
      usedTokens: usedTokens(row),
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt || null,
      revokedAt: row.revokedAt || null
    };
  }

  function find(id) {
    if (typeof id !== 'string' || !id.trim()) throw workError('MCP 令牌 id 无效', 400);
    const row = rows().find(item => item.id === id.trim());
    if (!row) throw workError('MCP 令牌不存在', 404);
    return row;
  }

  function issue(input = {}, { knownTools } = {}) {
    const current = prune(rows());
    if (current.length >= MAX_TOKENS) throw workError(`最多同时保存 ${MAX_TOKENS} 个 MCP 令牌，请先撤销不再使用的令牌`, 429);
    const name = text(input.name ?? '外部 Agent', '令牌名称', 60);
    const projectId = input.projectId === undefined || input.projectId === null || input.projectId === ''
      ? null
      : text(input.projectId, 'projectId', 100);
    // 项目必须真实存在；否则令牌签发后连一次工具调用都做不了。
    if (projectId) engine.getProject(projectId);
    const readOnly = input.readOnly !== false;
    const tools = stringList(input.tools, '工具白名单', 100);
    if (knownTools) {
      const unknown = tools.filter(tool => !knownTools.has(tool));
      if (unknown.length) throw workError(`未知 MCP 工具：${unknown.join('、')}`, 400);
    }
    const ttlDays = integer(input.ttlDays, '有效期', 1, 365, 7);
    const token = MCP_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const createdAt = iso(now());
    const row = {
      id: randomUUID(),
      name,
      tokenHash: mcpTokenHash(token),
      projectId,
      readOnly,
      tools,
      budgetTokens: integer(input.budgetTokens, 'Token 预算', 0, 1_000_000_000, 0),
      maxCalls: integer(input.maxCalls, '调用上限', 0, 1_000_000, 0),
      maxConcurrency: integer(input.maxConcurrency, '并发上限', 1, 16, 4),
      calls: 0,
      expiresAt: iso(now() + ttlDays * 86400000),
      createdAt,
      lastUsedAt: null,
      revokedAt: null
    };
    writeRows([...current, row]);
    // 云端需要把令牌哈希登记到账号库，外部 Agent 才能在没有会话时定位到对应工作区。
    try { onIssue?.(row.tokenHash, row); } catch { /* 索引失败时令牌仍可在本工作区使用。 */ }
    if (engine.auditExternal) engine.auditExternal('mcp/token', 'mcp', 'created', `${row.id.slice(0, 8)} ${name}`);
    return { token, record: publicRow(row) };
  }

  function list() {
    const current = prune(rows());
    if (current.length !== rows().length) writeRows(current);
    return current.map(publicRow).sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  function revoke(id) {
    const current = rows();
    const row = find(id);
    if (row.revokedAt) return publicRow(row);
    const next = { ...row, revokedAt: iso(now()) };
    writeRows(current.map(item => item.id === row.id ? next : item));
    try { onRevoke?.(row.tokenHash, row); } catch { /* 索引清理失败时本地令牌已失效。 */ }
    active.delete(row.id);
    if (engine.auditExternal) engine.auditExternal('mcp/token', 'mcp', 'revoked', row.id.slice(0, 8));
    return publicRow(next);
  }

  function authenticate(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw workError('MCP 令牌无效', 401);
    const hash = mcpTokenHash(token);
    const row = rows().find(item => item.tokenHash === hash);
    if (!row || row.revokedAt || Date.parse(row.expiresAt) <= now()) throw workError('MCP 令牌无效或已过期', 401);
    if (row.maxCalls > 0 && (row.calls || 0) >= row.maxCalls) throw workError('该 MCP 令牌的调用额度已用完', 403);
    if (row.budgetTokens > 0 && usedTokens(row) >= row.budgetTokens) throw workError('该 MCP 令牌的 Token 预算已用完', 403);
    return row;
  }

  // 并发闸门：外部 Agent 很容易同时开多个请求，按令牌限制能避免它们一起把工作区打满。
  function enter(row) {
    const count = active.get(row.id) || 0;
    if (count >= (row.maxConcurrency || 4)) throw workError('该 MCP 令牌的并发请求过多', 429);
    active.set(row.id, count + 1);
    let released = false;
    return () => { if (released) return; released = true; const left = Math.max(0, (active.get(row.id) || 1) - 1); if (left) active.set(row.id, left); else active.delete(row.id); };
  }

  function assertTool(row, name, input = {}) {
    if (row.tools?.length && !row.tools.includes(name)) throw workError('该 MCP 令牌无权调用此工具', 403);
    if (row.readOnly && MCP_WRITE_TOOLS.includes(name)) throw workError('该 MCP 令牌是只读令牌，不能修改工作区', 403);
    if (row.projectId) {
      if (input && typeof input === 'object' && input.projectId !== undefined && input.projectId !== null && input.projectId !== '' && input.projectId !== row.projectId) {
        throw workError('该 MCP 令牌只能访问绑定的项目', 403);
      }
      if (TICKET_TOOLS.includes(name) && input && typeof input.id === 'string' && input.id) {
        if (engine.ticketProjectId(input.id) !== row.projectId) throw workError('该 MCP 令牌只能访问绑定的项目', 403);
      }
      // 窗口 Agent 不属于任何项目，项目令牌一律不开放。
      if (name === 'work_list_windows' || name === 'work_send_window') throw workError('该 MCP 令牌不能操作本机窗口', 403);
    }
    if (row.maxCalls > 0 && (row.calls || 0) >= row.maxCalls) throw workError('该 MCP 令牌的调用额度已用完', 403);
    if (row.budgetTokens > 0 && usedTokens(row) >= row.budgetTokens) throw workError('该 MCP 令牌的 Token 预算已用完', 403);
  }

  function recordCall(row, { ticketId } = {}) {
    const current = rows();
    const latest = current.find(item => item.id === row.id);
    if (!latest) return;
    const next = { ...latest, calls: (latest.calls || 0) + 1, lastUsedAt: iso(now()) };
    writeRows(current.map(item => item.id === row.id ? next : item));
    if (typeof ticketId === 'string' && ticketId) {
      const existing = links();
      if (!existing.some(link => link.tokenId === row.id && link.ticketId === ticketId)) {
        writeLinks([{ tokenId: row.id, ticketId, at: iso(now()) }, ...existing]);
      }
    }
  }

  return { issue, list, revoke, authenticate, enter, assertTool, recordCall, usedTokens, publicRow };
}
