// 运行记录：一次「分析任务 → 拆解 → 分发 → 检测 → 修复 → 汇总」的完整留痕。
// 存进现有 SQLite（kind = work-run），不依赖 Mastra 的存储——
// 编排器可以重启、可以关掉，历史记录照样读得出来。
import { randomUUID } from 'node:crypto';

const KIND = 'work-run';
const BOARD_LIMIT = 200;

export const RUN_STATUS = Object.freeze({
  drafting: 'drafting',
  awaitingApproval: 'awaiting_approval',
  running: 'running',
  verifying: 'verifying',
  repairing: 'repairing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  paused: 'paused',
  interrupted: 'interrupted'
});

const TERMINAL = new Set([RUN_STATUS.completed, RUN_STATUS.failed, RUN_STATUS.cancelled]);
const PAUSABLE = new Set([RUN_STATUS.running, RUN_STATUS.verifying, RUN_STATUS.repairing, RUN_STATUS.awaitingApproval]);

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function createRunStore({ store, clock = () => new Date().toISOString() }) {
  function save(run) {
    run.updatedAt = clock();
    store.put(KIND, run);
    return run;
  }

  function create({ goal, projectId = null, chatId = null }) {
    const at = clock();
    const run = {
      id: randomUUID(),
      goal,
      projectId,
      chatId,
      templateId: null,
      templateLabel: null,
      confidence: 0,
      status: RUN_STATUS.drafting,
      createdAt: at,
      updatedAt: at,
      endedAt: null,
      rounds: 0,
      maxRounds: 2,
      steps: [],
      board: [],
      digest: '',
      error: null
    };
    return save(run);
  }

  function get(id) {
    const run = store.get(KIND, id);
    if (!run) {
      const error = new Error('这次运行不存在');
      error.status = 404;
      throw error;
    }
    return run;
  }

  function find(id) {
    return store.get(KIND, id);
  }

  function list(limit = 20) {
    return store.list(KIND).slice(0, limit);
  }

  function note(run, kind, text) {
    const entry = { at: clock(), kind, text: String(text || '').slice(0, 800) };
    run.board = [...(run.board || []), entry].slice(-BOARD_LIMIT);
    return entry;
  }

  function setStatus(run, status, error = null) {
    run.status = status;
    if (error) run.error = String(error).slice(0, 500);
    if (isTerminal(status)) run.endedAt = clock();
    return save(run);
  }

  function updateStep(run, index, patch) {
    const step = run.steps.find(item => item.index === index);
    if (!step) return null;
    Object.assign(step, patch);
    return step;
  }

  // 进程重启后，跑到一半的运行不会再有人推进——标成 paused，等用户决定续跑。
  function markPaused() {
    const stale = [];
    for (const run of list(500)) {
      if (!PAUSABLE.has(run.status)) continue;
      run.status = RUN_STATUS.paused;
      run.error = '服务重启，这次运行已暂停，可续跑';
      save(run);
      stale.push(run.id);
    }
    return stale;
  }

  // 把 paused 的运行恢复到可继续状态；不自动启动，由调用方决定何时开始。
  function markResumable(id) {
    const run = find(id);
    if (!run) return null;
    if (run.status !== RUN_STATUS.paused && run.status !== RUN_STATUS.interrupted) return run;
    run.status = RUN_STATUS.running;
    run.error = null;
    save(run);
    return run;
  }

  return { kind: KIND, create, get, find, list, save, note, setStatus, updateStep, markPaused, markResumable };
}
