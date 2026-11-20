import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-profiles-'));
  const store = new Store(dir);
  const analysis = {
    id: 'analysis', name: '分析', kind: 'analysis', available: true, requiresDataset: true, capabilities: [],
    start() { throw new Error('unused'); }, get() { return null; }
  };
  const codex = {
    id: 'codex', name: 'Codex', kind: 'cli', available: true, capabilities: [],
    defaultInput: text => ({ prompt: text }),
    validateInput: input => input,
    start(ticket, assignment) { return { id: assignment.id, status: 'completed', report: { summary: 'done' } }; },
    get() { return null; }
  };
  const engine = createWorkEngine(store, createExecutorRegistry([analysis, codex]), () => {}, {
    workspace: dir,
    policy: { allowedExecutors: ['analysis', 'codex'] },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1', LAGENT_ALLOW_UNMANAGED_EXTERNAL: '1' }
  });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine };
}

test('配置档：保存、重名、应用全局策略、重置与删除', t => {
  const { engine, store } = fixture(t);
  const profile = engine.saveProfile({
    name: '质量优先',
    description: '给重要项目用的高配',
    settings: { model: 'claude-opus-5-5', effort: 'high', permission: 'workspace' },
    policy: { permission: 'full', allowedExecutors: ['analysis', 'codex'] },
    library: { skills: ['review'], mcpServers: ['github'], instructions: ['先读代码'] }
  });
  assert.equal(profile.name, '质量优先');
  assert.deepEqual(profile.settings, { model: 'claude-opus-5-5', effort: 'high', permission: 'workspace' });
  assert.equal(profile.policy.permission, 'full');
  assert.deepEqual(profile.library.skills, ['review']);

  assert.throws(() => engine.saveProfile({ name: '质量优先' }), { status: 409 });
  assert.throws(() => engine.saveProfile({ name: '坏配置', settings: { model: 'claude opus 5!' } }), { status: 400 });
  assert.throws(() => engine.saveProfile({ name: '坏字段', settings: { temperature: 0.2 } }), { status: 400 });
  assert.throws(() => engine.saveProfile({ name: '坏权限', settings: { permission: 'root' } }), { status: 400 });
  assert.throws(() => engine.saveProfile({ name: '坏 Library', library: { secrets: ['x'] } }), { status: 400 });

  const applied = engine.applyProfile(profile.id);
  assert.equal(applied.scope, 'global');
  assert.equal(engine.policy().permission, 'full');
  assert.deepEqual(engine.policy().allowedExecutors, ['analysis', 'codex']);
  assert.equal(engine.profilesActive().effective.profileId, profile.id);
  assert.equal(engine.bootstrap().activeProfile.global.profileId, profile.id);
  // 全局配置档带权限时，不支持权限设置的分析执行器仍能正常下任务。
  assert.equal(engine.command({ text: '检查活跃' }).executor, 'analysis');
  assert.equal(engine.listProfiles().length, 1);

  const renamed = engine.updateProfile(profile.id, { name: '质量优先 2', settings: { model: 'claude-sonnet-5-5', effort: 'medium' } });
  assert.equal(renamed.name, '质量优先 2');
  assert.deepEqual(renamed.settings, { model: 'claude-sonnet-5-5', effort: 'medium' });

  const reset = engine.resetProfile();
  assert.equal(reset.scope, 'global');
  assert.equal(engine.policy().permission, 'workspace');
  assert.equal(engine.profilesActive().global, null);

  engine.deleteProfile(profile.id);
  assert.equal(engine.profilesActive().global, null);
  assert.throws(() => engine.updateProfile(profile.id, { name: 'x' }), { status: 404 });
  assert.equal((store.list('work-profile') || []).length, 0);
});

test('配置档：项目级覆盖不改全局策略，并接管项目对话默认设置', t => {
  const { engine, dir } = fixture(t);
  const { project } = engine.importProject({ path: dir });
  const profile = engine.saveProfile({
    name: '省钱只读',
    settings: { model: 'claude-haiku-5-5', effort: 'low', permission: 'read' },
    policy: { permission: 'full' }
  });
  const before = engine.policy().permission;
  const applied = engine.applyProfile(profile.id, { projectId: project.id });
  assert.equal(applied.scope, 'project');
  assert.equal(applied.projectId, project.id);
  // 项目级应用只覆盖工作方式，不悄悄把全局策略改成 full。
  assert.equal(engine.policy().permission, before);

  const active = engine.profilesActive(project.id);
  assert.equal(active.global, null);
  assert.equal(active.project.profileId, profile.id);
  assert.equal(active.effective.settings.permission, 'read');

  // 没有对话时，按 projectId 下任务应给出可操作的错误。
  assert.throws(() => engine.command({ text: '检查项目', projectId: project.id }), { status: 400 });
  const chat = engine.createProjectChat(project.id, { executorId: 'codex', title: '默认对话' }).chat;
  const ticket = engine.command({ text: '检查项目', executorId: 'codex', projectId: project.id });
  assert.equal(ticket.projectChatId, chat.id);
  assert.equal(ticket.executor, 'codex');

  engine.resetProfile({ projectId: project.id });
  assert.equal(engine.profilesActive(project.id).project, null);
  assert.equal(engine.profilesActive(project.id).effective, null);
});

test('配置档 Library 与项目简报按执行器注入', t => {
  const { engine, dir, store } = fixture(t);
  const { project } = engine.importProject({ path: dir });
  const profile = engine.saveProfile({
    name: '按 Agent 注入',
    policy: { allowedExecutors: ['analysis', 'codex'] },
    library: {
      instructions: ['先跑测试', '[claude-code] 用 TypeScript', '[codex] 只改 server/**'],
      skills: ['review'],
      mcpServers: []
    }
  });
  engine.applyProfile(profile.id);
  engine.saveProjectBrief(project.id, { constraints: ['[codex] 不改前端', '[claude-code] 用函数组件'] });
  engine.createProjectChat(project.id, { executorId: 'codex', title: '注入检查' });
  const ticket = engine.command({ text: '检查项目', executorId: 'codex', projectId: project.id });
  const prompt = store.get('work-control', ticket.id).executorInput.prompt;
  assert.match(prompt, /先跑测试/);
  assert.match(prompt, /只改 server/);
  assert.match(prompt, /不改前端/);
  assert.match(prompt, /登记技能：review/);
  // 别的 Agent 的约定不能混进来。
  assert.doesNotMatch(prompt, /用 TypeScript/);
  assert.doesNotMatch(prompt, /用函数组件/);
});

test('配置档：最多保存 20 个，应用不存在的配置档返回 404', t => {
  const { engine } = fixture(t);
  for (let index = 0; index < 20; index++) engine.saveProfile({ name: `配置 ${index}` });
  assert.throws(() => engine.saveProfile({ name: '第 21 个' }), { status: 429 });
  assert.throws(() => engine.applyProfile('missing'), { status: 404 });
  assert.throws(() => engine.applyProfile(''), { status: 400 });
});
