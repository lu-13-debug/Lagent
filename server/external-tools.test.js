import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { browserExecutor, validateBrowserInput } from './work/executors/browser.js';
import { githubExecutor, validateGithubInput } from './work/executors/github.js';

async function waitFor(predicate, message = '等待条件超时', timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-external-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store };
}

function browserHarness({ goto, evaluate, launchError } = {}) {
  const state = {
    launchCalls: 0,
    contextCalls: 0,
    browserClosed: 0,
    contextClosed: 0,
    continueCalls: 0,
    abortCalls: [],
    contextOptions: null,
    routeHandler: null
  };
  const page = {
    setDefaultTimeout() {},
    goto: goto || (async () => {}),
    url: () => 'https://example.com/final',
    evaluate: evaluate || (async (_fn, maxChars) => ({ title: 'Example', text: 'hello world', links: [], truncated: false, maxChars }))
  };
  const context = {
    route: async (_pattern, handler) => { state.routeHandler = handler; },
    newPage: async () => page,
    close: async () => { state.contextClosed++; }
  };
  const browser = {
    newContext: async options => { state.contextCalls++; state.contextOptions = options; return context; },
    close: async () => { state.browserClosed++; }
  };
  const playwright = {
    chromium: {
      launch: async () => {
        state.launchCalls++;
        if (launchError) throw launchError;
        return browser;
      }
    }
  };
  return { state, page, context, browser, playwright };
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

test('E3 浏览器输入只允许公网 HTTP(S)、标准端口与受限 maxChars', () => {
  assert.deepEqual(validateBrowserInput({ url: ' https://example.com/docs ', maxChars: 120 }), {
    url: 'https://example.com/docs',
    maxChars: 120
  });
  const blocked = [
    'file:///etc/passwd',
    'data:text/html,hello',
    'javascript:alert(1)',
    'http://localhost/',
    'http://service.local/',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://169.254.1.1/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://example.com:8080/',
    'http://user:pass@example.com/'
  ];
  for (const url of blocked) assert.throws(() => validateBrowserInput({ url }), { status: 400 }, url);
  assert.throws(() => validateBrowserInput({ url: 'https://example.com', maxChars: 0 }), { status: 400 });
  assert.throws(() => validateBrowserInput({ url: 'https://example.com', maxChars: 50001 }), { status: 400 });
  assert.throws(() => validateBrowserInput({ url: 'https://example.com', maxChars: 1.5 }), { status: 400 });
});

test('E3 浏览器执行器禁用 JS/下载、限制链接并完整关闭 context/browser', async t => {
  const { store } = fixture(t);
  const links = Array.from({ length: 35 }, (_, index) => ({ text: `link-${index}`, url: `https://example.com/${index}` }));
  const harness = browserHarness({
    evaluate: async (_fn, maxChars) => ({ title: '  Example  ', text: 'hello', links, truncated: false, maxChars })
  });
  const executor = browserExecutor({
    store,
    environment: { DATAAGENT_BROWSER_ENABLED: '1' },
    playwright: harness.playwright,
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  t.after(() => executor.close());
  assert.equal(executor.available, true);
  const task = executor.start(
    { id: 'ticket-browser', command: '读取页面' },
    { id: 'browser-success', ticketId: 'ticket-browser', executor: 'browser' },
    { executorInput: { url: 'https://example.com/page', maxChars: 4 } }
  );
  await waitFor(() => store.get('task', task.id)?.status === 'completed');
  const saved = store.get('task', task.id);
  assert.equal(harness.state.contextOptions.javaScriptEnabled, false);
  assert.equal(harness.state.contextOptions.serviceWorkers, 'block');
  assert.equal(harness.state.contextOptions.acceptDownloads, false);
  assert.equal(saved.artifacts.browser.title, '  Example  ');
  assert.equal(saved.artifacts.browser.url, 'https://example.com/final');
  assert.equal(saved.artifacts.browser.text, 'hell');
  assert.equal(saved.artifacts.browser.links.length, 30);
  assert.equal(saved.artifacts.browser.truncated, true);
  assert.equal(harness.state.contextClosed, 1);
  assert.equal(harness.state.browserClosed, 1);
});

test('E3 浏览器 DNS 私网与子资源私网请求均被拒绝', async t => {
  const { store } = fixture(t);
  const privateDns = browserHarness();
  const dnsExecutor = browserExecutor({
    store,
    environment: { DATAAGENT_BROWSER_ENABLED: '1' },
    playwright: privateDns.playwright,
    lookupHost: async () => [{ address: '10.0.0.7', family: 4 }]
  });
  const dnsTask = dnsExecutor.start(
    { id: 'ticket-dns', command: 'DNS 私网' },
    { id: 'browser-dns', ticketId: 'ticket-dns' },
    { url: 'https://private.example/' }
  );
  await waitFor(() => store.get('task', dnsTask.id)?.status === 'failed');
  assert.equal(privateDns.state.launchCalls, 0);
  assert.match(store.get('task', dnsTask.id).error, /失败/);
  dnsExecutor.close();

  const routed = browserHarness();
  const routeExecutor = browserExecutor({
    store,
    environment: { DATAAGENT_BROWSER_ENABLED: '1' },
    playwright: routed.playwright,
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  const routeTask = routeExecutor.start(
    { id: 'ticket-route', command: '子资源' },
    { id: 'browser-route', ticketId: 'ticket-route' },
    { url: 'https://example.com/page' }
  );
  await waitFor(() => Boolean(routed.state.routeHandler));
  await routed.state.routeHandler({
    request: () => ({ url: () => 'http://127.0.0.1/admin' }),
    continue: async () => { routed.state.continueCalls++; },
    abort: async reason => { routed.state.abortCalls.push(reason); }
  });
  assert.equal(routed.state.continueCalls, 0);
  assert.deepEqual(routed.state.abortCalls, ['blockedbyclient']);
  await waitFor(() => store.get('task', routeTask.id)?.status === 'completed');
  routeExecutor.close();
});

test('E3 浏览器超时与 stop 会关闭 context/browser', async t => {
  const { store } = fixture(t);
  const timedHarness = browserHarness({ goto: () => new Promise(() => {}) });
  const timed = browserExecutor({
    store,
    environment: { DATAAGENT_BROWSER_ENABLED: '1' },
    playwright: timedHarness.playwright,
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 15
  });
  const timedTask = timed.start(
    { id: 'ticket-timeout', command: '超时' },
    { id: 'browser-timeout', ticketId: 'ticket-timeout' },
    { url: 'https://example.com/slow' }
  );
  await waitFor(() => store.get('task', timedTask.id)?.status === 'failed');
  assert.equal(store.get('task', timedTask.id).artifacts.browser.timedOut, true);
  assert.equal(timedHarness.state.contextClosed, 1);
  assert.equal(timedHarness.state.browserClosed, 1);
  timed.close();

  const stoppedHarness = browserHarness({ goto: () => new Promise(() => {}) });
  const stopped = browserExecutor({
    store,
    environment: { DATAAGENT_BROWSER_ENABLED: '1' },
    playwright: stoppedHarness.playwright,
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  const stoppedTask = stopped.start(
    { id: 'ticket-stop', command: '停止' },
    { id: 'browser-stop', ticketId: 'ticket-stop' },
    { url: 'https://example.com/slow' }
  );
  await waitFor(() => stoppedHarness.state.contextCalls === 1);
  stopped.stop(stoppedTask);
  await waitFor(() => stoppedHarness.state.contextClosed === 1 && stoppedHarness.state.browserClosed === 1);
  assert.equal(store.get('task', stoppedTask.id).status, 'cancelled');
  stopped.close();
});

test('E3 GitHub 输入白名单、无 token 不可用与固定只读请求', async t => {
  assert.deepEqual(validateGithubInput({ action: 'file', owner: 'acme', repo: 'data-agent', path: 'docs/readme.md' }), {
    action: 'file', owner: 'acme', repo: 'data-agent', path: 'docs/readme.md'
  });
  assert.throws(() => validateGithubInput({ action: 'write', owner: 'acme', repo: 'repo' }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'repo', owner: '../acme', repo: 'repo' }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'repo', owner: 'acme', repo: '..' }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'issues', owner: 'acme', repo: 'repo', number: 0 }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'checks', owner: 'acme', repo: 'repo' }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'file', owner: 'acme', repo: 'repo', path: '../secret' }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'file', owner: 'acme', repo: 'repo', path: 'C:\\secret' }), { status: 400 });

  const { store } = fixture(t);
  let called = false;
  const anonymous = githubExecutor({ store, environment: {}, fetchImpl: async (url) => { called = true; return jsonResponse({ total_count: 1, items: [{ full_name: 'phaserjs/phaser', stargazers_count: 12000, language: 'JavaScript', description: 'game framework', html_url: 'https://github.com/phaserjs/phaser', pushed_at: '2026-01-01T00:00:00Z' }] }); } });
  assert.equal(anonymous.available, true);
  const anonTask = anonymous.start({ command: '搜索平台跳跃游戏' }, { id: 'github-anon' }, { action: 'search', query: 'platformer', limit: 3 });
  await waitFor(() => store.get('task', anonTask.id)?.status === 'completed');
  assert.equal(called, true);
  const anonSaved = store.get('task', anonTask.id);
  assert.equal(anonSaved.artifacts.github.action, 'search');
  assert.equal(anonSaved.artifacts.github.items[0].fullName, 'phaserjs/phaser');
  assert.deepEqual(validateGithubInput({ action: 'search', query: '  platformer  ' }), { action: 'search', query: 'platformer', limit: 5 });
  assert.throws(() => validateGithubInput({ action: 'search', query: '   ' }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'search', query: 'x'.repeat(201) }), { status: 400 });
  assert.throws(() => validateGithubInput({ action: 'search', query: 'ok', limit: 0 }), { status: 400 });
  anonymous.close();

  const token = 'ghp_super_secret_token';
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse({
      full_name: 'acme/data-agent',
      description: `read only ${token}`,
      private: false,
      default_branch: 'main',
      html_url: 'https://github.com/acme/data-agent'
    });
  };
  const executor = githubExecutor({ store, environment: { GITHUB_TOKEN: token }, fetchImpl });
  assert.equal(executor.available, true);
  const task = executor.start(
    { id: 'ticket-github', command: '读取仓库' },
    { id: 'github-repo', ticketId: 'ticket-github', executor: 'github' },
    { executorInput: { action: 'repo', owner: 'acme', repo: 'data-agent' } }
  );
  await waitFor(() => store.get('task', task.id)?.status === 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/data-agent');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'manual');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${token}`);
  const saved = store.get('task', task.id);
  assert.equal(saved.artifacts.github.repository.fullName, 'acme/data-agent');
  assert.match(saved.artifacts.github.repository.description, /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(saved.artifacts), new RegExp(token));
  executor.close();
});

