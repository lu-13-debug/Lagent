import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_VERSION } from './version.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
const module = await import('./cloud-app.js').catch(() => ({}));
const password = 'account-password-2026';
async function walkFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else out.push(full);
  }
  return out;
}

test('Memory云端需登录、A/B隔离及拒绝跨账号修改',async t=>{
 const s=await setup(t);assert.equal((await s.client().api('/api/memory')).status,401);
 const a=await s.register('memoryowner'),b=await s.register('memoryother');
 const saved=await a.api('/api/memory','POST',{scope:'project',type:'constraint',key:'口径',value:'先核对币种',status:'confirmed'});assert.equal(saved.status,201);
 assert.equal((await b.api('/api/memory')).memories.length,0);
 assert.equal((await b.api(`/api/memory/${saved.memory.id}`,'PATCH',{value:'替换'})).status,404);
 assert.equal((await b.api(`/api/memory/${saved.memory.id}`,'DELETE')).status,404);
 assert.equal((await a.api('/api/memory')).memories[0].value,'先核对币种');
});

test('模型用量需要登录并按账号隔离',async t=>{
 const s=await setup(t);assert.equal((await s.client().api('/api/model-usage?days=all')).status,401);
 const a=await s.register('usageowner'),b=await s.register('usageother');
 const boot=await a.api('/api/bootstrap');await b.api('/api/bootstrap');
 const db=new DatabaseSync(path.join(s.dir,'users',a.user.id,'lagent.sqlite'));
 const entry={id:'owner-call',taskId:'usage-task',stageId:'insights',stageName:'洞察',kind:'stage',provider:'测试',model:'mock',recordedAt:new Date().toISOString(),inputTokens:7,outputTokens:3,totalTokens:10};
 db.prepare('INSERT INTO entities(kind,id,body) VALUES(?,?,?)').run('task','usage-task',JSON.stringify({id:'usage-task',status:'completed'}));db.prepare('INSERT INTO entities(kind,id,body) VALUES(?,?,?)').run('model-call',entry.id,JSON.stringify(entry));db.close();
 assert.equal((await a.api('/api/model-usage?days=all')).totals.calls,1);
 assert.equal((await b.api('/api/model-usage?days=all')).totals.calls,0);
 assert.equal((await a.api('/api/runtime')).capabilities.modelUsage,true);
});

test('Super-agent Work需登录且按云账号隔离',async t=>{
 const s=await setup(t,{workEnabled:true});assert.equal((await s.client().api('/api/work/bootstrap')).status,401);
 const a=await s.register('workowner'),b=await s.register('workother');
 assert.equal((await a.api('/api/runtime')).capabilities.superagent,true);
 const created=await a.api('/api/work/command','POST',{text:'检查留存',clientRequestId:'cloud-work-once',executorInput:{program:'pwd',args:[]}});assert.equal(created.status,201,created.error);
 const ticket=created.ticket;assert.equal((await a.api('/api/work/command','POST',{text:' 检查留存 ',clientRequestId:'cloud-work-once',executorInput:{program:'pwd',args:[]}})).ticket.id,ticket.id);
 const otherBoot=await b.api('/api/work/bootstrap');assert.equal(otherBoot.tickets.some(item=>item.id===ticket.id),false);assert.equal(otherBoot.attention.some(item=>item.ticketId===ticket.id),false);
 assert.equal((await b.api('/api/work/tickets/'+ticket.id)).status,404);
 assert.equal((await b.api('/api/work/tickets/'+ticket.id+'/actions','POST',{action:'stop'})).status,404);
 const own=await a.api('/api/work/tickets/'+ticket.id);assert.equal(own.status,200);assert.equal(own.ticket.id,ticket.id);
});
test('云端移动文件接口进入鉴权而不是被路由白名单拦成 404', async t => {
  const s = await setup(t, { workEnabled: true });
  const anon = s.client();
  assert.equal((await anon.api('/api/mobile/tickets/demo/files')).status, 401);
  assert.equal((await anon.api('/api/mobile/tickets/demo/file/preview?path=report.md')).status, 401);
  assert.equal((await anon.api('/api/mobile/tickets/demo/file/link', 'POST', { path: 'report.md' })).status, 401);
  const token = await anon.api('/api/mobile/files/bad-token');
  assert.equal(token.status, 401);
  assert.match(token.error, /下载链接已过期或无效/);
  // 未登记的手机接口仍然保持 404，避免把 /api/mobile 变成任意路由入口。
  assert.equal((await anon.api('/api/mobile/unknown')).status, 404);
});

