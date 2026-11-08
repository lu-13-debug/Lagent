import test from 'node:test';
import assert from 'node:assert/strict';
import { Workflow, publicTask } from './workflow.js';

function fixture() {
  const task = { id: 't', status: 'awaiting_approval', currentStep: 0, goal: '目标', datasetId: 'd', workflowSnapshot: { version: 1, stages: {} }, steps: [{ id: 'plan', name: '计划', status: 'awaiting_approval' }, { id: 'report', name: '报告', status: 'pending' }], messages: [], events: [], _approved: [], artifacts: { plan: { summary: '计划', deliverable: { contract: { datasetVersion: 'v1' } } } } };
  let runs = 0;
  const workflow = new Workflow({ list: () => [], put: () => {} });
  workflow.schedule = () => { runs++; };
  return { task, workflow, runs: () => runs };
}

test('新版待确认任务公开内容快照，运行中不公开', () => {
  const { task } = fixture();
  assert.equal(publicTask(task).approvalSnapshot?.stepId, 'plan');
  task.status = 'running';
  assert.equal(publicTask(task).approvalSnapshot, undefined);
});

for (const [label, change] of [
  ['范围', task => { task.skippedSteps = ['retention']; }],
  ['背景', task => { task.messages.push({ role: 'user', content: '新增背景' }); }],
  ['产物', task => { task.artifacts.plan.summary = '修改计划'; }],
  ['契约', task => { task.analysisContract = { question: '新问题' }; }],
  ['数据版本', task => { task.derivedDatasetId = 'derived-v2'; }],
  ['阶段', task => { task.currentStep = 1; task.steps[1].status = 'awaiting_approval'; }],
]) test(`${label}变更后旧确认返回409且不执行`, () => {
  const { task, workflow, runs } = fixture();
  const snapshot = publicTask(task).approvalSnapshot;
  change(task);
  assert.throws(() => workflow.approve(task, undefined, 'plan', snapshot), error => error.status === 409);
  assert.equal(runs(), 0);
  assert.equal(task.status, 'awaiting_approval');
});

test('新版缺少快照拒绝，携带背景确认先校验旧快照，重复请求不批准下一阶段', () => {
  const { task, workflow, runs } = fixture();
  assert.throws(() => workflow.approve(task, undefined, 'plan'), error => error.status === 409);
  const snapshot = publicTask(task).approvalSnapshot;
  workflow.approve(task, '确认时补充背景', 'plan', snapshot);
  assert.equal(task.messages.length, 1);
  assert.equal(runs(), 1);
  task.currentStep = 1; task.status = 'awaiting_approval'; task.steps[1].status = 'awaiting_approval';
  workflow.approve(task, '确认时补充背景', 'plan', snapshot);
  assert.equal(runs(), 1);
  assert.equal(task.steps[1].status, 'awaiting_approval');
  assert.equal(task.messages.length, 1);
});

test('旧单模型确认仍兼容无快照客户端', () => {
  const { task, workflow, runs } = fixture();
  delete task.workflowSnapshot;
  workflow.approve(task, undefined, 'plan');
  assert.equal(runs(), 1);
});

test('错误阶段及伪造hash不改变状态，内容快照不依赖对象键顺序', () => {
  const { task, workflow, runs } = fixture();
  const snapshot = publicTask(task).approvalSnapshot;
  assert.throws(() => workflow.approve(task, undefined, 'report', snapshot), error => error.status === 409);
  assert.throws(() => workflow.approve(task, undefined, 'plan', { ...snapshot, hash: 'forged' }), error => error.status === 409);
  task.artifacts.plan = { deliverable: task.artifacts.plan.deliverable, summary: task.artifacts.plan.summary };
  assert.deepEqual(publicTask(task).approvalSnapshot, snapshot);
  assert.equal(runs(), 0);
});
