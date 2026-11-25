import test from 'node:test';
import assert from 'node:assert/strict';

const model = await import('./mobile-chat-model.ts');

test('会话按今天/昨天/更早分组，组内按更新时间倒序', () => {
  const now = new Date('2026-11-25T12:00:00.000Z');
  const groups = model.groupConversations([
    { id: 'a', updatedAt: '2026-11-25T10:00:00.000Z' },
    { id: 'b', updatedAt: '2026-11-24T10:00:00.000Z' },
    { id: 'c', updatedAt: '2026-11-01T10:00:00.000Z' }
  ], now);
  assert.deepEqual(groups.map(group => group.label), ['今天', '昨天', '更早']);
  assert.deepEqual(groups[0].items.map(item => item.id), ['a']);
});

test('活动合并去重并过滤 result，最多保留 200 条', () => {
  const merged = model.mergeActivity(
    [{ kind: 'thought', text: 'a', at: 't1' }],
    [{ kind: 'thought', text: 'a', at: 't1' }, { kind: 'result', text: 'r' }, { kind: 'tool', text: 'ls', at: 't2' }]
  );
  assert.deepEqual(merged.map(step => step.text), ['a', 'ls']);
  const many = Array.from({ length: 250 }, (_, index) => ({ kind: 'thought', text: String(index) }));
  assert.equal(model.mergeActivity([], many).length, 200);
  assert.equal(model.mergeActivity([], many)[0].text, '50');
});

test('设置白名单丢弃 permission/model，强度映射只保留已选 Agent', () => {
  assert.deepEqual(model.sanitizeSettings({ profileId: 'p1', effort: 'high', permission: 'full', model: 'x' }), { profileId: 'p1', effort: 'high' });
  assert.deepEqual(model.sanitizeEfforts(['model', 'codex'], { model: 'high', codex: 'low', terminal: 'max' }), { model: 'high', codex: 'low' });
  assert.deepEqual(model.removeEffort({ model: 'high', codex: 'low' }, 'codex'), { model: 'high' });
  assert.deepEqual(model.setEffort({ model: 'high' }, 'codex', 'max'), { model: 'high', codex: 'max' });
});

test('分页游标只返回更早轮次', () => {
  const turns = Array.from({ length: 40 }, (_, index) => ({ index }));
  const first = model.visibleTurns(turns, { limit: 30 });
  assert.equal(first.turns[0].index, 10);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextBefore, 10);
  const second = model.visibleTurns(turns, { limit: 30, before: first.nextBefore });
  assert.equal(second.turns.length, 10);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextBefore, null);
});

test('模型选项：Lagent 按能力过滤，协作方全档位', () => {
  assert.deepEqual(model.lagentEfforts({ efforts: ['low', 'high', 'bogus'] }), ['default', 'low', 'high']);
  assert.deepEqual(model.collaboratorEfforts(), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('助手结论优先合成工单，思考分组按 Agent 合并实时步骤', () => {
  const turn = {
    id: 'turn-1', index: 0, prompt: 'x', mode: 'multi', createdAt: '',
    agentIds: ['model', 'codex'],
    runs: [{ ticketId: 't1', agentId: 'codex', role: 'answer' }],
    synthesisTicketId: 't2'
  };
  const report = model.assistantReport(turn, {
    t1: { reports: [{ id: 'r1', text: '执行结论' }] },
    t2: { reports: [{ id: 'r2', text: '汇总结论' }] }
  });
  assert.equal(report.id, 'r2');
  const groups = model.thinkingGroups(turn, {
    t1: { ticket: { id: 't1', status: 'working' }, activity: [{ kind: 'thought', text: 'a' }], reports: [] }
  }, { t1: [{ kind: 'tool', text: 'ls' }] }, { codex: 'Codex' });
  assert.deepEqual(groups.map(group => group.name), ['Codex']);
  assert.deepEqual(groups[0].steps.map(step => step.text), ['a', 'ls']);
});
