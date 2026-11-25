import test from 'node:test';
import assert from 'node:assert/strict';
import { lagentOnlySuggestion } from './agent-choice.ts';

test('一句话问题选了协作 Agent 时建议只用 Lagent', () => {
  const result = lagentOnlySuggestion({ text: '解释一下这个报错是什么原因', collaborators: ['claude-code'], mode: 'auto' });
  assert.equal(result.suggestLagentOnly, true);
  assert.match(result.reason, /更快/);
});

test('多 Agent 模式遇到一句话问题，仍可建议退回单 Agent', () => {
  assert.equal(lagentOnlySuggestion({ text: '解释一下这个报错是什么原因', collaborators: ['claude-code'], mode: 'multi' }).suggestLagentOnly, true);
});

test('没有协作 Agent 时不提示', () => {
  assert.equal(lagentOnlySuggestion({ text: '解释一下这个报错', collaborators: [], mode: 'auto' }).suggestLagentOnly, false);
});

test('多步骤、代码/文件信号或复核模式都不建议简化', () => {
  for (const [text, mode] of [
    ['先看测试，然后修复失败项', 'auto'],
    ['检查 src/app.ts 里的鉴权逻辑', 'auto'],
    ['运行 npm test 并总结结果', 'auto'],
    ['审查这段代码有没有漏洞', 'review'],
    ['这是一个很长的问题。它还有第二句。', 'auto']
  ]) {
    assert.equal(lagentOnlySuggestion({ text, collaborators: ['claude-code'], mode }).suggestLagentOnly, false, text);
  }
});

test('超过 120 字不提示，带数据集也不提示', () => {
  assert.equal(lagentOnlySuggestion({ text: '解释'.repeat(70), collaborators: ['codex'], mode: 'auto' }).suggestLagentOnly, false);
});
