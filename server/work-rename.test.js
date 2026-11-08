import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { projectService } from './work/projects.js';
import { workStore } from './work/store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';

const scratch = () => mkdtempSync(join(tmpdir(), 'dataagent-rename-'));

test('P1 工作文件夹与会话可重命名，首条消息自动命名且项目摘要带工单计数', t => {
  const root = scratch();
  const store = new Store(root);
  const projectDir = join(root, 'proj');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const service = projectService(workStore(store, () => {}), { home });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const { project } = service.importProject({ path: projectDir });
  const chat = service.createChat(project.id, { executorId: 'claude-code' });
  assert.equal(chat.autoTitle, true);

  // 重命名校验
  assert.throws(() => service.renameChat(chat.id, { title: '   ' }), { status: 400 });
  assert.throws(() => service.renameChat(chat.id, { title: 'x'.repeat(201) }), { status: 400 });
  assert.throws(() => service.renameChat('missing', { title: 'ok' }), { status: 404 });
  const renamed = service.renameChat(chat.id, { title: '  修复   首页  溢出  ' });
  assert.equal(renamed.title, '修复 首页 溢出');
  assert.equal(renamed.autoTitle, false);

  // 自动命名只对默认标题生效
  const auto = service.createChat(project.id, { executorId: 'codex' });
  assert.equal(service.adoptTitle(auto.id, '').title, auto.title);
  const longText = '把夜间开关接到设置页并补测试、修窄屏溢出，再补一条变更记录说明'.repeat(2);
  const titled = service.adoptTitle(auto.id, `  ${longText}  `);
  assert.equal(titled.title, `${longText.slice(0, 42)}…`);
  assert.equal(titled.autoTitle, false);
  assert.equal(service.adoptTitle(auto.id, '第二条消息不再改名').title, titled.title);
  const shortChat = service.createChat(project.id, { executorId: 'claude-code' });
  assert.equal(service.adoptTitle(shortChat.id, '  短标题  ').title, '短标题');
  assert.equal(service.adoptTitle(chat.id, '手动命名的会话不受影响').title, '修复 首页 溢出');

  // 项目重命名
  assert.throws(() => service.renameProject(project.id, { name: '  ' }), { status: 400 });
  assert.throws(() => service.renameProject(project.id, { name: 'y'.repeat(81) }), { status: 400 });
  assert.equal(service.renameProject(project.id, { name: '  夜间主题  ' }).name, '夜间主题');
  assert.equal(service.listProjects()[0].name, '夜间主题');

  // 摘要里的工单元数据
  const executor = claudeCodeExecutor({ store, cwd: root, binary: process.execPath, spawnImpl: () => { throw new Error('不应启动 CLI'); } });
  const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, {
    policy: { allowedExecutors: ['claude-code'] },
    env: { ...process.env, DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    home
  });
  t.after(() => engine.close());
  const ticket = engine.projectChatMessage(chat.id, { text: '给首页加夜间开关' });
  assert.equal(ticket.status, 'awaiting_review');
  const summary = engine.getProject(project.id);
  const row = summary.chats.find(item => item.id === chat.id);
  assert.equal(row.ticketCount, 1);
  assert.equal(row.pendingCount, 1);
  assert.equal(row.lastTicketStatus, 'awaiting_review');
  assert.ok(row.lastTicketAt);
  assert.ok(summary.lastActivity);
});
