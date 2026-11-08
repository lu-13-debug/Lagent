import test from 'node:test';
import assert from 'node:assert/strict';
import { recentTasks, taskStatusHint, prepareGoal } from './concise-workspace.ts';

test('近期任务按更新时间排序且不改变原数组', () => {
  const tasks = [{ id:'old', updatedAt:'2026-10-01' }, { id:'new', updatedAt:'2026-11-01' }];
  assert.deepEqual(recentTasks(tasks, 1).map(t=>t.id), ['new']);
  assert.equal(tasks[0].id, 'old');
});
test('真实状态保留失败、待确认和完成语义', () => {
  assert.match(taskStatusHint({status:'failed', error:'数据不足'}), /数据不足/);
  assert.match(taskStatusHint({status:'awaiting_approval'}), /确认/);
  assert.match(taskStatusHint({status:'running', steps:[{name:'校验',status:'running'}]}), /校验/);
  assert.match(taskStatusHint({status:'completed'}), /完成/);
  assert.match(taskStatusHint({status:'cancelled'}), /取消/);
  assert.match(taskStatusHint(), /暂无/);
});
test('目标仅清理首尾空白以预填现有向导', () => {
  assert.equal(prepareGoal('  分析留存\n趋势  '), '分析留存\n趋势');
  assert.equal(prepareGoal('   '), undefined);
});
