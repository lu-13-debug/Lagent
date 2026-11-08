import test from 'node:test';
import assert from 'node:assert/strict';
import { listModels } from './model-catalog.js';
test('自定义Anthropic协议目录使用x-api-key并按同源游标分页', async () => {
  const requests = [];
  const result = await listModels({ settings: { baseUrl: 'https://claude-proxy.example/v1', protocol: 'anthropic' }, key: 'fake-proxy-key', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return Response.json(requests.length === 1 ? { data: [{ id: 'model-one' }], has_more: true, last_id: 'model-one' } : { data: [{ id: 'model-two' }], has_more: false });
  } });
  assert.equal(requests[0].init.headers['x-api-key'], 'fake-proxy-key'); assert.ok(requests[0].init.headers['anthropic-version']); assert.equal(requests[0].init.redirect, 'error');
  assert.equal(result.models.length, 2); assert.equal(new URL(requests[1].url).searchParams.get('after_id'), 'model-one');
  assert.ok(requests.every(request => new URL(request.url).origin === 'https://claude-proxy.example'));
});
test('显式Chat协议不从Anthropic主机推断额外目录参数', async () => {
  let request;
  await listModels({ settings: { baseUrl: 'https://api.anthropic.com/v1', protocol: 'chat-completions' }, key: 'fake-chat-key', fetchImpl: async (url, init) => {
    request = { url, init };
    return Response.json({ data: [{ id: 'compatible-model' }] });
  } });
  assert.equal(request.init.headers['anthropic-version'], undefined); assert.equal(new URL(request.url).search, '');
});
