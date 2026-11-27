import { randomUUID } from 'node:crypto';

// 工作流：把一条多步计划存成可重复执行的模板。执行仍然走 startPlan，
// 不引入第二套调度器；工作流只负责「记住步骤、校验步骤、发起一次运行」。
const MAX_WORKFLOWS = 100;
const MAX_STEPS = 5;
const MIN_STEPS = 2;

const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';

function workflowError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeWorkflowSteps(steps) {
  if (!Array.isArray(steps) || steps.length < MIN_STEPS || steps.length > MAX_STEPS) {
    throw workflowError(`工作流需要 ${MIN_STEPS}–${MAX_STEPS} 个步骤`);
  }
  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) throw workflowError(`第 ${index + 1} 步参数无效`);
    const executorId = text(step.executorId, 60);
    if (!executorId) throw workflowError(`第 ${index + 1} 步必须指定 executorId`);
    const body = text(step.text, 3000);
    if (!body) throw workflowError(`第 ${index + 1} 步说明不能为空`);
    const dependsOn = step.dependsOn === undefined ? [] : step.dependsOn;
    if (!Array.isArray(dependsOn) || dependsOn.length > 3) throw workflowError(`第 ${index + 1} 步依赖必须是最多 3 项的数组`);
    if (new Set(dependsOn).size !== dependsOn.length || dependsOn.some(item => !Number.isInteger(item) || item < 0 || item >= index)) {
      throw workflowError(`第 ${index + 1} 步依赖必须引用更早步骤`);
    }
    return {
      executorId,
      text: body,
      dependsOn: [...dependsOn],
      ...(step.verify && typeof step.verify === 'object' ? { verify: step.verify } : {}),
      ...(step.contract && typeof step.contract === 'object' ? { contract: step.contract } : {}),
      ...(Array.isArray(step.scope) ? { scope: step.scope.filter(item => typeof item === 'string').slice(0, 6) } : {})
    };
  });
}

export function createWorkflowService(store, { startPlan, listExecutors = () => [] } = {}) {
  if (!store?.put) throw new TypeError('工作流服务需要 Store');
  if (typeof startPlan !== 'function') throw new TypeError('工作流服务需要 startPlan');

  function list() {
    return store.list('workflow').sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }

  function get(id) {
    const row = store.get('workflow', text(id, 100));
    if (!row) throw workflowError('工作流不存在', 404);
    return row;
  }

  function save(input = {}) {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const id = text(body.id, 100);
    const existing = id ? store.get('workflow', id) : null;
    if (id && !existing) throw workflowError('工作流不存在', 404);
    if (!existing && list().length >= MAX_WORKFLOWS) throw workflowError(`最多保存 ${MAX_WORKFLOWS} 个工作流`, 400);
    const name = text(body.name, 60);
    if (!name) throw workflowError('工作流需要名称', 400);
    const goal = text(body.goal, 4000);
    if (!goal) throw workflowError('工作流需要目标', 400);
    const steps = normalizeWorkflowSteps(body.steps);
    const known = new Set(listExecutors());
    const unknown = known.size ? steps.map(step => step.executorId).filter(executor => !known.has(executor)) : [];
    if (unknown.length) throw workflowError(`执行器不可用：${[...new Set(unknown)].join('、')}`, 400);
    const stamp = new Date().toISOString();
    const row = {
      id: existing?.id || randomUUID(),
      name,
      goal,
      steps,
      ...(text(body.projectId, 100) ? { projectId: text(body.projectId, 100) } : {}),
      ...(text(body.projectChatId, 100) ? { projectChatId: text(body.projectChatId, 100) } : {}),
      runs: Array.isArray(existing?.runs) ? existing.runs.slice(0, 20) : [],
      createdAt: existing?.createdAt || stamp,
      updatedAt: stamp
    };
    store.put('workflow', row);
    return row;
  }

  // 起一次运行：走 startPlan，把返回的计划 id 记到工作流上，方便回看每次结果。
  function run(id, { autoRun = false, clientRequestId = '' } = {}) {
    const row = get(id);
    const plan = startPlan({
      goal: row.goal,
      steps: row.steps,
      autoRun: autoRun === true,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.projectChatId ? { projectChatId: row.projectChatId } : {}),
      ...(text(clientRequestId, 120) ? { clientRequestId: text(clientRequestId, 120) } : {})
    });
    const stamp = new Date().toISOString();
    const runRow = { planId: plan.id, at: stamp, autoRun: autoRun === true };
    store.put('workflow', { ...row, runs: [runRow, ...row.runs].slice(0, 20), lastRunAt: stamp, updatedAt: stamp });
    return { workflow: get(id), plan };
  }

  function remove(id) {
    const row = get(id);
    store.delete('workflow', row.id);
    return { id: row.id, removed: true };
  }

  return { list, get, save, run, remove };
}
