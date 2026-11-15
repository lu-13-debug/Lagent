import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSmsSender } from './phone-auth.js';
const module = await import('./cloud-app.js').catch(() => ({}));

const password = 'x'.repeat(12);

// 云服务测试需要同时保存 da_session 与 da_device；只取第一个 Set-Cookie 会丢掉设备信任。
function cookieJar(initial = {}) {
  const jar = { ...initial };
  return {
    header: () => Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; '),
    absorb: response => {
      for (const cookie of response.headers.getSetCookie?.() || []) {
        const pair = cookie.split(';')[0];
        const index = pair.indexOf('=');
        if (index > 0) jar[pair.slice(0, index)] = pair.slice(index + 1);
      }
    },
    values: () => ({ ...jar })
  };
}

async function setup(t, options = {}) {
  assert.equal(typeof module.createCloudApp, 'function', '必须提供 createCloudApp');
  const dir = await mkdtemp(path.join(tmpdir(), 'lagent-cloud-phone-'));
  let time = Date.parse('2026-11-14T08:00:00.000Z');
  const sms = createSmsSender({ env: { NODE_ENV: 'test', LAGENT_SMS_PROVIDER: 'mock' } });
  let app = null, server = null, base = '';
  const start = async (extra = {}) => {
    app = module.createCloudApp({ dataDir: dir, now: () => time, phoneSms: sms, phoneRequired: true, phoneSecret: 'x'.repeat(32), ...extra });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    base = `http://127.0.0.1:${server.address().port}`;
  };
  const close = async () => { if (app) await new Promise(resolve => server.close(resolve)); app?.locals.close(); app = null; };
  t.after(async () => { await close(); await rm(dir, { recursive: true, force: true }); });
  await start(options);
  const client = (optionsClient = {}) => {
    const jar = cookieJar(optionsClient.cookies);
    const api = async (route, method = 'GET', body, headers = {}) => {
      const response = await fetch(base + route, {
        method,
        headers: {
          ...(jar.header() ? { cookie: jar.header() } : {}),
          ...(!['GET', 'HEAD'].includes(method) ? { origin: base } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual'
      });
      jar.absorb(response);
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = { text }; }
      return { ...data, status: response.status };
    };
    return { api, cookies: jar.values, header: jar.header };
  };
  const sendCode = async (client, body) => {
    const result = await client.api('/api/auth/sms/send', 'POST', body);
    assert.equal(result.status, 200, result.error);
    assert.ok(result.devCode, '测试环境应返回 devCode');
    return result;
  };
  return {
    client, sendCode, dir, sms,
    advance: ms => { time += ms; },
    restart: async extra => { await close(); await start(extra); },
    get base() { return base; }
  };
}

test('手机号强制模式：发送验证码、注册、掩码与登录态', async t => {
  const s = await setup(t);
  const client = s.client();
  const runtime = await client.api('/api/runtime');
  assert.equal(runtime.phoneRequired, true);
  assert.equal(runtime.smsConfigured, true);

  const sent = await s.sendCode(client, { phone: '13800138000', purpose: 'register' });
  assert.equal(sent.expiresIn, 300);
  const registered = await client.api('/api/auth/register', 'POST', { phone: '13800138000', code: sent.devCode, username: 'phone_user', displayName: '手机用户', password });
  assert.equal(registered.status, 201, registered.error);
  assert.equal(registered.user.phoneMasked, '138****8000');
  assert.equal(registered.user.phoneVerified, true);
  assert.doesNotMatch(JSON.stringify(registered), /13800138000/);
  assert.equal((await client.api('/api/auth/me')).phoneRequired, false);
  assert.equal((await client.api('/api/bootstrap')).status, 200);
  // 手机号已注册：验证码有效时给出明确冲突，而不是静默创建第二个账号。
  s.advance(61_000);
  const again = await s.sendCode(client, { phone: '13800138000', purpose: 'register' });
  const duplicate = await client.api('/api/auth/register', 'POST', { phone: '13800138000', code: again.devCode, username: 'phone_user_two', password });
  assert.equal(duplicate.status, 409);
});

test('手机号强制模式：存量账号先拦截再绑定手机号', async t => {
  const s = await setup(t, { phoneRequired: false });
  const legacy = s.client();
  const registered = await legacy.api('/api/auth/register', 'POST', { username: 'legacy_user', displayName: '老用户', password });
  assert.equal(registered.status, 201, registered.error);
  assert.equal((await legacy.api('/api/bootstrap')).status, 200);

  await s.restart({ phoneRequired: true });
  const blocked = await legacy.api('/api/bootstrap');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.code, 'PHONE_BIND_REQUIRED');
  assert.equal((await legacy.api('/api/auth/me')).phoneRequired, true);

  const sent = await s.sendCode(legacy, { purpose: 'bind', phone: '13900139000' });
  const bound = await legacy.api('/api/auth/phone/bind', 'POST', { phone: '13900139000', code: sent.devCode });
  assert.equal(bound.status, 200, bound.error);
  assert.equal(bound.user.phoneMasked, '139****9000');
  assert.equal(bound.user.phoneVerified, true);
  assert.equal((await legacy.api('/api/auth/me')).phoneRequired, false);
  assert.equal((await legacy.api('/api/bootstrap')).status, 200);
});

