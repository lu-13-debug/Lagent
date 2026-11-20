import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { authError } from './accounts.js';

// 手机号短信验证：验证码只存 HMAC 哈希，手机号只存数据库明文字段但接口/日志一律掩码。
// 本地模式不加载本模块；只有云端服务在 LAGENT_REQUIRE_PHONE=1 或显式配置时启用。
export const PHONE_PURPOSES = Object.freeze(['register', 'login', 'bind', 'change', 'reset']);
const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_MS = 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const LIMITS = Object.freeze({ phoneHour: 5, phoneDay: 10, ipHour: 20, deviceHour: 10, budgetDay: 500 });

export const normalizePhone = value => {
  if (typeof value !== 'string') throw authError('请输入 11 位手机号');
  let phone = value.replace(/[\s-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  if (phone.startsWith('86') && phone.length === 13) phone = phone.slice(2);
  if (!/^1[3-9]\d{9}$/.test(phone)) throw authError('请输入有效的 11 位手机号');
  return phone;
};

export const maskPhone = phone => {
  const value = String(phone || '');
  return /^\d{11}$/.test(value) ? `${value.slice(0, 3)}****${value.slice(-4)}` : '';
};

const purposeValue = value => {
  if (!PHONE_PURPOSES.includes(value)) throw authError('验证码用途无效');
  return value;
};

const percentEncode = value => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

async function requestJson(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(8000), redirect: 'error' });
  let data = null;
  try { data = await response.json(); } catch { /* 供应商可能返回空响应。 */ }
  if (!response.ok) throw new Error(`短信供应商返回 HTTP ${response.status}`);
  return data;
}

export function createSmsSender({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const configuredProvider = String(env.LAGENT_SMS_PROVIDER || (env.LAGENT_SMS_MOCK === '1' ? 'mock' : 'none')).toLowerCase();
  const mockAllowed = env.NODE_ENV !== 'production' || env.LAGENT_SMS_ALLOW_MOCK === '1';
  const provider = configuredProvider === 'mock' && !mockAllowed ? 'none' : configuredProvider;
  const lastCodes = new Map();
  const configured = provider === 'mock'
    ? true
    : provider === 'http'
      ? Boolean(env.LAGENT_SMS_HTTP_URL)
      : provider === 'aliyun'
        ? Boolean(env.LAGENT_SMS_ACCESS_KEY_ID && env.LAGENT_SMS_ACCESS_KEY_SECRET && env.LAGENT_SMS_SIGN_NAME && env.LAGENT_SMS_TEMPLATE_ID)
        : false;

  async function send({ phone, code, purpose }) {
    if (!configured) throw Object.assign(new Error('短信服务尚未配置，请联系服务管理员'), { status: 503 });
    if (provider === 'mock') {
      lastCodes.set(phone, { code, purpose, at: Date.now() });
      return { ok: true, provider: 'mock' };
    }
    if (provider === 'http') {
      await requestJson(fetchImpl, env.LAGENT_SMS_HTTP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(env.LAGENT_SMS_HTTP_TOKEN ? { authorization: `Bearer ${env.LAGENT_SMS_HTTP_TOKEN}` } : {}) },
        body: JSON.stringify({ phone, code, purpose, signName: env.LAGENT_SMS_SIGN_NAME || '', templateId: env.LAGENT_SMS_TEMPLATE_ID || '' })
      });
      return { ok: true, provider: 'http' };
    }
    if (provider === 'aliyun') {
      const params = {
        AccessKeyId: env.LAGENT_SMS_ACCESS_KEY_ID,
        Action: 'SendSms',
        Format: 'JSON',
        PhoneNumbers: phone,
        RegionId: env.LAGENT_SMS_REGION || 'cn-hangzhou',
        SignName: env.LAGENT_SMS_SIGN_NAME,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: randomUUID(),
        SignatureVersion: '1.0',
        TemplateCode: env.LAGENT_SMS_TEMPLATE_ID,
        TemplateParam: JSON.stringify({ code }),
        Timestamp: new Date().toISOString(),
        Version: '2017-05-25'
      };
      const canonical = Object.keys(params).sort().map(key => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&');
      const signature = createHmac('sha1', `${env.LAGENT_SMS_ACCESS_KEY_SECRET}&`).update(`GET&%2F&${percentEncode(canonical)}`).digest('base64');
      const url = `https://dysmsapi.aliyuncs.com/?${canonical}&Signature=${percentEncode(signature)}`;
      const data = await requestJson(fetchImpl, url, { method: 'GET' });
      if (data?.Code !== 'OK') throw new Error(`短信供应商拒绝发送：${String(data?.Code || 'UNKNOWN').slice(0, 40)}`);
      return { ok: true, provider: 'aliyun' };
    }
    throw Object.assign(new Error('短信服务尚未配置，请联系服务管理员'), { status: 503 });
  }

  return {
    provider,
    configured,
    devMode: provider === 'mock' && mockAllowed,
    send,
    // 测试用：不写入日志、不暴露给 HTTP 接口。
    lastCode: phone => lastCodes.get(phone)?.code || ''
  };
}