test('E3 GitHub file/checks 摘要、大小上限、HTTP 错误与超时脱敏', async t => {
  const { store } = fixture(t);
  const token = 'ghp_another_secret';
  const fetchImpl = async url => {
    if (url.endsWith('/contents/docs/readme.md')) {
      const content = Buffer.from(`hello ${token}`).toString('base64');
      return jsonResponse({ type: 'file', encoding: 'base64', size: Buffer.byteLength(`hello ${token}`), content });
    }
    if (url.endsWith('/pulls/7')) return jsonResponse({ number: 7, head: { sha: 'a'.repeat(40) } });
    if (url.includes('/check-runs?')) return jsonResponse({ check_runs: [
      { name: 'test', status: 'completed', conclusion: 'success', details_url: 'https://github.com/acme/repo/runs/1' },
      { name: 'lint', status: 'completed', conclusion: 'failure', details_url: 'https://github.com/acme/repo/runs/2' }
    ] });
    return jsonResponse({ message: 'not found' }, 404);
  };
  const executor = githubExecutor({ store, environment: { GITHUB_TOKEN: token }, fetchImpl });
  const fileTask = executor.start(
    { id: 'ticket-file', command: '读取文件' },
    { id: 'github-file', ticketId: 'ticket-file' },
    { action: 'file', owner: 'acme', repo: 'repo', path: 'docs/readme.md' }
  );
  await waitFor(() => store.get('task', fileTask.id)?.status === 'completed');
  assert.match(store.get('task', fileTask.id).artifacts.github.content, /\[REDACTED\]/);

  const checksTask = executor.start(
    { id: 'ticket-checks', command: '读取检查' },
    { id: 'github-checks', ticketId: 'ticket-checks' },
    { action: 'checks', owner: 'acme', repo: 'repo', number: 7 }
  );
  await waitFor(() => store.get('task', checksTask.id)?.status === 'completed');
  const checks = store.get('task', checksTask.id).artifacts.github;
  assert.equal(checks.count, 2);
  assert.deepEqual(checks.conclusions, { success: 1, failure: 1 });
  assert.equal(checks.items.length, 2);
  executor.close();

  for (const status of [401, 403, 404, 429, 302]) {
    const errorExecutor = githubExecutor({
      store,
      environment: { GITHUB_TOKEN: token },
      fetchImpl: async () => new Response(`token=${token}`, { status })
    });
    const task = errorExecutor.start(
      { id: `ticket-error-${status}`, command: '错误' },
      { id: `github-error-${status}`, ticketId: `ticket-error-${status}` },
      { action: 'repo', owner: 'acme', repo: 'repo' }
    );
    await waitFor(() => store.get('task', task.id)?.status === 'failed');
    const saved = store.get('task', task.id);
    assert.ok(saved.error);
    assert.doesNotMatch(JSON.stringify(saved.artifacts), new RegExp(token));
    errorExecutor.close();
  }

  const oversizedFile = githubExecutor({
    store,
    environment: { GITHUB_TOKEN: token },
    maxFileBytes: 10,
    fetchImpl: async () => jsonResponse({ type: 'file', encoding: 'base64', size: 11, content: Buffer.from('x'.repeat(11)).toString('base64') })
  });
  const fileSizeTask = oversizedFile.start(
    { id: 'ticket-file-size', command: '大文件' },
    { id: 'github-file-size', ticketId: 'ticket-file-size' },
    { action: 'file', owner: 'acme', repo: 'repo', path: 'docs/large.md' }
  );
  await waitFor(() => store.get('task', fileSizeTask.id)?.status === 'failed');
  assert.match(store.get('task', fileSizeTask.id).error, /大小上限/);
  oversizedFile.close();

  const timed = githubExecutor({
    store,
    environment: { GITHUB_TOKEN: token },
    timeoutMs: 15,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })
  });
  const timeoutTask = timed.start(
    { id: 'ticket-github-timeout', command: '超时' },
    { id: 'github-timeout', ticketId: 'ticket-github-timeout' },
    { action: 'repo', owner: 'acme', repo: 'repo' }
  );
  await waitFor(() => store.get('task', timeoutTask.id)?.status === 'failed');
  assert.equal(store.get('task', timeoutTask.id).artifacts.github.timedOut, true);
  timed.close();
});

