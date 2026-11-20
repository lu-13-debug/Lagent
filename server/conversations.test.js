import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationStatus, createConversationService } from './work/conversations.js';

// 会话是用户可见的唯一对话容器，不依赖 SQLite，先用内存表把契约钉住。
function fakeDb() {
  const rows = new Map();
  const key = (kind, id) => `${kind}:${id}`;
  return {
    get: (kind, id) => rows.get(key(kind, id)) || null,
    put: (kind, row) => { rows.set(key(kind, row.id), JSON.parse(JSON.stringify(row))); return row; },
    delete: (kind, id) => rows.delete(key(kind, id)),
    list: kind => [...rows.entries()].filter(([name]) => name.startsWith(`${kind}:`)).map(([, row]) => row)
  };
}

test('会话状态按内部 run 聚合，等待确认优先于完成', () => {
  assert.equal(conversationStatus([]), 'waiting');
  assert.equal(conversationStatus(['completed', 'working']), 'working');
  assert.equal(conversationStatus(['completed', 'awaiting_review']), 'awaiting_review');
  assert.equal(conversationStatus(['completed', 'completed']), 'completed');
  assert.equal(conversationStatus(['completed', 'failed']), 'failed');
  assert.equal(conversationStatus(['cancelled', 'cancelled']), 'cancelled');
});

test('创建会话、追加轮次、汇总与工单归集', () => {
  const service = createConversationService(fakeDb(), { now: () => '2026-11-19T00:00:00.000Z' });
  const created = service.create({ goal: '审查鉴权逻辑\n并给出修复建议', agentIds: ['claude-code', 'codex'] });
  assert.equal(created.host, 'lagent');
  assert.equal(created.title, '审查鉴权逻辑');
  // Lagent 是隐式主控：选择外部 Agent 时也必须留在参与者里。
  assert.deepEqual(created.participants, ['model', 'claude-code', 'codex']);
  assert.deepEqual(created.turns, []);

  const first = service.addTurn(created.id, {
    id: 'turn-1',
    prompt: '审查鉴权逻辑',
    mode: 'review',
    agentIds: ['claude-code', 'codex'],
    runs: [
      { ticketId: 'ticket-a', agentId: 'claude-code', role: 'answer' },
      { ticketId: 'ticket-b', agentId: 'codex', role: 'answer' }
    ]
  });
  assert.equal(first.turn.index, 0);
  assert.deepEqual(service.get(created.id).ticketIds, ['ticket-a', 'ticket-b']);

  // 追问只追加一轮，不新建会话，参与 Agent 取并集。
  const second = service.addTurn(created.id, {
    id: 'turn-2',
    prompt: '再看下会话固定',
    mode: 'auto',
    agentIds: ['model'],
    runs: [{ ticketId: 'ticket-c', agentId: 'model', role: 'answer' }]
  });
  assert.equal(second.turn.index, 1);
  const loaded = service.get(created.id);
  assert.equal(loaded.turns.length, 2);
  assert.deepEqual(loaded.participants, ['model', 'claude-code', 'codex']);
  assert.deepEqual(loaded.ticketIds, ['ticket-a', 'ticket-b', 'ticket-c']);
  assert.equal(loaded.updatedAt, '2026-11-19T00:00:00.000Z');

  const withSynthesis = service.setSynthesis(created.id, 'turn-1', { ticketId: 'ticket-synth', agentId: 'model' });
  assert.equal(withSynthesis.turns[0].synthesisTicketId, 'ticket-synth');
  assert.equal(withSynthesis.turns[0].synthesisAgentId, 'model');
  assert.deepEqual(withSynthesis.ticketIds, ['ticket-a', 'ticket-b', 'ticket-synth', 'ticket-c']);

  const renamed = service.rename(created.id, { title: '鉴权复核' });
  assert.equal(renamed.title, '鉴权复核');

  const removed = service.remove(created.id);
  assert.deepEqual(removed.ticketIds, ['ticket-a', 'ticket-b', 'ticket-synth', 'ticket-c']);
  assert.throws(() => service.get(created.id), { status: 404 });
});

test('同一 id 重复创建是幂等的，重复上报不会多开对话', () => {
  const service = createConversationService(fakeDb());
  const first = service.create({ id: 'conv-import-1', goal: '旧的交叉验证', agentIds: ['claude-code'] });
  const again = service.create({ id: 'conv-import-1', goal: '不该覆盖', agentIds: ['codex'] });
  assert.equal(again.id, first.id);
  assert.equal(again.goal, '旧的交叉验证');
  assert.deepEqual(again.participants, ['model', 'claude-code']);
});

test('会话入参做长度与格式校验，空轮次直接拒绝', () => {
  const service = createConversationService(fakeDb());
  const created = service.create({ goal: '做一个导出按钮' });
  assert.throws(() => service.addTurn(created.id, { prompt: '   ', runs: [{ ticketId: 'ticket-a' }] }), { status: 400 });
  assert.throws(() => service.addTurn(created.id, { prompt: '没有 Agent', runs: [] }), { status: 400 });
  assert.throws(() => service.rename(created.id, { title: '   ' }), { status: 400 });
  assert.throws(() => service.get('../etc/passwd'), { status: 400 });
  assert.throws(() => service.create({ goal: 'x'.repeat(4001) }), { status: 400 });
});

test('工单归集只加会话字段，不动执行状态', () => {
  const service = createConversationService(fakeDb());
  const ticket = { id: 'ticket-a', status: 'completed', summary: '完成' };
  const linked = service.linkTicket(ticket, { conversationId: 'conv-1', turnId: 'turn-1', agentId: 'codex', role: 'synthesis' });
  assert.equal(linked.status, 'completed');
  assert.equal(linked.summary, '完成');
  assert.equal(linked.conversationId, 'conv-1');
  assert.equal(linked.turnId, 'turn-1');
  assert.equal(linked.agentId, 'codex');
  assert.equal(linked.role, 'synthesis');
  assert.equal(ticket.conversationId, undefined, '不修改原对象');
  // 缺参时不写脏字段。
  const untouched = service.linkTicket({ id: 'ticket-b' }, {});
  assert.deepEqual(Object.keys(untouched), ['id']);
});
