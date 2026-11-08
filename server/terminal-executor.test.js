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
  for (const input of [
    { program: 'rm', args: [] },
    { program: 'ls', args: ['..'] },
    { program: 'ls', args: ['C:\\Windows'] },
    { program: 'git', args: ['status;rm'] },
    { program: 'git', args: ['status', '|', 'cat'] },
    { program: 'pwd', args: ['x'] },
    { program: 'npm', args: ['test'] },
  ]) assert.throws(() => validateTerminalInput(input));
});

test('terminal 成功执行并写脱敏产物', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-terminal-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-terminal-timeout-'));
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
