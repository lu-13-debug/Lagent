import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../store.js';
import { createWorkEngine } from '../work/engine.js';
import { createExecutorRegistry } from '../work/executors/index.js';
import { EVAL_TASKS, scriptedExecutor } from './tasks.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled']);

async function until(check, { timeoutMs = 10000, intervalMs = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * 在临时工作区跑一遍任务集：每个任务独立 store + 工作目录，跑完即删。
 * 返回 pass@1（单次运行通过率）与每个任务的结果，供回归对比。
 */
export async function runEval({ tasks = EVAL_TASKS, root = os.tmpdir(), executorId = 'terminal' } = {}) {
  const results = [];
  for (const task of tasks) {
    const dir = fs.mkdtempSync(path.join(root, 'lagent-eval-'));
    const store = new Store(dir);
    const executor = scriptedExecutor({ workspace: dir, id: executorId });
    const engine = createWorkEngine(store, createExecutorRegistry([executor]), () => {}, { workspace: dir });
    const startedAt = Date.now();
    let ticket = null;
    let acceptance = null;
    let trajectory = null;
    try {
      if (Array.isArray(task.plan) && task.plan.length) {
        const plan = engine.plan({
          goal: task.goal,
          autoRun: true,
          steps: task.plan.map((step, index) => ({
            executorId,
            text: `步骤 ${index + 1}`,
            executorInput: { actions: step.actions },
            ...(Array.isArray(step.dependsOn) ? { dependsOn: step.dependsOn } : index > 0 ? { dependsOn: [index - 1] } : {})
          }))
        });
        await until(() => plan.steps.every(step => {
          const current = engine.detail(step.ticketId)?.ticket;
          return current && TERMINAL.has(current.status);
        }));
        const last = plan.steps[plan.steps.length - 1];
        ticket = engine.detail(last.ticketId).ticket;
        // 轨迹评审：记录每一步最终状态，失败时能看出卡在哪一步，而不是只有一个总分。
        trajectory = plan.steps.map(step => ({ step: step.index, executor: step.executorId || executorId, status: engine.detail(step.ticketId)?.ticket?.status || 'missing' }));
      } else {
        ticket = engine.command({
          text: task.goal,
          executorId,
          executorInput: { actions: task.actions },
          ...(task.verify ? { verify: task.verify } : {})
        });
        if (task.verify) {
          acceptance = await until(() => {
            const detail = engine.detail(ticket.id);
            ticket = detail.ticket;
            if (detail.ticket.acceptance) return detail.ticket.acceptance;
            // 工单已经失败/阻塞/取消就不会再有验收结果，别等到超时。
            // completed 不算终点：自动验收在完成之后异步跑，还要再等一会儿。
            return ['failed', 'blocked', 'cancelled'].includes(detail.ticket.status) ? 'settled' : null;
          });
          if (acceptance === 'settled') acceptance = null;
        }
        trajectory = [{ step: 0, executor: executorId, status: ticket?.status || 'missing' }];
      }
      const passed = Boolean(await task.expect({ dir, engine, ticket, acceptance }));
      results.push({ id: task.id, name: task.name, passed, status: ticket?.status || null, trajectory, durationMs: Date.now() - startedAt });
    } catch (error) {
      results.push({ id: task.id, name: task.name, passed: false, error: error?.message || String(error), trajectory, durationMs: Date.now() - startedAt });
    } finally {
      engine.close();
      store.close();
      // Windows 上数据库文件句柄偶尔晚一拍释放，清理失败不应把一条通过的用例判成失败。
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* 临时目录留给系统清理 */ }
    }
  }
  const passed = results.filter(result => result.passed).length;
  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? Math.round((passed / results.length) * 100) / 100 : 0
    }
  };
}