async function setup(t, options = {}) {
  assert.equal(typeof module.createCloudApp, 'function', '必须提供 createCloudApp');
  const dir = await mkdtemp(path.join(tmpdir(), 'lagent-cloud-'));
  const publicUrl = options.production ? 'https://cloud.example.test' : 'http://localhost:3002';
  let app, server, base;
  const start = async () => {
    app = module.createCloudApp({ dataDir: dir, publicUrl, ...options });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const close = async () => { await new Promise(resolve => server.close(resolve)); app.locals.close(); };
  await start();
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  const client = (initial = '') => {
    let cookie = initial;
    const api = async (route, method = 'GET', body, headers = {}) => {
      const multipart = body instanceof FormData;
      const wireBody = multipart ? new Request('http://localhost', { method: 'POST', body }) : null;
      const encoded = multipart ? Buffer.from(await wireBody.arrayBuffer()) : body ? Buffer.from(JSON.stringify(body)) : undefined;
      const result = await new Promise((resolve, reject) => {
        const req = request(base + route, { method, headers: { host: new URL(publicUrl).host, ...(cookie ? { cookie } : {}), ...(!['GET', 'HEAD'].includes(method) ? { origin: publicUrl } : {}), ...(body ? { 'content-type': multipart ? wireBody.headers.get('content-type') : 'application/json', 'content-length': encoded.length } : {}), ...headers } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() })); });
        req.once('error', reject); req.end(encoded);
      });
      const setCookie = result.headers['set-cookie']?.[0] || null;
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = result.text;
      let data; try { data = JSON.parse(text); } catch { data = { text }; }
      return { ...data, status: result.status, setCookie, ...(route.startsWith('/api/public/shares/') ? { headers: result.headers } : {}) };
    };
    return { api, cookie: () => cookie };
  };
  const register = async username => { const c = client(); const r = await c.api('/api/auth/register', 'POST', { username, displayName: `用户${username}`, password }); assert.equal(r.status, 201, r.error); return { ...c, user: r.user }; };
  return { client, register, dir, get app() { return app; }, get base() { return base; }, restart: async () => { await close(); await start(); } };
}

test('OpenCode Go requires an explicit cloud allowlist and keeps credentials session scoped', async t => {
  const baseUrl = 'https://opencode.ai/inference/go/openai/v1';
  const closed = await setup(t); const blocked = await closed.register('go_blocked');
  assert.equal((await blocked.api('/api/settings', 'PUT', { baseUrl, model: 'glm-5.3', apiKey: 'private-go-key' })).status, 400);
  const seen = [];
  const open = await setup(t, { modelHosts: ['opencode.ai'], fetchImpl: async (url, init) => { seen.push({ url, init }); return Response.json({ choices: [{ message: { content: '已连接' }, finish_reason: 'stop' }] }); } });
  const user = await open.register('go_allowed');
  assert.equal((await user.api('/api/settings', 'PUT', { baseUrl: 'https://opencode.ai.evil.example/inference/go/openai/v1', model: 'glm-5.3', apiKey: 'private-go-key' })).status, 400);
  const saved = await user.api('/api/settings', 'PUT', { baseUrl, model: 'glm-5.3', apiKey: 'private-go-key' });
  assert.equal(saved.status, 200); assert.equal(JSON.stringify(saved).includes('private-go-key'), false);
  assert.equal((await user.api('/api/settings/test', 'POST', {})).status, 200);
  assert.equal(seen[0].url, `${baseUrl}/chat/completions`);
  assert.equal(seen[0].init.headers.authorization, 'Bearer private-go-key');
  assert.equal(seen[0].init.redirect, 'error');
});

