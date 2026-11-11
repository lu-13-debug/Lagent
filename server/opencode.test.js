import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, validateSettings } from './gateway.js';
import { listModels } from './model-catalog.js';

test('OpenCode Go uses official Chat Completions endpoint with a task session', async () => {
  let seen;
  const baseUrl = 'https://opencode.ai/inference/go/openai/v1';
  const result = await chat({ settings: { baseUrl, model: 'glm-5.3' }, key: 'private-test-key', messages: [{ role: 'user', content: '聚合数据' }], sessionId: 'task-123', fetchImpl: async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return Response.json({ choices: [{ message: { content: '已完成' }, finish_reason: 'stop' }] }); } });
  assert.equal(result, '已完成');
  assert.equal(seen.url, `${baseUrl}/chat/completions`);
  assert.equal(seen.init.headers.authorization, 'Bearer private-test-key');
  assert.equal(seen.init.headers['x-opencode-session'], 'task-123');
  assert.match(seen.init.headers['user-agent'], /^Lagent\//);
  assert.equal(seen.init.redirect, 'error');
  assert.equal('temperature' in seen.body, false);
  assert.equal(validateSettings({ baseUrl: `${baseUrl}/chat/completions` }).baseUrl, baseUrl);
});

test('OpenCode Go discovers models from its dedicated catalog without exposing key', async () => {
  let captured;
  const baseUrl = 'https://opencode.ai/inference/go/openai/v1';
  const data = await listModels({ settings: { baseUrl }, key: 'private-test-key', fetchImpl: async (url, init) => { captured = { url, init }; return Response.json({ data: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }] }); } });
  assert.equal(captured.url, 'https://opencode.ai/inference/go/v1/models');
  assert.equal(captured.init.headers.authorization, 'Bearer private-test-key');
  assert.match(captured.init.headers['user-agent'], /^Lagent\//);
  assert.deepEqual(data.models.map(x => x.id), ['glm-5.3', 'kimi-k3']);
  assert.equal(JSON.stringify(data).includes('private-test-key'), false);
});

test('OpenCode-specific handling does not apply to lookalike hosts or unrelated paths', async () => {
  for (const baseUrl of ['https://opencode.ai.example.test/inference/go/openai/v1', 'https://opencode.ai/custom/v1']) {
    let target;
    await listModels({ settings: { baseUrl }, key: 'private-test-key', fetchImpl: async url => { target = url; return Response.json({ data: [] }); } });
    assert.equal(target, `${baseUrl}/models`);
  }
});
