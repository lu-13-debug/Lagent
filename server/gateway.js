import { modelError, modelRequest, httpModelError, readModelResponse, visibleReply, providerUsage } from './model-protocol.js';
import { randomUUID } from 'node:crypto';
import { APP_VERSION } from './version.js';
export const DEFAULT_MODEL_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_SETTINGS = { provider: 'OpenAI 兼容', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' };
export const DEFAULT_MODEL_HOSTS = Object.freeze(['api.deepseek.com', 'api.anthropic.com', 'api.openai.com']);

export function validateSettings(input, previous = DEFAULT_SETTINGS) {
  const provider = String(input.provider ?? previous.provider).trim();
  const model = String(input.model ?? previous.model).trim();
  if (!provider || provider.length > 80 || !model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('请填写有效的服务商和模型名称');
  return { provider, baseUrl: normalizeBaseUrl(input.baseUrl ?? previous.baseUrl), model };
}

export function normalizeBaseUrl(value) {
  const rawUrl = String(value ?? '').trim();
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('模型服务地址无效'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('模型服务必须使用 HTTPS；仅 loopback 本地服务允许 HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('模型服务地址不能包含凭据、查询参数或片段');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models|messages|responses)$/, '');
  if ((!url.pathname || url.pathname === '/') && ['api.openai.com', 'api.anthropic.com'].includes(url.hostname)) url.pathname = '/v1';
  return url.toString().replace(/\/+$/, '');
}

export function validateKey(key) {
  if (typeof key !== 'string' || key.length > 4096 || /[\r\n]/.test(key)) throw new Error('API Key 格式无效');
  return key.trim();
}
export function redact(text, key) { return key ? String(text).split(key).join('[已隐藏凭据]') : String(text); }

export async function chat({ settings, key, pool, poolId, affinity, onAttempt, messages, signal, fetchImpl = fetch, timeoutMs = DEFAULT_MODEL_TIMEOUT_MS, maxTokens = 8192, connectionTest = false, onUsage, sessionId }) {
  if (!key && !pool) throw modelError('KEY_REQUIRED', '尚未设置 API Key；请先在模型设置中配置。');
  let protocol = 'chat-completions';
  // 单次请求：每次尝试单独创建超时信号，避免第一个 Key 超时后把后续尝试也一起中止。
  async function send(attemptSettings, attemptKey) {
    const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const baseUrl = normalizeBaseUrl(attemptSettings.baseUrl);
    const request = modelRequest(baseUrl, attemptSettings.model, messages, attemptKey, maxTokens, connectionTest, attemptSettings);
    if (baseUrl === 'https://opencode.ai/inference/go/openai/v1') {
      request.headers['user-agent'] = 'Lagent/' + APP_VERSION;
      request.headers['x-opencode-session'] = typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId) ? sessionId : randomUUID();
    }
    try {
      const response = await fetchImpl(request.endpoint, { method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: combined, redirect: 'error' });
      onAttempt?.({ ok: response.ok, status: response.status, attemptSettings, request });
      return { response, request, combined };
    } catch (error) {
      if (combined.aborted) {
        if (signal?.aborted) throw modelError('CANCELLED', '任务已取消。');
        throw Object.assign(modelError('TIMEOUT', '模型请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）；请检查服务连接或更换模型后重试。'), { retryable: true, status: 504 });
      }
      throw Object.assign(modelError('UNREACHABLE', '无法连接模型服务，请检查地址、网络和证书；供应商原始错误已隐藏。'), { retryable: true, status: 502 });
    }
  }
  try {
    let response, request, usedKey = key;
    if (pool) {
      const executed = await pool.execute(poolId, async ({ key: attemptKey, settings: attemptSettings }) => {
        // pool.execute 以 result.ok === false 判断需要换 Key；这里包成原始 Response 让状态码参与路由。
        return send({ ...settings, ...attemptSettings, model: settings.model }, attemptKey);
      }, { affinity: affinity || sessionId || '', model: settings.model });
      response = executed.result.response;
      request = executed.result.request;
      usedKey = executed.lease?.key || key;
    } else {
      const sent = await send(settings, key);
      response = sent.response;
      request = sent.request;
    }
    if (!response.ok) { await response.body?.cancel(); throw httpModelError(response.status); }
    protocol = request.protocol;
    const payload = await readModelResponse(response);
    onUsage?.(providerUsage(payload?.usage, protocol));
    return redact(visibleReply(payload, protocol, connectionTest), usedKey);
  } catch (error) {
    if (signal?.aborted) throw modelError('CANCELLED', '任务已取消。');
    if (error?.modelFailure) throw error;
    // 池化后的最后一次失败通常带供应商状态码；统一映射成用户能理解的错误。
    if (Number.isInteger(error?.status)) throw httpModelError(error.status);
    throw modelError('UNREACHABLE', '无法连接模型服务，请检查地址、网络和证书；供应商原始错误已隐藏。');
  }
}