test('cloud runtime, password hashing, opaque secure cookie and duplicate identity validation', async t => {
  const s = await setup(t, { production: true });
  const anon = s.client();
  assert.deepEqual(await anon.api('/api/runtime'), { mode: 'cloud', authRequired: true, serviceName: 'Lagent', version: APP_VERSION, registrationOpen: true, modelHosts: ['api.deepseek.com', 'api.anthropic.com', 'api.openai.com'], capabilities: { memory: true, modelUsage: true, modelHub: true, superagent: true }, status: 200, setCookie: null });
  assert.equal((await anon.api('/api/bootstrap')).status, 401);
  assert.equal((await anon.api('/api/auth/session')).user, null);
  const r = await anon.api('/api/auth/register', 'POST', { username: 'Alice_01', displayName: '阿丽丝', password });
  assert.equal(r.status, 201);
  assert.equal(r.user.username, 'alice_01');
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Strict/); assert.match(r.setCookie, /Secure/);
  assert.equal((await s.client().api('/api/auth/register', 'POST', { username: 'ALICE_01', displayName: '重复', password })).status, 409);
  assert.equal((await s.client().api('/api/auth/register', 'POST', { username: 'bad', displayName: '短密码', password: 'short' })).status, 400);
  const token = anon.cookie().split('=')[1];
  const db = new DatabaseSync(path.join(s.dir, 'accounts.sqlite'));
  try {
    const user = db.prepare('SELECT * FROM users').get();
    assert.equal(user.password_hash.includes(password), false); assert.equal(user.password_hash.startsWith('scrypt$32768$8$3$'), true);
    const session = db.prepare('SELECT * FROM sessions').get();
    assert.equal(session.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(session).includes(token), false);
  } finally { db.close(); }
});

test('default whitelist permits the three official providers and rejects lookalike hosts', async t => {
  const seen = [];
  const s = await setup(t, { fetchImpl: async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization, apiKey: init.headers['x-api-key'] });
    assert.equal(init.redirect, 'error');
    return Response.json(url.includes('api.anthropic.com') ? { type: 'message', content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' } : { choices: [{ message: { content: 'OK' } }] });
  } });
  const a = await s.register('official_providers');
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.anthropic.com/v1', 'https://api.openai.com/v1']) {
    assert.equal((await a.api('/api/settings', 'PUT', { baseUrl, model: 'account-model', apiKey: 'session-provider-key' })).status, 200);
    assert.equal((await a.api('/api/settings/test', 'POST', {})).status, 200);
  }
  assert.deepEqual(seen.map(x => x.url), ['https://api.deepseek.com/chat/completions', 'https://api.anthropic.com/v1/messages', 'https://api.openai.com/v1/chat/completions']);
  for (const baseUrl of ['https://api.openai.com.evil.test/v1', 'https://sub.api.deepseek.com/v1', 'https://api.anthropic.com:444/v1', 'http://api.openai.com/v1']) {
    assert.equal((await a.api('/api/settings', 'PUT', { baseUrl, apiKey: 'must-not-send' })).status, 400);
  }
  assert.equal(seen.length, 3);
  assert.ok(seen.every(x => x.url.includes('api.anthropic.com') ? x.apiKey === 'session-provider-key' && !x.authorization : x.authorization === 'Bearer session-provider-key'));
});

test('explicit environment whitelist replaces defaults and an empty value disables AI', async t => {
  const previous = process.env.LAGENT_MODEL_HOSTS;
  t.after(() => { if (previous === undefined) delete process.env.LAGENT_MODEL_HOSTS; else process.env.LAGENT_MODEL_HOSTS = previous; });
  process.env.LAGENT_MODEL_HOSTS = 'trusted.example.test';
  const custom = await setup(t);
  assert.deepEqual((await custom.client().api('/api/runtime')).modelHosts, ['trusted.example.test']);
  process.env.LAGENT_MODEL_HOSTS = '';
  const disabled = await setup(t);
  assert.deepEqual((await disabled.client().api('/api/runtime')).modelHosts, []);
});

