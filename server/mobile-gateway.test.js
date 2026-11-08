import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { createCloudApp } from './cloud-app.js';
import { tokenHash } from './accounts.js';
import {
  MOBILE_DEVICE_TTL_MS,
  MOBILE_NOTIFICATION_MAX,
  MOBILE_REQUEST_LIMIT,
  MobileGateway,
  mobileWorkEvent,
  sanitizeMobileBootstrap,
  sanitizeMobileDetail,
  sanitizeMobilePolicy,
  sanitizeMobileTicket
} from './mobile-gateway.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tempDir = prefix => mkdtempSync(join(tmpdir(), prefix));
const bearer = token => ({ headers: { authorization: `Bearer ${token}` } });
const legacy = token => ({ headers: { 'x-device-token': token } });
let actorSequence = 0;
const nextActor = () => `actor-${++actorSequence}`;

function issueDevice(gateway, ownerId = 'owner-a', deviceName = '手机') {
  const pair = gateway.createPair(ownerId);
  return gateway.claim(pair.code, deviceName, nextActor());
}

async function serve(app) {
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server, app) {
  await new Promise(resolve => server.close(resolve));
  app.locals.close?.();
}

async function request(base, path, { method = 'GET', body, token, cookie } = {}) {
  return fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function register(base, username) {
  const response = await request(base, '/api/auth/register', {
    method: 'POST',
    body: { username, password: 'Password123!', displayName: username }
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie').split(';')[0];
}

async function pairDevice(base, cookie) {
  const pair = await request(base, '/api/mobile/pair', { method: 'POST', body: {}, cookie });
  assert.equal(pair.status, 201);
  const code = await pair.json();
  const claim = await request(base, '/api/mobile/pair/claim', {
    method: 'POST',
    body: { code: code.code, deviceName: '<Phone & Test>' }
  });
  assert.equal(claim.status, 201);
  return claim.json();
}

test('移动配对码一次性、5 分钟过期并按来源限制 5 次失败', t => {
  let now = Date.UTC(2026, 10, 6, 8, 0, 0);
  const dir = tempDir('mobile-pair-');
  const gateway = new MobileGateway({
    dataDir: dir,
    now: () => now,
    pairTtlMs: 5 * 60 * 1000,
    deviceTtlMs: MOBILE_DEVICE_TTL_MS,
    maxClaimAttempts: 5
  });
  t.after(() => { gateway.close(); rmSync(dir, { recursive: true, force: true }); });

  const first = gateway.createPair('owner-a');
  assert.match(first.code, /^\d{6}$/);
  assert.equal(new Date(first.expiresAt).getTime(), now + 5 * 60 * 1000);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.throws(() => gateway.claim('000000', '手机', 'same-source'), { status: 401 });
  }
  assert.throws(() => gateway.claim(first.code, '手机', 'same-source'), { status: 429 });

  const oneTime = gateway.createPair('owner-a');
  const device = gateway.claim(oneTime.code, '一次性手机', nextActor());
  assert.match(device.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => gateway.claim(oneTime.code, '再次领取', nextActor()), { status: 401 });

  const expiring = gateway.createPair('owner-a');
  now += 5 * 60 * 1000 + 1;
  assert.throws(() => gateway.claim(expiring.code, '过期手机', nextActor()), { status: 401 });
});

test('设备 token 仅存 hash，支持双认证头、90 天 TTL、撤销、owner 隔离和每分钟限流', t => {
  let now = Date.UTC(2026, 10, 6, 9, 0, 0);
  const dir = tempDir('mobile-token-');
  const gateway = new MobileGateway({
    dataDir: dir,
    now: () => now,
    deviceTtlMs: MOBILE_DEVICE_TTL_MS,
    requestLimit: MOBILE_REQUEST_LIMIT
  });
  t.after(() => { gateway.close(); rmSync(dir, { recursive: true, force: true }); });

  const device = issueDevice(gateway, 'owner-a');
  assert.equal(new Date(device.expiresAt).getTime(), now + MOBILE_DEVICE_TTL_MS);
  const row = gateway.db.prepare('SELECT token_hash FROM mobile_devices WHERE id=?').get(device.deviceId);
  assert.equal(row.token_hash, tokenHash(device.deviceToken));
  assert.notEqual(row.token_hash, device.deviceToken);

  assert.equal(gateway.authenticateRequest(bearer(device.deviceToken)).ownerId, 'owner-a');
  assert.equal(gateway.authenticateRequest(legacy(device.deviceToken)).ownerId, 'owner-a');
  assert.throws(() => gateway.authenticateToken(device.deviceToken, { ownerId: 'owner-b' }), { status: 401 });
  for (let count = 2; count < MOBILE_REQUEST_LIMIT; count++) gateway.authenticateToken(device.deviceToken);
  assert.throws(() => gateway.authenticateToken(device.deviceToken), { status: 429 });

  const revokeDevice = issueDevice(gateway, 'owner-revoke');
  assert.equal(gateway.revokeDevice('owner-revoke', revokeDevice.deviceId), true);
  assert.throws(() => gateway.authenticateToken(revokeDevice.deviceToken), { status: 401 });

  now += MOBILE_DEVICE_TTL_MS + 1;
  const expired = issueDevice(gateway, 'owner-expired');
  now += MOBILE_DEVICE_TTL_MS + 1;
  assert.throws(() => gateway.authenticateToken(expired.deviceToken), { status: 401 });
});

test('移动投影和 Work 事件采用字段 allowlist，不泄露命令、prompt、原始记录或凭据', () => {
  const secret = 'MOBILE_SECRET_COMMAND_PROMPT_RECORD_TOKEN';
  const publicTitle = 'T'.repeat(120);
  const publicSummary = 'S'.repeat(450);
  const ticket = {
    id: 'ticket-1', status: 'awaiting_review', stage: 'executor', source: 'manual', executor: 'analysis',
    datasetId: 'dataset-1', createdAt: '2026-11-06T00:00:00.000Z', updatedAt: '2026-11-06T00:00:01.000Z',
    title: publicTitle, summary: publicSummary, handoffSummary: 'H'.repeat(450), parentTicketId: 'ticket-parent', handoffDepth: 2,
    planId: 'plan-1', planStep: 1, planTotal: 3, planSecret: secret,
    chainRootId: secret, handoffChildId: secret, command: secret, executorInput: secret, approvalSnapshot: secret, prompt: secret,
    attention: { question: '确认执行？', createdAt: secret, options: [{ id: 'approve', label: '批准', action: 'approve', prompt: secret }] }
  };
  const bootstrap = {
    capabilities: { work: true, credentials: secret }, tickets: [ticket], datasets: [{ id: 'dataset-1', name: '数据', rowCount: 2, source: 'upload', records: [{ secret }], privateToken: secret }],
    agents: [{ id: 'agent-1', name: '分析', kind: 'analysis', status: 'ready', capabilities: ['work'], prompt: secret }],
    tools: [{ command: secret }], plans: [{ id: 'plan-1', goal: '计划目标', status: 'active', currentStep: 1, totalSteps: 3, updatedAt: ticket.updatedAt, command: secret, executorInput: secret }], policy: { mode: 'personal', acceptMode: 'explicit', requireApproval: true, allowedExecutors: ['analysis'], budgets: { maxConcurrent: 2 }, limits: { browserHosts: [], githubRepos: [] }, privateToken: secret }
  };
  const detail = {
    ticket,
    assignments: [{ id: 'assignment-1', ticketId: ticket.id, executor: 'analysis', status: 'queued', command: secret }],
    reports: [{ id: 'report-1', ticketId: ticket.id, assignmentId: 'assignment-1', kind: 'result', createdAt: ticket.createdAt, summary: `${'R'.repeat(450)}${secret}`, artifacts: [{ content: secret }], prompt: secret, rawRecords: [secret] }],
    team: { revision: 1, updatedAt: ticket.updatedAt, cancelled: false, limits: { maxNodes: 4 }, usage: { calls: 1 }, nodes: [{ id: 'node-1', status: 'done', prompt: secret, artifacts: [{ content: secret }], proposals: [{ id: 'proposal-1', kind: 'patch', status: 'pending', content: secret }] }], events: [{ type: 'node', nodeId: 'node-1', status: 'done', seq: 1, createdAt: ticket.updatedAt, prompt: secret }] }
  };
  const event = { type: 'report', ticketId: ticket.id, payload: { id: 'report-1', status: 'completed', command: secret, prompt: secret, records: [{ secret }] } };
  const projected = {
    ticket: sanitizeMobileTicket(ticket), bootstrap: sanitizeMobileBootstrap(bootstrap, { unread: 3 }), detail: sanitizeMobileDetail(detail),
    policy: sanitizeMobilePolicy(bootstrap.policy), event: mobileWorkEvent(event)
  };
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /privateToken|rawRecords|records|prompt|command|executorInput|approvalSnapshot|artifacts|chainRootId|handoffChildId/);
  assert.deepEqual(Object.keys(projected.ticket).sort(), ['attention', 'createdAt', 'datasetId', 'executor', 'handoffDepth', 'handoffSummary', 'id', 'parentTicketId', 'planId', 'planStep', 'planTotal', 'source', 'stage', 'status', 'summary', 'title', 'updatedAt']);
  assert.equal(projected.ticket.title.length, 100);
  assert.equal(projected.ticket.summary.length, 400);
  assert.equal(projected.ticket.handoffSummary.length, 400);
  assert.equal(projected.detail.reports[0].summary.length, 400);
  assert.deepEqual(Object.keys(projected.event.payload).sort(), ['reportId', 'status']);
  assert.deepEqual(projected.bootstrap.notifications, { unread: 3 });
  assert.deepEqual(projected.bootstrap.plans, [{ id: 'plan-1', goal: '计划目标', status: 'active', currentStep: 1, totalSteps: 3, updatedAt: ticket.updatedAt }]);
  assert.equal(projected.bootstrap.tools.length, 0);
});

test('SSE 推送 connected/heartbeat、owner 隔离、脱敏并在撤销后断开', async t => {
  const dir = tempDir('mobile-sse-');
  const gateway = new MobileGateway({ dataDir: dir, heartbeatMs: 15 });
  t.after(() => { gateway.close(); rmSync(dir, { recursive: true, force: true }); });
  const device = issueDevice(gateway, 'owner-a');
  const chunks = [];
  let ended = false;
  let connected = false;
  const response = new EventEmitter();
  response.set = () => response;
  response.flushHeaders = () => {};
  response.write = chunk => { chunks.push(String(chunk)); return true; };
  response.end = () => { ended = true; response.emit('close'); };
  gateway.connect(bearer(device.deviceToken), response, { ownerId: 'owner-a', onConnect: () => { connected = true; } });
  assert.equal(connected, true);
  assert.match(chunks.join(''), /: connected\n\n/);
  await sleep(30);
  assert.match(chunks.join(''), /: heartbeat\n\n/);

  const secret = 'SSE_SECRET_PROMPT';
  gateway.publish('owner-b', { type: 'report', ticketId: 'other', payload: { id: 'report-b', status: secret } });
  gateway.publish('owner-a', { type: 'report', ticketId: 'ticket-a', payload: { id: 'report-a', status: 'completed', prompt: secret } });
  const ticketEvent = {
    id: 'event-shared', type: 'ticket', ticketId: 'ticket-a', createdAt: '2026-11-06T00:00:00.000Z',
    payload: { status: 'completed', title: secret, summary: secret, command: secret, executorInput: secret, artifacts: [{ secret }] }
  };
  gateway.publish('owner-b', ticketEvent);
  gateway.publish('owner-a', ticketEvent);
  gateway.publish('owner-a', ticketEvent);
  const output = chunks.join('');
  assert.doesNotMatch(output, /report-b|SSE_SECRET_PROMPT/);
  assert.match(output, /"ticketId":"ticket-a"/);
  assert.match(output, /"reportId":"report-a"/);
  assert.match(output, /"status":"completed"/);
  const notificationFrames = output.split('\n\n').filter(frame => frame.startsWith('event: notification'));
  assert.equal(notificationFrames.length, 1);
  assert.doesNotMatch(notificationFrames[0], new RegExp(secret));
  const notificationData = JSON.parse(notificationFrames[0].split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.deepEqual(Object.keys(notificationData).sort(), ['createdAt', 'id', 'status', 'ticketId', 'unread']);
  assert.equal(notificationData.id, 'event-shared');
  assert.equal(notificationData.unread, true);
  assert.equal(gateway.unreadNotificationCount('owner-a'), 1);
  assert.equal(gateway.listNotifications('owner-b').length, 1);

  assert.equal(gateway.revokeDevice('owner-a', device.deviceId), true);
  assert.equal(ended, true);
});

test('通知收件箱按 owner 去重、过滤状态、裁剪 200 条、持久化已读并隔离', t => {
  let now = Date.UTC(2026, 10, 6, 10, 0, 0);
  const dir = tempDir('mobile-notifications-');
  let gateway = new MobileGateway({ dataDir: dir, now: () => now });
  t.after(() => { gateway.close(); rmSync(dir, { recursive: true, force: true }); });
  const workEvent = (id, status = 'completed', extra = {}) => ({
    id, type: 'ticket', ticketId: `ticket-${id}`, createdAt: new Date(now).toISOString(),
    payload: { id: `payload-${id}`, title: '任务标题', summary: '任务摘要', status, command: 'SECRET_COMMAND', executorInput: { prompt: 'SECRET_PROMPT' }, approvalSnapshot: { secret: true }, artifacts: [{ content: 'SECRET_ARTIFACT' }], ...extra }
  });

  assert.equal(gateway.recordNotification('owner-a', workEvent('working', 'working')), null);
  assert.equal(gateway.recordNotification('owner-a', { ...workEvent('report', 'completed'), type: 'report' }), null);
  const first = gateway.recordNotification('owner-a', workEvent('event-a', 'awaiting_review', { title: 'T'.repeat(120), summary: 'S'.repeat(450) }));
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'id', 'status', 'summary', 'ticketId', 'title', 'unread']);
  assert.equal(first.title.length, 100);
  assert.equal(first.summary.length, 400);
  assert.equal(first.unread, true);
  assert.equal(gateway.recordNotification('owner-a', workEvent('event-a', 'failed', { title: '重复' })), null);
  assert.equal(gateway.listNotifications('owner-a')[0].status, 'awaiting_review');
  assert.equal(gateway.markNotificationRead('owner-b', 'event-a'), null);
  assert.equal(gateway.unreadNotificationCount('owner-a'), 1);

  const read = gateway.markNotificationRead('owner-a', 'event-a');
  assert.equal(read.notification.unread, false);
  assert.equal(read.unread, 0);
  assert.equal(gateway.markNotificationRead('owner-a', 'event-a').unread, 0);
  assert.equal(gateway.unreadNotificationCount('owner-b'), 0);
  assert.ok(gateway.recordNotification('owner-b', workEvent('event-a', 'failed')));
  assert.equal(gateway.unreadNotificationCount('owner-b'), 1);

  now += 1000;
  gateway.recordNotification('owner-a', workEvent('event-b', 'blocked'));
  assert.equal(gateway.markAllNotificationsRead('owner-a'), 1);
  assert.equal(gateway.unreadNotificationCount('owner-a'), 0);
  for (let index = 0; index < MOBILE_NOTIFICATION_MAX + 5; index++) {
    now += 1000;
    gateway.recordNotification('owner-trim', workEvent(`trim-${String(index).padStart(3, '0')}`));
  }
  const trimmed = gateway.listNotifications('owner-trim', { limit: MOBILE_NOTIFICATION_MAX });
  assert.equal(trimmed.length, MOBILE_NOTIFICATION_MAX);
  assert.equal(trimmed[0].id, `trim-${String(MOBILE_NOTIFICATION_MAX + 4).padStart(3, '0')}`);
  assert.equal(trimmed.some(item => item.id === 'trim-000'), false);

  gateway.close();
  gateway = new MobileGateway({ dataDir: dir, now: () => now });
  assert.equal(gateway.listNotifications('owner-a').find(item => item.id === 'event-a').unread, false);
  assert.equal(gateway.unreadNotificationCount('owner-b'), 1);
  assert.equal(gateway.listNotifications('owner-trim', { limit: MOBILE_NOTIFICATION_MAX }).length, MOBILE_NOTIFICATION_MAX);
});

