import test from 'node:test';
import assert from 'node:assert/strict';
import { isKeyChange, normalizePrompts, refineLocal } from './work/prompt-refiner.js';

test('提示词改写：本地兜底给三份侧重点不同的任务书，都保留原目标', () => {
  const prompts = refineLocal({
    goal: '给播放器加一个音量记忆功能',
    agents: ['claude-code', 'codex'],
    memory: '播放器已经有 play() 与 pause()。',
  });
  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts.map(item => item.id), ['constraints', 'steps', 'acceptance']);
  for (const item of prompts) {
    assert.ok(item.label, '每版都要有名字');
    assert.ok(item.focus, '每版说明侧重点');
    assert.match(item.prompt, /给播放器加一个音量记忆功能/, '原目标不能被改写掉');
    assert.match(item.prompt, /claude-code/, '要写清执行者');
  }
  // 侧重点确实不同：约束版讲边界，步骤版讲顺序，验收版讲完成标准。
  assert.match(prompts[0].prompt, /不要改动与本任务无关的文件/);
  assert.match(prompts[1].prompt, /先摸清现状/);
  assert.match(prompts[2].prompt, /验收标准/);
  assert.match(prompts[0].prompt, /播放器已经有 play\(\) 与 pause\(\)/, '项目记忆要带进任务书');
});

test('提示词改写：目标是空的就不生成版本', () => {
  assert.deepEqual(refineLocal({ goal: '   ' }), []);
});

test('提示词改写：模型给的三版被规范化，只给一版就回退本地模板', () => {
  const model = normalizePrompts(
    [
      { id: 'a', label: '版本 A', focus: '更保守', prompt: '目标：给播放器加音量记忆。只改 player.js。' },
      { label: '版本 B', prompt: '目标：给播放器加音量记忆。分三步做。' },
      { prompt: '' },
    ],
    { goal: '给播放器加音量记忆', agents: ['claude-code'] },
  );
  assert.equal(model.length, 2, '空的那版要丢掉');
  assert.equal(model[0].id, 'a');
  assert.equal(model[1].id, 'v2', '缺 id 的补一个稳定 id');

  const fallback = normalizePrompts([{ prompt: '只有一版' }], { goal: '给播放器加音量记忆', agents: ['claude-code'] });
  assert.equal(fallback.length, 3, '不足两版就用本地模板');
  assert.equal(fallback[0].id, 'constraints');
});

test('关键改动：有文件变化才算改动，闲聊与报错不算', () => {
  assert.equal(isKeyChange({ summary: '随便聊聊', files: ['src/a.js'], status: 'completed' }), true);
  assert.equal(isKeyChange({ summary: '决定改用 IndexedDB 存进度', files: [], status: 'completed' }), true);
  assert.equal(isKeyChange({ summary: '完成：新增 index.html 与 player.js', files: [], status: 'completed' }), true);
  assert.equal(isKeyChange({ summary: '缺少样式文件，建议先补 styles.css', files: [], status: 'failed' }), true);
  assert.equal(isKeyChange({ summary: '模型接口返回 HTTP 500。', files: [], status: 'failed' }), false);
  assert.equal(isKeyChange({ summary: '好的', files: [], status: 'completed' }), false);
  assert.equal(isKeyChange({ summary: '', files: [], status: 'completed' }), false);
});