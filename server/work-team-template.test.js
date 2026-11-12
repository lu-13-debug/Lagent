import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { normalizeTeamTemplate } from './work/team-templates.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-team-template-'));
  const store = new Store(dir);
  const terminal = { id: 'terminal', name: '受控终端', kind: 'tool', available: true, requiresDataset: false, capabilities: [], start() { throw new Error('unused'); }, get() { return null; } };
  const engine = createWorkEngine(store, createExecutorRegistry([terminal]), () => {}, { workspace: dir });
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { engine };
}

test('团队模板规范化：角色、权限与默认模式', () => {
  const template = normalizeTeamTemplate({
    name: '默认开发团队',
    roles: [
      { role: '调研', executorId: 'claude-code', permissions: 'read' },
      { role: '实现', executorId: 'codex', permissions: 'workspace' }
    ],
    defaultMode: 'plan'
  });
  assert.equal(template.name, '默认开发团队');
  assert.deepEqual(template.roles, [
    { role: '调研', executorId: 'claude-code', permissions: 'read' },
    { role: '实现', executorId: 'codex', permissions: 'workspace' }
  ]);
  assert.equal(template.defaultMode, 'plan');

  assert.throws(() => normalizeTeamTemplate({ name: '', roles: [] }), /名称/);
  assert.throws(() => normalizeTeamTemplate({ name: 'x', roles: [] }), /1–8/);
  assert.throws(() => normalizeTeamTemplate({ name: 'x', roles: [{ role: 'a', executorId: 'b', permissions: 'root' }] }), /read\/workspace\/full/);
  assert.throws(() => normalizeTeamTemplate({ name: 'x', roles: [{ role: 'a', executorId: 'b' }], defaultMode: 'chat' }), /auto\/plan\/review/);
  assert.throws(() => normalizeTeamTemplate({ name: 'x', roles: [{ role: 'a', executorId: 'b', extra: 1 }] }), /未知字段/);
});

test('引擎保存、列出、更新与删除团队模板', t => {
  const { engine } = fixture(t);
  const created = engine.saveTeamTemplate({
    name: '前端小队',
    roles: [{ role: '实现', executorId: 'claude-code', permissions: 'workspace' }],
    defaultMode: 'auto'
  });
  assert.ok(created.id);
  assert.equal(created.createdAt, created.updatedAt);
  assert.equal(engine.listTeamTemplates().length, 1);

  const updated = engine.saveTeamTemplate({
    id: created.id,
    name: '前端小队 2',
    roles: [{ role: '实现', executorId: 'codex', permissions: 'workspace' }],
    defaultMode: 'review'
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.name, '前端小队 2');
  assert.equal(engine.listTeamTemplates().length, 1);

  const projectTemplate = engine.saveTeamTemplate({
    name: '项目模板',
    projectId: 'proj-1',
    roles: [{ role: '验证', executorId: 'terminal', permissions: 'read' }]
  });
  assert.equal(engine.listTeamTemplates('proj-1').length, 1);
  assert.equal(engine.listTeamTemplates('proj-1')[0].id, projectTemplate.id);
  assert.equal(engine.listTeamTemplates('other').length, 0);

  assert.deepEqual(engine.deleteTeamTemplate(created.id), { id: created.id });
  assert.equal(engine.listTeamTemplates().length, 1);
  assert.throws(() => engine.deleteTeamTemplate('missing'), { status: 404 });
});
