import test from 'node:test';
import assert from 'node:assert/strict';
const s = await import('./model-picker.ts').catch(() => ({}));
const models = [
  { id: 'gpt-4o', name: 'GPT-4o' },
  { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat' },
];

test('空关键词返回前若干项并给出总数', () => {
  assert.equal(typeof s.filterModels, 'function');
  const result = s.filterModels(models, '', 2);
  assert.deepEqual(result.items.map(item => item.id), ['gpt-4o', 'gpt-4o-mini']);
  assert.equal(result.total, 4);
});

test('按 ID 或显示名不区分大小写匹配', () => {
  assert.deepEqual(s.filterModels(models, 'SONNET').items.map(item => item.id), ['claude-sonnet-5-5']);
  assert.deepEqual(s.filterModels(models, '  deepseek ').items.map(item => item.id), ['deepseek-chat']);
});

test('精确与前缀匹配排在前，包含匹配随后', () => {
  const list = [
    { id: 'x-gpt-4o-pro', name: 'x-gpt-4o-pro' },
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
  ];
  assert.deepEqual(s.filterModels(list, 'gpt-4o').items.map(item => item.id), ['gpt-4o', 'gpt-4o-mini', 'x-gpt-4o-pro']);
  assert.equal(s.filterModels(list, 'gpt-4o').total, 3);
});

test('没有匹配时返回空列表且不报错', () => {
  assert.deepEqual(s.filterModels(models, '不存在').items, []);
  assert.equal(s.filterModels(models, '不存在').total, 0);
  assert.deepEqual(s.filterModels([], 'gpt').items, []);
});
