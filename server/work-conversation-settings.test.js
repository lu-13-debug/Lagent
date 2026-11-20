import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t, { id, kind = 'cli', policy, env } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-conv-settings-'));
  const store = new Store(dir);
  const seen = [];
  const executor = {
    id,
    name: id,
    kind,
    available: true,
    requiresDataset: false,
    capabilities: ['code'],
    defaultInput: text => ({ prompt: text }),
    validateInput: value => value,
    start(ticket, assignment, input) {
      seen.push(input?.executorInput ?? input);
      return { id: assignment.id, status: 'completed', report: { summary: 'done' }, artifacts: {} };
    },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, {
    workspace: dir,
    ...(policy ? { policy } : {}),
    ...(env ? { env: { LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1', ...process.env, ...env } } : { env: { ...process.env, LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' } })
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine, seen };
}

test('内置 Agent 透传模型、思考强度与工作权限', t => {
  const { engine, seen } = fixture(t, { id: 'model', policy: { allowedExecutors: ['model'] } });
  const ticket = engine.command({
    text: '检查项目',
    executorId: 'model',
    executorInput: { prompt: '检查项目' },
    settings: { profileId: 'profile-1', effort: 'high', permission: 'read' }
  });
  assert.equal(ticket.status, 'completed');
  assert.deepEqual(seen[0], { prompt: '检查项目', profileId: 'profile-1', effort: 'high', permission: 'read' });
});

test('外部 CLI 支持模型、思考强度与只读/可写权限', t => {
  const env = { LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' };
  const policy = { allowedExecutors: ['codex'] };
  const read = fixture(t, { id: 'codex', policy, env });
  read.engine.command({
    text: '只读检查',
    executorId: 'codex',
    executorInput: { prompt: '只读检查' },
    settings: { model: 'gpt-5.2-codex', effort: 'high', permission: 'read' }
  });
  assert.deepEqual(read.seen[0], { prompt: '只读检查', model: 'gpt-5.2-codex', effort: 'high', write: false });

  const write = fixture(t, { id: 'codex', policy, env });
  write.engine.command({ text: '开始修改', executorId: 'codex', executorInput: { prompt: '开始修改' }, settings: { permission: 'workspace' } });
  assert.equal(write.seen[0].write, true);
});

test('项目对话把 CLI 的模型与思考强度传进执行器输入', t => {
  const env = { LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' };
  const { engine, seen } = fixture(t, { id: 'codex', policy: { allowedExecutors: ['codex'] }, env });
  const { project } = engine.importProject({ path: process.cwd() });
  const chat = engine.createProjectChat(project.id, { executorId: 'codex', title: '测试' }).chat;
  engine.projectChatMessage(chat.id, { text: '继续修', model: 'gpt-5.2-codex', effort: 'xhigh' });
  assert.equal(seen[0].model, 'gpt-5.2-codex');
  assert.equal(seen[0].effort, 'xhigh');
});

test('对话设置校验未知字段、执行器能力与项目对话权限', t => {
  const env = { LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' };
  const { engine } = fixture(t, { id: 'codex', policy: { allowedExecutors: ['codex', 'terminal'] }, env });
  assert.throws(() => engine.command({ text: 'x', executorId: 'codex', executorInput: { prompt: 'x' }, settings: { bogus: 1 } }), /未知字段/);
  assert.throws(() => engine.command({ text: 'x', executorId: 'codex', executorInput: { prompt: 'x' }, settings: { profileId: 'p1' } }), /只有内置 Agent/);
  assert.throws(() => engine.command({ text: 'x', executorId: 'codex', executorInput: { prompt: 'x' }, settings: { permission: 'root' } }), /read\/workspace\/full/);
});
