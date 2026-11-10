// 执行器能力表：编排时按「这步需要什么」挑人，而不是让模型瞎点名。
// 与 executors 里的 capabilities 字段互补——这里只描述「编排意义上的能力」，
// 用于在可用 Agent 之间做匹配与打分。
export const CAPABILITY_TABLE = Object.freeze({
  model: { reads: true, writes: true, commands: true, browser: false, github: false, summarize: true, parallelSafe: false, weight: 2 },
  'claude-code': { reads: true, writes: true, commands: true, browser: false, github: true, summarize: true, parallelSafe: false, weight: 3 },
  'codex': { reads: true, writes: true, commands: true, browser: false, github: true, summarize: true, parallelSafe: false, weight: 3 },
  'claude-acp': { reads: true, writes: true, commands: true, browser: false, github: true, summarize: true, parallelSafe: false, weight: 3 },
  'dsh-acp': { reads: true, writes: true, commands: true, browser: false, github: true, summarize: true, parallelSafe: false, weight: 3 },
  'codex-acp': { reads: true, writes: true, commands: true, browser: false, github: true, summarize: true, parallelSafe: false, weight: 3 },
  analysis: { reads: true, writes: false, commands: false, browser: false, github: false, summarize: true, parallelSafe: false, weight: 1 },
  terminal: { reads: true, writes: false, commands: true, browser: false, github: false, summarize: false, parallelSafe: false, weight: 1 },
  browser: { reads: false, writes: false, commands: false, browser: true, github: false, summarize: false, parallelSafe: true, weight: 1 },
  github: { reads: true, writes: false, commands: false, browser: false, github: true, summarize: false, parallelSafe: true, weight: 1 },
  window: { reads: true, writes: true, commands: true, browser: false, github: false, summarize: true, parallelSafe: false, weight: 2 }
});

const EMPTY = Object.freeze({ reads: false, writes: false, commands: false, browser: false, github: false, summarize: false, parallelSafe: false, weight: 0 });

export function capabilitiesOf(executorId) {
  return CAPABILITY_TABLE[executorId] || EMPTY;
}

// need 例：{ writes: true, commands: true }；只有写 true 的键才参与匹配。
export function matches(executorId, need = {}) {
  const caps = capabilitiesOf(executorId);
  return Object.keys(need).every(key => (need[key] ? caps[key] === true : true));
}

// 在候选里挑最合适的：先按满足的硬需求过滤，再按 weight、内置模型优先兜底。
export function pickExecutor(available, need = {}, preferred = []) {
  const candidates = available.filter(id => matches(id, need));
  if (!candidates.length) return null;
  const score = id => {
    const caps = capabilitiesOf(id);
    const pref = preferred.indexOf(id);
    return (pref === -1 ? 0 : (preferred.length - pref) * 10) + caps.weight;
  };
  return candidates.slice().sort((left, right) => score(right) - score(left))[0];
}

// 能不能并行：同一轮里两个步骤都不动文件，且互不依赖，才可以同时跑。
export function parallelSafe(executorId) {
  return capabilitiesOf(executorId).parallelSafe === true;
}