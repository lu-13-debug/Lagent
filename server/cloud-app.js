import { workEnabled } from './work/policy.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { APP_VERSION } from './version.js';
import { DEFAULT_MODEL_HOSTS } from './gateway.js';
import { Accounts, PasswordHasher, AuthRateLimiter, authError, usernameValue, passwordValue, publicUser, tokenHash } from './accounts.js';
import { createPhoneAuth, createSmsSender } from './phone-auth.js';
import { MobileGateway, hasDeviceToken, mobileFileOwner, registerMobilePairingRoutes } from './mobile-gateway.js';
import { loadNodeSecret } from './work/node-hub.js';
import { registerNodeRoutes } from './work/node-routes.js';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loopback = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
function serviceUrl(value, production) {
  let url; try { url = new URL(value); } catch { throw new Error('PUBLIC_URL 必须是有效服务根地址'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('PUBLIC_URL 必须是无凭据、查询和片段的根地址');
  if (production && url.protocol !== 'https:') throw new Error('生产环境 PUBLIC_URL 必须使用 HTTPS');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw new Error('服务地址必须使用 HTTPS；本机开发仅允许环回 HTTP');
  return url;
}
function modelPolicy(hosts, { production, allowLocalModelHttp, fetchImpl }) {
  const allowed = [...new Set(hosts.map(x => String(x).trim().toLowerCase()).filter(Boolean))];
  for (const host of allowed) {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes('..') || loopback(host) || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error('LAGENT_MODEL_HOSTS 必须为精确 HTTPS 主机名');
  }
  const assert = settings => {
    const url = new URL(settings.baseUrl);
    const localTest = !production && allowLocalModelHttp === true && typeof fetchImpl === 'function' && url.protocol === 'http:' && loopback(url.hostname);
    if (localTest) return;
    if (url.protocol !== 'https:' || url.port || !allowed.includes(url.hostname.toLowerCase())) throw authError('模型服务未列入管理员配置的 HTTPS 主机白名单，无法发起 AI 请求');
  };
  return { allowed, assert };
}
function cookieValue(req, name) {
  const values = String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  return values.length === 1 ? values[0].slice(name.length + 1) : '';
}
function cookieToken(req) { return cookieValue(req, 'da_session'); }

export function createCloudApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const configuredUrl = options.publicUrl || process.env.PUBLIC_URL;
  if (production && !configuredUrl) throw new Error('生产环境必须配置 HTTPS PUBLIC_URL');
  // Development listeners may use an OS-selected loopback port.
  const publicUrl = configuredUrl ? serviceUrl(configuredUrl, production) : null;
  const hosts = options.modelHosts ?? (process.env.LAGENT_MODEL_HOSTS === undefined ? DEFAULT_MODEL_HOSTS : process.env.LAGENT_MODEL_HOSTS.split(','));
  const policy = modelPolicy(hosts, { ...options, production });
  const dataDir = path.resolve(options.dataDir || process.env.LAGENT_DATA_DIR || path.join(root, 'data', 'cloud'));
  const now = options.now || Date.now;
  const enableWork = workEnabled(options);
  const mobileGateway = enableWork ? new MobileGateway({ dataDir: path.join(dataDir, 'mobile-gateway'), now }) : null;
  const accounts = new Accounts(dataDir, { now, sessionTtlMs: options.sessionTtlMs });
  const hasher = new PasswordHasher({ maxConcurrent: options.maxKdfConcurrent || 2, maxQueue: options.maxKdfQueue ?? 16 });
  const limiter = new AuthRateLimiter(options.authRateLimit, now);
  // 短信发送器允许测试注入；生产从 LAGENT_SMS_* 环境变量读取，未配置时短信接口返回 503。
  const phoneSms = options.phoneSms || (options.smsProvider ? createSmsSender({ env: { ...process.env, LAGENT_SMS_PROVIDER: options.smsProvider } }) : undefined);
  const phoneAuth = createPhoneAuth({ accounts, now, sms: phoneSms, requirePhone: options.phoneRequired, secret: options.phoneSecret || process.env.LAGENT_PHONE_SECRET });
  const app = express(); app.disable('x-powered-by');
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  app.set('trust proxy', trustProxy ? 1 : false);
  const workspaces = new Map(); const maxWorkspaces = options.maxWorkspaces || 32; const idleMs = options.workspaceIdleMs ?? 15 * 60 * 1000;
  let inFlight = 0; let closed = false;
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: production || publicUrl?.protocol === 'https:', path: '/', maxAge: accounts.sessionTtlMs };
  // 设备标识单独放一年期 cookie：用于「记住此设备」和用户名密码登录时的二次验证。
  const deviceOptions = { httpOnly: true, sameSite: 'strict', secure: cookieOptions.secure, path: '/', maxAge: 365 * 86400000 };
  const deviceHashOf = (req, res, { create = false } = {}) => {
    let token = cookieValue(req, 'da_device');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      // 未启用手机号验证时不写设备 cookie：避免给旧部署凭空增加一个长期标识。
      if (!create || !phoneAuth.required) return '';
      token = randomBytes(32).toString('base64url');
      res.cookie('da_device', token, deviceOptions);
    }
    return tokenHash(token);
  };
  const sendSession = (res, user, status = 200) => { const token = accounts.createSession(user.id); res.cookie('da_session', token, cookieOptions); return res.status(status).json({ user: publicUser(user) }); };
  const autoUsername = () => `u${randomBytes(5).toString('hex')}`;
  const requireSession = req => { const session = accounts.session(cookieToken(req)); if (!session) throw authError('登录已失效，请重新登录', 401); return session; };
  const idle = workspace => workspace.refs === 0 && !workspace.app.locals.isBusy();
  const releaseStream = (_req, res) => { res.locals.releaseCloudRequest?.(); res.locals.releaseWorkspaceRequest?.(); };
  function evict(workspace) { workspace.app.locals.close(); workspaces.delete(workspace.userId); }
  function cleanupWorkspaces() { accounts.prune(); accounts.pruneShares(); for (const workspace of workspaces.values()) if (idle(workspace) && now() - workspace.lastUsed >= idleMs) evict(workspace); }
  function workspaceFor(userId) {
    let workspace = workspaces.get(userId);
    if (workspace) return workspace;
    if (workspaces.size >= maxWorkspaces) {
      const candidates = [...workspaces.values()].filter(idle).sort((a, b) => a.lastUsed - b.lastUsed);
      if (!candidates.length) throw authError('服务工作空间已满，请稍后再试', 503);
      evict(candidates[0]);
    }
    const child = createApp({ dataDir: path.join(dataDir, 'users', userId), userId, workEnabled:enableWork, credentialMasterKey: options.credentialMasterKey, analysisTool: options.analysisTool, pdfBuilder: options.pdfBuilder, serveStatic: false, cloud: true, networkGuard: false, maxDatasets: 20, maxConcurrentTasks: 2, maxAsyncRequests: options.maxWorkspaceRequests || 8, fetchImpl: options.fetchImpl, modelTimeoutMs: options.modelTimeoutMs,
      maxTaskEventConnections: options.maxTaskEventConnections, taskHeartbeatMs: options.taskHeartbeatMs,
      maxReportExplorations: options.maxReportExplorations, reportExploreWorkerFactory: options.reportExploreWorkerFactory, reportExploreTimeoutMs: options.reportExploreTimeoutMs,
      isSessionValid: req => Boolean(accounts.session(cookieToken(req))),
      mobileGateway, mobileOwnerId: userId, onMobileEventConnect: releaseStream,
      // 作用域令牌要能脱离浏览器会话使用：把哈希登记到账号库，外层据此找到账号。
      mcpTokenIndex: { onIssue: hash => accounts.registerMcpToken(hash, userId), onRevoke: hash => accounts.revokeMcpToken(hash) },
      getTaskEventOrigin: (_req, res) => res.locals.cloudRequestOrigin,
      onTaskEventConnect: releaseStream,
      getKey: (req, baseUrl) => req.cloudSession?.hash ? accounts.getKey(req.cloudSession.hash, baseUrl) : '', setKey: (req, key, baseUrl) => { if (!req.cloudSession?.hash) throw authError('移动端无模型凭据写权限', 403); accounts.setKey(req.cloudSession.hash, key, baseUrl); }, assertModelSettings: policy.assert });
    workspace = { userId, app: child, refs: 0, lastUsed: now() }; workspaces.set(userId, workspace); return workspace;
  }
  app.locals.cleanupWorkspaces = cleanupWorkspaces;
  const timer = setInterval(cleanupWorkspaces, Math.min(idleMs || 1, 60000)); timer.unref();
  app.locals.close = () => { if (closed) return; closed = true; clearInterval(timer); for (const workspace of workspaces.values()) workspace.app.locals.close(); workspaces.clear(); mobileGateway?.close(); accounts.close(); };

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api') || req.path === '/share' || req.path.startsWith('/share/')) res.setHeader('Cache-Control', 'no-store');
    if (req.path.startsWith('/api/public/shares/') || req.path === '/share' || req.path.startsWith('/share/')) res.setHeader('Referrer-Policy', 'no-referrer');
    // Ignore forwarded Host. Only the deployment's configured public Host is accepted.
    const host = String(req.get('host') || '').toLowerCase();
    let requestUrl;
    try { requestUrl = publicUrl || serviceUrl(`http://${host}`, false); } catch { return res.status(403).json({ error: '请求服务地址无效' }); }
    if (host !== requestUrl.host.toLowerCase() || (!publicUrl && !loopback(requestUrl.hostname))) return res.status(403).json({ error: '请求服务地址无效' });
    res.locals.cloudRequestOrigin = requestUrl.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if ((origin !== undefined && origin !== requestUrl.origin) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: '已拒绝跨站写入请求' });
    }
    if (inFlight >= (options.maxRequests || 128)) return res.status(503).json({ error: '服务繁忙，请稍后重试' });
    inFlight++;
    let released = false; const release = () => { if (!released) { released = true; inFlight--; } }; res.locals.releaseCloudRequest = release; res.once('finish', release); res.once('close', release); next();
  });
  // 本机执行节点的上报体带任务快照，先于全局解析器挂载，避免被 128kb 截断。
  const nodeRouter = express.Router();
  app.use('/api/node', nodeRouter);
  app.use(express.json({ limit: '128kb' }));
  if (enableWork) {
    registerNodeRoutes(nodeRouter, {
      resolveHub: userId => workspaceFor(userId).app.locals.nodeHub,
      authenticate: req => requireSession(req).user.id,
      secret: loadNodeSecret(dataDir, process.env)
    });
  }
  if (enableWork) registerMobilePairingRoutes(app, mobileGateway, { desktopOwner: req => requireSession(req).user.id });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/runtime', (_req, res) => {
    // 注册关闭时客户端要能提前知道，否则登录页还会摆一个点了必然报错的「创建账号」。
    const runtime = { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: APP_VERSION, registrationOpen: process.env.LAGENT_REGISTRATION !== 'closed', modelHosts: policy.allowed, capabilities: { memory: true, modelUsage: true, modelHub: true, ...(workEnabled(options) ? { superagent: true } : {}) } };
    // 只在启用手机号验证时增加字段，保持旧部署的运行时契约不变。
    if (phoneAuth.required) Object.assign(runtime, { phoneRequired: true, smsConfigured: phoneAuth.configured });
    res.json(runtime);
  });
  app.get('/api/auth/session', (req, res) => { const session = accounts.session(cookieToken(req)); res.json({ user: session?.user || null }); });
  app.get('/api/auth/me', (req, res) => {
    const session = requireSession(req); const user = accounts.userById(session.user.id);
    res.json({ user: publicUser(user), phoneRequired: phoneAuth.required && !user.phone_verified_at });
  });
  const rateLimit = req => { const name = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().slice(0, 128) : ''; limiter.consume(req.ip, name); };
  const phoneRegistration = req => phoneAuth.required || (typeof req.body?.phone === 'string' && req.body.phone.trim() !== '');
  app.post('/api/auth/sms/send', async (req, res) => {
    const purpose = req.body?.purpose || 'login';
    // 绑定/换号必须已登录；登录/注册/找回不需要。
    let phone = req.body?.phone;
    if (purpose === 'bind' || purpose === 'change') {
      const session = requireSession(req);
      const current = accounts.userById(session.user.id);
      if (purpose === 'change' && !phone && current.phone) phone = current.phone;
    }
    // 账号密码登录时若被要求二次验证，客户端只知道用户名；由服务端查出绑定号码，
    // 不把完整手机号回传给浏览器。
    if ((purpose === 'login' || purpose === 'reset') && (typeof phone !== 'string' || !phone.trim()) && typeof req.body?.username === 'string' && req.body.username.trim()) {
      const candidate = accounts.userByName(req.body.username.trim().toLowerCase());
      if (!candidate?.phone) throw authError('该账号未绑定手机号，请使用密码登录');
      phone = candidate.phone;
    }
    if (typeof phone !== 'string' || !phone.trim()) throw authError('请输入手机号');
    const result = await phoneAuth.sendCode({ phone, purpose, ip: req.ip, deviceHash: deviceHashOf(req, res), captchaToken: req.body?.captchaToken });
    res.json(result);
  });
  app.post('/api/auth/register', async (req, res) => {
    // 公网部署可用 LAGENT_REGISTRATION=closed 关闭自助注册，只保留管理员已有账号。
    if (process.env.LAGENT_REGISTRATION === 'closed') return res.status(403).json({ error: '当前服务未开放注册' });
    rateLimit(req);
    if (phoneRegistration(req)) {
      if (typeof req.body?.phone !== 'string' || !req.body.phone.trim()) throw authError('请输入手机号');
      if (typeof req.body?.code !== 'string' || !req.body.code.trim()) throw authError('请输入短信验证码');
      const deviceHash = deviceHashOf(req, res, { create: true });
      const verified = await phoneAuth.verifyCode({ phone: req.body.phone, code: req.body.code.trim(), purpose: 'register', ip: req.ip, deviceHash });
      // 冲突提示放在验证码校验之后，避免通过注册接口枚举手机号。
      if (accounts.userByPhone(verified.phone)) throw authError('该手机号已注册，请直接登录', 409);
      let username = typeof req.body?.username === 'string' && req.body.username.trim() ? usernameValue(req.body.username) : '';
      if (!username) {
        for (let attempt = 0; attempt < 5 && !username; attempt++) {
          const candidate = autoUsername();
          if (!accounts.userByName(candidate)) username = candidate;
        }
        if (!username) throw authError('暂时无法分配用户名，请稍后重试', 503);
      }
      const displayName = typeof req.body?.displayName === 'string' && req.body.displayName.trim() ? req.body.displayName.trim() : `用户${verified.phone.slice(-4)}`;
      if ([...displayName].length > 40) throw authError('显示名称须为 1–40 个字符');
      const password = req.body?.password !== undefined && req.body.password !== '' ? passwordValue(req.body.password) : randomBytes(18).toString('base64url');
      const hash = await hasher.hash(password);
      const user = accounts.register(username, displayName, hash, { shareToken: req.body?.shareToken, visitorToken: req.body?.visitorToken }, { phone: verified.phone, phoneVerifiedAt: new Date(now()).toISOString() });
      if (req.body?.rememberDevice !== false) accounts.trustDevice(user.id, deviceHash, now() + 30 * 86400000);
      accounts.auditAuth({ userId: user.id, action: 'register', result: 'ok', phoneHash: verified.phoneHash, deviceHash });
      return sendSession(res, user, 201);
    }
    const username = usernameValue(req.body?.username); const password = passwordValue(req.body?.password);
    const displayName = req.body?.displayName;
    if (typeof displayName !== 'string' || !displayName.trim() || [...displayName.trim()].length > 40) throw authError('显示名称须为 1–40 个字符');
    const hash = await hasher.hash(password); const user = accounts.register(username, displayName.trim(), hash, { shareToken: req.body?.shareToken, visitorToken: req.body?.visitorToken }); sendSession(res, user, 201);
  });
  app.post('/api/auth/login', async (req, res) => {
    rateLimit(req);
    if (typeof req.body?.phone === 'string' && req.body.phone.trim()) {
      if (typeof req.body?.code !== 'string' || !req.body.code.trim()) throw authError('请输入短信验证码');
      const deviceHash = deviceHashOf(req, res, { create: true });
      // 登录侧统一成 401：验证码错误、过期与已使用不应给攻击者额外的状态区分。
      let verified;
      try { verified = await phoneAuth.verifyCode({ phone: req.body.phone, code: req.body.code.trim(), purpose: 'login', ip: req.ip, deviceHash }); }
      catch (error) { if (error?.status === 429) throw error; throw authError('手机号或验证码错误', 401); }
      const user = accounts.userByPhone(verified.phone);
      if (!user) throw authError('手机号或验证码错误', 401);
      if (req.body?.rememberDevice !== false) accounts.trustDevice(user.id, deviceHash, now() + 30 * 86400000);
      accounts.auditAuth({ userId: user.id, action: 'login', result: 'ok', phoneHash: verified.phoneHash, deviceHash });
      return sendSession(res, user);
    }
    let username, password;
    try { username = usernameValue(req.body?.username); password = passwordValue(req.body?.password); } catch { throw authError('用户名或密码错误', 401); }
    const user = accounts.userByName(username);
    if (!await hasher.verify(password, user?.password_hash)) throw authError('用户名或密码错误', 401);
    // A password change during the asynchronous KDF must not create a stale session.
    if (accounts.userByName(username)?.password_hash !== user.password_hash) throw authError('用户名或密码错误', 401);
    // 已绑定手机号的账号在新设备上登录时需要短信验证码；可信设备 30 天内免验证。
    if (phoneAuth.required && user.phone && !accounts.isTrustedDevice(user.id, deviceHashOf(req, res))) {
      if (typeof req.body?.code !== 'string' || !req.body.code.trim()) {
        return res.status(401).json({ error: '新设备登录需要短信验证码', code: 'PHONE_CODE_REQUIRED', phoneMasked: phoneAuth.maskPhone(user.phone) });
      }
      try { await phoneAuth.verifyCode({ phone: user.phone, code: req.body.code.trim(), purpose: 'login', ip: req.ip, deviceHash: deviceHashOf(req, res) }); }
      catch (error) { if (error?.status === 429) throw error; throw authError('手机号或验证码错误', 401); }
    }
    const deviceHash = deviceHashOf(req, res, { create: true });
    if (req.body?.rememberDevice !== false && user.phone) accounts.trustDevice(user.id, deviceHash, now() + 30 * 86400000);
    sendSession(res, user);
  });
  app.post('/api/auth/phone/bind', async (req, res) => {
    const session = requireSession(req); limiter.consume(req.ip, session.user.username);
    if (typeof req.body?.phone !== 'string' || typeof req.body?.code !== 'string') throw authError('请输入手机号和验证码');
    const deviceHash = deviceHashOf(req, res, { create: true });
    const verified = await phoneAuth.verifyCode({ phone: req.body.phone, code: req.body.code.trim(), purpose: 'bind', ip: req.ip, deviceHash });
    const owner = accounts.userByPhone(verified.phone);
    if (owner && owner.id !== session.user.id) throw authError('该手机号已绑定其他账号', 409);
    let user;
    try { user = accounts.setPhone(session.user.id, verified.phone); }
    catch { throw authError('该手机号已绑定其他账号', 409); }
    accounts.trustDevice(user.id, deviceHash, now() + 30 * 86400000);
    accounts.auditAuth({ userId: user.id, action: 'bind', result: 'ok', phoneHash: verified.phoneHash, deviceHash });
    res.json({ user: publicUser(user), phoneRequired: false });
  });
  app.post('/api/auth/phone/change', async (req, res) => {
    const session = requireSession(req); limiter.consume(req.ip, session.user.username);
    const current = accounts.userById(session.user.id);
    if (!current?.phone) throw authError('当前账号尚未绑定手机号，请先绑定');
    if (typeof req.body?.oldCode !== 'string' || typeof req.body?.newPhone !== 'string' || typeof req.body?.newCode !== 'string') throw authError('请填写原手机号验证码、新手机号和新验证码');
    const deviceHash = deviceHashOf(req, res, { create: true });
    await phoneAuth.verifyCode({ phone: current.phone, code: req.body.oldCode.trim(), purpose: 'change', ip: req.ip, deviceHash });
    const verified = await phoneAuth.verifyCode({ phone: req.body.newPhone, code: req.body.newCode.trim(), purpose: 'bind', ip: req.ip, deviceHash });
    const owner = accounts.userByPhone(verified.phone);
    if (owner && owner.id !== current.id) throw authError('该手机号已绑定其他账号', 409);
    let user;
    try { user = accounts.setPhone(current.id, verified.phone); }
    catch { throw authError('该手机号已绑定其他账号', 409); }
    // 换号后撤销其他设备会话，避免旧号码留下的登录继续可用。
    accounts.revokeOtherSessions(current.id, session.hash);
    accounts.auditAuth({ userId: current.id, action: 'change', result: 'ok', phoneHash: verified.phoneHash, deviceHash });
    res.json({ user: publicUser(user) });
  });
  app.post('/api/auth/devices/revoke-all', async (req, res) => {
    const session = requireSession(req); limiter.consume(req.ip, session.user.username);
    const current = accounts.userById(session.user.id);
    const deviceHash = deviceHashOf(req, res);
    if (current?.phone) {
      if (typeof req.body?.code !== 'string' || !req.body.code.trim()) throw authError('请输入短信验证码');
      await phoneAuth.verifyCode({ phone: current.phone, code: req.body.code.trim(), purpose: 'login', ip: req.ip, deviceHash });
    }
    const sessions = accounts.revokeOtherSessions(current.id, session.hash);
    const devices = accounts.revokeOtherTrustedDevices(current.id, deviceHash);
    accounts.auditAuth({ userId: current.id, action: 'revoke', result: 'ok', deviceHash });
    res.json({ ok: true, sessions, devices });
  });
  app.post('/api/auth/logout', (req, res) => {
    const session = accounts.session(cookieToken(req)); if (session) accounts.revoke(session.hash);
    res.clearCookie('da_session', { ...cookieOptions, maxAge: undefined }); res.json({ ok: true });
  });
  app.post('/api/auth/change-password', async (req, res) => {
    const session = requireSession(req); limiter.consume(req.ip, session.user.username);
    const next = passwordValue(req.body?.newPassword); const current = req.body?.currentPassword;
    if (typeof current !== 'string' || current.length > 128 || !await hasher.verify(current, session.passwordHash)) throw authError('当前密码错误', 401);
    // 修改密码属于敏感操作：已绑定手机号的账号需要短信二次验证。
    const phoneUser = accounts.userById(session.user.id);
    if (phoneAuth.required && phoneUser?.phone) {
      if (typeof req.body?.code !== 'string' || !req.body.code.trim()) throw authError('请输入短信验证码');
      try { await phoneAuth.verifyCode({ phone: phoneUser.phone, code: req.body.code.trim(), purpose: 'change', ip: req.ip, deviceHash: deviceHashOf(req, res) }); }
      catch (error) { if (error?.status === 429) throw error; throw authError('验证码错误或已过期'); }
    }
    const hash = await hasher.hash(next);
    const latest = accounts.session(cookieToken(req));
    if (!latest || latest.passwordHash !== session.passwordHash) throw authError('登录已失效，请重新登录', 401);
    accounts.changePassword(session.user.id, hash);
    accounts.auditAuth({ userId: session.user.id, action: 'change-password', result: 'ok' });
    res.clearCookie('da_session', { ...cookieOptions, maxAge: undefined }); res.json({ ok: true });
  });
  // Short-lived in-memory rate limiting; addresses are never persisted or included in reports.
  const shareLimiter = new AuthRateLimiter(options.shareRateLimit || { maxIp: 120, maxUsername: 10000, windowMs: 60000, maxEntries: 10000 }, now);
  const publicShare = req => {
    shareLimiter.consume(req.ip, 'share-public');
    const share = accounts.validShare(req.body?.token);
    if (!share) throw authError('分享不可用', 404);
    return share;
  };
  app.post('/api/public/shares/read', (req, res) => { const share = publicShare(req); res.json({ report: JSON.parse(share.snapshot) }); });
  app.post('/api/public/shares/visit', (req, res) => { const share = publicShare(req); accounts.visitShare(share, req.body?.visitorToken); res.json({ ok:true }); });
  // 只保留早起分享链接的只读查看；新建、列出与撤销入口随 DataAgent 一并下线。
  // 手机端可用的 Work 接口白名单：新增路由必须同时登记在这里，
  // 否则云端会把它拦成 404；未登记路径仍保持 404，避免把 /api/mobile 变成任意路由入口。
  const mobileWorkRoute = req => {
    const { method, path: route } = req;
    if (method === 'GET' && ['/api/mobile/bootstrap', '/api/mobile/policy', '/api/mobile/events', '/api/mobile/notifications', '/api/mobile/models', '/api/mobile/conversations', '/api/mobile/approvals', '/api/mobile/capabilities'].includes(route)) return true;
    if (method === 'GET' && (/^\/api\/mobile\/conversations\/[^/]+$/.test(route) || /^\/api\/mobile\/tickets\/[^/]+$/.test(route) || /^\/api\/mobile\/reports\/[^/]+\/text$/.test(route))) return true;
    // 工单产物列表、预览与签名下载；下载地址自带令牌，仍由路由自身校验。
    if (method === 'GET' && (/^\/api\/mobile\/tickets\/[^/]+\/files$/.test(route) || /^\/api\/mobile\/tickets\/[^/]+\/file\/preview$/.test(route) || /^\/api\/mobile\/files\/[^/]+$/.test(route))) return true;
    if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/mobile\/conversations\/[^/]+$/.test(route)) return true;
    return method === 'POST' && (route === '/api/mobile/command' || route === '/api/mcp' || route === '/api/mobile/notifications/read-all' || route === '/api/mobile/conversations' || /^\/api\/mobile\/conversations\/[^/]+\/messages$/.test(route) || /^\/api\/mobile\/tickets\/[^/]+\/file\/link$/.test(route) || /^\/api\/mobile\/tickets\/[^/]+\/actions$/.test(route) || /^\/api\/mobile\/tickets\/[^/]+\/permissions\/[^/]+$/.test(route) || /^\/api\/mobile\/notifications\/[^/]+\/read$/.test(route) || /^\/api\/mobile\/approvals\/[^/]+\/decision$/.test(route) || /^\/api\/mobile\/tools\/[^/]+\/state$/.test(route) || /^\/api\/mobile\/market\/[^/]+\/install$/.test(route));
  };
  app.use((req, res, next) => {
    if (!req.path.toLowerCase().startsWith('/api/')) return next();
    if (req.path.startsWith('/api/mobile/') && !mobileWorkRoute(req)) return res.status(404).json({ error: '移动接口不存在' });
    let userId;
    // 签名下载 URL 由系统下载器直接请求，不携带设备 token；先按令牌找到归属账号。
    const downloadToken = req.method === 'GET' ? /^\/api\/mobile\/files\/([^/]+)$/.exec(req.path)?.[1] || '' : '';
    // 作用域 MCP 令牌：外部 Agent 通常没有浏览器会话，用令牌哈希在账号库里反查归属账号。
    const scoped = /^Bearer\s+(lagent_mcp_[A-Za-z0-9_-]{43})$/i.exec(String(req.get('authorization') || '').trim())?.[1] || '';
    if (downloadToken) {
      const ownerId = mobileFileOwner(downloadToken);
      if (!ownerId) return res.status(401).json({ error: '下载链接已过期或无效，请重新打开文件' });
      userId = ownerId;
    } else if (scoped) {
      // 作用域令牌只开放 JSON-RPC 入口，不能当移动设备 token 使用。
      if (!(req.method === 'POST' && req.path === '/api/mcp')) return res.status(401).json({ error: 'MCP 令牌仅可用于 MCP 接口' });
      const ownerId = accounts.mcpTokenUser(tokenHash(scoped));
      if (!ownerId) return res.status(401).json({ error: 'MCP 令牌无效或已撤销' });
      userId = ownerId;
    } else if (hasDeviceToken(req)) {
      if (!mobileWorkRoute(req)) return res.status(401).json({ error: '设备 token 仅可用于移动 Work API' });
      const device = mobileGateway.authenticateRequest(req);
      req.mobileAuthenticated = true; req.mobileDevice = device; userId = device.ownerId;
    } else {
      req.cloudSession = requireSession(req); userId = req.cloudSession.user.id;
      // 强制手机号模式下，未绑定账号只能看到账号接口；绑定后才能创建工作区数据。
      if (phoneAuth.required && !req.cloudSession.user.phoneVerified) return res.status(403).json({ error: '请先绑定手机号', code: 'PHONE_BIND_REQUIRED' });
    }
    if (phoneAuth.required && !accounts.userById(userId)?.phone_verified_at) return res.status(403).json({ error: '请先绑定手机号', code: 'PHONE_BIND_REQUIRED' });
    const workspace = workspaceFor(userId);
    if (workspace.refs >= (options.maxWorkspaceRequests || 8)) throw authError('当前账号请求过多，请稍后再试', 429);
    workspace.refs++; workspace.lastUsed = now();
    let released = false; const release = () => { if (!released) { released = true; workspace.refs--; workspace.lastUsed = now(); } }; res.locals.releaseWorkspaceRequest = release; res.once('finish', release); res.once('close', release);
    workspace.app(req, res, next);
  });
  const distDir = options.distDir || path.join(root, 'dist');
  if (existsSync(distDir)) { app.use(express.static(distDir, { index: false })); app.get('/{*path}', (req, res, next) => { if (req.accepts('html')) res.sendFile(path.join(distDir, 'index.html')); else next(); }); }
  app.use((error, _req, res, _next) => {
    const status = error.type === 'entity.parse.failed' ? 400 : error.status || 500;
    res.status(status).json({ error: status >= 500 ? '服务繁忙或处理失败，请稍后重试' : error.type === 'entity.parse.failed' ? 'JSON 请求格式无效' : error.message });
  });
  return app;
}
