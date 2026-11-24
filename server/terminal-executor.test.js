import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { terminalExecutor, validateTerminalInput } from './work/executors/terminal.js';

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.pid = 12345; this.killed = false; }
  kill() { this.killed = true; this.emit('close', null, 'SIGTERM'); }
}

test('terminal 只接受受控程序、相对路径和无 shell 元字符', () => {
  assert.deepEqual(validateTerminalInput({ program: 'git', args: ['status', '--short'] }), { program: 'git', args: ['status', '--short'] });
  assert.deepEqual(validateTerminalInput({ program: 'ls', args: ['-la', 'src'] }), { program: 'ls', args: ['-la', 'src'] });
  // 项目在子目录里时要用 -C 进去，否则仓库在当前目录之上就永远只能拿到「不是 git 仓库」。
  assert.deepEqual(
    validateTerminalInput({ program: 'git', args: ['-C', 'projects/demo', 'log', '--oneline', '-3'] }),
    { program: 'git', args: ['-C', 'projects/demo', 'log', '--oneline', '-3'] }
  );
  for (const input of [
    { program: 'rm', args: [] },
    { program: 'ls', args: ['..'] },
    { program: 'ls', args: ['C:\\Windows'] },
    { program: 'git', args: ['status;rm'] },
    { program: 'git', args: ['status', '|', 'cat'] },
    // -C 不能跳出工作区，也不能借它夹带第二个子命令。
    { program: 'git', args: ['-C', '..', 'log'] },
    { program: 'git', args: ['-C', 'C:\\Windows', 'log'] },
    { program: 'git', args: ['-C'] },
    { program: 'git', args: ['-C', 'a', '-C', 'b', 'log'] },
    { program: 'git', args: ['-C', 'a', 'push'] },
    { program: 'pwd', args: ['x'] },
    { program: 'npm', args: ['test'] },
  ]) assert.throws(() => validateTerminalInput(input));
});

test('terminal 成功执行并写脱敏产物', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-terminal-'));
  const store = new Store(dir);
  let child;
  const executor = terminalExecutor({ store, cwd: dir, spawnImpl: () => (child = new FakeChild()) });
  t.after(() => { executor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = executor.start({ command: 'git status' }, { id: 'assignment-1' }, { executorInput: { program: 'git', args: ['status'] } });
  child.stdout.emit('data', Buffer.from('clean'));
  child.emit('close', 0, null);
  const saved = store.get('task', task.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.artifacts.terminal.stdout, 'clean');
  assert.equal(saved.artifacts.terminal.exitCode, 0);
  assert.equal(executor.get(task.id).status, 'completed');
});

test('terminal 超时和停止都不会覆盖最终状态', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-terminal-timeout-'));
  const store = new Store(dir);
  const children = [];
  const executor = terminalExecutor({ store, cwd: dir, timeoutMs: 5, spawnImpl: () => { const child = new FakeChild(); children.push(child); return child; } });
  t.after(() => { executor.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const task = executor.start({ command: 'pwd' }, { id: 'assignment-2' }, { executorInput: { program: 'pwd', args: [] } });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(store.get('task', task.id).status, 'failed');
  assert.equal(store.get('task', task.id).artifacts.terminal.timedOut, true);
  assert.equal(children[0].killed, true);
});
