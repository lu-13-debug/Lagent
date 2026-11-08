import test from 'node:test';
import assert from 'node:assert/strict';
import { taskSummary } from './task-monitor.js';
import { createTask } from './workflow.js';

test('task summaries keep every workflow step and optional skip reason', () => {
  const task = createTask({ title: '十分钟摘要', goal: '核对完整步骤', mode: 'collaborative', domain: 'game', datasetId: 'd1', useAI: false }, { id: 'd1', name: '数据集' });
  task.skippedSteps = ['channel', 'seasonality'];
  const summary = taskSummary(task);
  assert.equal(summary.steps.length, 10);
  assert.deepEqual(summary.steps.map(step => step.id), task.steps.map(step => step.id));
  assert.ok(summary.steps.some(step => step.id === 'channel'));
  assert.ok(summary.steps.some(step => step.id === 'seasonality'));
  assert.deepEqual(summary.skippedSteps, ['channel', 'seasonality']);
});
