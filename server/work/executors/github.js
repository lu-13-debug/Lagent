import { workError } from '../domain.js';

const API_BASE = 'https://api.github.com';
const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const ACTIONS = new Set(['repo', 'issues', 'pulls', 'checks', 'file', 'search']);

function positiveNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function validOwner(value) {
  return typeof value === 'string' && value.length <= 39 && /^[A-Za-z0-9-]+$/.test(value) && !value.startsWith('-') && !value.endsWith('-');
}

function validRepo(value) {
  return typeof value === 'string' && value.length <= 100 && value !== '.' && value !== '..' && /^[A-Za-z0-9._-]+$/.test(value);
}

function validFilePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || Buffer.byteLength(value, 'utf8') > 1024) return false;
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\') || value.includes('\0') || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^[A-Za-z]:/.test(value) || value.includes('?') || value.includes('#')) return false;
  return value.split('/').every(segment => segment && segment !== '.' && segment !== '..');
}

export function validateGithubInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('GitHub 执行器需要查询参数');
  if (!ACTIONS.has(input.action)) throw workError('不支持的 GitHub action');
  // search 只需要关键词：用于「先看看开源项目怎么做」这类调研，不需要预先知道仓库。
  if (input.action === 'search') {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) throw workError('GitHub 搜索关键词须为 1–200 字');
    const limit = input.limit === undefined ? 5 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw workError('GitHub 搜索条数须为 1–20');
    return { action: 'search', query, limit };
  }
  if (!validOwner(input.owner)) throw workError('GitHub owner 格式无效');
  if (!validRepo(input.repo)) throw workError('GitHub repo 格式无效');
  const result = { action: input.action, owner: input.owner, repo: input.repo };
  if (input.number !== undefined && input.number !== null) {
    const number = positiveNumber(input.number);
    if (!number) throw workError('GitHub number 必须为正整数');
    result.number = number;
  }
  if (input.action === 'checks' && !result.number) throw workError('GitHub checks 查询需要 PR number');
  if (input.action === 'file') {
    if (!validFilePath(input.path)) throw workError('GitHub file path 必须为仓库根目录下的安全相对路径');
    result.path = input.path;
  }
  return result;
}

function redact(value, token, limit = 2000) {
  let text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (token) text = text.split(token).join('[REDACTED]');
  text = text.replace(/\b(?:authorization|bearer|token|secret)\b\s*[:=]?\s*\S+/gi, '[REDACTED]');
  return text.slice(0, limit);
}

export function safeGithubUrl(value) {
  try {
    const parsed = new URL(String(value));
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password) return null;
    return parsed.href.slice(0, 2048);
  } catch { return null; }
}

function itemSummary(item, token) {
  return {
    number: positiveNumber(item?.number),
    title: redact(item?.title, token, 500),
    state: redact(item?.state, token, 40),
    url: safeGithubUrl(item?.html_url),
    updatedAt: typeof item?.updated_at === 'string' ? item.updated_at.slice(0, 40) : null
  };
}

function checkItemSummary(item, token) {
  return {
    name: redact(item?.name, token, 300),
    status: redact(item?.status, token, 40),
    conclusion: item?.conclusion == null ? null : redact(item.conclusion, token, 40),
    url: safeGithubUrl(item?.details_url || item?.html_url)
  };
}

async function readLimited(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw statusError('GitHub 响应超过大小上限', 502);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw statusError('GitHub 响应超过大小上限', 502);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function httpError(status) {
  const messages = {
    301: 'GitHub 拒绝跨域重定向',
    302: 'GitHub 拒绝跨域重定向',
    303: 'GitHub 拒绝跨域重定向',
    307: 'GitHub 拒绝跨域重定向',
    308: 'GitHub 拒绝跨域重定向',
    401: 'GitHub 凭据无效',
    403: 'GitHub 权限不足或已触发限流',
    404: 'GitHub 仓库或资源不存在',
    429: 'GitHub 请求过于频繁'
  };
  return statusError(messages[status] || `GitHub 请求失败（HTTP ${status}）`, status === 401 ? 401 : 502);
}

function requestHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'DataAgent/1.1.0'
  };
}

async function requestJson(url, { token, fetchImpl, signal, maxBytes, accept }) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: requestHeaders(token, accept), redirect: 'manual', signal });
  } catch {
    if (signal.aborted) throw statusError('GitHub 请求已停止', 499);
    throw statusError('GitHub 网络请求失败', 502);
  }
  if (response.status >= 300 && response.status < 400) throw httpError(response.status);
  if (!response.ok) throw httpError(response.status);
  let text;
  try { text = await readLimited(response, maxBytes); }
  catch (error) { if (error?.status) throw error; throw statusError('GitHub 响应读取失败', 502); }
  try { return JSON.parse(text); }
  catch { throw statusError('GitHub 返回了无效数据', 502); }
}

