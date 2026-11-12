// 编排器：一次运行 = analyze → plan → approve → execute → verify → summarize。
// 设计上的边界：工单仍然是执行与审批的唯一真相，编排器只决定「下一步做什么、
// 交给谁、要不要返工」。所以这里从不直接读写文件，也从不绕过工单审批。
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import { detectTemplate, buildSteps, repairStep, templateById } from './templates.js';
import { pickExecutor, capabilitiesOf } from './capabilities.js';
import { createRunStore, RUN_STATUS, isTerminal } from './runs.js';
import { artifactGap, describeGap } from '../artifacts.js';

const TERMINAL_TICKET = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const DEFAULT_STEP_TIMEOUT_MS = 30 * 60 * 1000;
// 单步「完全没有动静」的上限：CLI 卡住时总超时太远，用户只能干等。
// 实测 Codex 有过 20 分钟零输出的情况，5 分钟没有任何活动基本就可以判死。
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_MS = 400;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createOrchestrator({
  engine,
  store,
  emit = () => {},
  listAgents = () => engine.bootstrap().agents || [],
  storageUrl = null,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  idleTimeoutMs = Number(process.env.LAGENT_STEP_IDLE_MS) > 0 ? Number(process.env.LAGENT_STEP_IDLE_MS) : DEFAULT_IDLE_TIMEOUT_MS,
  now = () => new Date().toISOString()
}) {
  const runs = createRunStore({ store, clock: now });
  const publish = event => { try { emit({ ...event, scope: 'run' }); } catch { /* 事件失败不能影响执行 */ } };

  function agentsUsable() {
    return listAgents()
      .filter(agent => agent.status === 'available' || agent.available === true)
      .map(agent => agent.id);
  }

  // 项目根目录：产出校验要拿它当基准。
  function projectRootOf(run) {
    if (!run?.projectId) return '';
    try {
      return engine.getProject(run.projectId)?.project?.path || engine.getProject(run.projectId)?.path || '';
    } catch {
      return '';
    }
  }

  // 模板有两种来源：用户在对话里手动选的（templateChoice），或者按目标关键词猜的。
  // 手动选的优先，不再猜；这样「补一份 README」这类词面不明显的目标也能选对模板。
  function templateOf(run) {
    const manual = run.templateChoice ? templateById(run.templateChoice) : null;
    if (manual) return { template: manual, confidence: 1, manual: true };
    return { ...detectTemplate(run.goal), manual: false };
  }

  // 把前几步的结论摘成一段，跟着下一步的提示词一起发过去。
  // 没有这个，后面几步只能看到自己的任务，容易把上一步已经做完的事再做一遍。
  function boardBrief(run) {
    // 只带「上一步做完了什么」和「验证发现了什么」：模板判定这类决策对执行没帮助，反而占提示词。
    const entries = (run.board || []).filter(item => item.kind === 'result' || item.kind === 'check').slice(-6);
    if (!entries.length) return '';
    const lines = [];
    let size = 0;
    for (const entry of entries) {
      const line = `- ${String(entry.text || '').replace(/\s+/g, ' ').slice(0, 200)}`;
      if (size + line.length > 800) break;
      lines.push(line);
      size += line.length + 1;
    }
    return lines.length ? `前几步的结论（供参考，别重复做）：\n${lines.join('\n')}` : '';
  }

  function planStepsFor(run) {
    const { template, confidence, manual } = templateOf(run);
    const steps = buildSteps(template, run.goal);
    const available = agentsUsable();
    const preferred = ['claude-code', 'codex', 'model'];
    return {
      template,
      confidence,
      manual,
      steps: steps.map(step => ({
        ...step,
        executorId: pickExecutor(available, step.need, preferred),
        ticketId: null,
        status: 'pending',
        summary: '',
        startedAt: null,
        endedAt: null
      }))
    };
  }

  // 每个执行器在项目里各有一个子对话：工单必须挂在同执行器的对话上，
  // 这样审批、改动快照、项目记忆都还能按对话追溯。
  // writable 要跟着步骤走：只读步骤别建可写对话，否则工单摘要会说「只读」而实际能写。
  function chatFor(run, executorId, writable = false) {
    // 没绑定文件夹的编排（首页发起）不需要子对话，工单直接挂在主对话上。
    if (!run.projectId) return null;
    // 项目可能在建好计划之后被删掉（清理临时项目时就会这样），这里翻成一句人话，
    // 而不是把「项目不存在」这种内部错误直接甩给用户。
    let project = null;
    try {
      project = engine.getProject(run.projectId);
    } catch {
      throw new Error('这条编排绑定的工作文件夹已经被删掉了，请重新导入文件夹后再开始。');
    }
    if (!project) throw new Error('这条编排绑定的工作文件夹已经被删掉了，请重新导入文件夹后再开始。');
    const chats = project.chats || [];
    const host = chats.find(chat => chat.id === run.chatId) || null;
    const sameParent = chat => (chat.parentChatId || null) === (host?.id || null);
    const reuse = chats.find(chat => chat.executorId === executorId && sameParent(chat) && (chat.writable === true) === writable);
    if (reuse) return reuse.id;
    const created = engine.createProjectChat(run.projectId, {
      executorId,
      title: `编排 · ${executorId}${writable ? '' : '（只读）'}`,
      writable,
      ...(host ? { parentChatId: host.id } : {})
    });
    publish({ type: 'run-chat', runId: run.id, payload: { chatId: created.chat.id, executorId } });
    return created.chat.id;
  }

  // 看门狗要的信号：这一步到底有没有在动。
  // 工单的 updatedAt、摘要、以及执行器任务里的 activity 条数，任何一个变化都算“在动”。
  function progressSignature(ticket) {
    const assignments = store.list('work-assignment').filter(row => row.ticketId === ticket.id);
    const last = assignments[assignments.length - 1] || null;
    const task = last ? store.get('task', last.id) : null;
    const activity = Array.isArray(task?.activity) ? task.activity.length : 0;
    return `${ticket.status}|${ticket.updatedAt || ''}|${String(ticket.summary || '').slice(0, 60)}|${activity}|${task?.status || ''}`;
  }

  async function waitTicket(ticketId) {
    const deadline = Date.now() + stepTimeoutMs;
    let signature = '';
    let lastChange = Date.now();
    for (;;) {
      const ticket = store.get('work-ticket', ticketId);
      if (ticket && TERMINAL_TICKET.has(ticket.status)) {
        const report = store.list('work-report').find(row => row.ticketId === ticketId) || null;
        return { status: ticket.status, summary: report?.summary || ticket.summary || '' };
      }
      if (ticket) {
        const next = progressSignature(ticket);
        if (next !== signature) {
          signature = next;
          lastChange = Date.now();
        } else if (idleTimeoutMs > 0 && Date.now() - lastChange > idleTimeoutMs) {
          // 长时间零进展：先停掉，再如实告诉用户发生了什么，而不是继续干等 30 分钟。
          try { engine.action(ticketId, 'stop'); } catch { /* 已经停了就算了 */ }
          const minutes = Math.round(idleTimeoutMs / 60000);
          return { status: 'stalled', summary: `这一步 ${minutes} 分钟没有任何输出，已停止（多半是 CLI 卡住了）` };
        }
      }
      if (Date.now() > deadline) return { status: 'timeout', summary: '这一步超过等待上限，已放弃等待' };
      await sleep(POLL_MS);
    }
  }

  async function dispatch(run, step) {
    const executorId = step.executorId;
    if (!executorId) {
      // 挑不出人时不能装作在跑：把这一步标成「跳过」，并在黑板上写清缺哪种能力。
      const missing = Object.keys(step.need || {}).filter(key => step.need[key]).join('/');
      runs.note(run, 'decision', `「${step.role}」找不到具备 ${missing} 能力的 Agent，已跳过。`);
      runs.updateStep(run, step.index, { status: 'skipped', summary: `没有 Agent 具备 ${missing} 能力`, endedAt: now() });
      publish({ type: 'run-step', runId: run.id, payload: { index: step.index, status: 'skipped' } });
      return { status: 'skipped', summary: '没有可用 Agent' };
    }
    // 续跑时复用已经完成的工单，不重复派发。
    if (step.ticketId && step.status === 'done') {
      const ticket = store.get('work-ticket', step.ticketId);
      if (ticket && ticket.status === 'completed') {
        const report = store.list('work-report').find(row => row.ticketId === step.ticketId);
        return { status: 'completed', summary: report?.summary || ticket.summary || '' };
      }
    }
    const chatId = chatFor(run, executorId, step.need?.writes === true);
    const brief = boardBrief(run);
    // 上下文放后面：工单标题取的是开头，前面塞一段摘要会让列表里看不出这一步在干什么。
    const ticket = engine.command({
      text: brief ? `${step.prompt}\n\n${brief}` : step.prompt,
      title: step.prompt,
      executorId,
      ...(chatId ? { projectChatId: chatId } : {})
    });
    runs.updateStep(run, step.index, { ticketId: ticket.id, status: 'running', startedAt: now() });
    runs.note(run, 'step', `${step.role} → ${executorId}`);
    runs.save(run);
    publish({ type: 'run-step', runId: run.id, payload: { index: step.index, status: 'running', executorId, ticketId: ticket.id } });

    // 运行级审批已经通过，逐步的工单直接放行；执行器内部的危险操作仍会自己弹窗。
    engine.action(ticket.id, 'approve');
    const result = await waitTicket(ticket.id);

    let stepStatus = result.status === 'completed' ? 'done' : 'failed';
    let summary = String(result.summary || '');
    // 动文件的步骤要自己证明「文件真的在」：退出码 0 不算数。
    if (stepStatus === 'done' && step.kind === 'implement') {
      const root = projectRootOf(run);
      const gap = root ? artifactGap(root, step.prompt) : [];
      if (gap.length) {
        stepStatus = 'failed';
        summary = `${summary}${summary ? '；' : ''}${describeGap(gap)}`;
        runs.note(run, 'check', `「${step.role}」${describeGap(gap)}`);
      }
    }
    if (result.status === 'stalled') runs.note(run, 'check', `「${step.role}」长时间没有输出，已停止`);

    runs.updateStep(run, step.index, {
      status: stepStatus,
      summary: summary.slice(0, 2000),
      endedAt: now()
    });
    if (summary) runs.note(run, 'result', `${step.role}：${summary.slice(0, 400)}`);
    runs.save(run);
    publish({ type: 'run-step', runId: run.id, payload: { index: step.index, status: stepStatus, summary } });
    return { status: stepStatus === 'done' ? 'completed' : (result.status === 'stalled' ? 'stalled' : 'failed'), summary };
  }

  // ---- Mastra 工作流 ----
  const analyzeStep = createStep({
    id: 'analyze',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() }),
    execute: async ({ inputData }) => {
      const run = runs.get(inputData.runId);
      const { template, confidence, manual } = templateOf(run);
      run.templateId = template.id;
      run.templateLabel = template.label;
      run.confidence = confidence;
      runs.note(run, 'decision', manual
        ? `按你选的「${template.label}」模板拆解`
        : confidence > 0
          ? `判定为「${template.label}」类任务（关键词命中 ${Math.round(confidence * 3)} 个）`
          : `没命中关键词，按默认的「${template.label}」处理`);
      runs.setStatus(run, RUN_STATUS.drafting);
      publish({ type: 'run', runId: run.id, payload: { status: run.status, templateId: run.templateId } });
      return { runId: run.id };
    }
  });

  const planStep = createStep({
    id: 'plan',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() }),
    execute: async ({ inputData }) => {
      const run = runs.get(inputData.runId);
      const { template, confidence, steps } = planStepsFor(run);
      run.templateId = template.id;
      run.templateLabel = template.label;
      run.confidence = confidence;
      run.steps = steps;
      const missing = steps.filter(step => !step.executorId).map(step => step.role);
      if (missing.length) runs.note(run, 'note', `这些步骤没有符合能力的 Agent：${missing.join('、')}（会跳过）`);
      runs.setStatus(run, RUN_STATUS.awaitingApproval);
      for (const step of steps) runs.note(run, 'decision', `第 ${step.index + 1} 步「${step.role}」交给 ${step.executorId || '（无人）'}`);
      publish({ type: 'run', runId: run.id, payload: { status: run.status, steps: steps.map(s => ({ index: s.index, role: s.role, executorId: s.executorId })) } });
      return { runId: run.id };
    }
  });

  const approveStep = createStep({
    id: 'approve',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() }),
    suspendSchema: z.object({ question: z.string() }),
    resumeSchema: z.object({ decision: z.enum(['approve', 'reject']) }),
    execute: async ({ inputData, resumeData, suspend }) => {
      const run = runs.get(inputData.runId);
      if (!resumeData) {
        runs.note(run, 'note', '等你确认这份计划');
        return await suspend({ question: `计划已就绪：${run.steps.map(s => s.role).join(' → ')}` });
      }
      if (resumeData.decision !== 'approve') {
        run.cancelledAt = now();
        runs.setStatus(run, RUN_STATUS.cancelled, '用户没有批准这次计划');
        runs.note(run, 'note', '计划被拒绝，没有派任何工单');
        publish({ type: 'run', runId: run.id, payload: { status: run.status } });
        return { runId: run.id };
      }
      run.approvedAt = now();
      runs.setStatus(run, RUN_STATUS.running);
      runs.note(run, 'note', '计划已批准，开始执行');
      publish({ type: 'run', runId: run.id, payload: { status: run.status } });
      return { runId: run.id };
    }
  });

  const executeStep = createStep({
    id: 'execute',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() }),
    execute: async ({ inputData }) => {
      const run = runs.get(inputData.runId);
      if (run.cancelledAt) return { runId: run.id };
      runs.setStatus(run, RUN_STATUS.running);
      for (const step of run.steps.filter(item => item.kind !== 'verify')) {
        if (run.cancelledAt) break;
        if (step.status === 'done' || step.status === 'skipped') continue;
        await dispatch(run, step);
      }
      return { runId: run.id };
    }
  });

  const verifyStep = createStep({
    id: 'verify',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() }),
    execute: async ({ inputData }) => {
      const run = runs.get(inputData.runId);
      if (run.cancelledAt) return { runId: run.id };
      runs.setStatus(run, RUN_STATUS.verifying);
      const verifySteps = run.steps.filter(item => item.kind === 'verify');

      // 模板里没有验证步骤的（比如调研），用一个只读步骤兜底确认结论有依据。
      if (!verifySteps.length) {
        runs.note(run, 'check', '这个模板不需要跑命令验证，直接收口。');
        return { runId: run.id };
      }

      for (const step of verifySteps) {
        if (step.status === 'done' || step.status === 'skipped') continue;
        if (!step.executorId) {
          step.executorId = pickExecutor(agentsUsable(), step.need, ['claude-code', 'codex', 'model']);
        }
        let result = await dispatch(run, step);
        let round = 0;
        let previous = String(result.summary || '').trim();
        while (result.status !== 'completed' && round < run.maxRounds && !run.cancelledAt) {
          round += 1;
          run.rounds = (run.rounds || 0) + 1;
          runs.setStatus(run, RUN_STATUS.repairing);
          const fix = {
            ...repairStep(run.goal, String(result.summary || '验证步骤失败').slice(0, 1200)),
            index: run.steps.length,
            executorId: pickExecutor(agentsUsable(), { reads: true, writes: true }, ['claude-code', 'codex', 'model']),
            ticketId: null,
            status: 'pending',
            summary: '',
            startedAt: null,
            endedAt: null
          };
          run.steps.push(fix);
          runs.note(run, 'check', `验证没通过（第 ${round} 轮返工）：${String(result.summary || '').slice(0, 200)}`);
          await dispatch(run, fix);
          runs.setStatus(run, RUN_STATUS.verifying);
          result = await dispatch(run, { ...step, ticketId: null });
          const current = String(result.summary || '').trim();
          // 返工一轮后结论一字不变，说明这条路走不通，再试就是重复同样的失败。
          if (result.status !== 'completed' && current && current === previous) {
            runs.note(run, 'check', '返工后结果没有变化，先停下，避免重复同样的失败。');
            break;
          }
          previous = current;
        }
        if (result.status !== 'completed') {
          runs.note(run, 'check', `返工 ${round} 轮仍未通过验证，这次运行标记为失败。`);
          runs.setStatus(run, RUN_STATUS.failed, '验证没有通过');
          return { runId: run.id };
        }
      }
      runs.note(run, 'check', '验证通过。');
      return { runId: run.id };
    }
  });

  const summarizeStep = createStep({
    id: 'summarize',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() }),
    execute: async ({ inputData }) => {
      const run = runs.get(inputData.runId);
      const lines = [];
      lines.push(`目标：${run.goal}`);
      if (run.templateLabel) lines.push(`模板：${run.templateLabel}`);
      for (const step of run.steps) {
        const mark = step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '·';
        lines.push(`${mark} ${step.role}（${step.executorId || '无人'}）${step.summary ? `：${String(step.summary).replace(/\s+/g, ' ').slice(0, 180)}` : ''}`);
      }
      if (run.board.length) {
        const last = run.board.slice(-5).map(item => `- ${item.text}`).join('\n');
        lines.push('最近经过：', last);
      }
    // 运行级产出校验：目标里点名的文件是否真的存在。
    // 这一步就是 trio 那次「每步都报成功、index.html 引用的 input.js 却没有」的兜底。
    const gap = projectRootOf(run) ? artifactGap(projectRootOf(run), run.goal) : [];
    if (gap.length) {
      run.missing = gap;
      lines.push('', describeGap(gap));
      runs.note(run, 'check', describeGap(gap));
    } else {
      run.missing = [];
    }
    run.digest = lines.join('\n').slice(0, 4000);
    if (run.cancelledAt) {
      runs.note(run, 'note', '运行被取消，以下是已经做完的部分');
    } else if (gap.length) {
      runs.setStatus(run, RUN_STATUS.failed);
      run.error = describeGap(gap);
      runs.note(run, 'note', '运行结束，但产出不完整');
    } else if (run.status !== RUN_STATUS.failed) {
      runs.setStatus(run, RUN_STATUS.completed);
      runs.note(run, 'note', '运行结束');
    } else {
      runs.note(run, 'note', '运行结束（验证没通过）');
    }
      publish({ type: 'run', runId: run.id, payload: { status: run.status, digest: run.digest } });
      return { runId: run.id };
    }
  });

  const workflow = createWorkflow({
    id: 'work-orchestrator',
    inputSchema: z.object({ runId: z.string() }),
    outputSchema: z.object({ runId: z.string() })
  })
    .then(analyzeStep)
    .then(planStep)
    .then(approveStep)
    .then(executeStep)
    .then(verifyStep)
    .then(summarizeStep)
    .commit();

  const storage = new LibSQLStore({
    id: 'work-orchestrator',
    url: storageUrl || `file:${process.env.LAGENT_RUN_DB || 'data/orchestrator.db'}`
  });
  const mastra = new Mastra({ workflows: { orchestrator: workflow }, storage });
  const bound = mastra.getWorkflow('orchestrator');

  async function startWorkflow(run) {
    const context = await bound.createRun({ runId: run.id });
    context.start({ inputData: { runId: run.id } }).catch(error => {
      const failed = runs.find(run.id);
      if (!failed || isTerminal(failed.status)) return;
      runs.setStatus(failed, RUN_STATUS.failed, error?.message || String(error));
      publish({ type: 'run', runId: failed.id, payload: { status: failed.status, error: failed.error } });
    });
    return context;
  }

  async function start({ goal, projectId = null, chatId = null, templateId = null }) {
    const template = templateId ? templateById(templateId) : null;
    if (templateId && !template) {
      const error = new Error(`未知的任务模板：${templateId}`);
      error.status = 400;
      throw error;
    }
    const run = runs.create({ goal, projectId, chatId });
    if (template) {
      run.templateChoice = template.id;
      runs.save(run);
    }
    await startWorkflow(run);
    return run;
  }

  async function approve(id, decision = 'approve') {
    const run = runs.get(id);
    const context = await bound.createRun({ runId: id });
    await context.resume({ step: 'approve', resumeData: { decision } });
    return runs.get(id);
  }

  async function cancel(id) {
    const run = runs.get(id);
    if (isTerminal(run.status)) return run;
    run.cancelledAt = now();
    runs.setStatus(run, RUN_STATUS.cancelled, '已取消');
    runs.note(run, 'note', '用户取消了这次运行');
    publish({ type: 'run', runId: run.id, payload: { status: run.status } });
    return run;
  }

  async function resume(id) {
    const run = runs.markResumable(id);
    if (!run) {
      const error = new Error('这次运行不存在');
      error.status = 404;
      throw error;
    }
    if (isTerminal(run.status)) return run;
    // 已经有步骤时，从 execute 开始续跑；否则从 analyze 重新开始。
    const hasSteps = run.steps && run.steps.length > 0;
    const context = await bound.createRun({ runId: run.id });
    const startStep = hasSteps ? 'execute' : 'analyze';
    context.resume({ step: startStep, resumeData: { resumed: true } }).catch(error => {
      const failed = runs.find(run.id);
      if (!failed || isTerminal(failed.status)) return;
      runs.setStatus(failed, RUN_STATUS.failed, error?.message || String(error));
      publish({ type: 'run', runId: failed.id, payload: { status: failed.status, error: failed.error } });
    });
    return run;
  }

  return {
    start,
    approve,
    cancel,
    resume,
    get: id => runs.get(id),
    list: limit => runs.list(limit),
    markPaused: () => runs.markPaused(),
    runs,
    // 测试用：把编排能力直接暴露出来，避免每个用例都要起一遍工作流。
    _internal: { planStepsFor, dispatch, waitTicket, capabilitiesOf, templateById }
  };
}