test('本地应用完成配对、移动 Work API、只读 policy、脱敏与设备 token 路由边界', async t => {
  const dir = tempDir('mobile-app-');
  const app = createApp({ dataDir: dir, workEnabled: true, serveStatic: false });
  const { server, base } = await serve(app);
  t.after(async () => { await stop(server, app); rmSync(dir, { recursive: true, force: true }); });

  const device = await pairDevice(base, null);
  const token = device.deviceToken;
  const bootstrapResponse = await request(base, '/api/mobile/bootstrap', { token });
  assert.equal(bootstrapResponse.status, 200);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.capabilities.work, true);
  assert.ok(bootstrap.datasets.length > 0);
  assert.deepEqual(bootstrap.notifications, { unread: 0 });

  const secret = 'LOCAL_MOBILE_SECRET_PROMPT';
  const commandResponse = await request(base, '/api/mobile/command', {
    method: 'POST', token,
    body: { text: '整理销售数据', executorId: 'terminal', executorInput: { program: 'git', args: ['status', '--short', secret] }, clientRequestId: 'mobile-command-once', datasetId: bootstrap.datasets[0].id }
  });
  assert.equal(commandResponse.status, 201);
  const commandText = await commandResponse.text();
  assert.doesNotMatch(commandText, new RegExp(secret));
  assert.doesNotMatch(commandText, /executorInput|approvalSnapshot|"command"/);
  const ticket = JSON.parse(commandText).ticket;
  assert.equal(ticket.status, 'awaiting_review');
  assert.equal(ticket.title, '整理销售数据');

  const inboxResponse = await request(base, '/api/mobile/notifications?limit=10', { token });
  assert.equal(inboxResponse.status, 200);
  const inboxText = await inboxResponse.text();
  assert.doesNotMatch(inboxText, new RegExp(secret));
  const inbox = JSON.parse(inboxText);
  assert.equal(inbox.unread, 1);
  assert.equal(inbox.notifications.length, 1);
  assert.equal(inbox.notifications[0].status, 'awaiting_review');
  assert.equal(inbox.notifications[0].title, '整理销售数据');
  assert.equal(inbox.notifications[0].unread, true);
  const notificationId = inbox.notifications[0].id;
  assert.equal((await request(base, '/api/mobile/notifications?limit=0', { token })).status, 400);
  assert.equal((await request(base, '/api/mobile/notifications?limit=201', { token })).status, 400);
  assert.equal((await request(base, '/api/mobile/notifications?limit=abc', { token })).status, 400);
  assert.equal((await request(base, '/api/mobile/notifications')).status, 401);

  const readOne = await request(base, `/api/mobile/notifications/${notificationId}/read`, { method: 'POST', token });
  assert.equal(readOne.status, 200);
  assert.equal((await readOne.json()).unread, 0);
  const readAgain = await request(base, `/api/mobile/notifications/${notificationId}/read`, { method: 'POST', token });
  assert.equal(readAgain.status, 200);
  assert.equal((await readAgain.json()).unread, 0);
  const readAll = await request(base, '/api/mobile/notifications/read-all', { method: 'POST', token });
  assert.equal(readAll.status, 200);
  assert.equal((await readAll.json()).unread, 0);
  const bootstrapAfterRead = await (await request(base, '/api/mobile/bootstrap', { token })).json();
  assert.deepEqual(bootstrapAfterRead.notifications, { unread: 0 });

  const detailResponse = await request(base, `/api/mobile/tickets/${ticket.id}`, { token });
  assert.equal(detailResponse.status, 200);
  const detailText = await detailResponse.text();
  assert.doesNotMatch(detailText, new RegExp(secret));
  assert.equal(JSON.parse(detailText).ticket.id, ticket.id);

  const actionResponse = await request(base, `/api/mobile/tickets/${ticket.id}/actions`, { method: 'POST', token, body: { action: 'reject' } });
  assert.equal(actionResponse.status, 200);
  assert.equal((await actionResponse.json()).ticket.status, 'waiting');

  const policyBefore = await (await request(base, '/api/mobile/policy', { token })).json();
  const policyWrite = await request(base, '/api/mobile/policy', { method: 'PUT', token, body: { allowedExecutors: ['terminal'] } });
  assert.equal(policyWrite.status, 404);
  const policyAfter = await (await request(base, '/api/mobile/policy', { token })).json();
  assert.deepEqual(policyAfter, policyBefore);

  assert.equal((await request(base, '/api/work/bootstrap', { token })).status, 401);
  assert.equal((await request(base, '/api/work/bootstrap')).status, 200);
  assert.equal((await request(base, '/api/mobile/not-a-route', { token })).status, 404);
  assert.equal((await request(base, '/api/mobile/bootstrap', { token: token.replace(/=+$/, '') })).status, 200);
  const legacyResponse = await fetch(base + '/api/mobile/bootstrap', { headers: { 'x-device-token': token } });
  assert.equal(legacyResponse.status, 200);
  const devices = await (await fetch(base + '/api/mobile/devices', { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(devices.devices.length, 1);
  assert.doesNotMatch(JSON.stringify(devices), new RegExp(token));
});

test('云端设备 token 按账号 owner 选择工作区，跨账号工单不可见', async t => {
  const dir = tempDir('mobile-cloud-');
  const app = createCloudApp({ dataDir: dir, workEnabled: true, distDir: join(dir, 'dist'), maxKdfConcurrent: 2 });
  const { server, base } = await serve(app);
  t.after(async () => { await stop(server, app); rmSync(dir, { recursive: true, force: true }); });

  const cookieA = await register(base, 'mobile_owner_a');
  const cookieB = await register(base, 'mobile_owner_b');
  const deviceA = await pairDevice(base, cookieA);
  const deviceB = await pairDevice(base, cookieB);

  const command = await request(base, '/api/mobile/command', { method: 'POST', token: deviceA.deviceToken, body: { text: 'A 的私有工单' } });
  assert.equal(command.status, 201);
  const ticketId = (await command.json()).ticket.id;

  const bootstrapA = await (await request(base, '/api/mobile/bootstrap', { token: deviceA.deviceToken })).json();
  const bootstrapB = await (await request(base, '/api/mobile/bootstrap', { token: deviceB.deviceToken })).json();
  assert.ok(bootstrapA.tickets.some(ticket => ticket.id === ticketId));
  assert.deepEqual(bootstrapB.tickets, []);
  assert.equal(bootstrapA.notifications.unread, 1);
  assert.equal(bootstrapB.notifications.unread, 0);
  const inboxA = await (await request(base, '/api/mobile/notifications', { token: deviceA.deviceToken })).json();
  const inboxB = await (await request(base, '/api/mobile/notifications', { token: deviceB.deviceToken })).json();
  assert.equal(inboxA.notifications.length, 1);
  assert.deepEqual(inboxB.notifications, []);
  assert.equal(inboxB.unread, 0);
  const notificationId = inboxA.notifications[0].id;
  assert.equal((await request(base, `/api/mobile/notifications/${notificationId}/read`, { method: 'POST', token: deviceB.deviceToken })).status, 404);
  assert.equal((await (await request(base, '/api/mobile/notifications', { token: deviceA.deviceToken })).json()).unread, 1);
  const readA = await request(base, `/api/mobile/notifications/${notificationId}/read`, { method: 'POST', token: deviceA.deviceToken });
  assert.equal(readA.status, 200);
  assert.equal((await readA.json()).unread, 0);
  assert.equal((await request(base, `/api/mobile/tickets/${ticketId}`, { token: deviceB.deviceToken })).status, 404);
  assert.equal((await request(base, '/api/work/policy', { token: deviceB.deviceToken })).status, 401);
  assert.equal((await request(base, '/api/mobile/unknown', { token: deviceB.deviceToken })).status, 404);

  const revoke = await request(base, `/api/mobile/devices/${deviceA.deviceId}`, { method: 'DELETE', cookie: cookieA });
  assert.equal(revoke.status, 200);
  assert.equal((await request(base, '/api/mobile/bootstrap', { token: deviceA.deviceToken })).status, 401);
});

test('移动端交接路由返回脱敏子工单且重复交接幂等', async t => {
  const dir = tempDir('mobile-handoff-');
  const app = createApp({ dataDir: dir, workEnabled: true, serveStatic: false });
  const { server, base } = await serve(app);
  t.after(async () => { await stop(server, app); rmSync(dir, { recursive: true, force: true }); });

  const device = await pairDevice(base, null);
  const token = device.deviceToken;
  const sourceResponse = await request(base, '/api/mobile/command', {
    method: 'POST', token,
    body: { text: '移动交接源', executorId: 'terminal', executorInput: { program: 'pwd', args: [] } }
  });
  assert.equal(sourceResponse.status, 201);
  const source = (await sourceResponse.json()).ticket;
  assert.equal((await request(base, `/api/mobile/tickets/${source.id}/actions`, { method: 'POST', token, body: { action: 'approve' } })).status, 200);

  let detail;
  for (let attempt = 0; attempt < 50; attempt++) {
    detail = await (await request(base, `/api/mobile/tickets/${source.id}`, { token })).json();
    if (detail.ticket.status === 'completed') break;
    await sleep(100);
  }
  assert.equal(detail.ticket.status, 'completed');

  const handoff = body => request(base, `/api/mobile/tickets/${source.id}/actions`, { method: 'POST', token, body: { action: 'handoff', input: body } });
  const first = await handoff({ executorId: 'analysis', text: '移动子任务' });
  assert.equal(first.status, 201);
  const child = (await first.json()).ticket;
  assert.equal(child.title, '移动子任务');
  assert.equal(child.parentTicketId, source.id);
  assert.equal(child.handoffDepth, 1);
  assert.equal(child.handoffSummary, detail.ticket.summary);
  assert.equal(child.chainRootId, undefined);
  assert.equal(child.handoffChildId, undefined);
  const duplicate = await handoff({ executorId: 'analysis', text: '重复不应新建' });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).ticket.id, child.id);
  assert.equal((await request(base, `/api/mobile/tickets/${child.id}`, { token })).status, 200);
});
