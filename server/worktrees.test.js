import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorktreeService } from './work/worktrees.js';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function fixture(t, { enabled = true } = {}) {
  const project = mkdtempSync(join(tmpdir(), 'lagent-worktree-project-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lagent-worktree-data-'));
  const store = new Store(dataDir);
  t.after(() => {
    store.close();
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  git(project, ['init']);
  git(project, ['config', 'user.email', 'test@example.com']);
  git(project, ['config', 'user.name', 'Test']);
  writeFileSync(join(project, 'a.txt'), 'one\n');
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'init']);
  const service = createWorktreeService(store, { dataDir, enabled, now: () => '2026-11-27T12:00:00.000Z' });
  return { project, store, service };
}

test('未启用或非 git 项目不创建隔离工作树', t => {
  const disabled = fixture(t, { enabled: false });
  assert.equal(disabled.service.prepare({ projectPath: disabled.project, ticketId: 't-1' }), null);

  const plainDir = mkdtempSync(join(tmpdir(), 'lagent-worktree-plain-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lagent-worktree-plain-data-'));
  const store = new Store(dataDir);
  t.after(() => { store.close(); rmSync(plainDir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }); });
  const service = createWorktreeService(store, { dataDir, enabled: true });
  assert.equal(service.prepare({ projectPath: plainDir, ticketId: 't-1' }), null);
});

test('隔离工作树带走用户已有改动，只把运行新增的文件算作本次改动', t => {
  const { project, service } = fixture(t);
  writeFileSync(join(project, 'a.txt'), 'user-edit\n'); // 执行前用户自己的改动
  const row = service.prepare({ projectPath: project, ticketId: 't-1', threadId: 'th-1' });
  assert.ok(row);
  assert.match(row.branch, /^lagent\//);
  assert.equal(readFileSync(join(row.path, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'user-edit\n', '工作树里看得到用户未提交的改动');
  assert.deepEqual(Object.keys(row.baseline), ['a.txt'], '用户已有改动记入基线');

  writeFileSync(join(row.path, 'a.txt'), 'agent-edit\n');
  writeFileSync(join(row.path, 'b.txt'), 'agent-new\n');
  assert.deepEqual(service.changedSince(row.id).sort(), ['a.txt', 'b.txt'], '基线之外的变化才归到本次运行');

  const committed = service.commit(row.id, 'lagent: 测试提交');
  assert.equal(committed.status, 'committed');
  const log = git(project, ['log', '--oneline', row.branch]);
  assert.match(log, /lagent: 测试提交/);

  service.release(row.id);
  assert.equal(existsSync(row.path), false, '目录已清理');
  assert.match(git(project, ['branch', '--list', row.branch]), new RegExp(row.branch.replace('/', '\\/')), '分支保留供人工合并');
});

test('同一工单重复准备会复用已有工作树', t => {
  const { project, service } = fixture(t);
  writeFileSync(join(project, 'a.txt'), 'dirty\n');
  const first = service.prepare({ projectPath: project, ticketId: 't-9' });
  const again = service.prepare({ projectPath: project, ticketId: 't-9' });
  assert.equal(again.id, first.id);
  assert.equal(service.list({ projectPath: project }).length, 1);
});
