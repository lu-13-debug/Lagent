import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { tokenHash } from './accounts.js';
import { projectFileMime } from './work/project-files.js';
import { clipReportText, reportTextOfReport } from './work/report-text.js';
import { isEffort } from './work/efforts.js';

export const MOBILE_PAIR_TTL_MS = 5 * 60 * 1000;
export const MOBILE_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MOBILE_REQUEST_LIMIT = 60;
export const MOBILE_REQUEST_WINDOW_MS = 60 * 1000;
export const MOBILE_HEARTBEAT_MS = 15 * 1000;
export const MOBILE_MAX_CLAIM_ATTEMPTS = 5;
export const MOBILE_NOTIFICATION_MAX = 200;
export const MOBILE_NOTIFICATION_DEFAULT_LIMIT = 50;
// 下载链接是短期能力票据：手机 WebView 的下载器没法带 Bearer 头，
// 所以用签名 URL 代替设备 token，10 分钟内有效，且只能取这一个文件。
export const MOBILE_FILE_TOKEN_TTL_MS = 10 * 60 * 1000;
export const MOBILE_TICKET_FILE_MAX = 100;
const MOBILE_FILE_SECRET = randomBytes(32);

export const mobileError = (message, status = 400) => Object.assign(new Error(message), { status });
const iso = value => new Date(value).toISOString();
const nowMs = now => Number(now());
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const text = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : undefined;
const integer = value => Number.isSafeInteger(value) ? value : undefined;
const primitive = value => value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' ? value : undefined;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
const notificationStatuses = new Set(['awaiting_review', 'completed', 'failed', 'blocked', 'cancelled', 'budget_warning']);

