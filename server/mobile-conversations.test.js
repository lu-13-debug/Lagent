import test from 'node:test';
import assert from 'node:assert/strict';
import { clipReportText, reportTextOfReport } from './work/report-text.js';
import { createConversationService } from './work/conversations.js';
import { agentEffort, normalizeEfforts } from './work/efforts.js';
import { mobileWorkEvent, sanitizeMobileBootstrap, sanitizeMobileDetail, sanitizeMobileEfforts, sanitizeMobileSettings } from './mobile-gateway.js';

test('报告正文按 acp → cli → window → report → summary 取值', () => {
  assert.equal(reportTextOfReport({ artifacts: { acp: { text: ' A ' }, cli: { summary: 'B' }, summary: 'S' } }), 'A');
  assert.equal(reportTextOfReport({ artifacts: { cli: { summary: 'B' } }, summary: 'S' }), 'B');
  assert.equal(reportTextOfReport({ artifacts: { window: { text: 'W' } } }), 'W');
  assert.equal(reportTextOfReport({ artifacts: { report: { summary: 'R' } }, summary: 'S' }), 'R');
  assert.equal(reportTextOfReport({ summary: ' S ' }), 'S');
  assert.equal(reportTextOfReport(null), '');
});

test('正文截断返回 truncated 标记，未超出时原样返回', () => {
  assert.deepEqual(clipReportText('abc', 10), { text: 'abc', truncated: false });
  assert.deepEqual(clipReportText('abcdef', 3), { text: 'abc', truncated: true });
  assert.deepEqual(clipReportText(null, 3), { text: '', truncated: false });
});

function fakeDb() {
  const rows = new Map();
  return {
    get: (kind, id) => rows.get(`${kind}:${id}`) || null,
    put: (kind, row) => { rows.set(`${kind}:${row.id}`, JSON.parse(JSON.stringify(row))); return row; },
    delete: (kind, id) => rows.delete(`${kind}:${id}`),
    list: kind => [...rows].filter(([key]) => key.startsWith(`${kind}:`)).map(([, row]) => row)
  };
}

test('轮次保存 clientRequestId 但不对外投影，可按它查到已有轮次', () => {
  const service = createConversationService(fakeDb(), { now: () => '2026-11-25T00:00:00.000Z' });
  const created = service.create({ goal: '测试幂等' });
  const { turn } = service.addTurn(created.id, {
    prompt: '测试幂等',
    mode: 'auto',
    agentIds: ['model'],
    runs: [{ ticketId: 't-1', agentId: 'model', role: 'answer' }],
    clientRequestId: 'mobile-once'
  });
  assert.equal(turn.clientRequestId, 'mobile-once');
  assert.equal(service.get(created.id).turns[0].clientRequestId, undefined);
  assert.equal(service.turnByClientRequestId(created.id, 'mobile-once').id, turn.id);
  assert.equal(service.turnByClientRequestId(created.id, 'mobile-other'), null);
});

test('按 Agent 的强度：没有映射沿用全局，有映射缺失协作用 default', () => {
  assert.equal(agentEffort(null, 'model', 'high'), 'high');
  assert.equal(agentEffort({ model: 'max', codex: 'low' }, 'model', 'high'), 'max');
  assert.equal(agentEffort({ model: 'max' }, 'codex', 'default'), 'default');
  assert.equal(agentEffort({ model: 'bogus' }, 'model', 'high'), 'high');
  assert.deepEqual(normalizeEfforts({ model: 'high', codex: 'low', terminal: 'max' }, ['model', 'codex']), { model: 'high', codex: 'low' });
  assert.equal(normalizeEfforts(undefined, ['model']), null);
  assert.throws(() => normalizeEfforts({ model: 'nope' }, ['model']), /思考强度/);
});

test('移动设置只保留 profileId/effort，efforts 只保留本次 Agent 的键', () => {
  assert.deepEqual(sanitizeMobileSettings({ profileId: 'p1', effort: 'high', permission: 'full', model: 'x' }), { profileId: 'p1', effort: 'high' });
  assert.deepEqual(sanitizeMobileEfforts({ model: 'high', codex: 'low', terminal: 'max' }, ['model', 'codex']), { model: 'high', codex: 'low' });
  assert.throws(() => sanitizeMobileEfforts({ model: 'nope' }, ['model']), /思考强度/);
});

test('bootstrap 只下发白名单字段，详情带裁剪后的 activity 与报告正文', () => {
  const bootstrap = sanitizeMobileBootstrap({
    tickets: [], attention: [], agents: [], plans: [],
    projects: [{ id: 'p1', name: '仓库', path: 'C:/repo', gitBranch: 'main', apiKey: 'secret' }],
    conversations: [{ id: 'c1', title: '会话', status: 'working', turns: [{ prompt: 'x' }], secret: 's' }],
    lagent: { name: 'Lagent', executorId: 'model', ready: true, configured: true, reason: 'ok', token: 'secret' }
  });
  assert.deepEqual(bootstrap.projects, [{ id: 'p1', name: '仓库', path: 'C:/repo', gitBranch: 'main' }]);
  assert.equal(bootstrap.conversations[0].secret, undefined);
  assert.equal(bootstrap.lagent.token, undefined);

  const artifact = 'A'.repeat(20005);
  const detail = sanitizeMobileDetail({
    ticket: { id: 't1', status: 'working', secret: 's' },
    activity: [{ kind: 'thought', text: '思考', detail: '细节', secret: 's', decided: true }],
    reports: [{ id: 'r1', ticketId: 't1', summary: '摘要', artifacts: { acp: { text: artifact } } }]
  });
  assert.deepEqual(detail.activity, [{ kind: 'thought', text: '思考', detail: '细节', decided: true }]);
  assert.equal(detail.reports[0].text.length, 20000);
  assert.equal(detail.reports[0].truncated, true);
});

test('SSE 事件带裁剪后的 activity', () => {
  const event = mobileWorkEvent({ type: 'activity', ticketId: 't1', payload: { status: 'working', activity: [{ kind: 'tool', text: 'ls', secret: 's' }] } });
  assert.deepEqual(event.payload.activity, [{ kind: 'tool', text: 'ls' }]);
  assert.equal(event.payload.secret, undefined);
});
