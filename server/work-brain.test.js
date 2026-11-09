import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkBrain } from './work/brain.js';

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: null,
    async text() { return JSON.stringify(payload); },
    async json() { return payload; },
  };
}

function stubHub(context) {
  return {
    captureWorkflow: () => ({ stages: { plan: { provider: 'openai', model: 'gpt-test' } } }),
    context: () => context,
  };
}

function baseContext(fetchImpl) {
  return {
    settings: { provider: 'openai', model: 'gpt-test', baseUrl: 'https://api.example.com/v1', protocol: 'chat-completions' },
    key: 'sk-test',
    maxTokens: 1200,
    timeoutMs: 30000,
    fetchImpl,
  };
}

test('任务大脑：需要资料时先搜索仓库，再给出分工方案', async () => {
  const calls = [];
  const planReply = {
    choices: [{
      message: {
        role: 'assistant',
        content: '```json\n{"understanding":["目标：做一个 2D 平台跳跃游戏","先看开源实现再动手"],"steps":[{"title":"找参考实现","executorId":"github","readOnly":true,"output":"仓库列表"},{"title":"实现关卡与角色","executorId":"claude-code","scope":["src/**"],"output":"可运行的原型"}]}\n```',
      },
    }],
  };
  const toolReply = {
    choices: [{
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'github_search', arguments: JSON.stringify({ query: 'platformer framework', limit: 3 }) } }],
      },
    }],
  };
  const queue = [toolReply, planReply];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.github.com')) {
      return jsonResponse({ items: [{ full_name: 'phaserjs/phaser', stargazers_count: 38000, language: 'JavaScript', description: 'HTML5 game framework', html_url: 'https://github.com/phaserjs/phaser', updated_at: '2026-01-01T00:00:00Z' }] });
    }
    const next = queue.shift();
    if (!next) throw new Error('模型被调用了多余次数');
    return jsonResponse(next);
  };
  const brain = createWorkBrain({ modelHub: stubHub(baseContext(fetchImpl)), fetchImpl });

  assert.equal(brain.availability().ok, true);
  const result = await brain.think({
    goal: '参考开源实现，做一个 2D 平台跳跃游戏',
    executors: ['github', 'claude-code', 'codex'],
  });
  assert.equal(result.source, 'model');
  assert.deepEqual(result.steps.map(step => step.executorId), ['github', 'claude-code']);
  assert.equal(result.steps[0].readOnly, true);
  assert.equal(result.steps[1].kind, 'write');
  assert.deepEqual(result.steps[1].scope, ['src/**']);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'github_search');
  assert.equal(result.toolCalls[0].ok, true);
  assert.equal(calls.filter(url => url.includes('api.github.com')).length, 1);
  assert.equal(calls.filter(url => url.includes('api.example.com')).length, 2);
});

test('任务大脑：没有配置模型时明确报不可用', async () => {
  const brain = createWorkBrain({ modelHub: stubHub(null), fetchImpl: async () => jsonResponse({}) });
  const state = brain.availability();
  assert.equal(state.ok, false);
  assert.match(state.reason, /模型/);
  await assert.rejects(() => brain.think({ goal: '做点什么', executors: ['codex'] }), /模型/);
});

test('任务大脑：抓网页受浏览器域名白名单约束', async () => {
  const brain = createWorkBrain({ modelHub: stubHub(baseContext(async () => jsonResponse({}))), fetchImpl: async () => jsonResponse({}) });
  const blocked = await brain.__test__.callTool('fetch_page', { url: 'https://evil.example.org/a' }, { projectPath: '', browserHosts: ['example.com'] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /白名单/);
  const insecure = await brain.__test__.callTool('fetch_page', { url: 'http://example.com/a' }, { projectPath: '', browserHosts: [] });
  assert.equal(insecure.ok, false);
  assert.match(insecure.summary, /https/);
});

test('任务大脑：总结只产出摘要、改进与待办，不改文件名', async () => {
  const reply = {
    choices: [{
      message: {
        role: 'assistant',
        content: '{"summary":"补齐了统计接口并接上前端","improvements":["接口与页面一起改，避免二次回归"],"openQuestions":["导出功能还没做"]}',
      },
    }],
  };
  const fetchImpl = async () => jsonResponse(reply);
  const brain = createWorkBrain({ modelHub: stubHub(baseContext(fetchImpl)), fetchImpl });
  const result = await brain.summarize({
    goal: '实现统计接口',
    project: { name: 'demo', path: 'D:\\demo' },
    executorId: 'claude-code',
    summary: '接口写完了',
    files: ['server/stats.js'],
  });
  assert.match(result.summary, /统计接口/);
  assert.deepEqual(result.improvements, ['接口与页面一起改，避免二次回归']);
  assert.deepEqual(result.openQuestions, ['导出功能还没做']);
});