function cleanDeviceName(value) {
  const source = typeof value === 'string' ? value : '移动设备';
  const normalized = source.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim() || '移动设备';
  return Array.from(normalized).slice(0, 64).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pairDigest(salt, code) {
  return createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requestToken(req) {
  const authorization = req?.headers?.authorization;
  const legacy = req?.headers?.['x-device-token'];
  let bearer = '';
  if (authorization !== undefined) {
    if (typeof authorization !== 'string') throw mobileError('设备认证失败，请重新配对', 401);
    const match = /^Bearer\s+([A-Za-z0-9_-]{43})$/i.exec(authorization.trim());
    if (!match) throw mobileError('设备认证失败，请重新配对', 401);
    bearer = match[1];
  }
  if (legacy !== undefined && (typeof legacy !== 'string' || !tokenPattern.test(legacy))) throw mobileError('设备认证失败，请重新配对', 401);
  if (bearer && legacy && bearer !== legacy) throw mobileError('设备认证失败，请重新配对', 401);
  return bearer || legacy || '';
}

export function hasDeviceToken(req) {
  return req?.headers?.authorization !== undefined || req?.headers?.['x-device-token'] !== undefined;
}

function pick(value, fields) {
  const source = object(value);
  if (!source) return null;
  const result = {};
  for (const key of fields) {
    const item = primitive(source[key]);
    if (item !== undefined) result[key] = typeof item === 'string' ? item.slice(0, 4000) : item;
  }
  return result;
}

const timestamp = value => {
  if (typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

function mobileAttention(value) {
  const source = object(value);
  if (!source) return null;
  const result = {};
  const question = text(source.question);
  const createdAt = timestamp(source.createdAt);
  if (question !== undefined) result.question = question;
  if (createdAt !== undefined) result.createdAt = createdAt;
  if (Array.isArray(source.options)) {
    result.options = source.options.slice(0, 8).map(option => pick(option, ['id', 'label', 'action'])).filter(Boolean);
  }
  return result;
}

function mobilePreview(value) {
  const source = object(value);
  if (!source) return undefined;
  // 手机端只给风险与类型，不下发 action：action 里可能带命令行参数或用户输入。
  const preview = pick(source, ['kind', 'risk', 'tier', 'reversible']);
  if (!preview) return undefined;
  const cwd = text(source.cwd, 300);
  if (cwd !== undefined) preview.cwd = cwd;
  if (Array.isArray(source.paths)) preview.paths = source.paths.filter(item => typeof item === 'string').slice(0, 10).map(item => item.slice(0, 300));
  if (Array.isArray(source.hosts)) preview.hosts = source.hosts.filter(item => typeof item === 'string').slice(0, 10).map(item => item.slice(0, 200));
  return preview;
}

function mobileVerify(value) {
  const source = object(value);
  if (!source) return undefined;
  const verify = pick(source, ['command', 'expect']);
  if (!verify) return undefined;
  const command = text(source.command, 500);
  if (command !== undefined) verify.command = command;
  const timeoutMs = integer(source.timeoutMs);
  if (timeoutMs !== undefined && timeoutMs >= 1000 && timeoutMs <= 600000) verify.timeoutMs = timeoutMs;
  return verify;
}

function mobileAcceptance(value) {
  const source = object(value);
  if (!source) return undefined;
  const acceptance = pick(source, ['status', 'exitCode']);
  if (!acceptance) return undefined;
  const command = text(source.command, 500);
  if (command !== undefined) acceptance.command = command;
  return acceptance;
}

function mobileContract(value) {
  const source = object(value);
  if (!source) return undefined;
  const contract = {};
  const objective = text(source.objective, 500);
  if (objective !== undefined) contract.objective = objective;
  if (Array.isArray(source.acceptance)) contract.acceptance = source.acceptance.filter(item => typeof item === 'string').slice(0, 10).map(item => item.slice(0, 300));
  if (Array.isArray(source.constraints)) contract.constraints = source.constraints.filter(item => typeof item === 'string').slice(0, 10).map(item => item.slice(0, 300));
  return Object.keys(contract).length ? contract : undefined;
}

export function sanitizeMobileTicket(value) {
  const source = object(value);
  const ticket = pick(source, ['id', 'status', 'stage', 'source', 'executor', 'createdAt', 'updatedAt']);
  if (!ticket) return null;
  const title = text(source?.title, 100);
  const summary = text(source?.summary, 400);
  const parentTicketId = text(source?.parentTicketId, 80);
  const handoffDepth = integer(source?.handoffDepth);
  const handoffSummary = text(source?.handoffSummary, 400);
  const planId = text(source?.planId, 100);
  const planStep = integer(source?.planStep);
  const planTotal = integer(source?.planTotal);
  if (title !== undefined) ticket.title = title;
  if (summary !== undefined) ticket.summary = summary;
  if (parentTicketId !== undefined) ticket.parentTicketId = parentTicketId;
  if (handoffDepth !== undefined && handoffDepth >= 0 && handoffDepth <= 3) ticket.handoffDepth = handoffDepth;
  if (handoffSummary !== undefined) ticket.handoffSummary = handoffSummary;
  if (planId !== undefined) ticket.planId = planId;
  if (planStep !== undefined && planStep >= 0 && planStep < 5) ticket.planStep = planStep;
  if (planTotal !== undefined && planTotal >= 2 && planTotal <= 5) ticket.planTotal = planTotal;
  const attention = mobileAttention(source?.attention);
  if (attention) ticket.attention = attention;
  const preview = mobilePreview(source?.preview);
  if (preview) ticket.preview = preview;
  const verify = mobileVerify(source?.verify);
  if (verify) ticket.verify = verify;
  const acceptance = mobileAcceptance(source?.acceptance);
  if (acceptance) ticket.acceptance = acceptance;
  const contract = mobileContract(source?.contract);
  if (contract) ticket.contract = contract;
  return ticket;
}

const sanitizeAssignment = value => pick(value, ['id', 'ticketId', 'executor', 'status', 'startedAt', 'queuedAt', 'endedAt']);
const sanitizeReport = value => {
  const source = object(value);
  const report = pick(source, ['id', 'ticketId', 'assignmentId', 'kind', 'createdAt']);
  if (!report) return null;
  const summary = text(source?.summary, 400);
  if (summary !== undefined) report.summary = summary;
  // 正文只从 artifacts 取；回落时用已截断的 400 字摘要，保证不比旧版多暴露原始字段。
  const { text: body, truncated } = clipReportText(reportTextOfReport({ artifacts: object(source?.artifacts), summary }), 20000);
  if (body) report.text = body;
  if (truncated) report.truncated = true;
  return report;
};

const CONVERSATION_STATUS = new Set(['waiting', 'working', 'awaiting_review', 'completed', 'failed', 'cancelled']);
const activityKinds = new Set(['thought', 'tool', 'observation', 'error', 'permission']);

export const sanitizeMobileSettings = value => {
  const source = object(value);
  if (!source) return null;
  const result = {};
  const profileId = text(source.profileId, 100);
  if (profileId && /^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) result.profileId = profileId;
  if (isEffort(source.effort)) result.effort = source.effort;
  return Object.keys(result).length ? result : null;
};

// 键不属于本轮 Agent 的直接丢弃；键属于但档位非法才是 400。
export const sanitizeMobileEfforts = (value, agentIds = []) => {
  if (value === undefined || value === null) return undefined;
  if (!object(value)) throw mobileError('efforts 必须是对象', 400);
  const allowed = new Set(Array.isArray(agentIds) ? agentIds : []);
  const result = {};
  for (const [key, effort] of Object.entries(value)) {
    if (!allowed.has(key)) continue;
    if (!isEffort(effort)) throw mobileError('思考强度无效', 400);
    result[key] = effort;
  }
  return Object.keys(result).length ? result : undefined;
};

export function sanitizeMobileProject(value) {
  const source = object(value);
  const project = pick(source, ['id', 'name', 'gitBranch']);
  if (!project?.id) return null;
  const projectPath = text(source.path, 500);
  if (projectPath !== undefined) project.path = projectPath;
  return project;
}

export function sanitizeMobileConversationSummary(value) {
  const source = object(value);
  const conversation = pick(source, ['id', 'title', 'goal', 'projectId', 'createdAt', 'updatedAt']);
  if (!conversation?.id) return null;
  conversation.status = CONVERSATION_STATUS.has(source.status) ? source.status : 'waiting';
  conversation.turnCount = Math.max(0, integer(source.turnCount) || 0);
  const lastPrompt = text(source.lastPrompt, 4000);
  if (lastPrompt !== undefined) conversation.lastPrompt = lastPrompt;
  if (['auto', 'multi', 'plan', 'review'].includes(source.lastMode)) conversation.lastMode = source.lastMode;
  conversation.participants = Array.isArray(source.participants)
    ? source.participants.filter(item => typeof item === 'string').slice(0, 4).map(item => item.slice(0, 60))
    : [];
  return conversation;
}

export function sanitizeMobileTurn(value) {
  const source = object(value);
  const turn = pick(source, ['id', 'index', 'prompt', 'mode', 'createdAt']);
  if (!turn?.id) return null;
  if (!['auto', 'multi', 'plan', 'review'].includes(source.mode)) turn.mode = 'auto';
  turn.agentIds = Array.isArray(source.agentIds) ? source.agentIds.filter(item => typeof item === 'string').slice(0, 4).map(item => item.slice(0, 60)) : [];
  turn.runs = Array.isArray(source.runs)
    ? source.runs.slice(0, 8).map(run => pick(run, ['ticketId', 'agentId', 'role'])).filter(run => run?.ticketId)
    : [];
  if (typeof source.synthesisTicketId === 'string') turn.synthesisTicketId = source.synthesisTicketId.slice(0, 100);
  return turn;
}

export function sanitizeMobileActivity(value) {
  const source = object(value);
  if (!source || !activityKinds.has(source.kind)) return null;
  const result = { kind: source.kind };
  const body = text(source.text, 1200);
  if (body !== undefined) result.text = body;
  const detail = text(source.detail, 600);
  if (detail !== undefined) result.detail = detail;
  if (typeof source.at === 'string') result.at = source.at.slice(0, 40);
  if (typeof source.requestId === 'string') result.requestId = source.requestId.slice(0, 120);
  if (typeof source.decided === 'boolean') result.decided = source.decided;
  return result;
}

export function pageMobileTurns(turns, { limit = 30, before = null } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  const size = Math.max(1, Math.min(50, Number(limit) || 30));
  const visible = before === null || before === undefined
    ? list.slice(-size)
    : list.filter(turn => (integer(turn.index) || 0) < before).slice(-size);
  const first = visible[0];
  const hasMore = Boolean(first) && list.some(turn => (integer(turn.index) || 0) < first.index);
  return { turns: visible, hasMore, nextBefore: hasMore ? first.index : null };
}

export function sanitizeMobilePolicy(value) {
  const source = object(value);
  if (!source) return null;
  const policy = pick(source, ['mode', 'acceptMode', 'requireApproval']);
  if (Array.isArray(source.allowedExecutors)) policy.allowedExecutors = source.allowedExecutors.filter(item => typeof item === 'string').slice(0, 12).map(item => item.slice(0, 80));
  const budgets = pick(source.budgets, ['maxConcurrent', 'maxCallsPerTicket', 'maxRuntimeMs', 'maxTokensPerTicket']);
  if (budgets) policy.budgets = budgets;
  const limits = object(source.limits);
  if (limits) {
    policy.limits = {};
    for (const key of ['browserHosts', 'githubRepos']) if (Array.isArray(limits[key])) policy.limits[key] = limits[key].filter(item => typeof item === 'string').slice(0, 100).map(item => item.slice(0, 200));
  }
  return policy;
}

function safeLimits(value) {
  const limits = pick(value, ['maxDepth', 'maxNodes', 'maxConcurrent', 'maxCalls', 'maxTokens', 'timeoutMs', 'maxSubtasks']);
  return limits && Object.keys(limits).length ? limits : undefined;
}

function safeUsage(value) {
  const usage = pick(value, ['calls', 'totalTokens', 'reservedTokens']);
  return usage && Object.keys(usage).length ? usage : undefined;
}

function safeProposal(value) {
  return pick(value, ['id', 'kind', 'status']);
}

function safeTeamNode(value) {
  if (!object(value) || typeof value.id !== 'string') return null;
  const node = pick(value, ['id', 'parentId', 'depth', 'status', 'retries']);
  if (Array.isArray(value.dependsOn)) node.dependsOn = value.dependsOn.filter(item => typeof item === 'string').slice(0, 3).map(item => item.slice(0, 120));
  if (Array.isArray(value.proposals)) node.proposals = value.proposals.slice(-20).map(safeProposal).filter(Boolean);
  return node;
}

function safeTeamEvent(value) {
  const event = pick(value, ['type', 'nodeId', 'status', 'seq', 'createdAt']);
  if (!event) return null;
  const proposal = safeProposal(object(value)?.proposal);
  if (proposal) event.proposal = proposal;
  return event;
}

export function sanitizeMobileTeam(value) {
  const source = object(value);
  if (!source) return null;
  const team = {
    limits: safeLimits(source.limits),
    usage: safeUsage(source.usage),
    cancelled: source.cancelled === true,
    revision: integer(source.revision),
    updatedAt: text(source.updatedAt, 40),
    nodes: Array.isArray(source.nodes) ? source.nodes.slice(0, 100).map(safeTeamNode).filter(Boolean) : [],
    events: Array.isArray(source.events) ? source.events.slice(-100).map(safeTeamEvent).filter(Boolean) : []
  };
  return team;
}

export function sanitizeMobileBootstrap(value, notificationState = {}) {
  const source = object(value);
  if (!source) return null;
  const tickets = Array.isArray(source.tickets) ? source.tickets.slice(0, 200).map(sanitizeMobileTicket).filter(Boolean) : [];
  const unread = integer(object(notificationState)?.unread);
  return {
    capabilities: { work: true },
    tickets,
    attention: tickets.filter(ticket => ticket.attention).map(ticket => ({ ticketId: ticket.id, ...ticket.attention })),
    agents: Array.isArray(source.agents) ? source.agents.slice(0, 50).map(item => {
      const agent = pick(item, ['id', 'name', 'kind', 'status']);
      if (Array.isArray(object(item)?.capabilities)) agent.capabilities = item.capabilities.filter(entry => typeof entry === 'string').slice(0, 20).map(entry => entry.slice(0, 80));
      return agent;
    }) : [],
    tools: [],
    policy: sanitizeMobilePolicy(source.policy),
    plans: Array.isArray(source.plans) ? source.plans.slice(0, 20).map(plan => {
      const id = text(plan?.id, 100);
      const goal = text(plan?.goal, 300);
      const status = text(plan?.status, 20);
      const currentStep = integer(plan?.currentStep);
      const totalSteps = integer(plan?.totalSteps);
      if (id === undefined || goal === undefined || !['active', 'completed', 'failed', 'cancelled'].includes(status)) return null;
      if (currentStep === undefined || currentStep < 0 || totalSteps === undefined || totalSteps < 2 || totalSteps > 5) return null;
      return { id, goal, status, currentStep, totalSteps, updatedAt: timestamp(plan?.updatedAt) };
    }).filter(Boolean) : [],
    // 工作文件夹只来自电脑端已导入项目；凭据、路径列表等私有字段一律不下发。
    projects: Array.isArray(source.projects) ? source.projects.slice(0, 100).map(sanitizeMobileProject).filter(Boolean) : [],
    conversations: Array.isArray(source.conversations) ? source.conversations.slice(0, 30).map(sanitizeMobileConversationSummary).filter(Boolean) : [],
    lagent: (() => {
      const state = object(source.lagent);
      if (!state) return null;
      return {
        name: text(state.name, 60) || 'Lagent',
        executorId: text(state.executorId, 60) || 'model',
        ready: state.ready === true,
        configured: state.configured === true,
        ...(text(state.reason, 300) ? { reason: text(state.reason, 300) } : {})
      };
    })(),
    notifications: { unread: unread === undefined ? 0 : Math.max(0, Math.min(MOBILE_NOTIFICATION_MAX, unread)) }
  };
}

export function sanitizeMobileDetail(value) {
  const source = object(value);
  if (!source) return null;
  const result = {
    ticket: sanitizeMobileTicket(source.ticket),
    assignments: Array.isArray(source.assignments) ? source.assignments.slice(0, 20).map(sanitizeAssignment).filter(Boolean) : [],
    reports: Array.isArray(source.reports) ? source.reports.slice(0, 50).map(sanitizeReport).filter(Boolean) : []
  };
  const team = sanitizeMobileTeam(source.team);
  if (team) result.team = team;
  if (Array.isArray(source.activity)) result.activity = source.activity.slice(-40).map(sanitizeMobileActivity).filter(Boolean);
  const project = sanitizeMobileProject(source.project);
  if (project) result.project = project;
  return result;
}

export function mobileWorkEvent(event) {
  const payload = object(event?.payload) || {};
  const safe = pick(payload, ['status']);
  if (typeof payload.id === 'string' && event?.type === 'report') safe.reportId = payload.id.slice(0, 100);
  // 思考过程走同一条 SSE，只透出白名单字段并限制长度。
  if (Array.isArray(payload.activity)) {
    const activity = payload.activity.slice(-40).map(sanitizeMobileActivity).filter(Boolean);
    if (activity.length) safe.activity = activity;
  }
  return {
    type: String(event?.type || 'event').slice(0, 40),
    ticketId: typeof event?.ticketId === 'string' ? event.ticketId.slice(0, 100) : null,
    payload: safe
  };
}

const fileSignature = body => createHmac('sha256', MOBILE_FILE_SECRET).update(body).digest('base64url');

function signMobileFile(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${fileSignature(body)}`;
}

function readMobileFile(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const actual = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(fileSignature(body));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.ownerId !== 'string' || !payload.ownerId) return null;
  if (typeof payload.projectId !== 'string' || !payload.projectId) return null;
  if (typeof payload.path !== 'string' || !payload.path) return null;
  if (typeof payload.name !== 'undefined' && typeof payload.name !== 'string') return null;
  if (typeof payload.mime !== 'undefined' && typeof payload.mime !== 'string') return null;
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) return null;
  return payload;
}

// 云端在进入账号工作区之前，用签名下载令牌确认归属账号；
// 这样系统下载器不需要携带设备 token，也不会把设备凭据放进 URL。
export function mobileFileOwner(value) {
  return readMobileFile(value)?.ownerId || null;
}

function fileDisposition(name, download) {
  // 中文文件名用 RFC 5987 的 filename*，同时保留 ASCII 回退，兼容老下载器。
  const fallback = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(String(name || 'file')).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

const dirnamePosix = value => {
  const slash = value.lastIndexOf('/');
  return slash < 0 ? '' : value.slice(0, slash);
};

function cleanTicketPath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replaceAll('\\', '/').trim().replace(/^\.\/+/, '');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized) || normalized.split('/').includes('..')) return '';
  return normalized;
}

// 工单 → 项目：优先用 detail 的项目对话，计划步骤再回落到 plan.projectId。
function ticketProjectOf(engine, ticketId) {
  const detail = engine.detail(ticketId);
  if (!detail?.ticket) throw mobileError('工单不存在', 404);
  let project = detail.project || null;
  if (!project) {
    const projectId = engine.ticketProjectId?.(ticketId) || (detail.ticket.planId ? engine.planProjectId?.(detail.ticket.planId) : null);
    if (projectId) project = engine.getProject?.(projectId) || null;
  }
  return { detail, ticket: detail.ticket, project };
}

// 只暴露这个工单的变更记录里记录过的文件，而不是整个项目目录；
// 手机端没有文件浏览器，列出来的每一项都应当能对应到某次执行。
function ticketFilePaths(engine, projectId, ticketId) {
  const changes = Array.isArray(engine.projectChanges?.(projectId)) ? engine.projectChanges(projectId) : [];
  const wanted = new Set();
  const paths = [];
  for (const change of changes) {
    if (!change || change.ticketId !== ticketId) continue;
    for (const value of Array.isArray(change.files) ? change.files : []) {
      const cleaned = cleanTicketPath(value);
      if (!cleaned || wanted.has(cleaned)) continue;
      wanted.add(cleaned);
      paths.push(cleaned);
      if (paths.length >= MOBILE_TICKET_FILE_MAX) break;
    }
    if (paths.length >= MOBILE_TICKET_FILE_MAX) break;
  }
  return paths;
}

function localTicketFileEntries(engine, projectId, paths) {
  const groups = new Map();
  for (const filePath of paths) {
    const dir = dirnamePosix(filePath);
    if (!groups.has(dir)) groups.set(dir, new Set());
    groups.get(dir).add(filePath);
  }
  const found = new Map();
  for (const [dir, members] of groups) {
    try {
      const listing = engine.projectFiles(projectId, dir);
      for (const entry of Array.isArray(listing?.entries) ? listing.entries : []) {
        if (!members.has(entry.path) || entry.type !== 'file' || entry.locked) continue;
        found.set(entry.path, entry);
      }
    } catch { /* 文件在记录之后被删掉或移走：从清单里隐去，不让手机端看到坏链接。 */ }
  }
  return paths.map(filePath => found.get(filePath)).filter(Boolean);
}

const basenamePosix = value => String(value || '').split('/').pop() || 'file';

function mobileFileEntry(value) {
  const entry = pick(value, ['name', 'path', 'type', 'ext', 'kind', 'mime', 'size', 'modifiedAt', 'previewable']);
  if (!entry || entry.type !== 'file' || typeof entry.path !== 'string' || !entry.path) return null;
  if (typeof entry.name !== 'string' || !entry.name) entry.name = basenamePosix(entry.path);
  if (typeof entry.kind !== 'string' || !entry.kind) entry.kind = 'unsupported';
  return entry;
}

// 项目在服务器上可读就直接读；Windows 本机路径在云端读不到，才交给实际跑过该目录的节点。
function projectFileRelay(app, project) {
  if (!project?.path) return null;
  try { if (statSync(project.path).isDirectory()) return null; } catch { /* 云端看不到本机路径。 */ }
  const hub = app?.locals?.nodeHub;
  if (typeof hub?.nodeForWorkspace !== 'function' || typeof hub?.requestFile !== 'function') return null;
  return hub.nodeForWorkspace(project.path);
}

async function describeTicketFiles(app, engine, project, paths) {
  if (!paths.length) return [];
  const node = projectFileRelay(app, project);
  let raw;
  if (node) raw = (await app.locals.nodeHub.requestFile(node.nodeId, { op: 'describe', workspace: project.path, paths }))?.entries;
  else raw = localTicketFileEntries(engine, project.id, paths);
  const allowed = new Set(paths);
  const found = new Map();
  for (const item of Array.isArray(raw) ? raw : []) {
    const entry = mobileFileEntry(item);
    if (entry && allowed.has(entry.path)) found.set(entry.path, entry);
  }
  return paths.map(filePath => found.get(filePath)).filter(Boolean);
}

async function ticketFileOf(app, engine, ticketId) {
  const { project } = ticketProjectOf(engine, ticketId);
  if (!project?.id) return { project: null, entries: [] };
  const paths = ticketFilePaths(engine, project.id, ticketId);
  return { project, entries: await describeTicketFiles(app, engine, project, paths) };
}

// 链接只校验「这个路径属于该工单」；真正的读取仍由项目文件服务在下载/预览时校验敏感文件与越界。
function requireTicketFile(engine, ticketId, requested) {
  const filePath = cleanTicketPath(requested);
  if (!filePath) throw mobileError('文件路径无效', 400);
  const { project } = ticketProjectOf(engine, ticketId);
  if (!project) throw mobileError('这个工单没有关联项目', 404);
  if (!ticketFilePaths(engine, project.id, ticketId).includes(filePath)) throw mobileError('这个文件不属于该工单', 403);
  return { project, path: filePath };
}

function notificationProjection(row) {
  if (!row) return null;
  return {
    id: row.event_id,
    ticketId: row.ticket_id,
    title: row.title,
    status: row.status,
    summary: row.summary,
    createdAt: row.created_at,
    unread: row.read_at === null
  };
}

function mobileNotificationEvent(value) {
  const source = object(value) || {};
  return {
    id: text(source.id, 100),
    ticketId: text(source.ticketId, 100),
    status: text(source.status, 40),
    createdAt: timestamp(source.createdAt),
    unread: source.unread === true
  };
}

export class MobileGateway {
  constructor({
    dataDir,
    now = Date.now,
    pairTtlMs = MOBILE_PAIR_TTL_MS,
    deviceTtlMs = MOBILE_DEVICE_TTL_MS,
    maxClaimAttempts = MOBILE_MAX_CLAIM_ATTEMPTS,
    claimWindowMs = MOBILE_PAIR_TTL_MS,
    requestLimit = MOBILE_REQUEST_LIMIT,
    requestWindowMs = MOBILE_REQUEST_WINDOW_MS,
    heartbeatMs = MOBILE_HEARTBEAT_MS
  } = {}) {
    if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('MobileGateway 需要 dataDir');
    mkdirSync(dataDir, { recursive: true });
    this.now = now;
    this.pairTtlMs = pairTtlMs;
    this.deviceTtlMs = deviceTtlMs;
    this.maxClaimAttempts = maxClaimAttempts;
    this.claimWindowMs = claimWindowMs;
    this.requestLimit = requestLimit;
    this.requestWindowMs = requestWindowMs;
    this.heartbeatMs = heartbeatMs;
    this.dbPath = path.join(dataDir, 'mobile.sqlite');
    this.db = new DatabaseSync(this.dbPath);
    this.rateEntries = new Map();
    this.clients = new Map();
    this.closed = false;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS mobile_pairs (
        code_hash TEXT PRIMARY KEY, code_salt TEXT NOT NULL, owner_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, claimed_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mobile_pairs_owner ON mobile_pairs(owner_id, claimed_at);
      CREATE TABLE IF NOT EXISTS mobile_devices (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS mobile_devices_owner ON mobile_devices(owner_id, revoked_at);
      CREATE TABLE IF NOT EXISTS mobile_claim_attempts (
        actor_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mobile_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL, event_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
        created_at TEXT NOT NULL, read_at INTEGER, UNIQUE(owner_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS mobile_notifications_owner_created ON mobile_notifications(owner_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS mobile_notifications_owner_read ON mobile_notifications(owner_id, read_at);`);
  }

  createPair(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128) throw mobileError('移动配对不可用', 401);
    const createdAt = nowMs(this.now);
    const expiresAt = createdAt + this.pairTtlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 只清理全局过期记录和本账号的旧码；旧实现没有 owner 条件，任意账号生成
      // 配对码都会删掉其他账号尚未领取的码（云端所有租户共用一张表）。
      this.db.prepare('DELETE FROM mobile_pairs WHERE expires_at<=? OR owner_id=?').run(createdAt, ownerId);
      let code = '';
      let digest = '';
      let salt = '';
      for (let attempt = 0; attempt < 32; attempt++) {
        code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        salt = randomBytes(16).toString('hex');
        digest = pairDigest(salt, code);
        const inserted = this.db.prepare('INSERT OR IGNORE INTO mobile_pairs(code_hash,code_salt,owner_id,expires_at,claimed_at,created_at) VALUES(?,?,?,?,NULL,?)').run(digest, salt, ownerId, expiresAt, createdAt);
        if (inserted.changes) break;
        digest = '';
      }
      if (!digest) throw mobileError('暂时无法生成配对码，请稍后重试', 503);
      this.db.exec('COMMIT');
      return { code, expiresAt: iso(expiresAt) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  claim(code, deviceName, actorKey = 'unknown') {
    const current = nowMs(this.now);
    const actorHash = tokenHash(String(actorKey || 'unknown').slice(0, 200));
    this.pruneClaimAttempts(current);
    const attempts = this.db.prepare('SELECT * FROM mobile_claim_attempts WHERE actor_hash=?').get(actorHash);
    if (attempts?.window_start > current - this.claimWindowMs && attempts.attempts >= this.maxClaimAttempts) {
      throw mobileError('配对尝试次数过多，请稍后再试', 429);
    }
    const value = typeof code === 'string' ? code.trim() : '';
    let matched = null;
    if (/^\d{6}$/.test(value)) {
      for (const pair of this.db.prepare('SELECT * FROM mobile_pairs WHERE claimed_at IS NULL AND expires_at>?').all(current)) {
        const digest = pairDigest(pair.code_salt, value);
        if (equalHash(pair.code_hash, digest)) { matched = pair; break; }
      }
    }
    if (!matched) {
      this.recordClaimFailure(actorHash, current);
      throw mobileError('移动配对码无效或已过期', 401);
    }

    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const expiresAt = current + this.deviceTtlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const fresh = this.db.prepare('SELECT * FROM mobile_pairs WHERE code_hash=? AND claimed_at IS NULL AND expires_at>?').get(matched.code_hash, current);
      if (!fresh) throw mobileError('移动配对码无效或已过期', 401);
      const claimed = this.db.prepare('UPDATE mobile_pairs SET claimed_at=? WHERE code_hash=? AND claimed_at IS NULL').run(current, matched.code_hash);
      if (!claimed.changes) throw mobileError('移动配对码无效或已过期', 401);
      this.db.prepare('INSERT INTO mobile_devices(id,owner_id,name,token_hash,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,NULL)').run(id, fresh.owner_id, cleanDeviceName(deviceName), tokenHash(token), current, expiresAt);
      this.db.prepare('DELETE FROM mobile_claim_attempts WHERE actor_hash=?').run(actorHash);
      this.db.exec('COMMIT');
      return { deviceId: id, deviceToken: token, expiresAt: iso(expiresAt) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  recordClaimFailure(actorHash, current) {
    const previous = this.db.prepare('SELECT * FROM mobile_claim_attempts WHERE actor_hash=?').get(actorHash);
    if (!previous || previous.window_start <= current - this.claimWindowMs) {
      this.db.prepare('INSERT INTO mobile_claim_attempts(actor_hash,window_start,attempts) VALUES(?,?,1) ON CONFLICT(actor_hash) DO UPDATE SET window_start=excluded.window_start,attempts=1').run(actorHash, current);
      return;
    }
    this.db.prepare('UPDATE mobile_claim_attempts SET attempts=attempts+1 WHERE actor_hash=?').run(actorHash);
  }

  pruneClaimAttempts(current) {
    this.db.prepare('DELETE FROM mobile_claim_attempts WHERE window_start<=?').run(current - this.claimWindowMs);
  }

  listDevices(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) throw mobileError('设备认证失败，请重新配对', 401);
    const current = nowMs(this.now);
    return this.db.prepare('SELECT id,name,created_at,expires_at FROM mobile_devices WHERE owner_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,rowid DESC').all(ownerId, current)
      .map(row => ({ id: row.id, name: row.name, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at) }));
  }

  revokeDevice(ownerId, id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) return false;
    const result = this.db.prepare('UPDATE mobile_devices SET revoked_at=? WHERE id=? AND owner_id=? AND revoked_at IS NULL').run(nowMs(this.now), id, ownerId);
    if (!result.changes) return false;
    this.closeDeviceConnections(id);
    return true;
  }

  authenticateRequest(req, { ownerId } = {}) {
    const token = requestToken(req);
    if (!token) throw mobileError('设备认证失败，请重新配对', 401);
    return this.authenticateToken(token, { ownerId, consume: true });
  }

  authenticateToken(token, { ownerId, consume = true } = {}) {
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw mobileError('设备认证失败，请重新配对', 401);
    const current = nowMs(this.now);
    const hash = tokenHash(token);
    const row = this.db.prepare('SELECT * FROM mobile_devices WHERE token_hash=?').get(hash);
    if (!row || row.revoked_at !== null || row.expires_at <= current || (ownerId !== undefined && row.owner_id !== ownerId)) {
      throw mobileError('设备认证失败，请重新配对', 401);
    }
    if (consume) this.consumeRate(row.id, current);
    return { id: row.id, ownerId: row.owner_id, name: row.name, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), tokenHash: hash };
  }

  consumeRate(deviceId, current = nowMs(this.now)) {
    let entry = this.rateEntries.get(deviceId);
    if (!entry || entry.startedAt <= current - this.requestWindowMs) {
      entry = { count: 0, startedAt: current };
      this.rateEntries.set(deviceId, entry);
    }
    if (entry.count >= this.requestLimit) throw mobileError('设备请求过于频繁，请稍后再试', 429);
    entry.count++;
    if (this.rateEntries.size > 10000) {
      for (const [key, value] of this.rateEntries) if (value.startedAt <= current - this.requestWindowMs) this.rateEntries.delete(key);
    }
  }

  recordNotification(ownerId, event) {
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 || !['ticket', 'usage-alert'].includes(event?.type)) return null;
    const payload = object(event.payload);
    if (!payload || !notificationStatuses.has(payload.status)) return null;
    const eventId = bounded(event.id, 100);
    const ticketId = bounded(event.ticketId || payload.id, 100);
    if (!eventId || !ticketId) return null;
    const current = nowMs(this.now);
    const createdAt = timestamp(event.createdAt) || iso(current);
    const title = text(payload.title, 100) ?? '';
    const summary = text(payload.summary, 400) ?? '';
    let inserted;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      inserted = this.db.prepare('INSERT OR IGNORE INTO mobile_notifications(owner_id,event_id,ticket_id,status,title,summary,created_at,read_at) VALUES(?,?,?,?,?,?,?,NULL)')
        .run(ownerId, eventId, ticketId, payload.status, title, summary, createdAt);
      if (inserted.changes) {
        this.db.prepare(`DELETE FROM mobile_notifications WHERE owner_id=? AND id NOT IN (
          SELECT id FROM mobile_notifications WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT ?
        )`).run(ownerId, ownerId, MOBILE_NOTIFICATION_MAX);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    if (!inserted.changes) return null;
    return notificationProjection(this.db.prepare('SELECT * FROM mobile_notifications WHERE owner_id=? AND event_id=?').get(ownerId, eventId));
  }

  listNotifications(ownerId, { limit = MOBILE_NOTIFICATION_DEFAULT_LIMIT } = {}) {
    if (typeof ownerId !== 'string' || !ownerId) return [];
    const amount = Number.isSafeInteger(limit) ? Math.max(1, Math.min(MOBILE_NOTIFICATION_MAX, limit)) : MOBILE_NOTIFICATION_DEFAULT_LIMIT;
    return this.db.prepare('SELECT * FROM mobile_notifications WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT ?').all(ownerId, amount)
      .map(notificationProjection);
  }

  unreadNotificationCount(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) return 0;
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM mobile_notifications WHERE owner_id=? AND read_at IS NULL').get(ownerId)?.count || 0);
  }

  markNotificationRead(ownerId, id) {
    if (typeof ownerId !== 'string' || !ownerId) return null;
    const eventId = bounded(id, 100);
    if (!eventId) return null;
    this.db.prepare('UPDATE mobile_notifications SET read_at=? WHERE owner_id=? AND event_id=? AND read_at IS NULL').run(nowMs(this.now), ownerId, eventId);
    const notification = notificationProjection(this.db.prepare('SELECT * FROM mobile_notifications WHERE owner_id=? AND event_id=?').get(ownerId, eventId));
    if (!notification) return null;
    return { notification, unread: this.unreadNotificationCount(ownerId) };
  }

  markAllNotificationsRead(ownerId) {
    if (typeof ownerId !== 'string' || !ownerId) return 0;
    return Number(this.db.prepare('UPDATE mobile_notifications SET read_at=? WHERE owner_id=? AND read_at IS NULL').run(nowMs(this.now), ownerId).changes || 0);
  }

  deviceCurrent(client) {
    const current = nowMs(this.now);
    const row = this.db.prepare('SELECT id,owner_id,token_hash,expires_at,revoked_at FROM mobile_devices WHERE id=?').get(client.deviceId);
    return Boolean(row && row.owner_id === client.ownerId && row.token_hash === client.tokenHash && row.revoked_at === null && row.expires_at > current);
  }

  connect(req, res, { ownerId, device, onConnect } = {}) {
    if (this.closed) throw mobileError('移动网关已关闭', 503);
    const authenticated = device || (req?.mobileAuthenticated === true && req.mobileDevice) || this.authenticateRequest(req, { ownerId });
    if (!authenticated || (ownerId !== undefined && authenticated.ownerId !== ownerId)) throw mobileError('设备认证失败，请重新配对', 401);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const client = { res, deviceId: authenticated.id, ownerId: authenticated.ownerId, tokenHash: authenticated.tokenHash, timer: null };
    const cleanup = () => {
      if (client.timer) clearInterval(client.timer);
      client.timer = null;
      const set = this.clients.get(client.deviceId);
      set?.delete(client);
      if (set && !set.size) this.clients.delete(client.deviceId);
    };
    this.clients.set(client.deviceId, this.clients.get(client.deviceId) || new Set());
    this.clients.get(client.deviceId).add(client);
    res.write(': connected\n\n');
    client.timer = setInterval(() => {
      if (!this.deviceCurrent(client)) { cleanup(); res.end(); return; }
      try { res.write(': heartbeat\n\n'); } catch { cleanup(); res.end(); }
    }, this.heartbeatMs);
    client.timer.unref?.();
    res.on('close', cleanup);
    onConnect?.(req, res);
    return authenticated;
  }

  publishToOwner(ownerId, data) {
    for (const [deviceId, clients] of [...this.clients]) {
      for (const client of [...clients]) {
        if (client.ownerId !== ownerId) continue;
        try { client.res.write(data); }
        catch {
          if (client.timer) clearInterval(client.timer);
          clients.delete(client);
          if (!clients.size) this.clients.delete(deviceId);
        }
      }
    }
  }

  publishNotification(ownerId, notification) {
    if (!notification) return;
    this.publishToOwner(ownerId, `event: notification\ndata: ${JSON.stringify(mobileNotificationEvent(notification))}\n\n`);
  }

  publish(ownerId, event) {
    let notification = null;
    try { notification = this.recordNotification(ownerId, event); } catch { /* Notification persistence must not break Work delivery. */ }
    this.publishNotification(ownerId, notification);
    this.publishToOwner(ownerId, `data: ${JSON.stringify(mobileWorkEvent(event))}\n\n`);
  }

  closeDeviceConnections(deviceId) {
    const set = this.clients.get(deviceId);
    if (!set) return;
    for (const client of [...set]) {
      if (client.timer) clearInterval(client.timer);
      try { client.res.end(); } catch { /* Best-effort revocation. */ }
      set.delete(client);
    }
    this.clients.delete(deviceId);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const deviceId of [...this.clients.keys()]) this.closeDeviceConnections(deviceId);
    this.rateEntries.clear();
    this.db.close();
  }
}