function encodePath(path) {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

async function queryRepo(input, options) {
  const data = await requestJson(`${API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`, options);
  return { action: 'repo', repository: {
    fullName: redact(data.full_name, options.token, 200),
    description: redact(data.description, options.token, 1000),
    private: data.private === true,
    defaultBranch: redact(data.default_branch, options.token, 200),
    url: safeGithubUrl(data.html_url)
  } };
}

async function queryIssues(input, options) {
  const base = `${API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/issues`;
  const query = input.number ? `${base}/${input.number}` : `${base}?state=all&sort=updated&direction=desc&per_page=20`;
  const data = await requestJson(query, options);
  const rawItems = Array.isArray(data) ? data : [data];
  const items = rawItems.filter(item => item && !item.pull_request).map(item => itemSummary(item, options.token));
  return { action: 'issues', count: items.length, items };
}

async function queryPulls(input, options) {
  const base = `${API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`;
  const query = input.number ? `${base}/${input.number}` : `${base}?state=all&sort=updated&direction=desc&per_page=20`;
  const data = await requestJson(query, options);
  const items = (Array.isArray(data) ? data : [data]).filter(Boolean).map(item => itemSummary(item, options.token));
  return { action: 'pulls', count: items.length, items };
}

async function queryChecks(input, options) {
  const repo = `${API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
  const pull = await requestJson(`${repo}/pulls/${input.number}`, options);
  const ref = typeof pull?.head?.sha === 'string' ? pull.head.sha : '';
  if (!/^[a-f0-9]{40,64}$/i.test(ref)) throw statusError('GitHub PR 缺少可查询的提交 SHA', 502);
  const data = await requestJson(`${repo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=30`, options);
  const items = (Array.isArray(data?.check_runs) ? data.check_runs : []).slice(0, 30).map(item => checkItemSummary(item, options.token));
  const conclusions = {};
  for (const item of items) {
    const key = item.conclusion || item.status || 'unknown';
    conclusions[key] = (conclusions[key] || 0) + 1;
  }
  return { action: 'checks', ref, count: items.length, conclusions, items };
}

async function queryFile(input, options) {
  const data = await requestJson(`${API_BASE}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodePath(input.path)}`, options);
  if (data?.type !== 'file' || data?.encoding !== 'base64' || typeof data?.content !== 'string') throw statusError('GitHub 路径不是可读取的文本文件', 502);
  if (!Number.isSafeInteger(data.size) || data.size < 0 || data.size > options.maxFileBytes) throw statusError('GitHub 文件超过大小上限', 502);
  let decoded;
  try { decoded = Buffer.from(data.content.replace(/\s+/g, ''), 'base64'); }
  catch { throw statusError('GitHub 文件内容无效', 502); }
  if (decoded.length > options.maxFileBytes) throw statusError('GitHub 文件超过大小上限', 502);
  if (decoded.includes(0)) throw statusError('GitHub 文件不是文本文件', 502);
  return { action: 'file', path: input.path, size: decoded.length, content: redact(decoded.toString('utf8'), options.token, options.maxFileBytes), truncated: false };
}

async function querySearch(input, options) {
  const params = new URLSearchParams({
    q: input.query,
    sort: 'stars',
    order: 'desc',
    per_page: String(input.limit)
  });
  const data = await requestJson(`${API_BASE}/search/repositories?${params.toString()}`, options);
  const items = (Array.isArray(data?.items) ? data.items : []).slice(0, input.limit).map(item => ({
    fullName: typeof item?.full_name === 'string' ? item.full_name.slice(0, 140) : '',
    stars: Number.isSafeInteger(item?.stargazers_count) ? item.stargazers_count : 0,
    language: typeof item?.language === 'string' ? item.language.slice(0, 40) : null,
    description: redact(item?.description, options.token, 240),
    url: safeGithubUrl(item?.html_url),
    updatedAt: typeof item?.pushed_at === 'string' ? item.pushed_at : null
  })).filter(item => item.fullName);
  return { action: 'search', query: input.query, total: Number.isFinite(data?.total_count) ? data.total_count : items.length, count: items.length, items };
}

async function queryGithub(input, options) {
  if (input.action === 'search') return querySearch(input, options);
  if (input.action === 'repo') return queryRepo(input, options);
  if (input.action === 'issues') return queryIssues(input, options);
  if (input.action === 'pulls') return queryPulls(input, options);
  if (input.action === 'checks') return queryChecks(input, options);
  return queryFile(input, options);
}

function publicError(error, timedOut) {
  if (timedOut) return 'GitHub 查询超时';
  if (error?.status === 401 || error?.status === 403 || error?.status === 404 || error?.status === 429 || error?.status === 502) return redact(error.message, '', 400);
  return 'GitHub 查询失败';
}

export function githubExecutor({
  store,
  environment = process.env,
  fetchImpl = fetch,
  timeoutMs = 30000,
  maxJsonBytes = 1024 * 1024,
  maxFileBytes = 256 * 1024
} = {}) {
  if (!store) throw new TypeError('githubExecutor 需要 store');
  const token = typeof environment.GITHUB_TOKEN === 'string' ? environment.GITHUB_TOKEN.trim() : '';
  const controllers = new Map();
  const timeout = Math.max(1, Number(timeoutMs) || 30000);
  const jsonLimit = Math.max(1, Number(maxJsonBytes) || 1024 * 1024);
  const fileLimit = Math.max(1, Number(maxFileBytes) || 256 * 1024);

  function fail(task, controller, error) {
    if (controller.done || controller.cancelled) return;
    controller.done = true;
    clearTimeout(controller.timer);
    task.status = 'failed';
    task.endedAt = new Date().toISOString();
    task.updatedAt = task.endedAt;
    task.error = publicError(error, controller.timedOut);
    task.artifacts = { ...(task.artifacts || {}), github: { action: task.githubInput?.action || null, status: 'failed', timedOut: controller.timedOut, error: task.error } };
    store.put('task', task);
  }

  function launchTask(task, input) {
    const abortController = new AbortController();
    const controller = { abortController, done: false, cancelled: false, timedOut: false, timer: null };
    controllers.set(task.id, controller);
    controller.timer = setTimeout(() => {
      if (controller.done) return;
      controller.timedOut = true;
      abortController.abort(new Error('GitHub 查询超时'));
    }, timeout);
    controller.timer.unref?.();
    void (async () => {
      try {
        const result = await queryGithub(input, { token, fetchImpl, signal: abortController.signal, maxBytes: jsonLimit, maxFileBytes: fileLimit });
        if (controller.done || controller.cancelled) return;
        controller.done = true;
        clearTimeout(controller.timer);
        task.status = 'completed';
        task.endedAt = new Date().toISOString();
        task.updatedAt = task.endedAt;
        task.error = undefined;
        task.artifacts = { ...(task.artifacts || {}), github: { ...result, fetchedAt: task.endedAt } };
        store.put('task', task);
      } catch (error) {
        fail(task, controller, error);
      } finally {
        controllers.delete(task.id);
      }
    })();
  }

  return {
    id: 'github',
    name: 'GitHub 只读',
    kind: 'tool',
    available: true,
    requiresDataset: false,
    capabilities: ['github', 'repository', 'issues', 'pulls', 'checks', 'file', 'search', 'read-only', 'human-approval'],
    validateInput: validateGithubInput,
    // 只说一句话时（计划/指挥里的步骤），按「搜索仓库」执行——调研开源项目不需要预先知道仓库名。
    // GitHub 搜索接口对整句中文几乎没有命中，所以先把句子压成英文关键词；压不出来才退回默认词。
    defaultInput: text => {
      const ascii = String(text || '')
        .replace(/[^\x20-\x7E]/g, ' ')
        .replace(/[^A-Za-z0-9+#./\s-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const query = ascii.length >= 3 ? ascii.slice(0, 80) : 'platformer game';
      return validateGithubInput({ action: 'search', query, limit: 5 });
    },
    start(ticket, assignment, input) {
      const normalized = validateGithubInput(input?.executorInput ?? input);
      const prior = store.get('task', assignment.id);
      if (prior) return prior;
      const stamp = new Date().toISOString();
      const task = { id: assignment.id, workAssignmentId: assignment.id, executorId: 'github', goal: ticket.command, status: 'running', createdAt: stamp, updatedAt: stamp, executionStarted: true, githubInput: normalized, artifacts: {} };
      store.put('task', task);
      launchTask(task, normalized);
      return task;
    },
    get: id => id && store.get('task', id),
    resume(task) {
      if (!task || task.status !== 'running' || controllers.has(task.id)) return;
      task.status = 'failed'; task.error = '服务已重启，GitHub 查询已中断'; task.endedAt = new Date().toISOString(); task.updatedAt = task.endedAt;
      task.artifacts = { ...(task.artifacts || {}), github: { action: task.githubInput?.action || null, status: 'failed', interrupted: true, error: task.error } };
      store.put('task', task);
    },
    stop(task) {
      if (!task) return;
      const controller = controllers.get(task.id);
      if (controller) {
        controller.cancelled = true; controller.done = true; clearTimeout(controller.timer);
        controller.abortController.abort(new Error('GitHub 查询已停止'));
      }
      task.status = 'cancelled'; task.endedAt = new Date().toISOString(); task.updatedAt = task.endedAt;
      task.artifacts = { ...(task.artifacts || {}), github: { action: task.githubInput?.action || null, status: 'cancelled' } };
      store.put('task', task);
    },
    close() {
      for (const controller of controllers.values()) {
        controller.cancelled = true; controller.done = true; clearTimeout(controller.timer);
        controller.abortController.abort(new Error('GitHub 执行器已关闭'));
      }
      controllers.clear();
    }
  };
}