test('注册关闭时运行时返回开关，注册接口直接拒绝', async t => {
  const previous = process.env.LAGENT_REGISTRATION;
  t.after(() => { if (previous === undefined) delete process.env.LAGENT_REGISTRATION; else process.env.LAGENT_REGISTRATION = previous; });
  process.env.LAGENT_REGISTRATION = 'closed';
  const s = await setup(t);
  const anon = s.client();
  assert.equal((await anon.api('/api/runtime')).registrationOpen, false);
  assert.equal((await anon.api('/api/auth/register', 'POST', { username: 'closed_user', displayName: '关注册', password: 'Passw0rd!2026' })).status, 403);
});

test('logout, password changes and expiry revoke sessions and memory credentials', async t => {
  let time = Date.now(); const s = await setup(t, { now: () => time, sessionTtlMs: 10000 });
  const a = await s.register('revoke_user'); const stale = s.client(a.cookie());
  await a.api('/api/auth/logout', 'POST', {}); assert.equal((await stale.api('/api/bootstrap')).status, 401);
  await a.api('/api/auth/login', 'POST', { username: 'revoke_user', password });
  const b = s.client(); await b.api('/api/auth/login', 'POST', { username: 'revoke_user', password });
  assert.equal((await a.api('/api/auth/change-password', 'POST', { currentPassword: 'wrong-password', newPassword: 'changed-password-2026' })).status, 401);
  assert.equal((await a.api('/api/auth/change-password', 'POST', { currentPassword: password, newPassword: 'changed-password-2026' })).status, 200);
  assert.equal((await b.api('/api/bootstrap')).status, 401);
  assert.equal((await a.api('/api/auth/login', 'POST', { username: 'revoke_user', password })).status, 401);
  assert.equal((await a.api('/api/auth/login', 'POST', { username: 'revoke_user', password: 'changed-password-2026' })).status, 200);
  time += 10001; assert.equal((await a.api('/api/auth/session')).user, null); assert.equal((await a.api('/api/bootstrap')).status, 401);
});

test('host and same-origin validation rejects cross-site writes and ignores spoofed XFF by default', async t => {
  const s = await setup(t, { authRateLimit: { maxIp: 3, maxUsername: 3, windowMs: 60000 } });
  const c = s.client();
  assert.equal((await c.api('/api/runtime', 'GET', undefined, { host: 'evil.test' })).status, 403);
  assert.equal((await c.api('/api/auth/register', 'POST', {}, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await c.api('/api/auth/register', 'POST', {}, { origin: '', 'sec-fetch-site': 'cross-site' })).status, 403);
  for (let i = 0; i < 3; i++) assert.equal((await c.api('/api/auth/login', 'POST', { username: `missing_${i}`, password }, { 'x-forwarded-for': `10.0.0.${i}` })).status, 401);
  assert.equal((await c.api('/api/auth/login', 'POST', { username: 'different', password }, { 'x-forwarded-for': '10.0.0.100' })).status, 429);
});

test('disconnecting a model-test client cannot evict its workspace while the async operation is in flight', async t => {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  const s = await setup(t, { maxWorkspaces: 1, maxWorkspaceRequests: 1, modelHosts: ['model.example.test'], fetchImpl: async () => { entered(); await gate; return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); } });
  t.after(release);
  const a = await s.register('disconnect_a'); const b = await s.register('disconnect_b');
  await a.api('/api/settings', 'PUT', { baseUrl: 'https://model.example.test/v1', apiKey: 'disconnect-memory-key' });
  const req = request(s.base + '/api/settings/test', { method: 'POST', headers: { host: 'localhost:3002', origin: 'http://localhost:3002', cookie: a.cookie(), 'content-type': 'application/json' } });
  req.on('error', () => {}); req.end('{}'); await started; req.destroy(); await new Promise(resolve => setTimeout(resolve, 20));
  const blocked = await b.api('/api/bootstrap');
  const extra = a.api('/api/settings/test', 'POST', {}); await new Promise(resolve => setTimeout(resolve, 30)); release();
  assert.equal(blocked.status, 503);
  assert.equal((await extra).status, 429);
});

