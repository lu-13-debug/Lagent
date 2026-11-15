import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { Store } from './store.js';
import { createImNotifier } from './work/im-notify.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-im-'));
  const store = new Store(join(dir, 'data'));
  const calls = [];
  const requests = [];
  const engine = {
    action(ticketId, action) {
      calls.push({ ticketId, action });
      return { id: ticketId, status: action === 'approve' ? 'queued' : 'cancelled' };
    }
  };
  const im = createImNotifier({
    store,
    engine,
    env: { LAGENT_PUBLIC_URL: 'https://lagent.example' },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    }
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine, im, calls, requests };
}

const channel = (im, extra = {}) => im.saveChannel({ name: '研发群', kind: 'slack', webhookUrl: 'https://hooks.example/services/abc', events: ['ticket', 'usage-alert'], ...extra }).channel;

test('IM 渠道只保存不安全的 Webhook，接口不回显地址', t => {
  const f = fixture(t);
  const saved = channel(f.im);
  assert.equal(saved.webhookHost, 'hooks.example');
  assert.equal(saved.webhookUrl, undefined);
  const listed = JSON.stringify(f.im.list());
  assert.doesNotMatch(listed, /services\/abc/);
  assert.throws(() => f.im.saveChannel({ name: 'x', kind: 'slack', webhookUrl: 'http://hooks.example/x' }), { status: 400 });
  assert.throws(() => f.im.saveChannel({ name: 'x', kind: 'slack', webhookUrl: 'https://127.0.0.1/x' }), { status: 400 });
  assert.throws(() => f.im.saveChannel({ name: 'x', kind: 'unknown', webhookUrl: 'https://hooks.example/x' }), { status: 400 });
  assert.throws(() => f.im.saveChannel({ id: saved.id, name: 'x', events: [] }), { status: 400 });
});

test('工单待确认时推送带签名审批链接，同一状态不重复推送', async t => {
  const f = fixture(t);
  channel(f.im);
  const event = { id: 'evt-1', type: 'ticket', ticketId: 'ticket-1', payload: { id: 'ticket-1', title: '发布前检查', status: 'awaiting_review', summary: '请在发布前确认' } };
  const result = await f.im.onEvent(event);
  assert.equal(result.length, 1);
  assert.equal(result[0].ok, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://hooks.example/services/abc');
  const text = f.requests[0].body.text;
  assert.match(text, /发布前检查/);
  const link = text.match(/批准：(https:\/\/lagent\.example\/api\/work\/im\/actions\/\S+)/);
  assert.ok(link, text);
  const verified = f.im.verifyAction(link[1].replace('https://lagent.example/api/work/im/actions/', ''));
  assert.equal(verified.action, 'approve');
  assert.equal(verified.ticketId, 'ticket-1');
  // 工单其它状态更新不重复通知。
  await f.im.onEvent(event);
  assert.equal(f.requests.length, 1);
});

test('签名审批链接拒绝篡改、过期与重放', t => {
  const f = fixture(t);
  channel(f.im);
  const token = f.im.signAction('ticket-1', 'approve');
  assert.equal(f.im.verifyAction(token).action, 'approve');
  const parts = token.split('.');
  assert.throws(() => f.im.verifyAction([parts[0], parts[1], 'reject', ...parts.slice(3)].join('.')), { status: 401 });
  assert.throws(() => f.im.verifyAction('v1.ticket-1.approve.1.nonce.bad'), { status: 401 });
  const secret = f.store.config('im-notify-v1:local').secret;
  const past = Date.now() - 1000;
  const payload = `v1.ticket-1.approve.${past}.expired`;
  const expired = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
  assert.throws(() => f.im.verifyAction(expired), { status: 410 });
  // 只允许 approve / reject，其它动作无法生成链接。
  assert.throws(() => f.im.signAction('ticket-1', 'delete'), { status: 400 });
});

test('远程审批执行一次后链接失效', t => {
  const f = fixture(t);
  channel(f.im);
  const token = f.im.signAction('ticket-1', 'approve');
  const result = f.im.executeAction(token);
  assert.deepEqual(f.calls, [{ ticketId: 'ticket-1', action: 'approve' }]);
  assert.equal(result.ticket.status, 'queued');
  assert.throws(() => f.im.executeAction(token), { status: 409 });
  assert.equal(f.calls.length, 1);
});

test('通知按渠道事件过滤，用量告警单独推送', async t => {
  const f = fixture(t);
  channel(f.im, { events: ['usage-alert'] });
  const ticket = await f.im.onEvent({ id: 'evt-2', type: 'ticket', ticketId: 'ticket-2', payload: { id: 'ticket-2', title: '运行中', status: 'working' } });
  assert.deepEqual(ticket, []);
  assert.equal(f.requests.length, 0);
  const alert = await f.im.onEvent({ id: 'evt-3', type: 'usage-alert', ticketId: 'ticket-2', payload: { ticketId: 'ticket-2', title: 'Token 预算告警', summary: '已用 80%' } });
  assert.equal(alert.length, 1);
  assert.match(f.requests[0].body.text, /已用 80%/);
  const disabled = channel(f.im, { name: '停用渠道', enabled: false });
  assert.equal(disabled.enabled, false);
  const result = await f.im.onEvent({ id: 'evt-4', type: 'usage-alert', ticketId: 'ticket-2', payload: { ticketId: 'ticket-2', title: '再次告警', summary: 'x' } });
  assert.equal(result.length, 1);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.im.removeChannel(disabled.id), { ok: true, id: disabled.id });
  assert.throws(() => f.im.removeChannel(disabled.id), { status: 404 });
});
