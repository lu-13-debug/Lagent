import { projectStateOf, registerWork } from './work/routes.js';
import { createWindowBridge } from './window-bridge.js';
import { workEnabled } from './work/policy.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { terminalExecutor } from './work/executors/terminal.js';
import { windowExecutor } from './work/executors/window.js';
import { acpExecutors } from './work/executors/acp.js';
import { createProviderRegistry } from './work/providers.js';
import { createAgentPlanner } from './work/agent-planner.js';
import { createWorkBrain } from './work/brain.js';
import { codexExecutor } from './work/executors/codex.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';
import { localAgentExecutors } from './work/executors/local-agent.js';
import { browserExecutor } from './work/executors/browser.js';
import { githubExecutor } from './work/executors/github.js';
import { modelExecutor } from './work/executors/model.js';
import { workbuddyExecutor } from './work/executors/workbuddy.js';
import { loadMcpServers } from './work/mcp-client.js';
import { createNodeHub, loadNodeSecret } from './work/node-hub.js';
import { registerNodeRoutes } from './work/node-routes.js';
import { registerMemory } from './memory-api.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { APP_VERSION } from './version.js';
import { DEFAULT_MODEL_TIMEOUT_MS, DEFAULT_SETTINGS, validateSettings, validateKey, normalizeBaseUrl, chat, redact } from './gateway.js';
import { listModels } from './model-catalog.js';
import { summarizeModelUsage } from './model-usage.js';
import { isModelErrorCode } from './task-errors.js';
import { registerModelHub } from './model-hub.js';
import { localCredentialKey } from './local-key.js';
import { MobileGateway, hasDeviceToken, registerMobilePairingRoutes } from './mobile-gateway.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statusError = (message, status = 400) => Object.assign(new Error(message), { status });