test('model discovery is authenticated, checks hosts, isolates session keys and never saves draft settings', async t => {
  const calls = [];
  const s = await setup(t, { fetchImpl: async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization });
    return Response.json({ data: [{ id: 'discovered-model', name: '真实目录模型' }] });
  } });
  assert.equal((await s.client().api('/api/settings/models', 'POST', { baseUrl: 'https://api.deepseek.com', apiKey: 'anon-key' })).status, 401);
  const a = await s.register('catalog_user'); const b = s.client();
  await b.api('/api/auth/login', 'POST', { username: 'catalog_user', password });
  const before = (await a.api('/api/settings')).settings;
  const draft = await a.api('/api/settings/models', 'POST', { baseUrl: 'https://api.deepseek.com/chat/completions', apiKey: 'temporary-catalog-secret' });
  assert.equal(draft.status, 200, draft.error);
  assert.deepEqual(draft.models, [{ id: 'discovered-model', name: '真实目录模型' }]);
  assert.equal(draft.baseUrl, 'https://api.deepseek.com');
  assert.deepEqual((await a.api('/api/settings')).settings, before);
  await a.api('/api/settings', 'PUT', { baseUrl: 'https://api.deepseek.com', model: 'saved-model', apiKey: 'saved-session-key' });
  assert.equal((await a.api('/api/settings/models', 'POST', { baseUrl: 'https://api.deepseek.com' })).status, 200);
  assert.equal((await b.api('/api/settings/models', 'POST', { baseUrl: 'https://api.deepseek.com' })).status, 400);
  assert.equal((await a.api('/api/settings/models', 'POST', { baseUrl: 'https://api.openai.com/v1' })).status, 400, '不能把原地址的会话 Key 自动发到新地址');
  for (const baseUrl of ['https://api.deepseek.com.evil.test', 'http://127.0.0.1:9876', 'https://api.openai.com:444/v1']) {
    assert.equal((await a.api('/api/settings/models', 'POST', { baseUrl, apiKey: 'denied-key' })).status, 400);
  }
  assert.equal((await a.api('/api/settings', 'PUT', { baseUrl: 'https://api.openai.com/v1' })).status, 400, '切换地址后保存也必须提供新 Key');
  assert.deepEqual(calls, [
    { url: 'https://api.deepseek.com/models', authorization: 'Bearer temporary-catalog-secret' },
    { url: 'https://api.deepseek.com/models', authorization: 'Bearer saved-session-key' },
  ]);
  await b.api('/api/settings', 'PUT', { baseUrl: 'https://api.openai.com/v1', model: 'other-provider', apiKey: 'other-session-provider-key' });
  assert.equal((await a.api('/api/settings/models', 'POST', { baseUrl: 'https://api.openai.com/v1' })).status, 400, '同账号另一会话切换供应商后不能转发旧 Key');
  assert.equal(calls.length, 2);
  for (const file of await walkFiles(s.dir)) assert.equal((await readFile(file)).includes(Buffer.from('temporary-catalog-secret')), false);
});

test('provider authentication errors during discovery do not log the user out', async t => {
  const s = await setup(t, { fetchImpl: async () => Response.json({ error: { message: 'do-not-echo-key' } }, { status: 401 }) });
  const a = await s.register('catalog_error');
  const result = await a.api('/api/settings/models', 'POST', { baseUrl: 'https://api.deepseek.com', apiKey: 'do-not-echo-key' });
  assert.equal(result.status, 400); assert.match(result.error, /Key|凭据/); assert.equal(result.error.includes('do-not-echo-key'), false);
  assert.equal((await a.api('/api/auth/session')).user.id, a.user.id);
});

test('cloud API and static responses provide the same restrictive browser security headers', async t => {
  const s = await setup(t, { publicUrl: undefined });
  for (const route of ['/', '/api/runtime']) {
    const response = await fetch(s.base + route);
    assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'same-origin');
    await response.arrayBuffer();
  }
});
