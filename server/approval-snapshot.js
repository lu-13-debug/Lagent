import { createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

// Only business content belongs here: transport events and progress are not
// approval subjects. Invalidated outputs cannot contribute approved evidence.
export function buildApprovalSnapshot(task) {
  const step = task.steps?.[task.currentStep];
  if (!task.workflowSnapshot || task.status !== 'awaiting_approval' || !step) return undefined;
  const content = {
    taskId: task.id, stepId: step.id, currentStep: task.currentStep,
    goal: task.goal, nonGoals: task.nonGoals, budget: task.budget,
    scope: [...(task.skippedSteps || [])].sort(),
    background: (task.messages || []).filter(message => message.role === 'user').map(message => message.content),
    workflow: task.workflowSnapshot, contract: task.analysisContract,
    datasetId: task.datasetId, datasetVersion: task.datasetVersion,
    derivedDatasetId: task.derivedDatasetId,
    artifacts: Object.fromEntries(Object.entries(task.artifacts || {}).filter(([, artifact]) => !artifact.scopeInvalidated)),
    report: task.report,
  };
  return { version: 1, stepId: step.id, hash: createHash('sha256').update(JSON.stringify(canonical(content))).digest('hex') };
}

export const sameApprovalSnapshot = (left, right) => Boolean(left && right && left.version === right.version && left.stepId === right.stepId && typeof left.hash === 'string' && left.hash === right.hash);
