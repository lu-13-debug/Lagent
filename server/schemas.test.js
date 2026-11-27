import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RunStartBody, WorkflowSaveBody, CheckpointRestoreBody, ThreadQuery,
  ToolRegistryBody, parseBody, parseQuery
} from './work/schemas.js';

test('zod 契约：运行参数接受合法输入并剥离未知字段', () => {
  const body = parseBody(RunStartBody, { goal: '  检查发布  ', projectId: 'p1', extra: 'x' });
  assert.equal(body.goal, '检查发布');
  assert.equal(body.projectId, 'p1');
  assert.equal('extra' in body, false);

  assert.throws(() => parseBody(RunStartBody, { goal: '   ' }), error => error.status === 400 && /goal/.test(error.message));
  assert.throws(() => parseBody(RunStartBody, { goal: 'x'.repeat(4001) }), /goal/);
});

test('zod 契约：工作流只校验形状，2–5 步的业务规则留给服务', () => {
  const one = parseBody(WorkflowSaveBody, { name: 'w', goal: 'g', steps: [{ executorId: 'model', text: 'a' }] });
  assert.equal(one.steps.length, 1, '单步由服务报「2–5 步」，校验层不抢答');
  assert.throws(() => parseBody(WorkflowSaveBody, { name: 'w', goal: 'g', steps: [{ executorId: 'model' }] }), /文本|text/i);
  assert.throws(() => parseBody(WorkflowSaveBody, { name: '', goal: 'g', steps: [{ executorId: 'model', text: 'a' }] }), /name/);
  assert.throws(() => parseBody(WorkflowSaveBody, {
    name: 'w', goal: 'g',
    steps: Array.from({ length: 11 }, () => ({ executorId: 'model', text: 'a' }))
  }), /steps/);
});

test('zod 契约：回滚必须显式布尔 confirm，令牌与范围只接受约定值', () => {
  const body = parseBody(CheckpointRestoreBody, { scope: 'session', paths: ['a.txt'], token: 't', confirm: true });
  assert.equal(body.confirm, true);
  assert.throws(() => parseBody(CheckpointRestoreBody, { scope: 'everything' }), /scope/);
  assert.throws(() => parseBody(CheckpointRestoreBody, { confirm: 'true' }), /confirm/);
  assert.throws(() => parseBody(CheckpointRestoreBody, { paths: Array.from({ length: 501 }, (_, index) => `f${index}.txt`) }), /paths/);
});

test('zod 契约：查询参数做类型转换，非法值回落默认值', () => {
  assert.deepEqual(parseQuery(ThreadQuery, { after_seq: '42', limit: '10' }), { after_seq: 42, limit: 10 });
  assert.deepEqual(parseQuery(ThreadQuery, { after_seq: '-1', limit: 'abc' }, { after_seq: 0 }), { after_seq: 0 });
  assert.deepEqual(parseBody(ToolRegistryBody, { enabled: false, risk: 'high' }), { enabled: false, risk: 'high' });
  assert.throws(() => parseBody(ToolRegistryBody, { risk: 'critical' }), /risk/);
});
