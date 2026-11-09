import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectMemory, summarizeExecution } from './work/project-memory.js';

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
    put: (kind, row) => {
      rows.set(key(kind, row.id), { ...row, __kind: kind });
      return row;
    },
    delete: (kind, id) => rows.delete(key(kind, id)),
    size: () => rows.size,
  };
}

test('项目记忆：写入后能按时间倒序列出，并生成包含待办的摘要', () => {
  const db = fakeDb();
  const memory = createProjectMemory(db, { now: () => '2026-11-09T10:00:00.000Z' });
  const first = memory.add('p1', {
    title: '修复登录接口',
    summary: '把 token 校验提前到路由层',
    files: ['server/auth.js'],
    improvements: ['登录失败会返回 401 而不是 500'],
    openQuestions: ['刷新 token 还没做'],
    executorId: 'claude-code',
  });
  assert.equal(first.source, 'local');
  assert.equal(memory.list('p1').length, 1);
  const digest = memory.digest('p1');
  assert.match(digest, /项目记忆（最近 1 条 \/ 共 1 条）/);
  assert.match(digest, /claude-code/);
  assert.match(digest, /server\/auth\.js/);
  assert.match(digest, /还没解决的问题/);
  assert.match(digest, /刷新 token 还没做/);
});

test('项目记忆：更新后保留原 id，并按项目隔离', () => {
  const db = fakeDb();
  const memory = createProjectMemory(db);
  const entry = memory.add('p1', { title: '写首页', summary: '先搭骨架' });
  memory.add('p2', { title: '另一个项目' });
  const updated = memory.update(entry.id, { summary: '模型总结过的内容', improvements: ['可维护性'], source: 'model', model: { provider: '测试', model: 'm1' } });
  assert.equal(updated.id, entry.id);
  assert.equal(updated.summary, '模型总结过的内容');
  assert.equal(updated.source, 'model');
  assert.equal(memory.list('p1').length, 1);
  assert.equal(memory.list('p1')[0].summary, '模型总结过的内容');
  assert.equal(memory.list('p2').length, 1);
});

test('项目记忆：删除后摘要里不再出现', () => {
  const db = fakeDb();
  const memory = createProjectMemory(db);
  const entry = memory.add('p1', { title: '临时任务', summary: '做完就删' });
  memory.remove(entry.id);
  assert.equal(memory.list('p1').length, 0);
  assert.equal(memory.digest('p1'), '');
});

test('项目记忆：本地总结带出失败原因与改动文件', () => {
  const result = summarizeExecution({
    ticket: { title: '实现统计接口', command: '实现统计接口并补测试' },
    report: { summary: '接口写好了，但测试没跑通' },
    files: ['server/stats.js', 'src/pages/stats.tsx'],
    status: 'failed',
  });
  assert.equal(result.title, '实现统计接口');
  assert.match(result.summary, /测试没跑通/);
  assert.deepEqual(result.files, ['server/stats.js', 'src/pages/stats.tsx']);
  assert.match(result.openQuestions[0], /上次执行失败/);
});
