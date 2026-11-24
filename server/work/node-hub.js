import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 本机执行节点：桌面端在自己的电脑上跑 CLI，把过程与结果回传给云端。
 *
 * 传输只用最朴素的 HTTP：
 *   节点注册 → 长轮询领任务 → 执行时上报快照 → 上报最终结果。
 * 不引入 WebSocket，是因为节点和服务器之间隔着 Nginx/Caddy，长轮询在任何代理下都能用。
 */

const JOB_KIND = 'node-job';
const NODE_JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'];
const AGENT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_ACTIVITY = 40;
const MAX_NODES = 8;
const MAX_AGENTS = 12;
const MAX_PRODUCTS = 32;
const MAX_QUEUE = 32;
export const NODE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const NODE_IDLE_MS = 90_000;

export function loadNodeSecret(dataDir, environment = process.env) {
  const explicit = typeof environment?.LAGENT_NODE_SECRET === 'string' ? environment.LAGENT_NODE_SECRET.trim() : '';
  if (explicit.length >= 16) return explicit;
  const file = path.join(dataDir, 'node-secret');
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length >= 32) return value;
  } catch { /* 首次启动还没有这个文件。 */ }
  const value = randomBytes(32).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, value, { mode: 0o600 });
  } catch { /* 写不进去就只在本次进程内有效，节点会在重启后重新注册。 */ }
  return value;
}

export function signNodeToken(secret, { nodeId, userId, now = Date.now(), ttlMs = NODE_TOKEN_TTL_MS }) {
  const body = Buffer.from(JSON.stringify({ n: nodeId, u: userId, e: now + ttlMs })).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyNodeToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!payload || typeof payload.n !== 'string' || typeof payload.u !== 'string') return null;
  if (!Number.isFinite(payload.e) || payload.e < now) return null;
  return { nodeId: payload.n, userId: payload.u };
}

const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';

function cleanAgents(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const agents = [];
  for (const raw of input.slice(0, MAX_AGENTS)) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
    if (!AGENT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    agents.push({
      id,
      name: text(raw?.name, 40).trim() || id,
      kind: text(raw?.kind, 20).trim() || 'cli',
      capabilities: Array.isArray(raw?.capabilities)
        ? raw.capabilities.filter(item => typeof item === 'string' && item.trim()).slice(0, 8).map(item => item.trim().slice(0, 40))
        : []
    });
  }
  return agents;
}