test('新设备密码登录需要短信验证；可信设备 30 天内免验证', async t => {
  const s = await setup(t);
  const owner = s.client();
  const registered = await s.sendCode(owner, { phone: '13700137000', purpose: 'register' });
  assert.equal((await owner.api('/api/auth/register', 'POST', { phone: '13700137000', code: registered.devCode, username: 'device_owner', password })).status, 201);

  const newDevice = s.client();
  const challenged = await newDevice.api('/api/auth/login', 'POST', { username: 'device_owner', password });
  assert.equal(challenged.status, 401);
  assert.equal(challenged.code, 'PHONE_CODE_REQUIRED');
  assert.equal(challenged.phoneMasked, '137****7000');
  assert.doesNotMatch(JSON.stringify(challenged), /13700137000/);

  s.advance(61_000);
  const code = await s.sendCode(newDevice, { purpose: 'login', username: 'device_owner' });
  assert.doesNotMatch(JSON.stringify(code), /13700137000/);
  const loggedIn = await newDevice.api('/api/auth/login', 'POST', { username: 'device_owner', password, code: code.devCode });
  assert.equal(loggedIn.status, 200, loggedIn.error);
  assert.equal((await newDevice.api('/api/auth/me')).user.username, 'device_owner');

  // 同一设备退出后用密码即可登录，不再需要短信。
  await newDevice.api('/api/auth/logout', 'POST', {});
  const trusted = await newDevice.api('/api/auth/login', 'POST', { username: 'device_owner', password });
  assert.equal(trusted.status, 200, trusted.error);
});

test('撤销其他设备会踢掉旧会话，并保留当前设备', async t => {
  const s = await setup(t);
  const first = s.client();
  const sent = await s.sendCode(first, { phone: '13600136000', purpose: 'register' });
  assert.equal((await first.api('/api/auth/register', 'POST', { phone: '13600136000', code: sent.devCode, username: 'revoke_owner', password })).status, 201);

  const second = s.client();
  s.advance(61_000);
  const code = await s.sendCode(second, { purpose: 'login', username: 'revoke_owner', phone: '13600136000' });
  assert.equal((await second.api('/api/auth/login', 'POST', { username: 'revoke_owner', password, code: code.devCode })).status, 200);
  assert.equal((await first.api('/api/auth/me')).status, 200);

  s.advance(61_000);
  const revokeCode = await s.sendCode(second, { purpose: 'login', phone: '13600136000' });
  const revoked = await second.api('/api/auth/devices/revoke-all', 'POST', { code: revokeCode.devCode });
  assert.equal(revoked.status, 200, revoked.error);
  assert.equal(revoked.sessions, 1);
  assert.equal((await first.api('/api/auth/me')).status, 401);
  assert.equal((await second.api('/api/auth/me')).status, 200);
});

test('手机号登录不泄露号码是否注册，验证码不可重放', async t => {
  const s = await setup(t);
  const client = s.client();
  const unknown = await s.sendCode(client, { phone: '13500135000', purpose: 'login' });
  assert.match(unknown.message, /若号码可用/);
  const failed = await client.api('/api/auth/login', 'POST', { phone: '13500135000', code: unknown.devCode });
  assert.equal(failed.status, 401);
  assert.equal(failed.error, '手机号或验证码错误');
  const replay = await client.api('/api/auth/login', 'POST', { phone: '13500135000', code: unknown.devCode });
  assert.equal(replay.status, 401);

  // 60 秒内重复发送被限流。
  const limited = await client.api('/api/auth/sms/send', 'POST', { phone: '13500135000', purpose: 'login' });
  assert.equal(limited.status, 429);
});

test('更换手机号需要原号与新号两次验证码', async t => {
  const s = await setup(t);
  const client = s.client();
  const sent = await s.sendCode(client, { phone: '13300133000', purpose: 'register' });
  assert.equal((await client.api('/api/auth/register', 'POST', { phone: '13300133000', code: sent.devCode, username: 'move_owner', password })).status, 201);

  s.advance(61_000);
  const oldCode = await s.sendCode(client, { purpose: 'change' });
  const newCode = await s.sendCode(client, { phone: '13200132000', purpose: 'bind' });
  const changed = await client.api('/api/auth/phone/change', 'POST', { oldCode: oldCode.devCode, newPhone: '13200132000', newCode: newCode.devCode });
  assert.equal(changed.status, 200, changed.error);
  assert.equal(changed.user.phoneMasked, '132****2000');
  assert.equal((await client.api('/api/auth/me')).user.phoneMasked, '132****2000');

  s.advance(61_000);
  const oldLogin = await s.sendCode(client, { phone: '13300133000', purpose: 'login' });
  assert.equal((await client.api('/api/auth/login', 'POST', { phone: '13300133000', code: oldLogin.devCode })).status, 401);
  s.advance(61_000);
  const newLogin = await s.sendCode(client, { phone: '13200132000', purpose: 'login' });
  assert.equal((await client.api('/api/auth/login', 'POST', { phone: '13200132000', code: newLogin.devCode })).status, 200);
});

