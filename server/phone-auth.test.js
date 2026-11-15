import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Accounts } from './accounts.js';
import { createPhoneAuth, createSmsSender, maskPhone, normalizePhone } from './phone-auth.js';

function fixture(t, { requirePhone = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-phone-auth-'));
  let time = Date.parse('2026-11-14T08:00:00.000Z');
  const accounts = new Accounts(dir, { now: () => time });
  const sms = createSmsSender({ env: { NODE_ENV: 'test', LAGENT_SMS_PROVIDER: 'mock' } });
  const auth = createPhoneAuth({ accounts, now: () => time, sms, secret: 'x'.repeat(32), requirePhone });
  t.after(() => { accounts.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    accounts,
    auth,
    now: () => time,
    advance: ms => { time += ms; },
    code: phone => sms.lastCode(phone)
  };
}

test('手机号规范化与掩码', () => {
  assert.equal(normalizePhone('138 0013 8000'), '13800138000');
  assert.equal(normalizePhone('+8613800138000'), '13800138000');
  assert.equal(normalizePhone('8613800138000'), '13800138000');
  assert.throws(() => normalizePhone('12345'), { message: '请输入有效的 11 位手机号' });
  assert.equal(maskPhone('13800138000'), '138****8000');
  assert.equal(maskPhone('not-a-phone'), '');
});

test('验证码：只返回掩码、一次性使用且拒绝重放', async t => {
  const f = fixture(t);
  const result = await f.auth.sendCode({ phone: '13800138000', purpose: 'register', ip: '10.0.0.1' });
  assert.equal(result.ok, true);
  assert.equal(result.expiresIn, 300);
  assert.equal(result.retryAfter, 60);
  assert.match(result.message, /若号码可用/);
  // mock 仅用于开发/测试；devCode 帮助测试拿到短信内容。
  assert.equal(result.devCode, f.code('13800138000'));
  assert.doesNotMatch(JSON.stringify(f.accounts.db.prepare('SELECT * FROM phone_codes').all()), /13800138000/);
  assert.doesNotMatch(JSON.stringify(f.accounts.db.prepare('SELECT * FROM auth_audit').all()), /13800138000/);

  const verified = await f.auth.verifyCode({ phone: '13800138000', code: result.devCode, purpose: 'register', ip: '10.0.0.1' });
  assert.deepEqual(verified, { ok: true, phone: '13800138000', phoneHash: f.auth.phoneHash('13800138000') });
  await assert.rejects(f.auth.verifyCode({ phone: '13800138000', code: result.devCode, purpose: 'register', ip: '10.0.0.1' }), { message: '验证码错误或已过期' });
});

test('验证码：5 分钟过期，60 秒内不可重发', async t => {
  const f = fixture(t);
  const sent = await f.auth.sendCode({ phone: '13900139000', purpose: 'login', ip: '10.0.0.2' });
  await assert.rejects(f.auth.sendCode({ phone: '13900139000', purpose: 'login', ip: '10.0.0.2' }), { status: 429 });
  f.advance(60_001);
  const again = await f.auth.sendCode({ phone: '13900139000', purpose: 'login', ip: '10.0.0.2' });
  assert.notEqual(again.devCode, undefined);
  // 重发后旧码立即失效，避免两条短信都能用。
  await assert.rejects(f.auth.verifyCode({ phone: '13900139000', code: sent.devCode, purpose: 'login', ip: '10.0.0.2' }), { message: '验证码错误或已过期' });
  f.advance(5 * 60_000 + 1);
  await assert.rejects(f.auth.verifyCode({ phone: '13900139000', code: again.devCode, purpose: 'login', ip: '10.0.0.2' }), { message: '验证码错误或已过期' });
});

test('验证码：连续错误后锁定并要求验证码挑战', async t => {
  const f = fixture(t);
  const sent = await f.auth.sendCode({ phone: '13700137000', purpose: 'bind', ip: '10.0.0.3' });
  const wrong = sent.devCode === '000000' ? '000001' : '000000';
  for (let index = 0; index < 3; index++) {
    await assert.rejects(f.auth.verifyCode({ phone: '13700137000', code: wrong, purpose: 'bind', ip: '10.0.0.3' }), { message: '验证码错误或已过期' });
  }
  // 3 次失败后发送新码需要挑战标记（没有验证码供应商时由客户端显式提交）。
  await assert.rejects(f.auth.sendCode({ phone: '13700137000', purpose: 'bind', ip: '10.0.0.3' }), { status: 429, code: 'CAPTCHA_REQUIRED' });
  f.advance(61_000);
  const challenged = await f.auth.sendCode({ phone: '13700137000', purpose: 'bind', ip: '10.0.0.3', captchaToken: 'human' });
  for (let index = 0; index < 5; index++) {
    await assert.rejects(f.auth.verifyCode({ phone: '13700137000', code: wrong, purpose: 'bind', ip: '10.0.0.3' }), { message: '验证码错误或已过期' });
  }
  // 达到尝试上限后，即使输入正确也必须重新获取，防止暴力枚举。
  await assert.rejects(f.auth.verifyCode({ phone: '13700137000', code: challenged.devCode, purpose: 'bind', ip: '10.0.0.3' }), { status: 429, message: '验证码尝试次数过多，请重新获取' });
});

test('验证码：按手机号限流并记录审计', async t => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) {
    await f.auth.sendCode({ phone: '13600136000', purpose: 'login', ip: '10.0.0.4' });
    f.advance(61_000);
  }
  await assert.rejects(f.auth.sendCode({ phone: '13600136000', purpose: 'login', ip: '10.0.0.4' }), { status: 429, message: '该手机号发送次数过多，请稍后再试' });
  const audit = f.accounts.db.prepare("SELECT result,reason FROM auth_audit WHERE action='sms_send' ORDER BY created_at DESC,rowid DESC LIMIT 1").get();
  assert.equal(audit.result, 'limited');
  assert.doesNotMatch(JSON.stringify(audit), /13600136000/);
});

test('短信发送失败时不保留验证码，也不触发重发冷却', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-phone-fail-'));
  const accounts = new Accounts(dir);
  t.after(() => { accounts.close(); rmSync(dir, { recursive: true, force: true }); });
  let attempts = 0;
  const auth = createPhoneAuth({ accounts, secret: 'x'.repeat(32), requirePhone: true, sms: { configured: true, devMode: false, send: async () => { attempts++; throw new Error('短信网关不可用'); } } });
  await assert.rejects(auth.sendCode({ phone: '13500135001', purpose: 'login', ip: '10.0.0.6' }), { message: '短信网关不可用' });
  assert.equal(accounts.db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
  await assert.rejects(auth.sendCode({ phone: '13500135001', purpose: 'login', ip: '10.0.0.6' }), { message: '短信网关不可用' });
  assert.equal(attempts, 2);
});

test('生产环境禁止 mock 短信；未配置供应商时返回 503', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-phone-sms-'));
  const accounts = new Accounts(dir);
  t.after(() => { accounts.close(); rmSync(dir, { recursive: true, force: true }); });
  const production = createSmsSender({ env: { NODE_ENV: 'production', LAGENT_SMS_PROVIDER: 'mock' } });
  assert.equal(production.configured, false);
  assert.equal(production.devMode, false);
  const auth = createPhoneAuth({ accounts, sms: production, secret: 'x'.repeat(32), requirePhone: true });
  await assert.rejects(auth.sendCode({ phone: '13500135000', purpose: 'login', ip: '10.0.0.5' }), { status: 503 });
  assert.equal(auth.devMode, false);
});
