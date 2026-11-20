// MCP 工具可能很多，全部声明进每次模型请求会摊薄注意力、推高 token。
// 这里只做轻量词法检索：工具名命中权重最高，描述命中次之，中文按二元组切分。
const ASCII_WORD = /[a-z0-9_]+/g;
const HAN_RUN = /[\p{Script=Han}]+/gu;
const NAME_SPLIT = /[^a-z0-9_]+/g;
const DEFAULT_TOP_K = 16;

export function tokenizeToolText(value) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const words = text.match(ASCII_WORD) || [];
  const han = (text.match(HAN_RUN) || []).flatMap(run => (
    run.length === 1 ? [run] : Array.from({ length: run.length - 1 }, (_, index) => run.slice(index, index + 2))
  ));
  return [...words, ...han];
}

function toolParts(tool) {
  const fn = tool?.function && typeof tool.function === 'object' ? tool.function : {};
  return { name: String(fn.name || '').toLowerCase(), description: String(fn.description || '') };
}

export function scoreTool(tool, queryTokens) {
  const { name, description } = toolParts(tool);
  if (!name) return 0;
  const nameTokens = new Set(name.split(NAME_SPLIT).filter(Boolean));
  const frequencies = new Map();
  for (const token of tokenizeToolText(description)) frequencies.set(token, (frequencies.get(token) || 0) + 1);
  let score = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token)) score += 4;
    else if (name.includes(token)) score += 2;
    const hits = frequencies.get(token) || 0;
    if (hits) score += 1 + Math.log(hits);
  }
  return score;
}

/**
 * 选出与任务最相关的 k 个工具；`keep` 里的工具（例如本轮已经用过的）一定保留。
 * 结果按原始声明顺序返回，避免工具顺序随查询漂移。
 */
export function rankTools(tools, query, { k = DEFAULT_TOP_K, keep = [] } = {}) {
  const list = Array.isArray(tools)
    ? tools.filter(tool => tool?.function && typeof tool.function.name === 'string' && tool.function.name)
    : [];
  const limit = Number.isSafeInteger(k) && k > 0 ? k : DEFAULT_TOP_K;
  if (list.length <= limit) return list;
  const queryTokens = new Set(tokenizeToolText(query));
  const pinned = new Set((Array.isArray(keep) ? keep : []).map(name => String(name)));
  const scored = list.map((tool, index) => ({
    tool,
    index,
    score: scoreTool(tool, queryTokens),
    pinned: pinned.has(tool.function.name)
  }));
  scored.sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.score - left.score || left.index - right.index);
  return scored.slice(0, limit).sort((left, right) => left.index - right.index).map(row => row.tool);
}