test('修改密码属于敏感操作，需要短信验证码', async t => {
  const s = await setup(t);
  const client = s.client();
  const sent = await s.sendCode(client, { phone: '13400134000', purpose: 'register' });
  assert.equal((await client.api('/api/auth/register', 'POST', { phone: '13400134000', code: sent.devCode, username: 'secure_owner', password })).status, 201);
  s.advance(61_000);
  const code = await s.sendCode(client, { purpose: 'change' });
  assert.doesNotMatch(JSON.stringify(code), /13400134000/);

  const missing = await client.api('/api/auth/change-password', 'POST', { currentPassword: password, newPassword: 'y'.repeat(12) });
  assert.equal(missing.status, 400);
  assert.equal(missing.error, '请输入短信验证码');
  const wrong = await client.api('/api/auth/change-password', 'POST', { currentPassword: password, newPassword: 'y'.repeat(12), code: '000000' });
  assert.equal(wrong.status, 400);
  const changed = await client.api('/api/auth/change-password', 'POST', { currentPassword: password, newPassword: 'y'.repeat(12), code: code.devCode });
  assert.equal(changed.status, 200, changed.error);
  assert.equal((await client.api('/api/auth/me')).status, 401);
  const relogin = await client.api('/api/auth/login', 'POST', { username: 'secure_owner', password: 'y'.repeat(12) });
  // 可信设备仍有效，密码正确即可登录。
  assert.equal(relogin.status, 200, relogin.error);
});

test('云端作用域 MCP 令牌可脱离浏览器会话使用，并可撤销', async t => {
  const s = await setup(t, { workEnabled: true });
  const owner = s.client();
  const sent = await s.sendCode(owner, { phone: '13100131000', purpose: 'register' });
  assert.equal((await owner.api('/api/auth/register', 'POST', { phone: '13100131000', code: sent.devCode, username: 'mcp_owner', password })).status, 201);
  const projectDir = path.join(s.dir, 'project-a');
  await mkdir(projectDir, { recursive: true });
  const imported = await owner.api('/api/work/projects', 'POST', { path: projectDir });
  assert.equal(imported.status, 201, imported.error);
  const projectId = imported.project.id;

  const issued = await owner.api('/api/mcp/tokens', 'POST', { name: '外部只读', projectId });
  assert.equal(issued.status, 201, issued.error);
  assert.match(issued.token, /^lagent_mcp_/);

  const rpc = async (token, method, params) => {
    const response = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: s.base },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })
    });
    const body = await response.text();
    return { status: response.status, body: body ? JSON.parse(body) : null };
  };
  const listed = await rpc(issued.token, 'tools/list');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const names = listed.body.result.tools.map(tool => tool.name);
  assert.equal(names.includes('work_list_projects'), true);
  assert.equal(names.includes('work_send_command'), false);

  const projects = await rpc(issued.token, 'tools/call', { name: 'work_list_projects', arguments: {} });
  assert.equal(projects.status, 200);
  assert.deepEqual(JSON.parse(projects.body.result.content[0].text).projects.map(project => project.id), [projectId]);

  // 令牌不能管理令牌或访问其他接口。
  assert.equal((await rpc(issued.token, 'ping')).status, 200);
  const manage = await fetch(`${s.base}/api/mcp/tokens`, { method: 'GET', headers: { authorization: `Bearer ${issued.token}` } });
  assert.equal(manage.status, 401);

  assert.equal((await owner.api(`/api/mcp/tokens/${issued.record.id}`, 'DELETE')).status, 200);
  assert.equal((await rpc(issued.token, 'tools/list')).status, 401);
});

test('未启用手机号验证时保持旧注册/登录契约', async t => {
  const s = await setup(t, { phoneRequired: false });
  const client = s.client();
  const runtime = await client.api('/api/runtime');
  assert.equal(runtime.phoneRequired, undefined);
  assert.equal(runtime.smsConfigured, undefined);
  assert.equal((await client.api('/api/auth/register', 'POST', { username: 'plain_user', displayName: '普通用户', password })).status, 201);
  const login = await client.api('/api/auth/login', 'POST', { username: 'plain_user', password });
  assert.equal(login.status, 200, login.error);
  assert.equal(login.user.phoneMasked, undefined);
  assert.equal(login.user.phoneVerified, false);
});
