import { workError } from '../domain.js';

const MAX_TEXT = 8000;

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('窗口 Agent 输入必须为对象');
  const handle = Number(input.handle);
  if (!Number.isSafeInteger(handle) || handle <= 0) throw workError('窗口句柄无效');
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (!text || text.length > MAX_TEXT) throw workError(`窗口 Agent 指令须为 1–${MAX_TEXT} 字`);
  const processName = typeof input.process === 'string' ? input.process.trim().slice(0, 80) : '';
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
  return { handle, text, process: processName || undefined, ...(title ? { title } : {}), submit: input.submit !== false };
}

export function windowExecutor({ store, bridge, waitMs = 1200, pollMs = 900, maxWaitMs = 30000 } = {}) {
  if (!store) throw new TypeError('windowExecutor 需要 store');
  const tasks = new Map();
  const cancelled = new Set();
  const trimTasks = () => { if (tasks.size <= 200) return; for (const [idValue, row] of tasks) { if (tasks.size <= 200) break; if (!['running', 'awaiting_approval'].includes(row.status)) tasks.delete(idValue); } };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readText = async (handle, hint) => {
    try {
      const read = await bridge?.readWindow(handle, hint);
      return String(read?.text || '');
    } catch {
      return '';
    }
  };
  return {
    id: 'window',
    name: '窗口 Agent',
    kind: 'tool',
    available: Boolean(bridge),
    requiresDataset: false,
    capabilities: ['window', 'desktop-agent', 'send', 'read'],
    validateInput: normalizeInput,
    start(ticket, assignment, input) {
      const request = normalizeInput(input?.executorInput ?? input);
      const task = { id: assignment.id, status: 'running', startedAt: new Date().toISOString(), windowRequest: { handle: request.handle, process: request.process || '' } };
      tasks.set(task.id, task);
      store.put('task', task);
      void (async () => {
        try {
          if (!bridge) throw new Error('窗口桥未启用');
          const hint = { ...(request.process ? { process: request.process } : {}), ...(request.title ? { title: request.title } : {}) };
          const baseline = await readText(request.handle, hint);
          const sent = await bridge.sendToWindow(request.handle, request.text, { submit: request.submit, ...hint });
          await pause(Math.max(0, Math.min(Number(waitMs) || 0, 5000)));
          const target = Number.isSafeInteger(sent?.handle) && sent.handle > 0 ? sent.handle : request.handle;
          const deadline = Date.now() + Math.max(0, Math.min(Number(maxWaitMs) || 0, 120000));
          const interval = Math.max(200, Math.min(Number(pollMs) || 900, 5000));
          let output = '';
          let previous = null;
          while (Date.now() < deadline) {
            if (cancelled.has(task.id)) return;
            const current = await readText(target, hint);
            if (current && current !== baseline) {
              output = current;
              if (previous === current) break;
              previous = current;
            }
            await pause(interval);
          }
          if (!output) output = await readText(target, hint);
          if (cancelled.has(task.id)) return;
          const readable = Boolean(output && output !== baseline);
          if (!readable) output = '';
          const processName = sent.process || request.process || '窗口';
          const summary = readable
            ? `已向 ${processName} 发送指令并读取到窗口输出`
            : `已向 ${processName} 发送指令，但未读取到新输出`;
          const finished = {
            ...task,
            status: 'completed',
            completedAt: new Date().toISOString(),
            ...(readable ? {} : { warning: '窗口未返回可读文本，可到 Agent → 窗口列表用「读取」重试。' }),
            report: { id: `window-${task.id}`, summary, output: String(output).slice(-4000) },
            artifacts: { window: { handle: target, previousHandle: request.handle, relocated: sent.relocated === true, process: sent.process || request.process || '', submitted: sent.submitted === true, text: String(output).slice(-MAX_TEXT) } }
          };
          if (cancelled.has(task.id)) return;
          tasks.set(task.id, finished);
          trimTasks();
          store.put('task', finished);
        } catch (error) {
          if (cancelled.has(task.id)) return;
          const failed = { ...task, status: 'failed', completedAt: new Date().toISOString(), error: String(error?.message || '窗口 Agent 执行失败').slice(0, 300) };
          tasks.set(task.id, failed);
          trimTasks();
          store.put('task', failed);
        }
      })();
      return task;
    },
    get: id => id && (tasks.get(id) || store.get('task', id)),
    stop(task) {
      if (!task) return;
      cancelled.add(task.id);
      const stopped = { ...task, status: 'cancelled', completedAt: new Date().toISOString() };
      tasks.set(task.id, stopped);
      trimTasks();
      store.put('task', stopped);
    },
    close() { tasks.clear(); cancelled.clear(); }
  };
}
