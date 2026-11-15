import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { workError } from './domain.js';

// IM 通知与远程批准：只向用户显式配置的 Webhook 推送摘要，审批走签名链接。
// Webhook 地址和签名密钥只留在库里，接口永远不原样回显。
const CONFIG_PREFIX = 'im-notify-v1:';
const CHANNEL_KINDS = Object.freeze(['slack', 'teams', 'feishu', 'wecom', 'dingtalk', 'generic']);
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHANNELS = 10;
const MAX_SENT = 2000;
const ACTIONS = new Set(['approve', 'reject']);
const TICKET_EVENTS = new Set(['awaiting_review', 'failed', 'blocked']);

const text = (value, label, max) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw workError(`${label}不能超过 ${max} 字`, 400);
  return result;
};

function privateAddress(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function webhookUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); } catch { throw workError('Webhook 地址无效', 400); }
  if (parsed.protocol !== 'https:') throw workError('Webhook 必须使用 HTTPS', 400);
  if (parsed.username || parsed.password) throw workError('Webhook 地址不能包含账号密码', 400);
  if (privateAddress(parsed.hostname)) throw workError('Webhook 不能指向内网地址', 400);
  return parsed.toString();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createImNotifier({ store, engine, ownerId = 'local', fetchImpl = globalThis.fetch, now = () => new Date().toISOString(), env = process.env } = {}) {
  if (!store) throw new TypeError('IM 通知需要存储');
  const configKey = `${CONFIG_PREFIX}${ownerId}`;

  function load() {
    const value = store.config(configKey);
    const config = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      channels: Array.isArray(config.channels) ? config.channels : [],
      secret: typeof config.secret === 'string' && config.secret.length >= 32 ? config.secret : null,
      baseUrl: typeof config.baseUrl === 'string' ? config.baseUrl : ''
    };
  }

  function save(next) {
    store.config(configKey, { ...next, updatedAt: now() });
    return next;
  }

  function secretOf(config) {
    if (config.secret) return config.secret;
    const secret = randomBytes(32).toString('base64url');
    save({ ...config, secret });
    return secret;
  }

  function publicChannel(row) {
    let host = '';
    try { host = new URL(row.webhookUrl).host; } catch { /* 旧配置损坏时仍可展示。 */ }
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled !== false,
      events: Array.isArray(row.events) ? [...row.events] : ['ticket'],
      webhookHost: host,
      createdAt: row.createdAt
    };
  }

  function list() {
    const config = load();
    return {
      kinds: [...CHANNEL_KINDS],
      baseUrl: config.baseUrl || env.LAGENT_PUBLIC_URL || '',
      channels: config.channels.map(publicChannel)
    };
  }

  function saveChannel(input = {}) {
    const config = load();
    const id = text(input.id, '渠道 id', 100) || randomUUID();
    const existing = config.channels.find(row => row.id === id);
    if (!existing && config.channels.length >= MAX_CHANNELS) throw workError(`最多配置 ${MAX_CHANNELS} 个通知渠道`, 429);
    const kind = CHANNEL_KINDS.includes(input.kind) ? input.kind : existing?.kind;
    if (!kind) throw workError('请选择通知渠道类型', 400);
    const name = text(input.name, '渠道名称', 40) || existing?.name || kind;
    const url = input.webhookUrl === undefined ? existing?.webhookUrl : webhookUrl(input.webhookUrl);
    if (!url) throw workError('请填写 Webhook 地址', 400);
    const events = input.events === undefined
      ? (existing?.events || ['ticket'])
      : (Array.isArray(input.events) ? [...new Set(input.events.filter(item => ['ticket', 'usage-alert'].includes(item)))] : []);
    if (!events.length) throw workError('至少选择一种通知事件', 400);
    const baseUrl = input.baseUrl === undefined ? config.baseUrl : String(input.baseUrl || '').trim();
    if (baseUrl) {
      let parsed;
      try { parsed = new URL(baseUrl); } catch { throw workError('外部访问地址无效', 400); }
      if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !privateAddress(parsed.hostname) && parsed.hostname !== 'localhost')) {
        throw workError('外部访问地址必须使用 HTTPS（本机调试可用 HTTP）', 400);
      }
    }
    const row = {
      id,
      name,
      kind,
      webhookUrl: url,
      events,
      enabled: input.enabled === undefined ? existing?.enabled !== false : input.enabled !== false,
      createdAt: existing?.createdAt || now()
    };
    const channels = [...config.channels.filter(item => item.id !== id), row];
    save({ ...config, channels, baseUrl });
    return { channel: publicChannel(row) };
  }

  function removeChannel(id) {
    const config = load();
    if (!config.channels.some(row => row.id === id)) throw workError('通知渠道不存在', 404);
    save({ ...config, channels: config.channels.filter(row => row.id !== id) });
    return { ok: true, id };
  }

  function baseUrlOf(config) {
    return (config.baseUrl || env.LAGENT_PUBLIC_URL || '').replace(/\/+$/, '');
  }

  function signAction(ticketId, action, { ttlMs = ACTION_TTL_MS } = {}) {
    if (!engine) throw new TypeError('IM 审批需要工作引擎');
    if (!ACTIONS.has(action)) throw workError('不支持的审批动作', 400);
    const id = text(ticketId, '工单 id', 100);
    if (!id) throw workError('缺少工单 id', 400);
    const config = load();
    const expiresAt = Date.now() + Math.max(60_000, Math.min(Number(ttlMs) || ACTION_TTL_MS, ACTION_TTL_MS));
    const nonce = randomBytes(12).toString('base64url');
    const payload = `v1.${id}.${action}.${expiresAt}.${nonce}`;
    const signature = createHmac('sha256', secretOf(config)).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function verifyAction(token) {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 6 || parts[0] !== 'v1') throw workError('审批链接无效', 400);
    const [, ticketId, action, expiresAt, nonce, signature] = parts;
    if (!ACTIONS.has(action)) throw workError('审批链接无效', 400);
    const expected = createHmac('sha256', secretOf(load())).update(`v1.${ticketId}.${action}.${expiresAt}.${nonce}`).digest('base64url');
    if (!safeEqual(signature, expected)) throw workError('审批链接签名不匹配', 401);
    if (!Number.isInteger(Number(expiresAt)) || Number(expiresAt) < Date.now()) throw workError('审批链接已过期', 410);
    if (store.get('work-im-action', nonce)) throw workError('审批链接已使用', 409);
    return { ticketId, action, expiresAt: Number(expiresAt), nonce };
  }

  function executeAction(token) {
    const verified = verifyAction(token);
    // 先占位再执行：即使引擎动作失败，也不允许同一链接被重放。
    store.put('work-im-action', { id: verified.nonce, ticketId: verified.ticketId, action: verified.action, usedAt: now() });
    pruneActions();
    const ticket = engine.action(verified.ticketId, verified.action, {});
    return { ticket, action: verified.action };
  }

  function pruneActions() {
    const rows = store.list('work-im-action');
    for (const row of rows.slice(2000)) store.delete('work-im-action', row.id);
  }

  function ticketMessage(event, config) {
    const ticket = event.payload || {};
    const summary = String(ticket.summary || ticket.title || '').slice(0, 600);
    const lines = [`【Lagent】${ticket.title || '工单'} · ${ticket.status || event.type}`];
    if (summary) lines.push(summary);
    const base = baseUrlOf(config);
    const actions = [];
    if (base && ticket.status === 'awaiting_review') {
      actions.push({ label: '批准', url: `${base}/api/work/im/actions/${signAction(ticket.id, 'approve')}` });
      actions.push({ label: '拒绝', url: `${base}/api/work/im/actions/${signAction(ticket.id, 'reject')}` });
    } else if (base && ticket.id) {
      actions.push({ label: '查看工单', url: `${base}/?ticket=${encodeURIComponent(ticket.id)}` });
    }
    if (actions.length) lines.push(...actions.map(item => `${item.label}：${item.url}`));
    return { title: String(ticket.title || '').slice(0, 120), text: lines.join('\n'), actions, ticketId: ticket.id || '' };
  }

  function payloadFor(channel, message) {
    switch (channel.kind) {
      case 'slack': return { text: message.text };
      case 'teams': return { text: message.text };
      case 'feishu': return { msg_type: 'text', content: { text: message.text } };
      case 'wecom': return { msgtype: 'text', text: { content: message.text } };
      case 'dingtalk': return { msgtype: 'text', text: { content: message.text } };
      default: return { text: message.text, title: message.title, ticketId: message.ticketId, actions: message.actions };
    }
  }

  async function send(channel, message) {
    if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 Webhook 请求');
    const response = await fetchImpl(channel.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payloadFor(channel, message)),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(10000) : undefined
    });
    if (!response?.ok) throw new Error(`Webhook 返回 ${response?.status || '错误'}`);
    return { ok: true, status: response.status };
  }

  function shouldNotify(event, channel) {
    if (!event || typeof event !== 'object' || channel.enabled === false) return false;
    if (event.type === 'usage-alert') return channel.events.includes('usage-alert');
    if (event.type !== 'ticket' || !channel.events.includes('ticket')) return false;
    const ticket = event.payload || {};
    return TICKET_EVENTS.has(ticket.status) || Boolean(ticket.attention?.question);
  }

  // 去重键可能包含中文和冒号，实体 id 只允许安全字符，统一哈希后存储。
  const sentId = key => createHash('sha256').update(String(key)).digest('hex');

  function alreadySent(key) {
    return Boolean(store.get('work-im-sent', sentId(key)));
  }

  function markSent(key) {
    store.put('work-im-sent', { id: sentId(key), at: now() });
    const rows = store.list('work-im-sent');
    for (const row of rows.slice(MAX_SENT)) store.delete('work-im-sent', row.id);
  }

  async function onEvent(event) {
    if (!event || typeof event !== 'object') return [];
    const config = load();
    const targets = config.channels.filter(channel => shouldNotify(event, channel));
    if (!targets.length) return [];
    const ticket = event.payload || {};
    const dedupe = event.type === 'ticket'
      ? `${event.ticketId}:${ticket.status || ''}:${ticket.attention?.question || ''}`
      : String(event.id || `${event.type}:${ticket.ticketId || ''}`);
    if (alreadySent(dedupe)) return [];
    markSent(dedupe);
    const message = ticketMessage(event, config);
    if (event.type === 'usage-alert') {
      message.title = String(ticket.title || '用量告警').slice(0, 120);
      message.text = `【Lagent】${ticket.title || '用量告警'}\n${String(ticket.summary || '').slice(0, 600)}`;
    }
    const results = [];
    for (const channel of targets) {
      try {
        results.push({ channel: channel.id, ...(await send(channel, message)) });
      } catch (failure) {
        results.push({ channel: channel.id, ok: false, error: String(failure?.message || failure).slice(0, 300) });
      }
    }
    return results;
  }

  async function testChannel(id) {
    const config = load();
    const channel = config.channels.find(row => row.id === id);
    if (!channel) throw workError('通知渠道不存在', 404);
    const message = { title: 'Lagent 测试通知', text: '【Lagent】这是一条测试通知，收到即表示 Webhook 配置可用。', actions: [], ticketId: '' };
    return send(channel, message);
  }

  return { list, saveChannel, removeChannel, testChannel, onEvent, signAction, verifyAction, executeAction };
}
