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

/** 只取明确指向该执行器的条目（library-sync 的「按 Agent」分节用）。 */
export function taggedForAgent(items, executorId = '') {
  return (Array.isArray(items) ? items : [])
    .map(splitAgentTag)
    .filter(item => item.text && item.target === executorId)
    .map(item => item.text);
}

/**
 * 把配置档 Library 变成一段给执行器的上下文。
 * instructions 是真正的规则文本；skills / mcpServers 目前只是登记名称，所以只做清单提示。
 */
export function buildLibraryContext(library, { executorId = '', maxChars = 1200 } = {}) {
  const instructions = forAgent(library?.instructions, executorId);
  const skills = forAgent(library?.skills, executorId);
  const mcpServers = forAgent(library?.mcpServers, executorId);
  if (!instructions.length && !skills.length && !mcpServers.length) return '';
  const lines = ['【工作区配置 · 来自 Lagent 配置档】'];
  if (instructions.length) {
    lines.push('工作约定（必须遵守）：');
    for (const item of instructions) lines.push(`- ${item}`);
  }
  if (skills.length) lines.push(`登记技能：${skills.join('、')}。执行相关任务时按对应技能的做法与检查表来做。`);
  if (mcpServers.length) lines.push(`可用 MCP 服务：${mcpServers.join('、')}。`);
  const body = lines.join('\n');
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
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
