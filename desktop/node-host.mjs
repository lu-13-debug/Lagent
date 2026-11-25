#!/usr/bin/env node
/**
 * 本机执行节点。
 *
 * 由桌面端在连接云端服务后拉起：扫描本机装了哪些 CLI Agent，注册到账号下，
 * 然后长轮询领任务，在本机执行，把过程与结果回传。执行部分直接复用
 * server/work/executors 里的 CLI 封装，行为与本地模式完全一致。
 *
 * 环境变量：
 *   LAGENT_NODE_URL        服务根地址，例如 https://lagent.site
 *   LAGENT_NODE_COOKIE     登录后的 Cookie 头，只在注册时用一次
 *   LAGENT_NODE_STATE      节点状态目录（存 nodeId / token）
 *   LAGENT_NODE_WORKSPACE  默认工作目录，默认 ~/Lagent Workspace
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { claudeCodeExecutor } from '../server/work/executors/claude-code.js';
import { codexExecutor } from '../server/work/executors/codex.js';
import { localAgentExecutors } from '../server/work/executors/local-agent.js';
import { createProviderRegistry } from '../server/work/providers.js';
import { createProjectFiles } from '../server/work/project-files.js';

const origin = String(process.env.LAGENT_NODE_URL || '').replace(/\/+$/, '');
const stateDir = process.env.LAGENT_NODE_STATE || path.join(homedir(), '.lagent-node');
const workspace = process.env.LAGENT_NODE_WORKSPACE || path.join(homedir(), 'Lagent Workspace');
const stateFile = path.join(stateDir, 'node-state.json');
const log = (...args) => console.log(new Date().toISOString(), ...args);

if (!origin) {
  console.error('缺少 LAGENT_NODE_URL');
  process.exit(1);
}

mkdirSync(stateDir, { recursive: true });
try { mkdirSync(workspace, { recursive: true }); } catch { /* 用默认目录失败时下面会报错。 */ }

// CLI 执行器需要一个能按 kind/id 存取任务的 store；节点只在内存里保留任务。
const tasks = new Map();
const store = {
  put: (kind, body) => { tasks.set(`${kind}:${body.id}`, body); return body; },
  get: (kind, id) => tasks.get(`${kind}:${id}`) || undefined
};

// Claude Code / Codex 有专门的结构化解析；其余（opencode、dsh、gemini 等）用通用适配器。
const executors = [
  claudeCodeExecutor({ store, cwd: workspace }),
  codexExecutor({ store, cwd: workspace }),
  ...localAgentExecutors({ store, cwd: workspace })
];
const agents = executors
  .filter(executor => executor.available)
  .map(executor => ({ id: executor.id, name: executor.name, kind: executor.kind, capabilities: executor.capabilities || [] }));

if (!agents.length) {
  log('本机没有检测到可用的 CLI Agent（claude / codex），节点退出。');
  process.exit(0);
}
log(`检测到本机 Agent：${agents.map(agent => agent.name).join('、')}；工作目录：${workspace}`);

// 云端探测跑在服务器上，看不到这台电脑装了什么。节点用同一套探测在本机跑一遍，
// 把「装了但暂时没有可调用适配器」的产品（WorkBuddy、桌面版、仅识别的 CLI）也报上去。
const providerRegistry = createProviderRegistry({ env: process.env });
const detectedProducts = (async () => {
  try {
    const snapshots = await providerRegistry.snapshots({ force: true });
    const products = snapshots.filter(item => item.installed).map(item => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      version: item.version || '',
      command: item.command || '',
      status: item.status === 'ready' ? 'ready' : item.status,
      // 只有这台电脑真的能调起来的才给执行器 id；WorkBuddy 这类桌面产品只做识别。
      executorId: executors.some(executor => executor.id === item.executorId) ? item.executorId : ''
    }));
    if (products.length) log(`本机已安装的产品：${products.map(product => product.name).join('、')}`);
    return products;
  } catch (error) {
    log(`本机产品探测失败：${error?.message || error}`);
    return [];
  }
})();