export function registerMobilePairingRoutes(app, gateway, { desktopOwner } = {}) {
  app.post('/api/mobile/pair', (req, res) => {
    if (hasDeviceToken(req)) throw mobileError('请在桌面端登录后生成配对码', 401);
    const ownerId = desktopOwner?.(req);
    if (typeof ownerId !== 'string' || !ownerId) throw mobileError('请先在桌面端登录', 401);
    res.status(201).json(gateway.createPair(ownerId));
  });
  app.post('/api/mobile/pair/claim', (req, res) => {
    res.status(201).json(gateway.claim(req.body?.code, req.body?.deviceName, req.ip || req.socket?.remoteAddress || 'unknown'));
  });
  app.get('/api/mobile/devices', (req, res) => {
    const ownerId = hasDeviceToken(req) ? gateway.authenticateRequest(req).ownerId : desktopOwner?.(req);
    if (typeof ownerId !== 'string' || !ownerId) throw mobileError('请先在桌面端登录', 401);
    res.json({ devices: gateway.listDevices(ownerId) });
  });
  app.delete('/api/mobile/devices/:id', (req, res) => {
    const ownerId = hasDeviceToken(req) ? gateway.authenticateRequest(req).ownerId : desktopOwner?.(req);
    if (typeof ownerId !== 'string' || !ownerId) throw mobileError('请先在桌面端登录', 401);
    if (!gateway.revokeDevice(ownerId, req.params.id)) throw mobileError('设备不存在', 404);
    res.json({ ok: true });
  });
}

