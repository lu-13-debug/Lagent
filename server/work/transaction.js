// 事务语义的最小实现：检查点、补偿清单、幂等键。
// 原则：副作用先记清楚再推进；回滚命令不自动执行，必须由人确认后触发。
const CHECKPOINT_KIND = 'work-checkpoint';
const COMPENSATION_KIND = 'work-compensation';

export function normalizeCompensation(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const command = value.trim().slice(0, 2000);
    return command ? { command, label: command.slice(0, 80) } : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const command = typeof value.command === 'string' ? value.command.trim().slice(0, 2000) : '';
  if (!command) return null;
  return {
    command,
    label: (typeof value.label === 'string' && value.label.trim() ? value.label.trim() : command).slice(0, 120)
  };
}

export function idempotencyKey({ ticketId, stepId = '', attempt = 1, kind = 'launch', key = '' }) {
  return [
    kind,
    String(ticketId || '').slice(0, 100),
    String(stepId || '-').slice(0, 100),
    Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1,
    String(key || '-').slice(0, 100)
  ].join(':');
}

/** 在计划推进前落一份检查点：哪些步骤完成、产生了哪些文件。 */
export function recordCheckpoint(store, { planId, step, tickets = [], files = [] } = {}, at = new Date().toISOString()) {
  const id = `${String(planId).slice(0, 100)}-${Number.isSafeInteger(step) ? step : 0}`;
  const row = {
    id,
    planId,
    step: Number.isSafeInteger(step) ? step : 0,
    completed: tickets.filter(ticket => ticket?.status === 'completed').map(ticket => ({ id: ticket.id, executor: ticket.executor, title: ticket.title, planStep: ticket.planStep })),
    files: [...new Set(files)].slice(0, 200),
    at
  };
  if (typeof store.atomic === 'function') store.atomic(() => store.put(CHECKPOINT_KIND, row));
  else store.put(CHECKPOINT_KIND, row);
  return row;
}

export function latestCheckpoint(store, planId) {
  return store.list(CHECKPOINT_KIND)
    .filter(row => row.planId === planId)
    .sort((left, right) => right.step - left.step || String(right.at).localeCompare(String(left.at)))[0] || null;
}

/** 按逆序生成补偿清单：只有完成的步骤、且声明了 compensate 才需要回滚。 */
export function compensationPlan(plan, tickets = []) {
  const rows = [];
  for (const step of [...(plan?.steps || [])].reverse()) {
    const ticket = tickets.find(item => item?.id === step.ticketId);
    if (!ticket || ticket.status !== 'completed') continue;
    const compensate = normalizeCompensation(step.compensate);
    if (!compensate) continue;
    rows.push({
      step: step.index,
      ticketId: step.ticketId,
      executor: step.executorId,
      label: compensate.label,
      command: compensate.command
    });
  }
  return rows;
}

export function rememberCompensations(store, planId, rows, at = new Date().toISOString()) {
  return rows.map(row => {
    const id = `${planId}-${row.step}`;
    const record = { id, planId, ...row, status: 'pending', createdAt: at };
    if (typeof store.atomic === 'function') store.atomic(() => store.put(COMPENSATION_KIND, record));
    else store.put(COMPENSATION_KIND, record);
    return record;
  });
}

export function listCompensations(store, planId) {
  return store.list(COMPENSATION_KIND).filter(row => row.planId === planId).sort((left, right) => right.step - left.step);
}

export function markCompensation(store, planId, step, status, error = '') {
  const id = `${planId}-${step}`;
  const row = store.get(COMPENSATION_KIND, id);
  if (!row) return null;
  const next = { ...row, status, ...(error ? { error: String(error).slice(0, 200) } : {}), updatedAt: new Date().toISOString() };
  if (typeof store.atomic === 'function') store.atomic(() => store.put(COMPENSATION_KIND, next));
  else store.put(COMPENSATION_KIND, next);
  return next;
}
