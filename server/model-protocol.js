export const modelError = (code, message) => Object.assign(new Error(message), { code, modelFailure: true });
// 精确型号和协议白名单；兼容接口不代表具备同样的推理参数。
// 官方依据核查于2026-11-01；其余型号只开放默认档，不进行付费探测。
export function modelCapabilities({ baseUrl, model, protocol }) {
  const host = new URL(baseUrl).hostname;
  if (host === 'api.openai.com' && ['responses', 'chat-completions'].includes(protocol) && ['gpt-5.4', 'gpt-5.5'].includes(model)) return {
    efforts: ['default', 'low', 'medium', 'high', 'xhigh'], tools: true,
    source: `https://developers.openai.com/api/docs/models/${model}`,
  };
  if (host === 'api.anthropic.com' && protocol === 'anthropic' && ['claude-opus-4-6', 'claude-sonnet-4-6'].includes(model)) return {
    efforts: ['default', 'low', 'medium', 'high', 'max'], tools: true,
    source: 'https://platform.claude.com/docs/en/build-with-claude/effort',
  };
  return { efforts: ['default'], tools: false, reason: '该完整模型ID、接口地址和协议的可调思考强度尚未确认，仅开放默认档。' };
}
export function validateEffort(settings) {
  const effort = settings.effort === 'mid' ? 'medium' : settings.effort ?? 'default';
  if (!modelCapabilities(settings).efforts.includes(effort)) throw modelError('EFFORT_UNSUPPORTED', `此模型配置不支持思考强度 ${String(effort).slice(0, 20)}，请选择支持的档位。`);
  return effort;
}
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
// 推理型模型普遍拒绝自定义采样参数；按型号名兜底，避免第三方兼容接口各自报错。
const REASONING_MODEL = /(reason|thinking|^o[1-4]\b|gpt-5|r1\b|qwq)/i;
export function providerUsage(raw, protocol) {
  if (!raw || typeof raw !== 'object') return null;
  const result = {
    protocol, inputTokens: counter(raw.prompt_tokens ?? raw.input_tokens), outputTokens: counter(raw.completion_tokens ?? raw.output_tokens), totalTokens: counter(raw.total_tokens),
    cacheReadInputTokens: counter(raw.cache_read_input_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens),
    cacheCreationInputTokens: counter(raw.cache_creation_input_tokens), reasoningTokens: counter(raw.completion_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.reasoning_tokens ?? raw.output_tokens_details?.thinking_tokens),
  };
  return Object.entries(result).some(([key, value]) => key !== 'protocol' && value !== null) ? result : null;
}
export function modelRequest(baseUrl, model, messages, key, maxTokens, connectionTest, options = {}) {
  const hostname = new URL(baseUrl).hostname;
  const protocol = options.protocol ?? (hostname === 'api.anthropic.com' ? 'anthropic' : 'chat-completions');
  if (!['responses', 'anthropic', 'chat-completions'].includes(protocol)) throw modelError('PROTOCOL_ERROR', '模型协议无效。');
  const effort = validateEffort({ baseUrl, model, protocol, effort: options.effort });
  if (protocol === 'responses') return {
    protocol, endpoint: `${baseUrl}/responses`, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: { model, input: messages, max_output_tokens: maxTokens, ...(effort === 'default' ? {} : { reasoning: { effort } }) },
  };
  if (protocol === 'anthropic') return {
    protocol: 'anthropic', endpoint: `${baseUrl}/messages`,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    body: { model, max_tokens: maxTokens, system: messages.filter(message => message.role === 'system').map(message => message.content).join('\n'), messages: messages.filter(message => message.role !== 'system').map(({ role, content }) => ({ role, content })), ...(effort === 'default' ? {} : { output_config: { effort }, thinking: { type: 'adaptive' } }) },
  };
  return {
    protocol: 'chat-completions', endpoint: `${baseUrl}/chat/completions`, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: { model, messages, ...(['api.deepseek.com', 'api.openai.com'].includes(hostname) || baseUrl === 'https://opencode.ai/inference/go/openai/v1' || REASONING_MODEL.test(model) ? {} : { temperature: 0.2 }),
      ...(effort === 'default' ? {} : { reasoning_effort: effort }),
      ...(connectionTest && hostname === 'api.deepseek.com' && ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'].includes(model) ? { thinking: { type: 'disabled' } } : {}),
      ...(hostname === 'api.openai.com' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    },
  };
}
export function httpModelError(status) {
  if (status === 401) return modelError('INVALID_KEY', '模型 Key 无效或已过期；请重新填写该地址对应的 Key。');
  if (status === 403) return modelError('NO_PERMISSION', '没有访问此模型的权限；请在供应商控制台开通权限或选择已授权模型。');
  if (status === 429) return modelError('RATE_LIMITED', '模型服务限流或供应商额度不足；请稍后重试，并检查供应商余额和请求限制。');
  if (status === 404) return modelError('MODEL_UNSUPPORTED', '模型或接口不存在；请重新检测模型，并核对 API 地址和所选模型名称。');
  if (status === 400 || status === 422) return modelError('REQUEST_REJECTED', '模型拒绝当前请求；请核对文本对话能力、缩短业务背景或更换模型。');
  return modelError('UNREACHABLE', `模型服务返回 HTTP ${status}；请稍后重试或检查供应商服务状态。`);
}
export async function readModelResponse(response) {
  const limit = 2 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw modelError('RESPONSE_TOO_LARGE', '模型返回内容过大；请缩短输出或更换模型。'); }
  let text;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw modelError('RESPONSE_TOO_LARGE', '模型返回内容过大；请缩短输出或更换模型。'); } chunks.push(Buffer.from(value)); }
      text = Buffer.concat(chunks).toString('utf8');
    } finally { reader.releaseLock(); }
  } else { text = await response.text(); if (Buffer.byteLength(text, 'utf8') > limit) throw modelError('RESPONSE_TOO_LARGE', '模型返回内容过大；请缩短输出或更换模型。'); }
  try { return JSON.parse(text); } catch { throw modelError('PROTOCOL_ERROR', '模型服务未返回有效 JSON；请核对 API 地址是否支持对应的文本对话协议。'); }
}
export function visibleReply(payload, protocol, connectionTest) {
  if (protocol === 'responses') {
    if (!Array.isArray(payload?.output)) throw modelError('PROTOCOL_ERROR', '模型返回格式不兼容；请核对Responses协议。');
    const parts = payload.output.filter(item => item?.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []);
    if (parts.some(part => part?.type === 'refusal') || payload.incomplete_details?.reason === 'content_filter') throw modelError('REFUSED', '模型拒绝请求或触发安全过滤；请调整问题或选择其他已授权模型。');
    if (!connectionTest && payload.status === 'incomplete') throw modelError('OUTPUT_TRUNCATED', '模型达到输出上限，最终文本被截断；请调整输出预算后重试。');
    if (payload.error || payload.status === 'failed') throw modelError('REQUEST_REJECTED', '模型请求未成功完成；请检查模型权限与请求预算。');
    const content = parts.filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('');
    if (!content.trim() && payload.output.some(item => item?.type === 'reasoning')) {
      if (connectionTest && ['incomplete', 'completed'].includes(payload.status)) return '';
      throw modelError('REASONING_ONLY', '模型只返回推理，尚无最终文本；请调整输出预算或更换模型后重试。');
    }
    if (!content.trim()) throw modelError('EMPTY_RESPONSE', '模型未返回最终文本，内容为空；请确认模型支持文本对话或更换模型。');
    return content;
  }
  const claude = protocol === 'anthropic'; const choice = payload?.choices?.[0]; const message = claude ? payload : choice?.message;
  if (!message || typeof message !== 'object' || (claude && !Array.isArray(message.content))) throw modelError('PROTOCOL_ERROR', '模型返回格式不兼容；请核对 API 地址、模型协议或选择文本对话模型。');
  const parts = message.content;
  const content = typeof parts === 'string' ? parts : Array.isArray(parts) ? parts.filter(part => ['text', 'output_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('') : '';
  const stop = claude ? payload.stop_reason : choice.finish_reason;
  const reasoning = claude ? parts.some(part => part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) : typeof message.reasoning_content === 'string' && message.reasoning_content.trim();
  if (['content_filter', 'refusal'].includes(stop) || message.refusal || payload.stop_details?.type === 'refusal') throw modelError('REFUSED', '模型拒绝请求或触发安全过滤；请调整问题或选择其他已授权模型。');
  if (!content.trim() && reasoning) {
    if (connectionTest && ['length', 'max_tokens', 'stop', 'end_turn'].includes(stop)) return '';
    throw modelError('REASONING_ONLY', '模型只返回推理，尚无最终文本；请切换非推理模式、缩短目标或更换模型后重试。');
  }
  if (!connectionTest && ['length', 'max_tokens'].includes(stop)) throw modelError('OUTPUT_TRUNCATED', '模型达到输出上限，最终文本被截断；请缩短目标、关闭推理或更换模型后重试。');
  if (!content.trim()) throw modelError('EMPTY_RESPONSE', '模型未返回最终文本，内容为空；请确认模型支持文本对话或更换模型。');
  return content;
}
