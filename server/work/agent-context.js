/**
 * 按执行器裁剪上下文。
 *
 * 两件事：
 * - 配置档 Library（instructions / skills / mcpServers）里可以写 `[codex]`、`[claude-code]`
 *   这样的前缀，只给对应执行器看；不写前缀则所有执行器共享。
 * - 项目简报里的条目也支持同样前缀，避免把「Codex 的约定」塞给 Claude Code。
 *
 * 这里只做纯字符串处理，不读数据库、不碰执行器；调用方负责把结果拼进提示词。
 */

const TAG = /^\s*\[([a-z0-9*_-]+)\]\s*(.*)$/i;
const text = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** 把 `[codex] 先跑测试` 拆成 `{target:'codex', text:'先跑测试'}`；没有前缀时 target 为空。 */
export function splitAgentTag(value) {
  const raw = text(value);
  const match = TAG.exec(raw);
  if (!match) return { target: '', text: raw };
  return { target: match[1].toLowerCase(), text: match[2].trim() };
}

const appliesTo = (target, executorId) => !target || target === '*' || target === executorId;

/** 取当前执行器能看到的条目：公共条目 + 指向它的条目。 */
export function forAgent(items, executorId = '') {
  return (Array.isArray(items) ? items : [])
    .map(splitAgentTag)
    .filter(item => item.text && appliesTo(item.target, executorId))
    .map(item => item.text);
}

const charLength = value => [...String(value)].length;

/** 按字符（而不是 UTF-16 码元）截断，避免把中文或 emoji 切坏。 */
function clipChars(value, max) {
  if (max <= 0) return '';
  const chars = [...String(value)];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function fitLines(lines, budget) {
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const separator = kept.length ? 1 : 0;
    const room = budget - used - separator;
    if (room <= 0) break;
    const clipped = clipChars(line, room);
    if (!clipped) break;
    kept.push(clipped);
    used += separator + charLength(clipped);
  }
  return { lines: kept, used };
}

/**
 * 把配置档 Library 变成一段给执行器的上下文。
 *
 * 三层预算，从高密度到低密度：
 * - system：工作约定，必须保留；
 * - working：登记技能，帮助选择做法；
 * - recall：可用 MCP 服务，只在还有余量时提示。
 *
 * 低优先级层先被淘汰；上层没用完的预算可以顺延给下层。
 * instructions 是真正的规则文本；skills / mcpServers 目前只是登记名称，所以只做清单提示。
 */
export function buildLibraryContext(library, { executorId = '', maxChars = 1200 } = {}) {
  const instructions = forAgent(library?.instructions, executorId);
  const skills = forAgent(library?.skills, executorId);
  const mcpServers = forAgent(library?.mcpServers, executorId);
  if (!instructions.length && !skills.length && !mcpServers.length) return '';
  const header = '【工作区配置 · 来自 Lagent 配置档】';
  if (maxChars <= charLength(header) + 1) return clipChars(header, maxChars);
  // 减去 header 后的换行；每一层之间也各占一个换行。
  let remaining = maxChars - charLength(header) - 1;
  const layers = [
    instructions.length ? ['工作约定（必须遵守）：', ...instructions.map(item => `- ${item}`)] : [],
    skills.length ? [`登记技能：${skills.join('、')}。执行相关任务时按对应技能的做法与检查表来做。`] : [],
    mcpServers.length ? [`可用 MCP 服务：${mcpServers.join('、')}。`] : []
  ];
  const kept = [];
  for (const lines of layers) {
    if (!lines.length || remaining <= 0) continue;
    if (kept.length) remaining -= 1;
    if (remaining <= 0) break;
    const fitted = fitLines(lines, remaining);
    kept.push(...fitted.lines);
    remaining -= fitted.used;
  }
  return [header, ...kept].join('\n');
}

/**
 * library-sync 用：把 Library 拆成「公共」和「按 Agent」两部分。
 * 公共部分不重复出现在每个 Agent 名下，否则 AGENTS.md 会变成复读机。
 */
export function splitLibraryByAgent(library, executorIds = []) {
  const common = { instructions: [], skills: [], mcpServers: [] };
  const agents = {};
  for (const key of ['instructions', 'skills', 'mcpServers']) {
    for (const item of Array.isArray(library?.[key]) ? library[key] : []) {
      const parsed = splitAgentTag(item);
      if (!parsed.text) continue;
      if (!parsed.target || parsed.target === '*') common[key].push(parsed.text);
      else {
        if (!agents[parsed.target]) agents[parsed.target] = { instructions: [], skills: [], mcpServers: [] };
        agents[parsed.target][key].push(parsed.text);
      }
    }
  }
  // 只保留调用方关心的 Agent；用户可能在配置档里写了一个当前没装的执行器。
  const wanted = Array.isArray(executorIds) && executorIds.length ? new Set(executorIds) : null;
  const picked = {};
  for (const [id, value] of Object.entries(agents)) if (!wanted || wanted.has(id)) picked[id] = value;
  return { common, agents: picked };
}