// 节点上报的「本机已安装产品」：WorkBuddy、桌面版、没有适配器的 CLI 只做识别，
// 有适配器且节点能调起来的才带 executorId。
function cleanProducts(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const products = [];
  for (const raw of input.slice(0, MAX_PRODUCTS)) {
    const id = typeof raw?.id === 'string' ? raw.id.trim().toLowerCase() : '';
    if (!AGENT_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const executorId = typeof raw?.executorId === 'string' ? raw.executorId.trim().toLowerCase() : '';
    products.push({
      id,
      name: text(raw?.name, 60).trim() || id,
      kind: text(raw?.kind, 20).trim() || 'cli',
      version: text(raw?.version, 40).trim(),
      command: text(raw?.command, 300).trim(),
      status: ['ready', 'needs_auth', 'error'].includes(raw?.status) ? raw.status : 'ready',
      executorId: AGENT_ID.test(executorId) ? executorId : ''
    });
  }
  return products;
}

export function createNodeHub({ store, registry, engine = null, now = Date.now, idleMs = NODE_IDLE_MS }) {
  if (!store || typeof store.put !== 'function') throw new TypeError('节点中枢需要 store');
  if (!registry || typeof registry.register !== 'function') throw new TypeError('节点中枢需要支持动态注册的执行器表');
  const nodes = new Map();
  const jobs = new Map();
  const shortId = value => value.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase() || 'node';

  const persist = job => {
    jobs.set(job.id, job);
    try { store.put(JOB_KIND, job); } catch { /* 落盘失败不该打断正在跑的任务。 */ }
  };
  const readJob = id => {
    if (typeof id !== 'string' || !id) return null;
    if (jobs.has(id)) return jobs.get(id);
    try {
      const row = store.get(JOB_KIND, id);
      if (row && row.id) { jobs.set(id, row); return row; }
    } catch { /* 忽略 */ }
    return null;
  };

  const taskOf = job => {
    const base = job.task && typeof job.task === 'object' ? job.task : {};
    return {
      ...base,
      id: job.id,
      ticketId: job.ticketId,
      executorId: job.executorId,
      status: job.status,
      activity: Array.isArray(job.activity) ? job.activity.slice(-MAX_ACTIVITY) : [],
      createdAt: base.createdAt || new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString()
    };
  };

  // 引擎是靠 store 里 task 的变更通知来回收执行器状态的（CLI 执行器自己就写这个表），
  // 节点任务只写 node-job 的话工单会一直停在「执行中」。所以每次进度变化都同步一份 task。
  const publishTask = job => {
    try { store.put('task', taskOf(job)); } catch { /* 通知写不进去不该打断本机任务。 */ }
  };

  const settleWaiters = node => {
    const waiter = node.waiters.shift();
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    waiter.resolve(true);
    return true;
  };

  function createRemoteExecutor(node, agent, executorId) {
    return {
      id: executorId,
      __nodeBacked: true,
      name: `${agent.name}（本机）`,
      kind: agent.kind || 'cli',
      available: true,
      requiresDataset: false,
      capabilities: agent.capabilities,
      // 输入校验在节点上做：服务器只负责把引擎给的 executorInput 原样转发。
      validateInput: input => input && typeof input === 'object' ? input : { prompt: String(input ?? '') },
      defaultInput: value => ({ prompt: String(value ?? '') }),
      start(ticket, assignment, input) {
        if (node.closed) throw Object.assign(new Error('本机节点已断开'), { status: 503, code: 'NODE_OFFLINE' });
        if (node.queue.length >= MAX_QUEUE) throw Object.assign(new Error('本机节点任务队列已满'), { status: 429, code: 'NODE_BUSY' });
        const job = {
          id: `node-job-${randomUUID()}`,
          nodeId: node.nodeId,
          userId: node.userId,
          executorId,
          agentId: agent.id,
          ticketId: typeof ticket?.id === 'string' ? ticket.id : '',
          status: 'queued',
          input: input?.executorInput ?? input ?? {},
          activity: [],
          createdAt: now(),
          updatedAt: now()
        };
        persist(job);
        publishTask(job);
        node.queue.push(job.id);
        settleWaiters(node);
        return taskOf(job);
      },
      get(taskId) {
        const job = readJob(taskId);
        return job && job.nodeId === node.nodeId ? taskOf(job) : null;
      },
      stop(task) {
        const job = readJob(task?.id);
        if (!job) return;
        job.status = 'cancelled';
        job.cancelledAt = now();
        job.updatedAt = job.cancelledAt;
        persist(job);
        publishTask(job);
        settleWaiters(node);
      },
      close() { /* 节点断开时统一在 unregisterNode 里清理。 */ }
    };
  }

  function syncPolicy(ids, remove = false) {
    if (!engine || typeof engine.updatePolicy !== 'function' || !ids.length) return;
    try {
      const current = Array.isArray(engine.policy?.()?.allowedExecutors) ? engine.policy().allowedExecutors : [];
      const next = remove
        ? current.filter(id => !ids.includes(id))
        : [...new Set([...current, ...ids])];
      if (next.length !== current.length || next.some((id, index) => id !== current[index])) {
        engine.updatePolicy({ allowedExecutors: next });
      }
    } catch { /* 策略更新失败不影响节点本身可用。 */ }
  }

  function unregisterNode(nodeId, { reason = '节点已断开' } = {}) {
    const node = nodes.get(nodeId);
    if (!node) return false;
    node.closed = true;
    while (node.waiters.length) {
      const waiter = node.waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
    const executorIds = [...node.executors.values()];
    for (const executorId of executorIds) {
      try { registry.unregister(executorId); } catch { /* 忽略 */ }
    }
    // 被本机节点顶替掉的内置执行器（通常是「未安装」状态）要放回去，否则断开后它凭空消失。
    for (const [executorId, previous] of node.previous || []) {
      try { registry.register(previous); } catch { /* 已经有同名执行器就不覆盖 */ }
    }
    syncPolicy(executorIds, true);
    for (const jobId of node.queue) {
      const job = readJob(jobId);
      if (job && job.status === 'queued') {
        job.status = 'failed';
        job.error = reason;
        job.updatedAt = now();
        persist(job);
      }
    }
    nodes.delete(nodeId);
    return true;
  }

  function registerNode({ nodeId, userId, agents, detected }) {
    if (typeof nodeId !== 'string' || !nodeId || nodeId.length > 80) throw Object.assign(new Error('节点 id 无效'), { status: 400 });
    if (typeof userId !== 'string' || !userId) throw Object.assign(new Error('节点缺少账号'), { status: 400 });
    const list = cleanAgents(agents);
    if (!list.length) throw Object.assign(new Error('节点没有上报任何可用 Agent'), { status: 400 });
    if (!nodes.has(nodeId) && nodes.size >= MAX_NODES) throw Object.assign(new Error('本账号连接的电脑已达上限'), { status: 429 });
    unregisterNode(nodeId);
    const node = { nodeId, userId, agents: [], detected: cleanProducts(detected), executors: new Map(), previous: new Map(), queue: [], waiters: [], lastSeen: now(), closed: false };
    for (const agent of list) {
      const existing = registry.resolve(agent.id);
      // 默认沿用原来的 id（claude-code / codex），界面上的图标、名称和策略都不用改。
      // 只有当同名执行器本来就可用（本地模式）或已被另一台电脑占用时，才退到带节点前缀的 id。
      let executorId = agent.id;
      if (existing && (existing.__nodeBacked || existing.available !== false)) {
        executorId = `node-${shortId(nodeId)}-${agent.id}`.slice(0, 40);
      }
      const occupant = registry.resolve(executorId);
      if (occupant) {
        node.previous.set(executorId, occupant);
        try { registry.unregister(executorId); } catch { continue; }
      }
      try {
        registry.register(createRemoteExecutor(node, agent, executorId));
      } catch { continue; }
      node.executors.set(agent.id, executorId);
      node.agents.push({ ...agent, executorId });
    }
    if (!node.agents.length) throw Object.assign(new Error('节点上报的 Agent 都无法注册'), { status: 409 });
    nodes.set(nodeId, node);
    syncPolicy(node.agents.map(agent => agent.executorId));
    return { nodeId, agents: node.agents.map(agent => ({ ...agent })) };
  }

  function touch(nodeId) {
    const node = nodes.get(nodeId);
    if (!node) return null;
    node.lastSeen = now();
    return node;
  }

  function nextJob(nodeId, waitMs = 25_000) {
    const node = touch(nodeId);
    if (!node) return Promise.resolve(null);
    while (node.queue.length) {
      const job = readJob(node.queue.shift());
      if (job && job.status === 'queued') {
        job.status = 'running';
        job.startedAt = now();
        job.updatedAt = job.startedAt;
        persist(job);
        return Promise.resolve({ job: publicJob(job), task: taskOf(job) });
      }
    }
    const wait = Number.isFinite(waitMs) ? Math.max(0, Math.min(waitMs, 30_000)) : 0;
    if (!wait) return Promise.resolve(null);
    return new Promise(resolve => {
      let entry;
      const timer = setTimeout(() => {
        const index = node.waiters.indexOf(entry);
        if (index >= 0) node.waiters.splice(index, 1);
        resolve(null);
      }, wait);
      timer.unref?.();
      entry = { timer, resolve: ready => {
        if (!ready) { resolve(null); return; }
        const job = readJob(node.queue.shift());
        if (!job || job.status !== 'queued') { resolve(null); return; }
        job.status = 'running';
        job.startedAt = now();
        job.updatedAt = job.startedAt;
        persist(job);
        resolve({ job: publicJob(job), task: taskOf(job) });
      } };
      node.waiters.push(entry);
    });
  }

  function publicJob(job) {
    return {
      id: job.id,
      executorId: job.executorId,
      agentId: job.agentId,
      ticketId: job.ticketId,
      input: job.input,
      createdAt: job.createdAt
    };
  }

  function updateJob(nodeId, jobId, patch) {
    const node = touch(nodeId);
    if (!node) return null;
    const job = readJob(jobId);
    if (!job || job.nodeId !== nodeId) return null;
    const status = NODE_JOB_STATUSES.includes(patch?.status) ? patch.status : job.status;
    const reported = patch?.task && typeof patch.task === 'object' ? patch.task : null;
    const activity = Array.isArray(reported?.activity) ? reported.activity.slice(-MAX_ACTIVITY) : job.activity;
    const next = {
      ...job,
      status: job.status === 'cancelled' ? 'cancelled' : status,
      activity,
      ...(reported ? { task: { ...reported, id: job.id, ticketId: job.ticketId } } : {}),
      updatedAt: now()
    };
    persist(next);
    publishTask(next);
    return { status: next.status, cancelled: next.status === 'cancelled' };
  }

  function hasNodes() { return nodes.size > 0; }
  function listNodes() {
    return [...nodes.values()].map(node => ({
      nodeId: node.nodeId,
      lastSeen: node.lastSeen,
      agents: node.agents.map(agent => ({ ...agent })),
      detected: (node.detected || []).map(product => ({ ...product }))
    }));
  }

  const sweeper = setInterval(() => {
    const cutoff = now() - idleMs;
    for (const node of [...nodes.values()]) {
      if (node.lastSeen < cutoff) unregisterNode(node.nodeId, { reason: '本机节点已离线' });
    }
  }, Math.max(5000, Math.min(30_000, idleMs)));
  sweeper.unref?.();

  return {
    registerNode,
    unregisterNode,
    nextJob,
    updateJob,
    hasNodes,
    listNodes,
    getJob: id => readJob(id),
    close() {
      clearInterval(sweeper);
      for (const node of [...nodes.values()]) unregisterNode(node.nodeId);
    }
  };
}