test('E3 Work 对 browser/github 先审批后执行并只公开白名单 artifacts', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-e3-work-'));
  const store = new Store(dir);
  const events = [];
  const harness = browserHarness({ evaluate: async () => ({ title: 'Public', text: 'visible', links: [], truncated: false }) });
  const browser = browserExecutor({
    store,
    environment: { DATAAGENT_BROWSER_ENABLED: '1' },
    playwright: harness.playwright,
    lookupHost: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  const githubCalls = [];
  const github = githubExecutor({
    store,
    environment: { GITHUB_TOKEN: 'ghp_work_secret' },
    fetchImpl: async url => {
      githubCalls.push(url);
      return jsonResponse({ full_name: 'acme/repo', description: 'fixture', private: false, default_branch: 'main', html_url: 'https://github.com/acme/repo' });
    }
  });
  const analysis = {
    id: 'analysis', name: '数据分析', kind: 'analysis', available: true, requiresDataset: true, capabilities: ['analysis'],
    start() { throw new Error('not used'); }, get() { return null; }
  };
  const registry = createExecutorRegistry([analysis, browser, github]);
  const engine = createWorkEngine(store, registry, event => events.push(event), { policy: { allowedExecutors: ['browser', 'github'], requireApproval: true }, env: { ...process.env, DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const agents = engine.bootstrap().agents;
  assert.equal(agents.find(agent => agent.id === 'browser').status, 'available');
  assert.equal(agents.find(agent => agent.id === 'github').status, 'available');

  const browserTicket = engine.command({
    text: '读取公开页面',
    executorId: 'browser',
    executorInput: { url: 'https://example.com/page', maxChars: 100 }
  });
  assert.equal(browserTicket.status, 'awaiting_review');
  assert.equal(browserTicket.summary, '请确认受控浏览器读取后批准执行');
  assert.equal(Object.hasOwn(browserTicket, 'executorInput'), false);
  assert.equal(harness.state.launchCalls, 0);
  assert.equal(engine.detail(browserTicket.id).team, null);
  engine.action(browserTicket.id, 'approve');
  await waitFor(() => engine.detail(browserTicket.id).ticket.status === 'completed');
  const browserDetail = engine.detail(browserTicket.id);
  assert.equal(browserDetail.reports.find(report => report.kind === 'ready').artifacts.browser.title, 'Public');
  assert.equal(browserDetail.ticket.summary, '浏览器读取完成：Public');

  const githubTicket = engine.command({
    text: '查询仓库',
    executorId: 'github',
    executorInput: { action: 'repo', owner: 'acme', repo: 'repo' }
  });
  assert.equal(githubTicket.status, 'awaiting_review');
  assert.equal(githubTicket.summary, '请确认 GitHub 只读查询后批准执行');
  assert.equal(githubCalls.length, 0);
  engine.action(githubTicket.id, 'approve');
  await waitFor(() => engine.detail(githubTicket.id).ticket.status === 'completed');
  assert.equal(githubCalls.length, 1);
  const githubDetail = engine.detail(githubTicket.id);
  assert.equal(githubDetail.reports.find(report => report.kind === 'ready').artifacts.github.repository.fullName, 'acme/repo');
  assert.equal(githubDetail.ticket.summary, 'GitHub 查询完成');

  const publicPayload = JSON.stringify({ browserDetail, githubDetail, events });
  assert.doesNotMatch(publicPayload, /executorInput|browserInput|githubInput|ghp_work_secret/);
});