function readState() {
  try {
    const value = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (value && typeof value.token === 'string' && typeof value.nodeId === 'string') return value;
  } catch { /* 首次启动没有状态文件。 */ }
  return null;
}

function saveState(state) {
  try { writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 }); } catch { /* 写不进去就每次重新注册。 */ }
}

// 登录凭据由桌面端写到这个文件里：用户可能在节点启动后才登录，所以每次注册都重新读。
function readCookie() {
  try {
    const value = readFileSync(path.join(stateDir, 'session-cookie.txt'), 'utf8').trim();
    if (value) return value;
  } catch { /* 还没登录 */ }
  return String(process.env.LAGENT_NODE_COOKIE || '');
}

async function register() {
  // 本地服务不需要登录；云端没登录时会返回 401，外层会隔一会儿重试。
  const cookie = readCookie();
  const response = await fetch(`${origin}/api/node/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ agents, detected: await detectedProducts, features: ['files'] })
  });
  if (!response.ok) throw new Error(`注册失败：HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  const state = { nodeId: body.nodeId, token: body.token };
  saveState(state);
  log(`节点已注册：${body.nodeId}`);
  return state;
}

async function call(pathname, init = {}, state) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${state.token}`, 'content-type': 'application/json' }
  });
  return response;
}

const signature = task => `${task?.status || ''}|${Array.isArray(task?.activity) ? task.activity.length : 0}|${Array.isArray(task?.activity) ? (task.activity.at(-1)?.text || '').length : 0}`;

async function report(state, jobId, status, task, extra = {}) {
  const payload = {
    status,
    ...(task ? { task: { ...task, id: jobId } } : {}),
    ...extra
  };
  const response = await call(`/api/node/jobs/${encodeURIComponent(jobId)}`, { method: 'POST', body: JSON.stringify(payload) }, state);
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, ...(await response.json()) };
}

function startJob(job) {
  const executor = executors.find(item => item.id === job.agentId);
  if (!executor) throw new Error(`本机没有执行器 ${job.agentId}`);
  const ticket = { id: job.ticketId || job.id, command: '' };
  const assignment = { id: job.id };
  return executor.start(ticket, assignment, { executorInput: job.input || {} });
}

// 文件请求与 Agent 执行分开：长任务正在跑时，手机仍能预览和下载项目文件。
function describeNodeFiles(service, paths) {
  const groups = new Map();
  for (const filePath of Array.isArray(paths) ? paths : []) {
    if (typeof filePath !== 'string' || !filePath) continue;
    const slash = filePath.lastIndexOf('/');
    const dir = slash < 0 ? '' : filePath.slice(0, slash);
    if (!groups.has(dir)) groups.set(dir, new Set());
    groups.get(dir).add(filePath);
  }
  const found = new Map();
  for (const [dir, members] of groups) {
    try {
      const listing = service.list('node', dir);
      for (const entry of Array.isArray(listing?.entries) ? listing.entries : []) {
        if (!members.has(entry.path) || entry.type !== 'file' || entry.locked) continue;
        found.set(entry.path, entry);
      }
    } catch { /* 文件已删除或目录不可读。 */ }
  }
  return [...groups.values()].flatMap(members => [...members]).map(item => found.get(item)).filter(Boolean);
}

async function runFileJob(state, job) {
  const file = job.file || {};
  try {
    const service = createProjectFiles({ getProject: () => ({ id: 'node', path: String(file.workspace || '') }) });
    if (file.op === 'read') {
      const source = service.file('node', file.path);
      const bytes = readFileSync(source.absolute);
      const response = await fetch(`${origin}/api/node/files/${encodeURIComponent(job.id)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/octet-stream',
          'x-lagent-name': encodeURIComponent(source.name),
          'x-lagent-mime': source.mime
        },
        body: bytes
      });
      if (!response.ok) throw new Error(`文件上传失败：HTTP ${response.status}`);
      log(`已回传文件 ${source.name}（${bytes.length} 字节）`);
      return;
    }
    const result = file.op === 'describe'
      ? { entries: describeNodeFiles(service, file.paths) }
      : await service.preview('node', file.path);
    const response = await call(`/api/node/jobs/${encodeURIComponent(job.id)}`, {
      method: 'POST', body: JSON.stringify({ status: 'completed', result })
    }, state);
    if (!response.ok) throw new Error(`文件结果回传失败：HTTP ${response.status}`);
  } catch (error) {
    try {
      await call(`/api/node/jobs/${encodeURIComponent(job.id)}`, {
        method: 'POST', body: JSON.stringify({ status: 'failed', error: error?.message || '文件读取失败' })
      }, state);
    } catch { /* 节点已断开时服务器会自行超时。 */ }
    log(`文件请求 ${job.id} 失败：${error?.message || error}`);
  }
}

