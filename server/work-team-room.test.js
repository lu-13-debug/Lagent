import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';

function executor(id, name) {
  return {
    id, name, kind: 'cli', available: true, requiresDataset: false, capabilities: [],
    defaultInput: text => ({ prompt: text }), validateInput: input => input,
    start(ticket, assignment) {
      return { id: assignment.id, status: 'completed', report: { summary: `${name} 完成了 ${ticket.title}`, files: [`${id}.md`] }, artifacts: {} };
    },
    get: () => null
  };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-team-room-'));
  const store = new Store(join(dir, 'data'));
  const engine = createWorkEngine(store, createExecutorRegistry([executor('codex', 'Codex'), executor('claude-code', 'Claude Code')]), () => {}, {
    workspace: dir,
    policy: { allowedExecutors: ['codex', 'claude-code'], requireApproval: false, budgets: { maxConcurrent: 4, maxCallsPerTicket: 12, maxRuntimeMs: 3600000, maxTokensPerTicket: 100000 } },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' }
  });
  const project = engine.importProject({ path: dir, name: '协作项目' }).project;
  t.after(() => { engine.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, engine, project };
}

function planFixture(f, { autoRun = false } = {}) {
  return f.engine.plan({
    goal: '完成协作功能',
    projectId: f.project.id,
    autoRun,
    steps: [
      { executorId: 'codex', text: '写后端接口' },
      { executorId: 'claude-code', text: '写前端界面', dependsOn: [0] }
    ]
  });
}

test('团队房间从计划聚合步骤、成员与当前状态', t => {
  const f = fixture(t);
  const plan = planFixture(f);
  const room = f.engine.createTeamRoom({ planId: plan.id, title: '协作房间' });
  assert.equal(room.title, '协作房间');
  assert.equal(room.planId, plan.id);
  assert.equal(room.projectId, f.project.id);
  assert.equal(room.goal, '完成协作功能');
  assert.deepEqual(room.members.sort(), ['claude-code', 'codex']);
  assert.equal(room.lead, 'codex');
  assert.equal(room.steps.length, 2);
  assert.deepEqual(room.steps.map(step => step.executorId), ['codex', 'claude-code']);
  assert.deepEqual(room.steps.map(step => step.status), ['awaiting_review', 'waiting']);
  assert.equal(room.counts.awaiting_review, 1);
  assert.equal(room.counts.waiting, 1);
  // 未执行的工单也会出现在消息流里，房间打开就能看到每一步的状态。
  assert.equal(room.messages.filter(item => item.kind === 'status').length, 2);
  assert.match(room.messages.find(item => item.kind === 'status').text, /写后端接口/);
});

test('团队房间消息、认领与决定持久化', t => {
  const f = fixture(t);
  const plan = planFixture(f);
  const room = f.engine.createTeamRoom({ planId: plan.id });
  const ticketId = plan.steps[0].ticketId;

  const posted = f.engine.postTeamRoomMessage(room.id, { agent: 'codex', text: '接口已经写完了' });
  assert.equal(posted.message.kind, 'chat');
  assert.equal(posted.message.agent, 'codex');
  assert.ok(posted.room.messages.some(item => item.id === posted.message.id && item.text === '接口已经写完了'));
  assert.throws(() => f.engine.postTeamRoomMessage(room.id, { text: '   ' }), { status: 400 });

  assert.throws(() => f.engine.claimTeamRoomTicket(room.id, { member: 'codex', ticketId: 'not-in-plan' }), { status: 404 });
  const claimed = f.engine.claimTeamRoomTicket(room.id, { member: 'codex', ticketId });
  assert.equal(claimed.claims[ticketId], 'codex');
  assert.equal(claimed.steps.find(step => step.ticketId === ticketId).claimedBy, 'codex');

  const decided = f.engine.decideTeamRoom(room.id, { by: 'lead', ticketId, decision: '按当前方案继续' });
  assert.equal(decided.decision.by, 'lead');
  assert.equal(decided.room.decisions.length, 1);
  assert.equal(decided.room.decisions[0].decision, '按当前方案继续');

  const reloaded = f.engine.getTeamRoom(room.id);
  assert.equal(reloaded.claims[ticketId], 'codex');
  assert.equal(reloaded.messages.filter(item => item.id === posted.message.id).length, 1);
  assert.equal(reloaded.decisions.length, 1);
});

test('团队房间跟随计划状态并汇总报告产物', async t => {
  const f = fixture(t);
  const plan = planFixture(f, { autoRun: true });
  const deadline = Date.now() + 5000;
  let detail;
  while (Date.now() < deadline) {
    detail = f.engine.getPlan(plan.id);
    if (detail.steps.every(step => step.status === 'completed')) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(detail.steps.every(step => step.status === 'completed'), JSON.stringify(detail.steps.map(step => step.status)));
  const room = f.engine.createTeamRoom({ planId: plan.id });
  assert.deepEqual(room.steps.map(step => step.status), detail.steps.map(step => step.status));
  assert.equal(room.messages.filter(item => item.kind === 'report').length, 2);
  assert.ok(room.messages.filter(item => item.kind === 'report').every(item => item.text));
  assert.ok(room.artifacts.length >= 1);
  assert.ok(room.artifacts.every(item => item.files.length <= 20));
});

test('团队房间按项目过滤并可删除，非法参数被拒绝', t => {
  const f = fixture(t);
  const plan = planFixture(f);
  const room = f.engine.createTeamRoom({ planId: plan.id });
  const other = f.engine.createTeamRoom({ projectId: f.project.id, title: '第二个房间' });
  assert.equal(f.engine.listTeamRooms(f.project.id).length, 2);
  assert.equal(f.engine.listTeamRooms('missing-project').length, 0);
  assert.throws(() => f.engine.createTeamRoom({}), { status: 400 });
  assert.throws(() => f.engine.createTeamRoom({ planId: 'missing-plan' }), { status: 404 });
  assert.throws(() => f.engine.createTeamRoom({ projectId: 'missing-project' }), { status: 404 });
  assert.throws(() => f.engine.createTeamRoom({ planId: plan.id, title: 'x'.repeat(101) }), { status: 400 });

  assert.deepEqual(f.engine.deleteTeamRoom(other.id), { ok: true, id: other.id });
  assert.equal(f.engine.listTeamRooms(f.project.id).length, 1);
  assert.throws(() => f.engine.getTeamRoom(other.id), { status: 404 });
});
