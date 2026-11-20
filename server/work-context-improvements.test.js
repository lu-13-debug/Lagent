import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryContext, forAgent, splitLibraryByAgent } from './work/agent-context.js';
import { foldContextMessages, CONTEXT_BUDGET_BYTES } from './work/executors/model.js';
import { createProjectMemory } from './work/project-memory.js';

function fakeDb() {
  const rows = new Map();
  const key = (kind, id) => `${kind}:${id}`;
  return {
    list: kind => [...rows.values()].filter(row => row.__kind === kind).map(({ __kind, ...rest }) => rest),
    get: (kind, id) => {
      const row = rows.get(key(kind, id));
      if (!row) return null;
      const { __kind, ...rest } = row;
      return rest;
    },
    put: (kind, row) => { rows.set(key(kind, row.id), { ...row, __kind: kind }); return row; },
    delete: (kind, id) => rows.delete(key(kind, id)),
  };
}

test('Library 注入：公共条目给所有 Agent，[codex] 只给 Codex', () => {
  const library = {
    instructions: ['先跑测试', '[claude-code] 用 TypeScript', '[codex] 只改 server/**', '[*] 提交前说明改动'],
    skills: ['review', '[codex] 用 codex-review'],
    mcpServers: ['github'],
  };
  const codex = buildLibraryContext(library, { executorId: 'codex' });
  assert.match(codex, /先跑测试/);
  assert.match(codex, /只改 server/);
  assert.match(codex, /提交前说明改动/);
  assert.match(codex, /codex-review/);
  assert.doesNotMatch(codex, /用 TypeScript/);

  const claude = buildLibraryContext(library, { executorId: 'claude-code' });
  assert.match(claude, /用 TypeScript/);
  assert.doesNotMatch(claude, /只改 server/);
  assert.equal(buildLibraryContext({ instructions: [], skills: [], mcpServers: [] }, { executorId: 'codex' }), '');
});

test('Library 拆组：公共与按 Agent 不重复', () => {
  const split = splitLibraryByAgent({ instructions: ['公共', '[codex] 专属', '[unknown] 忽略'], skills: [], mcpServers: [] }, ['codex']);
  assert.deepEqual(split.common.instructions, ['公共']);
  assert.deepEqual(split.agents.codex.instructions, ['专属']);
  assert.equal(split.agents.unknown, undefined);
});

test('简报按 Agent 过滤：不把别人的约定塞给当前执行器', () => {
  const items = ['[codex] 只改 server', '[claude-code] 用函数组件', '公共：先读 README'];
  assert.deepEqual(forAgent(items, 'codex'), ['只改 server', '公共：先读 README']);
  assert.deepEqual(forAgent(items, 'claude-code'), ['用函数组件', '公共：先读 README']);
});

test('上下文折叠：超预算时压缩较早工具结果，保留最近记录', () => {
  const big = 'x'.repeat(8000);
  const messages = [{ role: 'system', content: 'system' }];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: 'user', content: '任务' + index });
    messages.push({ role: 'tool', tool_call_id: `call-${index}`, content: `工具结果：${big}` });
  }
  const result = foldContextMessages(messages, { budgetBytes: 40000, keepRecent: 4 });
  assert.ok(result.folded > 0);
  assert.ok(result.bytes <= 40000);
  // 最近 4 条工具结果原样保留，模型还能接着做。
  const toolMessages = messages.filter(message => message.role === 'tool');
  assert.equal(toolMessages.at(-1).content.length, 8000 + '工具结果：'.length);
  assert.match(toolMessages[0].content, /已折叠/);
  assert.equal(messages.length, 25);
});

test('上下文折叠：不超预算时不动消息', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'tool', tool_call_id: 'c', content: '小结果' }];
  const result = foldContextMessages(messages, { budgetBytes: CONTEXT_BUDGET_BYTES });
  assert.equal(result.folded, 0);
  assert.equal(messages[1].content, '小结果');
});

test('记忆检索：中文二元组命中，并按目录范围加权', () => {
  const db = fakeDb();
  const memory = createProjectMemory(db, { now: () => '2026-11-09T10:00:00.000Z' });
  memory.add('p1', { title: '登录接口修复', summary: 'token 校验提前到路由层', files: ['server/auth.js'], tags: ['bug'] });
  memory.add('p1', { title: '首页样式', summary: '调整按钮间距', files: ['src/home.css'] });
  memory.add('p1', { title: '文档更新', summary: '补充部署说明', files: ['docs/deploy.md'] });

  const byKeyword = memory.search('p1', { query: '登录失败', limit: 3 });
  assert.equal(byKeyword[0].title, '登录接口修复');

  const byScope = memory.search('p1', { scopes: ['server/**'], limit: 3 });
  assert.deepEqual(byScope.map(entry => entry.title), ['登录接口修复']);

  const digest = memory.digest('p1', { goal: '修登录报错', scopes: ['server/**'], limit: 3 });
  assert.match(digest, /与本任务相关/);
  assert.match(digest, /登录接口修复/);
  assert.doesNotMatch(digest, /首页样式/);
});
test('Library 三层预算：先保工作约定，再技能，最后低密度 MCP 清单', () => {
  const library = {
    instructions: ['规则一：先跑测试', '规则二：只改 server/**'],
    skills: Array.from({ length: 20 }, (_, index) => `skill-${index}-${'说'.repeat(20)}`),
    mcpServers: Array.from({ length: 20 }, (_, index) => `server-${index}`),
  };
  const text = buildLibraryContext(library, { executorId: 'codex', maxChars: 300 });
  assert.ok([...text].length <= 300, `实际长度 ${[...text].length}`);
  assert.match(text, /规则一/);
  assert.match(text, /规则二/);
  assert.doesNotMatch(text, /server-19/);
  assert.match(buildLibraryContext({ instructions: [], skills: [], mcpServers: ['github'] }, { maxChars: 1200 }), /可用 MCP 服务：github/);
});

test('Library 三层预算：高密度内容占满时直接丢掉低密度层，不做硬切', () => {
  const text = buildLibraryContext({
    instructions: [`规则：${'必须保留'.repeat(80)}`],
    skills: ['review'],
    mcpServers: ['github'],
  }, { executorId: 'codex', maxChars: 240 });
  assert.ok([...text].length <= 240);
  assert.match(text, /必须保留/);
  assert.doesNotMatch(text, /登记技能/);
  assert.doesNotMatch(text, /可用 MCP 服务/);
  assert.ok(text.endsWith('…'));
});
