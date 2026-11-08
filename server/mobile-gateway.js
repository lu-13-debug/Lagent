import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { tokenHash } from './accounts.js';

export const MOBILE_PAIR_TTL_MS = 5 * 60 * 1000;
export const MOBILE_DEVICE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const MOBILE_REQUEST_LIMIT = 60;
export const MOBILE_REQUEST_WINDOW_MS = 60 * 1000;
export const MOBILE_HEARTBEAT_MS = 15 * 1000;
export const MOBILE_MAX_CLAIM_ATTEMPTS = 5;
export const MOBILE_NOTIFICATION_MAX = 200;
export const MOBILE_NOTIFICATION_DEFAULT_LIMIT = 50;

export const mobileError = (message, status = 400) => Object.assign(new Error(message), { status });
const iso = value => new Date(value).toISOString();
const nowMs = now => Number(now());
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const text = (value, max = 4000) => typeof value === 'string' ? value.slice(0, max) : undefined;
const integer = value => Number.isSafeInteger(value) ? value : undefined;
const primitive = value => value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' ? value : undefined;
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
const notificationStatuses = new Set(['awaiting_review', 'completed', 'failed', 'blocked', 'cancelled']);

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

export function sanitizeMobileTicket(value) {
  const source = object(value);
  const ticket = pick(source, ['id', 'status', 'stage', 'source', 'executor', 'datasetId', 'createdAt', 'updatedAt']);
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
  return ticket;
}

const sanitizeAssignment = value => pick(value, ['id', 'ticketId', 'executor', 'status', 'startedAt', 'queuedAt', 'endedAt']);
const sanitizeReport = value => {
  const source = object(value);
  const report = pick(source, ['id', 'ticketId', 'assignmentId', 'kind', 'createdAt']);
  if (!report) return null;
  const summary = text(source?.summary, 400);
  if (summary !== undefined) report.summary = summary;
  return report;
};

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
    datasets: Array.isArray(source.datasets) ? source.datasets.slice(0, 50).map(item => pick(item, ['id', 'name', 'rowCount', 'source'])).filter(Boolean) : [],
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
  return result;
}

export function mobileWorkEvent(event) {
  const payload = object(event?.payload) || {};
  const safe = pick(payload, ['status']);
  if (typeof payload.id === 'string' && event?.type === 'report') safe.reportId = payload.id.slice(0, 100);
  return {
    type: String(event?.type || 'event').slice(0, 40),
    ticketId: typeof event?.ticketId === 'string' ? event.ticketId.slice(0, 100) : null,
    payload: safe
  };
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
      this.db.prepare('DELETE FROM mobile_pairs WHERE claimed_at IS NULL OR expires_at<=?').run(createdAt);
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
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 || event?.type !== 'ticket') return null;
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

export function registerMobileWorkRoutes(app, gateway, { engine, ownerId, onConnect } = {}) {
  if (!gateway || !engine) throw new TypeError('移动 Work 路由需要 gateway 与 engine');
  const auth = req => {
    if (req.mobileAuthenticated === true && req.mobileDevice) {
      if (req.mobileDevice.ownerId !== ownerId) throw mobileError('设备认证失败，请重新配对', 401);
      return req.mobileDevice;
    }
    return gateway.authenticateRequest(req, { ownerId });
  };
  app.get('/api/mobile/bootstrap', (req, res) => {
    const device = auth(req);
    res.json(sanitizeMobileBootstrap(engine.bootstrap(), { unread: gateway.unreadNotificationCount(device.ownerId) }));
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
  app.post('/api/mobile/command', (req, res) => {
    auth(req);
    const input = {};
    for (const key of ['text', 'clientRequestId', 'executorId', 'executorInput', 'datasetId']) if (req.body?.[key] !== undefined) input[key] = req.body[key];
    res.status(201).json({ ticket: sanitizeMobileTicket(engine.command(input)) });
  });
  app.get('/api/mobile/tickets/:id', (req, res) => { auth(req); res.json(sanitizeMobileDetail(engine.detail(req.params.id))); });
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
