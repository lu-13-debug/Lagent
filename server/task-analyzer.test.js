import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeTask } from './work/task-analyzer.js';

test('任务理解：游戏需求会先调研、再写代码，写文件的步骤带目录范围', () => {
  const analysis = analyzeTask({
    goal: '参考同类的像素游戏，做一个能跑能跳的关卡',
    executors: ['github', 'claude-code', 'codex'],
    project: { name: 'demo', path: 'D:\\demo' }
  });
  assert.equal(analysis.category, 'game');
  assert.equal(analysis.steps[0].executorId, 'github');
  const writes = analysis.steps.filter(step => step.scope.length);
  assert.equal(writes.length, 1, '只允许一个步骤写文件');
  assert.deepEqual(writes[0].scope, ['src/**']);
  assert.equal(analysis.conflicts.length, 0);
  assert.match(analysis.understanding[0], /我理解的目标/);
  assert.ok(analysis.steps.some(step => step.executorId === 'claude-code'));
});

test('任务理解：前后端分属不同目录时拆成两个可并行的写步骤', () => {
  const analysis = analyzeTask({
    goal: '实现一个新的接口，并同步调整前端页面和样式',
    executors: ['claude-code', 'codex'],
    project: { name: 'demo', path: 'D:\\demo' }
  });
  const writes = analysis.steps.filter(step => step.scope.length);
  assert.equal(writes.length, 2, '前端和后端各一个写步骤');
  assert.deepEqual(writes.map(step => step.scope[0]).sort(), ['server/**', 'src/**']);
  assert.equal(analysis.conflicts.length, 0, '目录不重叠，不算冲突');
  assert.equal(new Set(writes.map(step => step.executorId)).size, 2, '两个写步骤分给不同 Agent');
  assert.ok(writes.every(step => step.dependsOn.length === 0), '目录不重叠时可以并行');
});

test('任务理解：同一目录的两次写入会被判为冲突', () => {
  const analysis = analyzeTask({
    goal: '实现界面，并再实现一个界面组件',
    executors: ['claude-code', 'codex'],
    project: { name: 'demo', path: 'D:\\demo' }
  });
  const writes = analysis.steps.filter(step => step.scope.length);
  assert.equal(writes.length, 1, '同一类任务仍然只安排一个写步骤，避免自己和自己撞车');
  assert.equal(analysis.conflicts.length, 0);
});

test('任务理解：数据任务会先算数，再结论', () => {
  const analysis = analyzeTask({ goal: '分析最近 30 天的留存和付费情况', executors: ['analysis', 'claude-code'], hasDataset: true });
  assert.equal(analysis.category, 'data');
  assert.equal(analysis.steps[0].executorId, 'analysis');
  assert.ok(analysis.needs.some(item => item.id === 'analysis'));
  assert.ok(analysis.understanding.some(line => line.includes('数据分析引擎')));
});

test('任务理解：没有可用工具时也能给出一步兜底方案', () => {
  const analysis = analyzeTask({ goal: '整理一份说明', executors: [] });
  assert.equal(analysis.steps.length, 1);
  assert.equal(analysis.steps[0].executorId, 'analysis');
  assert.deepEqual(analysis.steps[0].scope, []);
});

test('任务理解：没有绑定工作文件夹时只出结论，不声明写权限', () => {
  const analysis = analyzeTask({ goal: '实现一个新的设置页', executors: ['claude-code'] });
  assert.ok(analysis.steps.every(step => step.scope.length === 0));
  assert.ok(analysis.steps.every(step => step.readOnly === true));
  assert.match(analysis.understanding[1], /没有绑定工作文件夹/);
});

test('任务理解：绑定了工作文件夹时把目录写进理解里', () => {
  const analysis = analyzeTask({ goal: '补上缺失的单测', executors: ['claude-code'], project: { name: 'demo-app', path: 'D:\\demo-app' } });
  assert.equal(analysis.category, 'general');
  assert.match(analysis.understanding[1], /demo-app/);
  assert.equal(analysis.project.name, 'demo-app');
});

test('任务理解：顺序固定为调研 → 写文件 → 验证，验证要等所有写步骤', () => {
  const analysis = analyzeTask({
    goal: '参考开源项目实现统计接口，并同步改前端页面，最后补上单测',
    executors: ['github', 'claude-code', 'codex'],
    project: { name: 'demo', path: 'D:\\demo' }
  });
  const kinds = analysis.steps.map(step => step.kind);
  assert.deepEqual(kinds, ['research', 'write', 'write', 'verify']);
  const verify = analysis.steps[3];
  assert.deepEqual(verify.dependsOn, [1, 2], '验证步骤要等两个写步骤都完成');
  assert.ok(analysis.steps[1].dependsOn.includes(0), '写步骤要吃调研结论');
  assert.equal(analysis.steps[1].dependsOn.includes(2), false, '两个写步骤之间不互相依赖');
});

test('任务理解：验证步骤尽量不交给写代码的那个执行器', () => {
  const analysis = analyzeTask({
    goal: '实现一个新的统计接口，并补上单测',
    executors: ['dsh', 'claude-code', 'codex'],
    project: { name: 'demo', path: 'D:\\demo' }
  });
  const write = analysis.steps.find(step => step.kind === 'write');
  const verify = analysis.steps.find(step => step.kind === 'verify');
  assert.ok(write);
  assert.ok(verify);
  assert.notEqual(verify.executorId, write.executorId);
});

// 真实踩过的坑：项目里是 js/ + index.html + styles.css，任务理解器却按关键词
// 猜成 src/**，两个写步骤都去改不存在的目录，还互相判成冲突。
test('任务理解：按项目真实目录分工，界面和逻辑不会互相覆盖', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-shape-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'js'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'js', 'game.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(root, 'index.html'), '<canvas></canvas>\n');
  fs.writeFileSync(path.join(root, 'styles.css'), 'body{}\n');
  fs.writeFileSync(path.join(root, 'docs', 'DESIGN.md'), '# 设计\n');

  const analysis = analyzeTask({
    goal: '在现有基础上优化这个游戏，调整界面配色，并更新说明文档',
    executors: ['claude-code', 'codex'],
    project: { name: 'game', path: root }
  });

  const writes = analysis.steps.filter(step => step.kind === 'write');
  const scopes = writes.flatMap(step => step.scope);
  assert.ok(scopes.includes('js/**'), `应该识别出 js/：${scopes.join('、')}`);
  assert.ok(scopes.includes('index.html'), `应该识别出 index.html：${scopes.join('、')}`);
  assert.ok(scopes.includes('styles.css'), `应该识别出 styles.css：${scopes.join('、')}`);
  assert.equal(scopes.includes('src/**'), false, '不该再凭空猜 src/**');
  assert.equal(analysis.conflicts.length, 0, '三组文件互不重叠');
  assert.ok(analysis.understanding.some(line => line.includes('js/')), '理解里要写清项目现状');
});

