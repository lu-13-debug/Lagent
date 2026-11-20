// 命令风险分类：给 shell 命令一个粗粒度等级，用于审批与阻断。
// 规则、原因与等级都来自 rules.js 的同一张表，不再单独维护 blocked/danger/write 名单。
import { COMMAND_RULES, evaluateCommandPolicy } from './rules.js';

export { COMMAND_RULES, evaluateCommandPolicy, ruleSummary } from './rules.js';

const LEVEL_ORDER = Object.freeze({ read: 0, write: 1, danger: 2, blocked: 3 });

function classifyLevel(value) {
  let best = { level: 'read', reasons: [] };
  for (const item of COMMAND_RULES) {
    if (!item.level || item.level === 'read' || !item.test(value)) continue;
    if (LEVEL_ORDER[item.level] < LEVEL_ORDER[best.level]) continue;
    if (item.level === best.level) {
      if (!best.reasons.includes(item.reason)) best.reasons.push(item.reason);
    } else {
      best = { level: item.level, reasons: [item.reason] };
    }
  }
  return best;
}

/**
 * @returns {{level:'read'|'write'|'danger'|'blocked', reasons:string[], policy?:object}}
 */
export function classifyCommand(command) {
  const value = String(command || '').trim();
  if (!value) return { level: 'read', reasons: [] };

  const policy = evaluateCommandPolicy(value);
  if (policy.action === 'stop') return { level: 'blocked', reasons: [policy.reason], policy };

  const judged = classifyLevel(value);
  if (judged.level === 'blocked') return { level: 'blocked', reasons: judged.reasons, policy };
  if (judged.level === 'danger') return { level: 'danger', reasons: judged.reasons, policy };
  if (judged.level === 'write') return { level: 'write', reasons: judged.reasons, policy };

  // 分号/管道按段判断：每段都是只读才算只读。
  const segments = value.split(/[;|]/).map(part => part.trim()).filter(Boolean);
  const readRules = COMMAND_RULES.filter(item => item.level === 'read');
  if (segments.length && segments.every(segment => readRules.some(item => item.test(segment)))) {
    // 规则表认为需要确认时，即使看着像只读（例如 cat .env）也不能按只读放行。
    if (policy.action === 'ask' || policy.action === 'llm_check') return { level: 'danger', reasons: [policy.reason], policy };
    return { level: 'read', reasons: [], policy };
  }
  return { level: 'write', reasons: ['未识别的命令，按写入处理'], policy };
}

export function isBlockedCommand(command) {
  return classifyCommand(command).level === 'blocked';
}
