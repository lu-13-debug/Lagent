import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { createProjectMemory } from './work/project-memory.js';
import { workStore } from './work/store.js';

function memoryFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-memory-v2-'));
  const store = new Store(dir);
  const db = workStore(store, () => {});
  const memory = createProjectMemory(db, { now: () => '2026-11-12T00:00:00.000Z' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { memory, store };
}

test('记忆 v2：scope/tags/confidence 与重复写入合并', t => {
  const { memory } = memoryFixture(t);
  const first = memory.add('p1', {
    title: '修复登录',
    summary: '改了登录页',
    files: ['src/auth/login.tsx'],
    tags: ['codex', 'completed'],
    confidence: 0.9,
    improvements: ['抽了表单组件']
  });
  assert.equal(first.scope, 'src/auth');
  assert.deepEqual(first.tags, ['codex', 'completed']);
  assert.equal(first.confidence, 0.9);

  const duplicate = memory.add('p1', {
    title: '修复登录',
    summary: '改了登录页',
    files: ['src/auth/login.tsx'],
    openQuestions: ['要不要支持 SSO？'],
    tags: ['claude-code']
  });
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(duplicate.tags.sort(), ['claude-code', 'codex', 'completed'].sort());
  assert.deepEqual(duplicate.openQuestions, ['要不要支持 SSO？']);
  assert.equal(memory.list('p1').length, 1);
});

test('记忆检索按关键词与 scope 过滤', t => {
  const { memory } = memoryFixture(t);
  memory.add('p1', { title: '修复登录页', summary: '登录表单校验', files: ['src/auth/login.tsx'], scope: 'src/auth' });
  memory.add('p1', { title: '补测试', summary: '订单接口加单测', files: ['src/order/api.ts'], scope: 'src/order' });
  memory.add('p2', { title: '别的项目', summary: '登录相关', scope: 'src/auth' });

  const byKeyword = memory.search('p1', { query: '登录' });
  assert.equal(byKeyword.length, 1);
  assert.equal(byKeyword[0].title, '修复登录页');

  const byScope = memory.search('p1', { scope: 'src/order' });
  assert.equal(byScope.length, 1);
  assert.equal(byScope[0].title, '补测试');

  assert.equal(memory.search('p1', { query: '不存在' }).length, 0);
  assert.equal(memory.search('p2', { query: '登录' }).length, 1);
});

test('引擎记忆摘要支持 query，自动写入 scope/tags', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-memory-engine-'));
  const store = new Store(dir);
  const cli = {
    id: 'codex', name: 'Codex Mock', kind: 'cli', available: true, requiresDataset: false, capabilities: ['code'],
    defaultInput: text => ({ prompt: text }),
    validateInput: value => value,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: '改了登录页' }, artifacts: { cli: { summary: '改了登录页', files: ['src/auth/login.tsx'] } } };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([cli]), () => {}, { workspace: dir, env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }, policy: { allowedExecutors: ['codex'] } });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const { project } = engine.importProject({ path: dir });
  const chat = engine.createProjectChat(project.id, { executorId: 'codex', title: '测试' }).chat;
  const ticket = engine.command({ text: '修登录页', executorId: 'codex', projectChatId: chat.id, executorInput: { prompt: '修登录页' } });
  assert.equal(ticket.status, 'completed');

  const digest = engine.projectMemoryDigest(project.id, { query: '登录' });
  assert.equal(digest.entries.length, 1);
  assert.equal(digest.entries[0].scope, 'src/auth');
  assert.deepEqual(digest.entries[0].tags.sort(), ['codex', 'completed'].sort());
  assert.match(digest.digest, /项目记忆/);

  const empty = engine.projectMemoryDigest(project.id, { query: '订单' });
  assert.equal(empty.entries.length, 0);
});
