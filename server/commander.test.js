import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';
import { codexExecutor } from './work/executors/codex.js';

function harness(t, { planner } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lagent-commander-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const store = new Store(join(home, 'store.sqlite'));
  const claude = claudeCodeExecutor({ store, cwd: root, binary: process.execPath });
  const codex = codexExecutor({ store, cwd: root, binary: process.execPath });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex'] },
    env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    home,
    planner
  });
  t.after(() => { engine.close(); store.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { engine, store, root };
}

test('指挥台：一句话目标被拆成多步、分给不同 Agent，并逐条落成待确认工单', async t => {
  const calls = [];
  const { engine } = harness(t, {
    planner: async input => {
      calls.push(input);
      return {
        steps: [
          { executorId: 'claude-code', text: '检查现有测试覆盖，列出缺口' },
          { executorId: 'codex', text: '按缺口补三个单测并跑通', dependsOn: [0] }
        ]
      };
    }
  });
  const result = await engine.commander({ goal: '补齐测试并写变更说明', executors: ['claude-code', 'codex'] });
  assert.equal(result.plan.steps.length, 2);
  assert.equal(result.plan.status, 'active');
  assert.deepEqual(result.plan.steps.map(step => step.executorId), ['claude-code', 'codex']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].goal, '补齐测试并写变更说明');
  const tickets = engine.bootstrap().tickets.filter(ticket => ticket.planId === result.plan.id);
  assert.equal(tickets.length, 2);
  const first = tickets.find(ticket => ticket.planStep === 0);
  const second = tickets.find(ticket => ticket.planStep === 1);
  assert.equal(first.status, 'awaiting_review');
  assert.equal(second.status, 'waiting');
  assert.equal(first.executor, 'claude-code');
  assert.equal(second.executor, 'codex');
});

test('指挥台：没配规划模型时明确报错，不生成半截计划', async t => {
  const { engine } = harness(t, { planner: undefined });
  await assert.rejects(() => engine.commander({ goal: '随便做点什么', executors: ['claude-code'] }), /规划模型/);
  assert.equal(engine.bootstrap().plans.length, 0);
});

test('指挥台：汇总按步骤拼出 Markdown，未完成的步骤单独列出', async t => {
  const { engine } = harness(t, {
    planner: async () => ({ steps: [{ executorId: 'claude-code', text: '第一步' }, { executorId: 'codex', text: '第二步' }] })
  });
  const { plan } = await engine.commander({ goal: '整理项目说明', executors: ['claude-code', 'codex'] });
  const report = engine.commanderReport(plan.id);
  assert.equal(report.total, 2);
  assert.equal(report.completed, 0);
  assert.match(report.markdown, /^# 指挥汇总：整理项目说明/);
  assert.match(report.markdown, /## 各步结果/);
  assert.match(report.markdown, /### 1\. 第一步/);
  assert.match(report.markdown, /- 执行：Claude Code CLI/);
  assert.match(report.markdown, /## 需要你处理/);
  assert.equal(report.rows.length, 2);
  assert.equal(report.rows[0].status, 'awaiting_review');
  assert.throws(() => engine.commanderReport('plan-missing'), /计划不存在/);
});

test('指挥台：绑定工作文件夹后，每一步都拿到该目录与写权限', async t => {
  const { engine, root, store } = harness(t, {
    planner: async input => {
      assert.equal(input.project?.path, root, '规划器应看到工作文件夹路径');
      return {
        steps: [
          { executorId: 'claude-code', text: '在这个目录里建 index.html 骨架' },
          { executorId: 'codex', text: '补充样式与交互', dependsOn: [0] }
        ]
      };
    }
  });
  const project = engine.importProject({ path: root, name: 'demo' }).project;
  const { plan } = await engine.commander({ goal: '做一个页面', projectId: project.id, executors: ['claude-code', 'codex'] });
  assert.equal(plan.projectId, project.id);
  const detail = engine.bootstrap().tickets.filter(ticket => ticket.planId === plan.id);
  assert.equal(detail.length, 2);
  for (const ticket of detail) {
    assert.ok(ticket.projectChatId, '每一步都应绑定项目会话');
    const stored = engine.detail(ticket.id);
    assert.equal(stored.project?.id, project.id);
    const control = store.get('work-control', ticket.id);
    assert.equal(control.executorInput.workspace, root, '每一步都应以工作文件夹为 cwd');
    assert.equal(control.executorInput.write, true, '每一步都应有写权限');
  }
  const chats = engine.getProject(project.id).chats;
  assert.deepEqual(chats.map(chat => chat.executorId).sort(), ['claude-code', 'codex']);
  await assert.rejects(() => engine.commander({ goal: 'x', projectId: 'missing-project', executors: ['claude-code'] }), /工作文件夹不存在/);
});
