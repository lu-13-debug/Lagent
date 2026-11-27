import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createCheckpointService, parseStatus, safeRelativePath } from './work/checkpoints.js';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function repoFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-data-'));
  const store = new Store(dataDir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'b.txt'), 'keep\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  const service = createCheckpointService(store, { dataDir, now: () => '2026-11-27T10:00:00.000Z' });
  return { dir, store, service };
}

test('safeRelativePath 拒绝绝对路径与越界', () => {
  assert.equal(safeRelativePath('src/app.js'), 'src/app.js');
  assert.equal(safeRelativePath('src\\app.js'), 'src/app.js');
  assert.equal(safeRelativePath('../secret.txt'), '');
  assert.equal(safeRelativePath('/etc/passwd'), '');
  assert.equal(safeRelativePath('C:/Windows/win.ini'), '');
  assert.equal(safeRelativePath(''), '');
});

test('parseStatus 识别重命名与未跟踪文件', () => {
  const rows = parseStatus(' M a.txt\n?? new file.txt\nR  old.txt -> moved.txt\n');
  assert.deepEqual(rows.map(row => [row.path, row.state]), [
    ['a.txt', 'modified'],
    ['new file.txt', 'untracked'],
    ['old.txt', 'renamed-from'],
    ['moved.txt', 'renamed-to']
  ]);
});

test('单文件回滚：存档内容原样写回，令牌与二次确认缺一不可', t => {
  const { dir, service } = repoFixture(t);
  writeFileSync(join(dir, 'a.txt'), 'two\n'); // 用户在执行前已有的改动
  const checkpoint = service.capture({ projectPath: dir, threadId: 'th-1', ticketId: 't-1' });
  assert.ok(checkpoint);
  writeFileSync(join(dir, 'a.txt'), 'three\n'); // 执行后的改动

  const preview = service.preview({ checkpointId: checkpoint.id, scope: 'file', path: 'a.txt' });
  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].before, 'saved');
  assert.match(preview.files[0].diff, /-one/);
  assert.ok(preview.token);

  assert.throws(() => service.restore({ checkpointId: checkpoint.id, scope: 'file', path: 'a.txt', token: preview.token }), /二次确认/);
  assert.throws(() => service.restore({ checkpointId: checkpoint.id, scope: 'file', path: 'a.txt', token: 'bad', confirm: true }), /令牌不匹配/);

  const result = service.restore({ checkpointId: checkpoint.id, scope: 'file', path: 'a.txt', token: preview.token, confirm: true });
  assert.equal(result.counts.restored, 1);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'two\n', '回到执行前，而不是 HEAD');
});

test('工作区回滚：恢复改动文件、删掉新建文件、找回被删文件', t => {
  const { dir, service } = repoFixture(t);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  const checkpoint = service.capture({ projectPath: dir, threadId: 'th-1', ticketId: 't-1' });
  assert.ok(checkpoint);

  // 模拟一次运行：改 a、新建 c、删除 b
  writeFileSync(join(dir, 'a.txt'), 'three\n');
  writeFileSync(join(dir, 'c.txt'), 'new\n');
  rmSync(join(dir, 'b.txt'));

  const preview = service.preview({ checkpointId: checkpoint.id, scope: 'workspace', paths: ['c.txt', 'b.txt'] });
  assert.deepEqual(preview.files.map(file => file.path).sort(), ['a.txt', 'b.txt', 'c.txt']);
  assert.equal(preview.files.find(file => file.path === 'c.txt').before, 'head');

  const result = service.restore({
    checkpointId: checkpoint.id, scope: 'workspace', paths: ['c.txt', 'b.txt'], token: preview.token, confirm: true
  });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'two\n');
  assert.equal(existsSync(join(dir, 'c.txt')), false, '执行中新建的文件被删除');
  assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8').replace(/\r\n/g, '\n'), 'keep\n', '被删除的已跟踪文件找回');
  assert.equal(result.counts.restored, 1);
  assert.equal(result.counts.deleted, 1);
  assert.equal(result.counts.reverted, 1);
});

test('整条会话回滚：以最早的检查点为基线', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-session-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-session-data-'));
  const store = new Store(dataDir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'base\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  let clock = '2026-11-27T10:00:00.000Z';
  const service = createCheckpointService(store, { dataDir, now: () => clock });

  writeFileSync(join(dir, 'a.txt'), 'before-first\n');
  const first = service.capture({ projectPath: dir, threadId: 'th-2', ticketId: 't-1' });
  clock = '2026-11-27T10:05:00.000Z';
  writeFileSync(join(dir, 'a.txt'), 'between\n');
  service.capture({ projectPath: dir, threadId: 'th-2', ticketId: 't-2' });
  writeFileSync(join(dir, 'a.txt'), 'after-second\n');

  const preview = service.preview({ threadId: 'th-2', scope: 'session', paths: ['a.txt'] });
  assert.deepEqual(preview.checkpointIds, [first.id], '会话回滚只用最早那份基线');
  const result = service.restore({ threadId: 'th-2', scope: 'session', paths: ['a.txt'], token: preview.token, confirm: true });
  assert.equal(result.counts.restored, 1);
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'before-first\n');
});

test('非 git 目录与无改动时不留检查点', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-plain-'));
  const dataDir = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-plain-data-'));
  const store = new Store(dataDir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const service = createCheckpointService(store, { dataDir });
  assert.equal(service.capture({ projectPath: dir }), null, '非 git 目录直接跳过');

  const repo = mkdtempSync(join(tmpdir(), 'lagent-checkpoint-clean-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-m', 'init']);
  assert.equal(service.capture({ projectPath: repo }), null, '工作区干净时不留空检查点');
});
