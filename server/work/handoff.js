import { workError } from './domain.js';

// 结构化交接：把「已完成、产物、证据、决定、未解问题、下一步」写清楚，
// 下一个 Agent 不用重读整段历史。字段全部可选，但至少要有内容。
const LISTS = ['artifacts', 'evidence', 'decisions', 'openQuestions', 'nextSteps'];
const BUDGET_KEYS = ['tokens', 'calls', 'wallMs'];
const MAX_ITEMS = 20;
const MAX_CHARS = 500;

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max = MAX_CHARS) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function stringList(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw workError(`${label} 必须是字符串数组`);
  if (value.length > MAX_ITEMS) throw workError(`${label} 最多 ${MAX_ITEMS} 项`);
  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, MAX_CHARS)))];
}

export function normalizeHandoff(input) {
  if (input === undefined || input === null) return null;
  if (!isObject(input)) throw workError('handoff 必须是对象');
  const allowed = ['summary', ...LISTS, 'budgetUsed'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) throw workError(`handoff 包含未知字段：${unknown.join('、')}`);
  const handoff = {
    summary: clip(input.summary),
    artifacts: stringList(input.artifacts, 'handoff.artifacts'),
    evidence: stringList(input.evidence, 'handoff.evidence'),
    decisions: stringList(input.decisions, 'handoff.decisions'),
    openQuestions: stringList(input.openQuestions, 'handoff.openQuestions'),
    nextSteps: stringList(input.nextSteps, 'handoff.nextSteps')
  };
  if (input.budgetUsed !== undefined) {
    if (!isObject(input.budgetUsed)) throw workError('handoff.budgetUsed 必须是对象');
    const unknownBudget = Object.keys(input.budgetUsed).filter(key => !BUDGET_KEYS.includes(key));
    if (unknownBudget.length) throw workError(`handoff.budgetUsed 包含未知字段：${unknownBudget.join('、')}`);
    const budget = {};
    for (const key of BUDGET_KEYS) {
      if (input.budgetUsed[key] === undefined) continue;
      const value = integer(input.budgetUsed[key]);
      if (value === null) throw workError(`handoff.budgetUsed.${key} 必须是非负整数`);
      budget[key] = value;
    }
    if (Object.keys(budget).length) handoff.budgetUsed = budget;
  }
  const empty = !handoff.summary && !handoff.artifacts.length && !handoff.evidence.length && !handoff.decisions.length
    && !handoff.openQuestions.length && !handoff.nextSteps.length && !handoff.budgetUsed;
  if (empty) throw workError('handoff 不能为空');
  return handoff;
}

export function handoffBrief(handoff, { sourceTitle = '', sourceSummary = '' } = {}) {
  if (!handoff) return '';
  const lines = ['【交接简报】'];
  if (sourceTitle) lines.push(`来源：${sourceTitle}`);
  const section = (label, value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      if (!value.length) return;
      lines.push(`${label}：`);
      for (const item of value) lines.push(`- ${item}`);
      return;
    }
    lines.push(`${label}：${value}`);
  };
  section('已完成', handoff.summary || sourceSummary);
  section('产物', handoff.artifacts);
  section('证据', handoff.evidence);
  section('关键决定', handoff.decisions);
  section('未解问题', handoff.openQuestions);
  section('下一步', handoff.nextSteps);
  if (handoff.budgetUsed) lines.push(`已用资源：${Object.entries(handoff.budgetUsed).map(([key, value]) => `${key}=${value}`).join('，')}`);
  return lines.join('\n').slice(0, 4000);
}