export function createApp(options = {}) {
  const app = express();
  const enableWork = workEnabled(options); let closeWork; let mobileGateway; let ownsMobileGateway = false;
  app.disable('x-powered-by');
  const storeDir = options.dataDir || process.env.LAGENT_DATA_DIR || path.join(root, 'data');
  const store = new Store(storeDir);
  let key = ''; let keyBaseUrl = '';
  let settings = store.config('settings') || { ...DEFAULT_SETTINGS };
  const getKey = (req, target = settings) => options.getKey ? options.getKey(req, normalizeBaseUrl(target.baseUrl)) || '' : keyBaseUrl === normalizeBaseUrl(target.baseUrl) ? key : '';
  const setKey = (req, value, target = settings) => { const baseUrl = normalizeBaseUrl(target.baseUrl); if (options.setKey) options.setKey(req, value, baseUrl); else { key = value; keyBaseUrl = baseUrl; } };
  let modelHub;
  const publicSettings = req => {
    const hub = modelHub?.publicState();
    const profile = hub?.profiles.find(item => item.id === hub.workflow.defaultProfileId);
    // 配置档可以绑定单个凭据，也可以绑定 Key 池；只看 credentialId 会把池配置误判为不可用。
    const enabled = Boolean(profile && !profile.unavailable && hub.vault.available && (
      profile.credentialId
        ? hub.credentials.some(credential => credential.id === profile.credentialId)
        : profile.poolId && hub.pools.some(pool => pool.id === profile.poolId)
    ));
    const sessionHasKey = Boolean(getKey(req));
    return { ...settings, ...(enabled ? { model: profile.model } : {}), hasKey: enabled || sessionHasKey, sessionHasKey, workflowEnabled: enabled };
  };
  let activeAsync = 0;
  const trackAsync = handler => async (req, res) => {
    if (activeAsync >= (options.maxAsyncRequests ?? Infinity)) throw statusError('当前账号请求过多，请稍后再试', 429);
    activeAsync++; try { return await handler(req, res); } finally { activeAsync--; }
  };
  app.locals.store = store;
  app.locals.isBusy = () => activeAsync > 0 || store.busyTaskCount() > 0 || Boolean(app.locals.workBusy?.()) || Boolean(app.locals.nodeHub?.hasNodes?.());
  let closed = false;
  app.locals.close = () => { if (closed) return; closed = true; try { app.locals.nodeHub?.close(); } catch { /* 节点清理失败不阻塞关闭。 */ } closeWork?.(); if (ownsMobileGateway) mobileGateway?.close(); key = ''; store.close(); };

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (options.networkGuard === false) return next(); // Authenticated cloud parent owns the network boundary.
    const hostname = req.hostname.toLowerCase();
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) return res.status(403).json({ error: '本地服务仅接受 localhost 访问' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (origin) {
        let parsed;
        try { parsed = new URL(origin); } catch { return res.status(403).json({ error: '请求来源无效' }); }
        const sameOrigin = parsed.origin === `${req.protocol}://${req.get('host')}`;
        const localDev = ['http:', 'https:'].includes(parsed.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) && ['3000', '3001', '4173', '5173', '5174', '5175'].includes(parsed.port);
        if (!sameOrigin && !localDev) return res.status(403).json({ error: '已拒绝跨站写入请求，请在本地应用内操作' });
      } else if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: '已拒绝跨站写入请求' });
    }
    next();
  });
  // 本机执行节点的上报体带任务快照，比普通接口大；在全局 128kb 解析器之前挂载，避免被截断。
  const nodeRouter = express.Router();
  app.use('/api/node', nodeRouter);
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, res, next) => {
    if (hasDeviceToken(req) && req.path.startsWith('/work/')) return res.status(401).json({ error: '设备 token 仅可用于移动 Work API' });
    next();
  });
  registerMemory(app, store, options.userId || 'local');
  const configuredMasterKey = options.credentialMasterKey || process.env.LAGENT_CREDENTIAL_MASTER_KEY || (options.cloud ? undefined : localCredentialKey(storeDir));
  modelHub = registerModelHub(app, { store, ownerId: options.userId || 'local', masterKey: configuredMasterKey, assertModelSettings: options.assertModelSettings, fetchImpl: options.fetchImpl });
  const agentPlanner = createAgentPlanner({ env: process.env });
  const workBrain = createWorkBrain({ modelHub, fetchImpl: options.fetchImpl || fetch });
  app.locals.modelHub = modelHub;
  if (enableWork) {
    const workCwd = options.cloud ? storeDir : root;
    const acp = acpExecutors({ store, cwd: workCwd });
    const terminal = terminalExecutor({ store, cwd: workCwd });
    const cliTimeoutMs = Number(process.env.LAGENT_CLI_TIMEOUT_MS);
    const cliTimeout = Number.isFinite(cliTimeoutMs) && cliTimeoutMs > 0 ? { timeoutMs: cliTimeoutMs } : {};
    const codex = codexExecutor({ store, cwd: workCwd, binary: process.env.LAGENT_CODEX_CLI, ...cliTimeout });
    const claudeCode = claudeCodeExecutor({ store, cwd: workCwd, binary: process.env.LAGENT_CLAUDE_CLI, ...cliTimeout });
    const localAgents = options.cloud ? [] : localAgentExecutors({ store, cwd: workCwd, ...cliTimeout });
    const browser = browserExecutor({ store });
    const github = githubExecutor({ store, fetchImpl: options.fetchImpl || fetch });
    // 模型 Agent：直接使用「规划设置」里选中的默认模型，不依赖本机 CLI。
    const modelAgent = modelExecutor({
      store,
      cwd: workCwd,
      context: () => {
        const captured = modelHub.captureWorkflow();
        const stage = captured?.stages?.plan;
        return stage ? modelHub.context(stage) : null;
      },
      // 会话级模型：允许这一步用指定的模型配置，而不是全局默认模型。
      contextFor: (profileId, effort) => modelHub.contextForProfile(profileId, effort),
      // 项目现状（最近改动 + 记忆摘要）：让内置 Agent 先看「别人改了什么」，
      // 而不是每次都把整个文件重读一遍。
      projectState: workspace => {
        try { return projectStateOf(workspace); } catch { return ''; }
      },
      // 内置模型可以直接调用项目配置的 MCP 工具；未配置或显式关闭时返回空列表。
      mcpServers: workspace => process.env.LAGENT_MCP_CLIENT === '0' ? [] : loadMcpServers({ store, ownerId: options.userId || 'local', workspace, env: process.env }),
      // 汇总/收口这类长任务要读清单、核对目录再补文件，15 分钟常在半途被掐断；默认给到 25 分钟。
      totalTimeoutMs: Number(process.env.LAGENT_MODEL_TOTAL_TIMEOUT_MS) > 0 ? Number(process.env.LAGENT_MODEL_TOTAL_TIMEOUT_MS) : 1500000,
      fetchImpl: options.fetchImpl || fetch,
    });
    const mobileOwnerId = options.userId || 'local';
    const windowBridge = options.cloud ? null : (options.windowBridge ?? createWindowBridge());
    const providerRegistry = options.providerRegistry ?? createProviderRegistry(windowBridge ? { desktopProbe: () => windowBridge.listWindows() } : {});
    const window = windowBridge ? windowExecutor({ store, bridge: windowBridge, ...(process.env.LAGENT_WINDOW_WAIT_MS ? { maxWaitMs: Number(process.env.LAGENT_WINDOW_WAIT_MS) } : {}) }) : null;
    // WorkBuddy 桌面端：通过 Chromium 调试端口派发任务并读取回复，没有可用的 CLI。
    const workbuddy = options.cloud ? null : workbuddyExecutor({ store });
    const executors = createExecutorRegistry([terminal, codex, claudeCode, ...localAgents, browser, github, modelAgent, ...(window ? [window] : []), ...(workbuddy ? [workbuddy] : []), ...acp]);
    mobileGateway = options.mobileGateway || new MobileGateway({ dataDir: path.join(storeDir, 'mobile'), now: options.now });
    ownsMobileGateway = !options.mobileGateway;
    // 云端由外层应用统一注册配对接口，子工作区应用不重复注册同一组路由。
    if (!options.cloud) registerMobilePairingRoutes(app, mobileGateway, { desktopOwner: options.mobileDesktopOwner || (() => mobileOwnerId) });
    closeWork = registerWork(app, store, executors, { isSessionValid: options.isSessionValid, onConnect: options.onTaskEventConnect, mobileGateway, mobileOwnerId, onMobileEventConnect: options.onMobileEventConnect, workspace: workCwd, brain: workBrain, planner: options.workPlanner ?? (async input => { try { return await modelHub.suggestWorkPlan(input); } catch (error) { try { return await agentPlanner(input); } catch (fallbackError) { throw fallbackError?.message ? Object.assign(error, { message: `${error.message}；本机 Agent 也无法拆解：${fallbackError.message}` }) : error; } } }), windowBridge, providerRegistry, ownerId: options.userId || 'local', allowFilesystemBrowser: !options.cloud, mcpTokenIndex: options.mcpTokenIndex });
    // 本机执行节点：桌面端连上来后，它电脑上的 CLI 会作为执行器出现在这个工作区里。
    const nodeSecret = options.nodeSecret || loadNodeSecret(storeDir, process.env);
    const nodeHub = createNodeHub({ store, registry: executors, engine: app.locals.workEngine });
    app.locals.nodeHub = nodeHub;
    app.locals.nodeSecret = nodeSecret;
    // 云端由顶层应用统一挂载 /api/node，因为节点要先登录才找得到自己的工作区。
    if (!options.cloud) {
      registerNodeRoutes(nodeRouter, { resolveHub: () => nodeHub, authenticate: () => options.userId || 'local', secret: nodeSecret });
    }
  }
  // 前端只需要读取当前会话的模型设置；数据分析时代的任务/数据集契约已随 DataAgent 一并下线。
  app.get('/api/runtime', (_req, res) => res.json({
    mode: 'local', authRequired: false, serviceName: 'Lagent', version: APP_VERSION,
    capabilities: { memory: true, modelUsage: true, modelHub: true, ...(enableWork ? { superagent: true } : {}) }
  }));
  app.get('/api/model-usage', (req, res) => {
    const days = req.query.days ?? '30';
    if (typeof days !== 'string' || !['7', '30', '90', 'all'].includes(days)) return res.status(400).json({ error: '用量范围仅支持7、30、90或all' });
    res.json(summarizeModelUsage({ calls: store.list('model-call'), tasks: store.list('task'), days: days === 'all' ? days : Number(days), now: new Date() }));
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/bootstrap', (req, res) => res.json({ settings: publicSettings(req) }));
  app.get('/api/settings', (req, res) => res.json({ settings: publicSettings(req) }));
  app.put('/api/settings', (req, res) => {
    let next;
    try { next = validateSettings(req.body || {}, settings); options.assertModelSettings?.(next); } catch (error) { throw statusError(error.message); }
    let nextKey = getKey(req, next);
    if (req.body?.clearKey === true) nextKey = '';
    else if (req.body?.apiKey !== undefined) {
      try { nextKey = validateKey(req.body.apiKey); } catch (error) { throw statusError(error.message); }
    }
    else if (getKey(req) && !nextKey) throw statusError('更换 API 地址后请重新填写对应的 API Key');
    settings = next; setKey(req, nextKey);
    // Persist the allowlisted non-secret settings only. Key always remains in process memory.
    store.config('settings', { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model });
    res.json({ settings: publicSettings(req) });
  });
  app.post('/api/settings/test', trackAsync(async (req, res) => {
    const requestKey = getKey(req);
    try {
      options.assertModelSettings?.(settings);
      const text = await chat({ settings, key: requestKey, fetchImpl: options.fetchImpl || fetch, timeoutMs: options.modelTimeoutMs || DEFAULT_MODEL_TIMEOUT_MS, maxTokens: 1024, connectionTest: true, messages: [{ role: 'user', content: '只回复 OK，用于检查连接。' }] });
      res.json({ ok: true, message: text ? '模型连接成功。本次进行了真实的小型模型调用，供应商可能计入用量。' : '模型已连接并返回推理内容；本次测试达到输出上限，未生成最终答案。正式任务使用更高上限，供应商可能计入用量。' });
    } catch (error) { throw Object.assign(statusError(redact(error.message, requestKey), 400), isModelErrorCode(error.code) ? { code: error.code } : {}); }
  }));
  app.post('/api/settings/models', trackAsync(async (req, res) => {
    let requestKey = '';
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', abort);
    try {
      const candidate = validateSettings({ baseUrl: req.body?.baseUrl ?? settings.baseUrl }, settings);
      options.assertModelSettings?.(candidate);
      requestKey = req.body?.apiKey !== undefined ? validateKey(req.body.apiKey) : getKey(req, candidate);
      if (!requestKey) throw new Error('请先填写当前 API 地址对应的 API Key，再检测模型');
      const result = await listModels({ settings: candidate, key: requestKey, signal: controller.signal, fetchImpl: options.fetchImpl || fetch, timeoutMs: options.modelTimeoutMs || 15000 });
      res.json(result);
    } catch (error) { throw statusError(redact(error.message, requestKey), 400); }
    finally { res.off('close', abort); }
  }));
  // /api 的兜底必须在更具体的 /api/mobile 之前声明，否则移动端 404 永远走不到。
  app.use('/api/mobile', (_req, res) => res.status(404).json({ error: '移动接口不存在' }));
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  const dist = options.distDir || path.join(root, 'dist');
  if (options.serveStatic !== false && existsSync(dist)) {
    app.use(express.static(dist, { index: false }));
    app.use((req, res, next) => { if (req.method === 'GET' && req.accepts('html')) res.sendFile(path.join(dist, 'index.html')); else next(); });
  }
  app.use((error, req, res, _next) => {
    let status = error.status || 500;
    let message = error.message || '服务内部错误';
    if (error.type === 'entity.parse.failed') { status = 400; message = 'JSON 请求格式无效'; }
    if (status >= 500 && error.expose !== true) message = '服务处理失败，请稍后重试；敏感错误细节已隐藏';
    // LAGENT_* 是工作台自己的前置条件错误（如模型未配置），前端要据此给出设置入口；
    // 只透出白名单前缀，避免把任何内部错误码当公开契约。
    const publicCode = isModelErrorCode(error.code) || (typeof error.code === 'string' && /^LAGENT_[A-Z_]+$/.test(error.code)) ? error.code : '';
    res.status(status).json({ error: redact(message, getKey(req)), ...(publicCode ? { code: publicCode } : {}) });
  });
  return app;
}