async function runJob(state, job) {
  let task;
  try {
    task = startJob(job);
  } catch (error) {
    await report(state, job.id, 'failed', { id: job.id, ticketId: job.ticketId, status: 'failed', error: error?.message || '本机启动失败', activity: [] });
    log(`任务 ${job.id} 启动失败：${error?.message || error}`);
    return;
  }
  log(`开始执行任务 ${job.id}（${job.agentId}）`);
  let last = '';
  let cancelled = false;
  while (!cancelled) {
    await new Promise(resolve => setTimeout(resolve, 900));
    const current = executors.find(item => item.id === job.agentId)?.get(job.id) || task;
    const status = current?.status || 'running';
    const mark = signature(current);
    if (mark !== last) {
      last = mark;
      const result = await report(state, job.id, status, current);
      if (result.cancelled) {
        cancelled = true;
        try { executors.find(item => item.id === job.agentId)?.stop(current); } catch { /* 已经停了 */ }
      }
    }
    if (['completed', 'failed', 'cancelled'].includes(status)) {
      log(`任务 ${job.id} 结束：${status}`);
      return;
    }
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  let state = readState();
  let refreshing = null;
  const ensureState = async () => {
    if (state) return state;
    if (!refreshing) {
      refreshing = (async () => {
        while (!state) {
          try { state = await register(); }
          catch (error) {
            log(`等待注册：${error?.message || error}`);
            await sleep(10_000);
          }
        }
        return state;
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  };
  await ensureState();

  // 第二个长轮询只领文件请求，避免 Agent 长任务把手机预览卡住。
  const fileLoop = async () => {
    for (;;) {
      const current = await ensureState();
      let response;
      try {
        response = await call('/api/node/next?wait=25&kind=file', { method: 'GET' }, current);
      } catch {
        await sleep(3000);
        continue;
      }
      if (response.status === 401 || response.status === 409) { state = null; continue; }
      if (response.status === 204) continue;
      if (!response.ok) { await sleep(3000); continue; }
      const body = await response.json().catch(() => null);
      if (body?.job?.kind === 'file') await runFileJob(current, body.job);
    }
  };
  void fileLoop();

  for (;;) {
    const current = await ensureState();
    let response;
    try {
      response = await call('/api/node/next?wait=25&kind=agent', { method: 'GET' }, current);
    } catch (error) {
      log(`连接服务失败：${error?.message || error}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    if (response.status === 401 || response.status === 409) {
      log('节点令牌失效，重新注册');
      state = null;
      continue;
    }
    if (response.status === 204) continue;
    if (!response.ok) {
      log(`领任务失败：HTTP ${response.status}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }
    const body = await response.json().catch(() => null);
    if (!body?.job) continue;
    await runJob(current, body.job);
  }
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
main().catch(error => {
  console.error(error);
  process.exit(1);
});
