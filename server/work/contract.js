import { workError } from './domain.js';

// 任务契约：把「目标、输入、约束、验收、工具、预算、截止、回报」变成结构化字段，
// 规划器、执行器和验收器共用同一份，不再靠自由文本传话。
const LISTS = {
  inputs: { max: 20, chars: 500 },
  constraints: { max: 30, chars: 500 },
  acceptance: { max: 20, chars: 500 },
  tools: { max: 20, chars: 100 }
};
const BUDGET_KEYS = ['tokens', 'wallMs', 'calls'];
const REPORT_KEYS = ['summary', 'evidence', 'next'];

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function stringList(value, label, { max, chars }) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw workError(`${label} 必须是字符串数组`);
  if (value.length > max) throw workError(`${label} 最多 ${max} 项`);
  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, chars)))];
}

/**
 * 规范化任务契约；未提供契约时返回 null（保持旧任务不携带契约）。
 * 只接受文档里列出的字段，避免把任意 JSON 塞进工单。
 */
export function normalizeContract(input) {
  if (input === undefined || input === null) return null;
  if (!isObject(input)) throw workError('contract 必须是对象');
  const allowed = ['objective', 'inputs', 'constraints', 'acceptance', 'tools', 'budget', 'deadlineMs', 'report'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) throw workError(`contract 包含未知字段：${unknown.join('、')}`);

  const objective = text(input.objective, 500);
  const contract = {
    objective,
    inputs: stringList(input.inputs, 'contract.inputs', LISTS.inputs),
    constraints: stringList(input.constraints, 'contract.constraints', LISTS.constraints),
    acceptance: stringList(input.acceptance, 'contract.acceptance', LISTS.acceptance),
    tools: stringList(input.tools, 'contract.tools', LISTS.tools)
  };

  if (input.budget !== undefined) {
    if (!isObject(input.budget)) throw workError('contract.budget 必须是对象');
    const unknownBudget = Object.keys(input.budget).filter(key => !BUDGET_KEYS.includes(key));
    if (unknownBudget.length) throw workError(`contract.budget 包含未知字段：${unknownBudget.join('、')}`);
    const budget = {};
    for (const key of BUDGET_KEYS) {
      if (input.budget[key] === undefined) continue;
      const value = integer(input.budget[key]);
      if (value === null) throw workError(`contract.budget.${key} 必须是非负整数`);
      budget[key] = value;
    }
    if (Object.keys(budget).length) contract.budget = budget;
  }

  if (input.deadlineMs !== undefined) {
    const deadline = integer(input.deadlineMs);
    if (deadline === null || deadline < 1000 || deadline > 86400000) throw workError('contract.deadlineMs 须为 1000–86400000 的整数');
    contract.deadlineMs = deadline;
  }

  if (input.report !== undefined) {
    if (!isObject(input.report)) throw workError('contract.report 必须是对象');
    const unknownReport = Object.keys(input.report).filter(key => !REPORT_KEYS.includes(key));
    if (unknownReport.length) throw workError(`contract.report 包含未知字段：${unknownReport.join('、')}`);
    contract.report = {
      summary: text(input.report.summary, 500),
      evidence: stringList(input.report.evidence, 'contract.report.evidence', { max: 20, chars: 500 }),
      next: stringList(input.report.next, 'contract.report.next', { max: 20, chars: 500 })
    };
  }

  // 空契约没有意义：至少要有一项内容，避免前端误传 {}。
  const empty = !contract.objective && !contract.inputs.length && !contract.constraints.length
    && !contract.acceptance.length && !contract.tools.length && !contract.budget && !contract.deadlineMs && !contract.report;
  if (empty) throw workError('contract 不能为空');
  return contract;
}

/** 把契约压成一段给执行器看的文本；没有契约时返回空串。 */
export function contractBrief(contract) {
  if (!contract) return '';
  const lines = [];
  if (contract.objective) lines.push(`目标：${contract.objective}`);
  if (contract.inputs?.length) lines.push(`输入：${contract.inputs.join('；')}`);
  if (contract.constraints?.length) lines.push(`约束：${contract.constraints.join('；')}`);
  if (contract.acceptance?.length) lines.push(`验收：${contract.acceptance.join('；')}`);
  if (contract.tools?.length) lines.push(`可用工具：${contract.tools.join('、')}`);
  if (contract.budget) lines.push(`预算：${Object.entries(contract.budget).map(([key, value]) => `${key}=${value}`).join('，')}`);
  if (contract.deadlineMs) lines.push(`截止：${contract.deadlineMs}ms`);
  if (contract.report) lines.push(`回报：${contract.report.summary || '按要求给出结论'}${contract.report.evidence?.length ? `（证据：${contract.report.evidence.join('；')}）` : ''}`);
  return lines.length ? `【任务契约】\n${lines.join('\n')}` : '';
}
