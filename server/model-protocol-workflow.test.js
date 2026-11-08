import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, normalizeBaseUrl } from './gateway.js';
import * as protocol from './model-protocol.js';
const messages = [{ role: 'system', content: '聚合数据分析' }, { role: 'user', content: '请返回结果' }];
test('Responses实际发送所选effort并只读取最终文本与真实用量', async () => {
  let request, usage;
  const result = await chat({ settings: { provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', protocol: 'responses', effort: 'xhigh' }, key: 'fake-protocol-key', messages, maxTokens: 2048, onUsage: value => { usage = value; }, fetchImpl: async (url, init) => {
    request = { url, ...init, body: JSON.parse(init.body) };
    return Response.json({ status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'private-thought' }] }, { type: 'message', content: [{ type: 'output_text', text: '分析完成' }] }], usage: { input_tokens: 20, output_tokens: 12, total_tokens: 32, output_tokens_details: { reasoning_tokens: 8 } } });
  } });
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(request.body, { model: 'gpt-5.4', input: messages, max_output_tokens: 2048, reasoning: { effort: 'xhigh' } });
  assert.equal(result, '分析完成'); assert.equal(usage.protocol, 'responses'); assert.equal(usage.reasoningTokens, 8); assert.equal(usage.totalTokens, 32);
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/responses'), 'https://api.openai.com/v1');
});
test('Chat和Anthropic发送各自effort字段，不把默认档发为原生字段', async () => {
  const captured = [];
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); captured.push(body); return Response.json(body.system !== undefined ? { content: [{ type: 'text', text: 'OK' }] } : { choices: [{ message: { content: 'OK' } }] }); };
  await chat({ settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', protocol: 'chat-completions', effort: 'high' }, key: 'fake-key', messages, fetchImpl });
  assert.equal(captured[0].reasoning_effort, 'high'); assert.equal(captured[0].temperature, undefined);
  await chat({ settings: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6', protocol: 'anthropic', effort: 'max' }, key: 'fake-key', messages, fetchImpl });
  assert.deepEqual(captured[1].output_config, { effort: 'max' }); assert.deepEqual(captured[1].thinking, { type: 'adaptive' });
  await chat({ settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5', protocol: 'chat-completions', effort: 'default' }, key: 'fake-key', messages, fetchImpl });
  assert.equal(captured[2].reasoning_effort, undefined);
});
test('未知型号、代理主机与不支持档位在发请求前拒绝，能力表必须精确匹配', async () => {
  assert.equal(typeof protocol.modelCapabilities, 'function', '必须提供模型能力表');
  assert.deepEqual(protocol.modelCapabilities({ baseUrl: 'https://api.openai.com/v1', protocol: 'responses', model: 'gpt-5.4-future' }).efforts, ['default']);
  assert.deepEqual(protocol.modelCapabilities({ baseUrl: 'https://proxy.example/v1', protocol: 'responses', model: 'gpt-5.4' }).efforts, ['default']);
  for (const [model, effort] of [['unknown', 'high'], ['gpt-5.4', 'max']]) {
    await assert.rejects(chat({ settings: { baseUrl: 'https://api.openai.com/v1', protocol: 'responses', model, effort }, key: 'fake-key', messages, fetchImpl: async () => { assert.fail('不应请求'); } }), error => error.code === 'EFFORT_UNSUPPORTED');
  }
});
test('Responses拒绝、截断、空白和只推理响应给出明确错误', async () => {
  const options = { settings: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', protocol: 'responses' }, key: 'fake-key', messages };
  for (const [payload, code] of [
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private refusal' }] }] }, 'REFUSED'],
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'unfinished' }] }] }, 'OUTPUT_TRUNCATED'],
    [{ status: 'completed', output: [] }, 'EMPTY_RESPONSE'],
    [{ status: 'completed', output: [{ type: 'reasoning', summary: [] }] }, 'REASONING_ONLY'],
  ]) await assert.rejects(chat({ ...options, fetchImpl: async () => Response.json(payload) }), error => error.code === code);
});