export function createPhoneAuth({ accounts, env = process.env, now = Date.now, sms, secret, requirePhone } = {}) {
  if (!accounts) throw new TypeError('手机号验证需要账号库');
  const sender = sms || createSmsSender({ env });
  const required = requirePhone === undefined ? env.LAGENT_REQUIRE_PHONE === '1' : requirePhone === true;
  const key = typeof secret === 'string' && secret.length >= 16 ? secret : env.LAGENT_PHONE_SECRET || randomBytes(32).toString('hex');
  const dailyBudget = Number.isSafeInteger(Number(env.LAGENT_SMS_DAILY_BUDGET)) && Number(env.LAGENT_SMS_DAILY_BUDGET) > 0 ? Number(env.LAGENT_SMS_DAILY_BUDGET) : LIMITS.budgetDay;

  const hashPhone = phone => createHmac('sha256', key).update(`phone:${phone}`).digest('hex');
  const hashIp = ip => ip ? createHmac('sha256', key).update(`ip:${String(ip).slice(0, 100)}`).digest('hex') : null;
  const hashCode = (salt, code) => createHmac('sha256', key).update(`code:${salt}:${code}`).digest('hex');
  const countAudit = (where, since) => {
    const clauses = [where, 'created_at>=?'].filter(Boolean).join(' AND ');
    return accounts.db.prepare(`SELECT COUNT(*) AS n FROM auth_audit WHERE ${clauses}`).get(since).n;
  };

  function limitSend({ phoneHash, ipHash, deviceHash }) {
    const current = now();
    if (accounts.phoneCodeCount({ phoneHash, since: current - 3600000 }) >= LIMITS.phoneHour) throw authError('该手机号发送次数过多，请稍后再试', 429);
    if (accounts.phoneCodeCount({ phoneHash, since: current - 86400000 }) >= LIMITS.phoneDay) throw authError('该手机号今日发送次数已达上限', 429);
    if (ipHash && accounts.phoneCodeCount({ ipHash, since: current - 3600000 }) >= LIMITS.ipHour) throw authError('当前网络发送次数过多，请稍后再试', 429);
    if (deviceHash) {
      const deviceSends = accounts.db.prepare("SELECT COUNT(*) AS n FROM auth_audit WHERE action='sms_send' AND device_hash=? AND created_at>=?").get(deviceHash, current - 3600000).n;
      if (deviceSends >= LIMITS.deviceHour) throw authError('当前设备发送次数过多，请稍后再试', 429);
    }
    const sentToday = countAudit(`action='sms_send' AND result='ok'`, current - 86400000);
    if (sentToday >= dailyBudget) throw authError('今日短信发送量已达上限，请稍后再试', 429);
    // 重发冷却按手机号统一计算，不区分用途，避免换用途绕过。
    const lastAny = accounts.db.prepare('SELECT created_at FROM phone_codes WHERE phone_hash=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(phoneHash)?.created_at || 0;
    if (lastAny > current - RESEND_MS) throw Object.assign(authError('发送过于频繁，请 60 秒后再试', 429), { retryAfter: 60 });
  }

  async function sendCode({ phone, purpose, ip, deviceHash = null, captchaToken = null }) {
    const normalized = normalizePhone(phone);
    const use = purposeValue(purpose);
    const phoneHash = hashPhone(normalized);
    const ipHash = hashIp(ip);
    const current = now();
    try {
      // 连续失败后用图形/行为验证挡住脚本；没有接验证码供应商时，要求客户端明确带上挑战标记。
      const failures = accounts.failedPhoneVerifications(phoneHash, current - LOCK_MS);
      if (failures >= 5) throw authError('验证失败次数过多，请 15 分钟后再试', 429);
      if (failures >= 3 && !captchaToken) throw Object.assign(authError('需要完成图形验证后再发送验证码', 429), { code: 'CAPTCHA_REQUIRED' });
      limitSend({ phoneHash, ipHash, deviceHash });
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const salt = randomBytes(16).toString('hex');
      const expiresAt = current + CODE_TTL_MS;
      const codeId = accounts.savePhoneCode({ phoneHash, codeHash: hashCode(salt, code), salt, purpose: use, expiresAt, ipHash });
      try {
        await sender.send({ phone: normalized, code, purpose: use });
      } catch (error) {
        // 供应商失败时删除刚写入的验证码：用户没收到短信，不应被冷却 60 秒。
        accounts.db.prepare('DELETE FROM phone_codes WHERE id=?').run(codeId);
        throw error;
      }
      accounts.auditAuth({ action: 'sms_send', result: 'ok', phoneHash, ipHash, deviceHash });
      return {
        ok: true,
        // 不泄露号码是否已注册；只返回统一的发送结果。
        message: '若号码可用，验证码已发送',
        expiresIn: Math.round(CODE_TTL_MS / 1000),
        retryAfter: Math.round(RESEND_MS / 1000),
        ...(sender.devMode ? { devCode: code } : {})
      };
    } catch (error) {
      accounts.auditAuth({ action: 'sms_send', result: error.status === 429 ? 'limited' : 'fail', phoneHash, ipHash, deviceHash, reason: String(error.message || '').slice(0, 200) });
      throw error;
    }
  }

  async function verifyCode({ phone, code, purpose, ip, deviceHash = null }) {
    const normalized = normalizePhone(phone);
    const use = purposeValue(purpose);
    const phoneHash = hashPhone(normalized);
    const ipHash = hashIp(ip);
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      accounts.auditAuth({ action: 'sms_verify', result: 'fail', phoneHash, ipHash, deviceHash, reason: '格式无效' });
      throw authError('验证码错误或已过期');
    }
    const row = accounts.latestPhoneCode(phoneHash, use);
    const current = now();
    if (!row || row.used || row.expires_at <= current) {
      accounts.auditAuth({ action: 'sms_verify', result: 'fail', phoneHash, ipHash, deviceHash, reason: '不存在或已过期' });
      throw authError('验证码错误或已过期');
    }
    if ((row.attempts || 0) >= MAX_CODE_ATTEMPTS) {
      accounts.consumePhoneCode(row.id);
      accounts.auditAuth({ action: 'sms_verify', result: 'blocked', phoneHash, ipHash, deviceHash, reason: '尝试次数过多' });
      throw authError('验证码尝试次数过多，请重新获取', 429);
    }
    const expected = Buffer.from(row.code_hash, 'hex');
    const actual = Buffer.from(hashCode(row.salt, code), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      accounts.bumpPhoneCodeAttempts(row.id);
      accounts.auditAuth({ action: 'sms_verify', result: 'fail', phoneHash, ipHash, deviceHash, reason: '校验失败' });
      throw authError('验证码错误或已过期');
    }
    // 校验与置位在同一事务语义内：consumePhoneCode 只在未使用且未过期时成功。
    if (!accounts.consumePhoneCode(row.id)) {
      accounts.auditAuth({ action: 'sms_verify', result: 'fail', phoneHash, ipHash, deviceHash, reason: '重放' });
      throw authError('验证码错误或已过期');
    }
    accounts.auditAuth({ action: 'sms_verify', result: 'ok', phoneHash, ipHash, deviceHash });
    return { ok: true, phone: normalized, phoneHash };
  }

  return {
    required,
    configured: sender.configured,
    provider: sender.provider,
    devMode: sender.devMode,
    sendCode,
    verifyCode,
    normalizePhone,
    maskPhone,
    phoneHash: hashPhone,
    ipHash: hashIp,
    lastCode: sender.lastCode
  };
}
