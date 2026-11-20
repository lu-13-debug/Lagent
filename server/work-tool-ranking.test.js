import test from 'node:test';
import assert from 'node:assert/strict';
import { rankTools, scoreTool, tokenizeToolText } from './work/tool-ranking.js';

const tool = (name, description = '') => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } });
const names = rows => rows.map(row => row.function.name);

test('工具 top-k：按任务选中相关 MCP 工具，不相关的尾部工具被排除', () => {
  const tools = [
    ...Array.from({ length: 30 }, (_, index) => tool(`generic_${index}`, `通用工具 ${index}`)),
    tool('db_migrate', '数据库迁移执行器'),
    ...Array.from({ length: 8 }, (_, index) => tool(`misc_${index}`, `杂项 ${index}`)),
    tool('migration_rollback', '数据库迁移失败后的回滚'),
    tool('weather', '查询天气'),
  ];
  const picked = names(rankTools(tools, '数据库迁移失败，需要回滚', { k: 16 }));
  assert.equal(picked.length, 16);
  assert.ok(picked.includes('db_migrate'));
  assert.ok(picked.includes('migration_rollback'));
  assert.ok(!picked.includes('weather'));
});

test('工具 top-k：已经用过的工具即使不含任务词也会保留', () => {
  const tools = Array.from({ length: 40 }, (_, index) => tool(`tool_${index}`, `工具 ${index}`));
  const picked = names(rankTools(tools, '和工具无关的任务', { k: 5, keep: ['tool_39'] }));
  assert.equal(picked.length, 5);
  assert.ok(picked.includes('tool_39'));
});

test('工具 top-k：工具不足 k 个时保持原顺序，中文描述可命中', () => {
  const tools = [tool('mystery', '查询天气与温度'), tool('other', '写入文件')];
  assert.deepEqual(names(rankTools(tools, '天气', { k: 16 })), ['mystery', 'other']);
  assert.ok(scoreTool(tools[0], new Set(tokenizeToolText('天气'))) > 0);
  assert.deepEqual(tokenizeToolText('MCP 天气'), ['mcp', '天气']);
});
