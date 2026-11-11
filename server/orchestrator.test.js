import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createOrchestrator } from './work/orchestrator/index.js';
import { detectTemplate, buildSteps, TEMPLATES } from './work/orchestrator/templates.js';
import { pickExecutor, matches, capabilitiesOf } from './work/orchestrator/capabilities.js';

function harness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lagent-orchestrator-'));
  const store = new Store(join(root, 'store.sqlite'));
  const events = [];
  let counter = 0;
  // 假执行器：只是把工单写成「已完成」，用来验证编排的顺序、路由与返工逻辑。
  const engine = {
    command(input) {
      const id = `ticket-${++counter}`;
      store.put('work-ticket', {
        id,
        title: (typeof input.title === 'string' && input.title.trim() ? input.title.trim() : input.text).slice(0, 100),
        text: input.text,
        status: 'awaiting_review',
        executor: input.executorId,
        ...(input.projectChatId ? { projectChatId: input.projectChatId } : {})
      });
      return { id, status: 'awaiting_review' };
    },
    action(id, action) {
      if (action !== 'approve') return { id };
      const ticket = store.get('work-ticket', id);
      const outcome = options.outcome || (() => 'completed');
      const status = outcome(ticket);
      store.put('work-ticket', { ...ticket, status });
      store.put('work-report', {
        id: `report-${id}`,
        ticketId: id,
        kind: status === 'completed' ? 'ready' : 'failed',
        // 每次失败的报告文字都不一样，模拟「返工后确实有变化」；需要模拟「毫无变化」时用 options.summary。
        summary: options.summary
          ? options.summary(ticket, status)
          : status === 'completed'
            ? `做完了：${ticket.title.slice(0, 20)}`
            : `命令退出码 1：测试失败（第 ${counter} 次）`
      });
      return { id, status };
    },
    getProject(id) {
      return { id, chats: [], ...(options.projectPath ? { path: options.projectPath } : {}) };
    },
    createProjectChat(projectId, input) {
      const chat = { id: `chat-${input.executorId}${input.writable ? '-write' : ''}`, executorId: input.executorId, projectId, ...(input.parentChatId ? { parentChatId: input.parentChatId } : {}), writable: input.writable === true };
      store.put('work-project-chat', chat);
      return { chat };
    }
  };
  const orchestrator = createOrchestrator({
    engine,
    store,
    emit: event => events.push(event),
    listAgents: () => options.agents || [
      { id: 'claude-code', status: 'available' },
      { id: 'model', status: 'available' },
      { id: 'terminal', status: 'available' }
    ],
    storageUrl: `file:${join(root, 'runs.db')}`
  });
  t.after(() => {
    store.close();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // LibSQL 的文件句柄在 Windows 上可能还没释放，临时目录留给系统清理。
    }
  });
  return { orchestrator, store, events };
}