export function registerMobileWorkRoutes(app, gateway, { engine, executors, ownerId, onConnect } = {}) {
  if (!gateway || !engine) throw new TypeError('移动 Work 路由需要 gateway 与 engine');
  const auth = req => {
    if (req.mobileAuthenticated === true && req.mobileDevice) {
      if (req.mobileDevice.ownerId !== ownerId) throw mobileError('设备认证失败，请重新配对', 401);
      return req.mobileDevice;
    }
    return gateway.authenticateRequest(req, { ownerId });
  };
  const MOBILE_AGENT_KINDS = new Set(['model', 'cli']);
  const LAGENT_ID = 'model';
  const readText = (value, max, message) => {
    const result = typeof value === 'string' ? value.trim() : '';
    if (!result || result.length > max) throw mobileError(message, 400);
    return result;
  };
  const mobileProfile = id => (app.locals.modelHub?.publicState?.()?.profiles || []).find(item => item.id === id);
  // 协作方只接受已注册、可用、model/cli 类型且在策略白名单内的 Agent。
  const collaboratorIds = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw mobileError('agentIds 必须是数组', 400);
    const ids = [...new Set(value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean))];
    if (ids.length > 3) throw mobileError('多 Agent 模式最多选择 3 个协作 Agent', 400);
    const list = executors?.list?.() || [];
    const policy = engine.policy?.() || {};
    const allowed = new Set(Array.isArray(policy.allowedExecutors) ? policy.allowedExecutors : []);
    for (const id of ids) {
      if (id === LAGENT_ID) throw mobileError('Lagent 由主控自动加入', 400);
      const agent = list.find(item => item.id === id);
      if (!agent || !MOBILE_AGENT_KINDS.has(agent.kind)) throw mobileError(`「${id}」不是可协作的 Agent`, 400);
      if (!agent.available) throw mobileError(`「${agent.name || id}」当前不可用`, 400);
      if (allowed.size && !allowed.has(id)) throw mobileError(`「${agent.name || id}」不在允许的执行器范围内`, 403);
    }
    return ids;
  };
  const settingsOf = value => {
    const settings = sanitizeMobileSettings(value);
    if (settings?.profileId) {
      const profile = mobileProfile(settings.profileId);
      if (!profile || profile.unavailable) throw mobileError('所选模型不可用', 400);
    }
    return settings;
  };
  app.get('/api/mobile/bootstrap', (req, res) => {
    const device = auth(req);
    res.json(sanitizeMobileBootstrap(engine.bootstrap(), { unread: gateway.unreadNotificationCount(device.ownerId) }));
  });
  app.get('/api/mobile/models', (req, res) => {
    auth(req);
    const state = app.locals.modelHub?.publicState?.() || {};
    const efforts = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
    res.json({
      profiles: (Array.isArray(state.profiles) ? state.profiles : []).map(profile => ({
        id: String(profile.id),
        name: String(profile.name || profile.id).slice(0, 80),
        model: String(profile.model || '').slice(0, 120),
        available: profile.unavailable !== true,
        efforts: ['default', ...new Set((Array.isArray(profile.capabilities?.efforts) ? profile.capabilities.efforts : []).filter(item => efforts.includes(item)))]
      })),
      defaultProfileId: state.workflow?.defaultProfileId || null
    });
  });
  app.get('/api/mobile/conversations', (req, res) => {
    auth(req);
    let limit = 60;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) throw mobileError('会话数量参数无效');
      limit = Number(req.query.limit);
      if (limit < 1 || limit > 100) throw mobileError('会话数量参数无效');
    }
    const result = engine.listConversations(limit);
    res.json({ conversations: (result?.conversations || []).map(sanitizeMobileConversationSummary).filter(Boolean) });
  });
  app.post('/api/mobile/conversations', (req, res) => {
    auth(req);
    const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
    if (goal.length > 4000) throw mobileError('会话目标不能超过 4000 字', 400);
    const title = req.body?.title === undefined ? '' : readText(req.body.title, 200, '会话标题须为 1–200 字');
    const collaborators = collaboratorIds(req.body?.agentIds);
    let projectId;
    if (req.body?.projectId !== undefined) {
      if (typeof req.body.projectId !== 'string' || !req.body.projectId.trim()) throw mobileError('项目 id 无效', 400);
      projectId = req.body.projectId.trim();
    }
    const result = engine.createConversation({
      title: title || (goal ? goal.split('\n')[0].slice(0, 60) : undefined),
      goal,
      ...(projectId ? { projectId } : {}),
      agentIds: [LAGENT_ID, ...collaborators]
    });
    res.status(201).json({ conversation: sanitizeMobileConversationSummary(result?.conversation) });
  });
  app.get('/api/mobile/conversations/:id', (req, res) => {
    auth(req);
    let limit = 30;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) throw mobileError('分页参数无效');
      limit = Number(req.query.limit);
      if (limit < 1 || limit > 50) throw mobileError('分页参数无效');
    }
    let before = null;
    if (req.query.before !== undefined) {
      if (typeof req.query.before !== 'string' || !/^\d+$/.test(req.query.before)) throw mobileError('分页参数无效');
      before = Number(req.query.before);
    }
    const result = engine.getConversation(req.params.id);
    const page = pageMobileTurns(result?.conversation?.turns, { limit, before });
    const ticketIds = new Set();
    for (const turn of page.turns) {
      for (const run of Array.isArray(turn.runs) ? turn.runs : []) if (run.ticketId) ticketIds.add(run.ticketId);
      if (turn.synthesisTicketId) ticketIds.add(turn.synthesisTicketId);
    }
    res.json({
      conversation: {
        ...sanitizeMobileConversationSummary(result?.conversation),
        turns: page.turns.map(sanitizeMobileTurn).filter(Boolean),
        hasMore: page.hasMore,
        nextBefore: page.nextBefore
      },
      tickets: (result?.tickets || []).filter(ticket => ticketIds.has(ticket.id)).map(sanitizeMobileTicket).filter(Boolean)
    });
  });
  app.patch('/api/mobile/conversations/:id', (req, res) => {
    auth(req);
    const title = readText(req.body?.title, 200, '会话标题须为 1–200 字');
    res.json({ conversation: sanitizeMobileConversationSummary(engine.renameConversation(req.params.id, { title })?.conversation) });
  });
  app.delete('/api/mobile/conversations/:id', (req, res) => {
    auth(req);
    res.json({ ok: true, ...engine.deleteConversation(req.params.id) });
  });
  app.post('/api/mobile/conversations/:id/messages', async (req, res) => {
    auth(req);
    const text = readText(req.body?.text, 3000, '消息须为 1–3000 字');
    const mode = req.body?.mode === 'multi' ? 'multi' : 'auto';
    let agentIds = [LAGENT_ID];
    if (mode === 'multi') {
      const collaborators = collaboratorIds(req.body?.agentIds);
      if (!collaborators.length) throw mobileError('多 Agent 模式至少选择一个协作 Agent', 400);
      agentIds = [LAGENT_ID, ...collaborators];
    }
    const settings = settingsOf(req.body?.settings);
    const efforts = sanitizeMobileEfforts(req.body?.efforts, agentIds);
    let clientRequestId = '';
    if (req.body?.clientRequestId !== undefined) {
      if (typeof req.body.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(req.body.clientRequestId.trim())) {
        throw mobileError('clientRequestId 无效', 400);
      }
      clientRequestId = req.body.clientRequestId.trim();
    }
    const result = await engine.conversationMessage(req.params.id, { text, mode, agentIds, settings, efforts, clientRequestId, autoRun: true });
    res.status(201).json({
      conversation: sanitizeMobileConversationSummary(result?.conversation),
      turn: sanitizeMobileTurn(result?.turn),
      tickets: (result?.tickets || []).map(sanitizeMobileTicket).filter(Boolean)
    });
  });
  app.get('/api/mobile/reports/:id/text', (req, res) => {
    auth(req);
    const result = engine.reportText(req.params.id);
    res.json(clipReportText(result?.text, 200000));
  });
  app.post('/api/mobile/tickets/:id/permissions/:requestId', (req, res) => {
    auth(req);
    const decision = req.body?.decision;
    if (decision !== 'allow' && decision !== 'deny') throw mobileError('授权决定只能是 allow 或 deny', 400);
    const result = engine.permissionDecision(req.params.id, req.params.requestId, decision);
    res.json({ ticket: sanitizeMobileTicket(result?.ticket) });
  });
  app.get('/api/mobile/policy', (req, res) => { auth(req); res.json({ policy: sanitizeMobilePolicy(engine.policy()) }); });
  app.get('/api/mobile/notifications', (req, res) => {
    const device = auth(req);
    let limit = MOBILE_NOTIFICATION_DEFAULT_LIMIT;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) throw mobileError('通知数量参数无效');
      limit = Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MOBILE_NOTIFICATION_MAX) throw mobileError('通知数量参数无效');
    }
    res.json({ notifications: gateway.listNotifications(device.ownerId, { limit }), unread: gateway.unreadNotificationCount(device.ownerId) });
  });
  app.post('/api/mobile/notifications/read-all', (req, res) => {
    const device = auth(req);
    gateway.markAllNotificationsRead(device.ownerId);
    res.json({ ok: true, unread: 0 });
  });
  app.post('/api/mobile/notifications/:id/read', (req, res) => {
    const device = auth(req);
    const result = gateway.markNotificationRead(device.ownerId, req.params.id);
    if (!result) throw mobileError('通知不存在', 404);
    res.json({ ok: true, ...result });
  });
  // 移动端不直接派外部 Agent：先在 Lagent 会话里建一轮，由主控拆分与汇总。
  const toolExecutors = new Set(['terminal', 'browser', 'github', 'model', 'window']);
  app.post('/api/mobile/command', async (req, res) => {
    auth(req);
    const input = {};
    for (const key of ['text', 'clientRequestId', 'executorId', 'executorInput']) if (req.body?.[key] !== undefined) input[key] = req.body[key];
    if (input.executorId && !toolExecutors.has(input.executorId)) {
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      const conversation = engine.createConversation({ title: text.slice(0, 60), goal: text }).conversation;
      const result = await engine.conversationMessage(conversation.id, {
        text,
        agentIds: [input.executorId],
        ...(typeof input.clientRequestId === 'string' ? { clientRequestId: input.clientRequestId } : {}),
        autoRun: true
      });
      return res.status(201).json({ ticket: sanitizeMobileTicket(result.tickets?.[0]), conversationId: conversation.id });
    }
    res.status(201).json({ ticket: sanitizeMobileTicket(engine.command(input)) });
  });
  app.get('/api/mobile/tickets/:id', (req, res) => { auth(req); res.json(sanitizeMobileDetail(engine.detail(req.params.id))); });
  // 工单产物：只列这次执行改动/产出的文件，路径、大小和预览类型都来自项目文件服务。
  app.get('/api/mobile/tickets/:id/files', async (req, res) => {
    auth(req);
    const { project, entries } = await ticketFileOf(app, engine, req.params.id);
    res.json({
      project: project ? { id: project.id, name: project.name } : null,
      files: entries,
      ...(project && !entries.length ? { message: '这次执行没有记录到可下载的文件。' } : {}),
      ...(!project ? { message: '这个工单没有关联项目，暂时没有可下载的文件。' } : {})
    });
  });
  app.get('/api/mobile/tickets/:id/file/preview', async (req, res) => {
    auth(req);
    const { project, path: filePath } = requireTicketFile(engine, req.params.id, req.query?.path);
    const node = projectFileRelay(app, project);
    if (node) return res.json(await app.locals.nodeHub.requestFile(node.nodeId, { op: 'preview', workspace: project.path, path: filePath }));
    res.json(await engine.projectFilePreview(project.id, filePath));
  });
  // 下载和 PDF/图片预览都走短期签名 URL：WebView 的下载器只认普通 http(s) 地址。
  app.post('/api/mobile/tickets/:id/file/link', (req, res) => {
    const device = auth(req);
    const { project, path: filePath } = requireTicketFile(engine, req.params.id, req.body?.path);
    const download = req.body?.download === true;
    const name = basenamePosix(filePath).slice(0, 200);
    const mime = projectFileMime(name);
    const expiresAt = Date.now() + MOBILE_FILE_TOKEN_TTL_MS;
    const token = signMobileFile({ ownerId: device.ownerId, projectId: project.id, path: filePath, download, expiresAt, name, mime });
    res.json({ url: `/api/mobile/files/${token}`, name, mime, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.get('/api/mobile/files/:token', async (req, res, next) => {
    const payload = readMobileFile(req.params.token);
    if (!payload) throw mobileError('下载链接已过期或无效，请重新打开文件', 401);
    const project = engine.getProject(payload.projectId);
    const node = projectFileRelay(app, project);
    const name = payload.name || basenamePosix(payload.path);
    const mime = payload.mime || projectFileMime(name);
    let absolute = '';
    let cleanup = null;
    if (node) {
      const uploaded = await app.locals.nodeHub.requestFile(node.nodeId, { op: 'read', workspace: project.path, path: payload.path });
      absolute = uploaded.path;
      cleanup = uploaded.cleanup || null;
    } else {
      absolute = engine.projectFileSource(project.id, payload.path).absolute;
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', fileDisposition(name, payload.download === true));
    // 在 iframe 里打开项目 HTML/SVG 时按沙箱处理，和桌面端预览的边界保持一致。
    if (payload.download !== true && ['html', 'htm', 'svg'].includes(String(name).split('.').pop()?.toLowerCase() || '')) {
      res.setHeader('Content-Security-Policy', 'sandbox');
    }
    res.sendFile(absolute, error => {
      cleanup?.();
      if (!error) return;
      if (res.headersSent) res.end();
      else next(error);
    });
  });
  app.post('/api/mobile/tickets/:id/actions', (req, res) => {
    auth(req);
    if (req.body?.action === 'handoff') {
      const result = engine.handoff(req.params.id, req.body?.input);
      return res.status(result.created ? 201 : 200).json({ ticket: sanitizeMobileTicket(result.ticket) });
    }
    res.json({ ticket: sanitizeMobileTicket(engine.action(req.params.id, req.body?.action, req.body?.input)) });
  });
  app.get('/api/mobile/events', (req, res) => {
    const device = auth(req);
    gateway.connect(req, res, { ownerId, device, onConnect });
  });
}
