import test from 'node:test';
import assert from 'node:assert/strict';
import { runEval } from './runner.js';
import { scriptedExecutor } from './tasks.js';

test('内置 eval 30 条任务全部通过，覆盖写入/计划/验收/越界拒绝与轨迹', async () => {
  const { results, summary } = await runEval();
  assert.equal(summary.total, 30);
  assert.equal(summary.failed, 0, JSON.stringify(results, null, 2));
  assert.equal(summary.passRate, 1);
  assert.deepEqual(results.slice(0, 5).map(result => result.id), ['create-file', 'plan-two-steps', 'verify-pass', 'verify-fail', 'reject-escape']);
  assert.ok(results.every(result => result.durationMs >= 0));
  assert.ok(results.every(result => Array.isArray(result.trajectory) && result.trajectory.length >= 1));
  const parallel = results.find(result => result.id === 'plan-parallel');
  assert.deepEqual(parallel.trajectory.map(step => step.status), ['completed', 'completed', 'completed']);
  const blocked = results.find(result => result.id === 'verify-blocked');
  assert.equal(blocked.status, 'blocked');
});

test('脚本执行器拒绝绝对路径与 .. 越界写入', async () => {
  const executor = scriptedExecutor({ workspace: process.cwd() });
  const failed = executor.start({ command: 'x' }, { id: 'a1' }, { actions: [{ write: { path: '../escape.txt', content: 'x' } }], workspace: process.cwd() });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /越界/);
  const absolute = executor.start({ command: 'x' }, { id: 'a2' }, { actions: [{ write: { path: 'C:/tmp/x.txt', content: 'x' } }], workspace: process.cwd() });
  assert.equal(absolute.status, 'failed');
});