async function settle(orchestrator, runId) {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  for (let i = 0; i < 200; i++) {
    const run = orchestrator.get(runId);
    if (terminal.has(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`运行没有在预期时间内结束：${orchestrator.get(runId).status}`);
}

test('模板识别：改代码 / 数据分析 / 调研 / 运维各归各的', () => {
  assert.equal(detectTemplate('修复首页按钮在窄屏溢出').template.id, 'code-change');
  assert.equal(detectTemplate('统计近 30 天的留存并出个报表').template.id, 'data-analysis');
  assert.equal(detectTemplate('对比三个矢量库做选型调研').template.id, 'research');
  assert.equal(detectTemplate('服务起不来，查一下端口和日志').template.id, 'ops');
  assert.equal(detectTemplate('做点事').template.id, 'code-change', '没命中时用默认模板');
  assert.equal(detectTemplate('做点事').confidence, 0);
});

test('能力路由：写步骤交给能写的 Agent，验证步骤交给能跑命令的', () => {
  const available = ['model', 'terminal', 'claude-code', 'browser'];
  assert.equal(pickExecutor(available, { reads: true, writes: true }), 'claude-code', '优先外部 CLI');
  assert.equal(pickExecutor(['model', 'terminal'], { reads: true, writes: true }), 'model', '没有外部 CLI 时退回内置模型');
  assert.equal(pickExecutor(['model', 'terminal'], { commands: true }), 'model', '终端执行器不做代码工作');
  assert.equal(pickExecutor(['browser'], { reads: true, writes: true }), null, '没有能写的就返回 null');
  assert.equal(matches('browser', { browser: true }), true);
  assert.equal(capabilitiesOf('不存在').writes, false);
});

test('模板步骤：每一步都带提示词与所需能力', () => {
  for (const template of TEMPLATES) {
    const steps = buildSteps(template, '修好登录页');
    assert.ok(steps.length >= 3, `${template.id} 至少三步`);
    for (const step of steps) {
      assert.ok(step.prompt.includes('修好登录页'), '提示词要带上目标');
      assert.ok(Object.keys(step.need).length >= 1, '每一步都要声明能力需求');
    }
  }
});

test('运行：先出计划等批准，批准后逐步执行并汇总', async t => {
  const { orchestrator, events } = harness(t);
  const created = await orchestrator.start({ goal: '修复首页按钮在窄屏溢出' });

  let run = null;
  for (let i = 0; i < 100; i++) {
    run = orchestrator.get(created.id);
    if (run.status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(run.status, 'awaiting_approval', '没有批准前不应该开跑');
  assert.equal(run.templateId, 'code-change');
  assert.equal(run.steps.length, 3);
  assert.deepEqual(run.steps.map(step => step.executorId), ['claude-code', 'claude-code', 'claude-code']);

  await orchestrator.approve(created.id);
  const done = await settle(orchestrator, created.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.steps.filter(step => step.status === 'done').length, 3);
  assert.match(done.digest, /目标：修复首页按钮在窄屏溢出/);
  assert.match(done.digest, /模板：改代码/);
  assert.ok(events.some(event => event.type === 'run-step'), '要发出步骤事件给界面');
});

test('运行：验证失败会返工一次，第二次通过就算成功', async t => {
  let verifyCalls = 0;
  const { orchestrator } = harness(t, {
    outcome: ticket => {
      if (!ticket.title.startsWith('验证')) return 'completed';
      verifyCalls += 1;
      return verifyCalls === 1 ? 'failed' : 'completed';
    }
  });
  const created = await orchestrator.start({ goal: '修复首页按钮在窄屏溢出' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(created.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(created.id);
  const done = await settle(orchestrator, created.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.rounds, 1, '只返工一轮');
  assert.equal(verifyCalls, 2, '验证跑了两次');
  assert.ok(done.steps.some(step => step.role === '修掉问题'), '返工步骤要留在记录里');
  assert.ok(done.board.some(item => /验证没通过/.test(item.text)));
});

test('运行：验证一直不过时最多返工两轮，然后判失败', async t => {
  const { orchestrator } = harness(t, { outcome: ticket => (ticket.title.includes('验证') ? 'failed' : 'completed') });
  const created = await orchestrator.start({ goal: '修复首页按钮在窄屏溢出' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(created.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(created.id);
  const done = await settle(orchestrator, created.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.rounds, 2);
});

test('运行：返工后结论一字不变就停下，不重复同样的失败', async t => {
  const { orchestrator } = harness(t, {
    outcome: ticket => (ticket.title.includes('验证') ? 'failed' : 'completed'),
    summary: () => '命令退出码 1：测试失败'
  });
  const created = await orchestrator.start({ goal: '修复首页按钮在窄屏溢出' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(created.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(created.id);
  const done = await settle(orchestrator, created.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.rounds, 1, '一轮之后发现没有变化就停');
  assert.ok(done.board.some(item => /没有变化/.test(item.text)));
});

test('运行：手选模板就按选的拆，不再按关键词猜', async t => {
  const { orchestrator } = harness(t);
  const created = await orchestrator.start({ goal: '看看这批订单怎么回事', templateId: 'data-analysis' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(created.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const planned = orchestrator.get(created.id);
  assert.equal(planned.templateId, 'data-analysis');
  assert.equal(planned.templateChoice, 'data-analysis');
  assert.deepEqual(planned.steps.map(step => step.role), ['读数据', '算结果', '核对口径']);
  assert.ok(planned.board.some(item => /按你选的/.test(item.text)));
});

test('运行：不认识的模板直接报错，不会悄悄退回自动识别', async t => {
  const { orchestrator } = harness(t);
  await assert.rejects(() => orchestrator.start({ goal: '随便干点什么', templateId: 'not-a-template' }), /未知的任务模板/);
});

test('运行：后面的步骤能看到前面几步的结论，但工单标题仍是这一步的任务', async t => {
  const { orchestrator, store } = harness(t);
  const created = await orchestrator.start({ goal: '修复首页按钮在窄屏溢出' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(created.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(created.id);
  const done = await settle(orchestrator, created.id);
  assert.equal(done.status, 'completed');
  const tickets = done.steps.map(step => step.ticketId).filter(Boolean).map(id => store.get('work-ticket', id)).filter(Boolean);
  assert.ok(tickets.length >= 2);
  assert.ok(!/前几步的结论/.test(tickets[0].title), '第一步没有上文可带');
  assert.ok(/前几步的结论/.test(tickets[1].text), '第二步要带上前一步的结论');
  assert.ok(!/前几步的结论/.test(tickets[1].title), '标题只留这一步的任务，不要在列表里显示摘要');
});

test('运行：拒绝批准就结束，不派任何工单', async t => {
  const { orchestrator, store } = harness(t);
  const created = await orchestrator.start({ goal: '这段代码需要重构一下' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(created.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(created.id, 'reject');
  const run = await settle(orchestrator, created.id);
  assert.equal(run.status, 'cancelled');
  assert.equal(store.list('work-ticket').length, 0);
});

test('运行：项目里每个执行器各有一个子对话，工单挂在对应对话上', async t => {
  const created = [];
  const { orchestrator, store } = harness(t);
  const run = await orchestrator.start({ goal: '修复首页按钮在窄屏溢出', projectId: 'project-1' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(run.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(run.id);
  await settle(orchestrator, run.id);
  const tickets = store.list('work-ticket');
  assert.ok(tickets.length >= 3);
  for (const ticket of tickets) assert.ok(ticket.projectChatId, '项目运行里的工单要挂在对话上');
  // 写步骤要拿可写对话，否则工单摘要会说「只读」而实际又能写。
  const chats = store.list('work-project-chat');
  const writable = chats.filter(chat => chat.writable === true);
  assert.ok(writable.length >= 1, '至少有一个可写子对话');
  for (const ticket of tickets) {
    const chat = chats.find(row => row.id === ticket.projectChatId);
    if (chat && chat.writable === true) continue;
    assert.ok(chat, '工单要挂在本项目新建的子对话上');
  }
  created.push(run.id);
  assert.ok(created.length === 1);
});

test('能力路由：没人能接的一步标成跳过，并说清缺哪种能力', async t => {
  // 只有内置模型可用：调研模板里「补外部信息」要浏览器，model 没有这个能力。
  const { orchestrator, store } = harness(t, { agents: [{ id: 'model', status: 'available' }] });
  const run = await orchestrator.start({ goal: '调研一下这个项目该用哪个构建工具' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(run.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const planned = orchestrator.get(run.id);
  const browserStep = planned.steps.find(step => step.need && step.need.browser);
  assert.ok(browserStep, '调研模板要有一步需要浏览器');
  assert.equal(browserStep.executorId, null, '没有浏览器执行器时不硬派给别人');

  await orchestrator.approve(run.id);
  const done = await settle(orchestrator, run.id);
  const skipped = done.steps.find(step => step.index === browserStep.index);
  assert.equal(skipped.status, 'skipped', '挑不出人的步骤要标成跳过，不能一直显示待执行');
  assert.ok(/browser/.test(skipped.summary || ''), '跳过原因要写清缺哪种能力');
  assert.ok(done.board.some(item => /找不到具备 browser 能力/.test(item.text)));
  // 其它步骤照常有人接，工单也照常派。
  assert.ok(store.list('work-ticket').length >= 2);
});

test('看门狗：一步长时间没有任何输出就停下来，而不是一直等', async t => {
  const root = mkdtempSync(join(tmpdir(), 'lagent-watchdog-'));
  const rows = new Map();
  const store = {
    get: (kind, id) => rows.get(`${kind}:${id}`) ?? null,
    list: kind => [...rows.entries()].filter(([key]) => key.startsWith(`${kind}:`)).map(([, body]) => body),
    put: (kind, body) => { rows.set(`${kind}:${body.id}`, body); return body; },
    delete: (kind, id) => { rows.delete(`${kind}:${id}`); },
  };
  // 工单一直停在 working、updatedAt 不动：模拟 CLI 卡住不出声。
  store.put('work-ticket', { id: 't-1', status: 'working', updatedAt: '2026-01-01T00:00:00.000Z', summary: '执行中', executor: 'codex' });
  const stopped = [];
  const orchestrator = createOrchestrator({
    engine: { action: (id, action) => { stopped.push([id, action]); return { id, status: 'cancelled' }; } },
    store,
    emit: () => {},
    listAgents: () => [],
    storageUrl: `file:${join(root, 'runs.db')}`,
    idleTimeoutMs: 120
  });
  t.after(() => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // LibSQL 句柄在 Windows 上可能还没释放，留给系统清理。
    }
  });
  const result = await orchestrator._internal.waitTicket('t-1');
  assert.equal(result.status, 'stalled', '没有输出就不再干等');
  assert.match(result.summary, /没有任何输出/);
  assert.deepEqual(stopped, [['t-1', 'stop']], '要真的把它停掉');
});

test('实现步骤没写全点名的文件，这一步和整条运行都判失败', async t => {
  const projectPath = mkdtempSync(join(tmpdir(), 'lagent-gap-'));
  const { orchestrator } = harness(t, { projectPath });
  t.after(() => {
    try {
      rmSync(projectPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // 忽略：临时目录会被系统清理。
    }
  });
  const run = await orchestrator.start({ goal: '做一个游戏页面：写 index.html 和 input.js', projectId: 'p-gap' });
  for (let i = 0; i < 100; i++) {
    if (orchestrator.get(run.id).status === 'awaiting_approval') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await orchestrator.approve(run.id);
  const done = await settle(orchestrator, run.id);
  const implement = done.steps.find(step => step.kind === 'implement');
  assert.ok(implement, '改代码模板要有实现步骤');
  assert.equal(implement.status, 'failed', '文件没出现就不算做完');
  assert.match(implement.summary || '', /产出不完整/);
  assert.equal(done.status, 'failed');
  assert.deepEqual(done.missing, ['index.html', 'input.js'], '缺哪些文件要记在运行上');
});
