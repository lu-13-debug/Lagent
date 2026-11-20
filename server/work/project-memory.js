/**
 * 项目记忆：把每次执行沉淀成一条可复用的记录，并在新会话里作为上下文读回来。
 *
 * 一条记忆回答三个问题：谁改了什么、对项目的改进是什么、还欠什么问题。
 * 记忆先按执行结果落盘（不依赖模型），有模型时再异步替换成更好的总结。
 */
import { createHash, randomUUID } from 'node:crypto';

export const MEMORY_LIMITS = Object.freeze({
  maxEntries: 400,
  titleChars: 200,
  summaryChars: 800,
  items: 3,
  itemChars: 240,
  files: 60,
  digestChars: 1600,
  scopeChars: 200,
  tags: 10,
  tagChars: 40,
  reflectionChars: 120,
  maxReflections: 200,
  playbookItems: 3,
  playbookChars: 600,
});

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textList = (value, max, chars) =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, max).map(item => text(item, chars)) : [];

// 没有模型时的失败反思：先按可观测信号给一条可执行教训，再附上原因片段。
const FAILURE_LESSONS = [
  [/超时|timeout|timed out/i, '下次缩小单步范围，必要时拆分任务或调高超时'],
  [/回合|max_turns|步数|step limit/i, '下次把任务拆小，先完成一小块再继续，避免一步用完回合'],
  [/预算|token|额度/i, '下次先检索再局部读取，避免整文件读取把预算用尽'],
  [/找不到|不存在|ENOENT|not found|no such file/i, '下次先确认路径、命令和依赖存在，再开始改'],
  [/权限|拒绝|denied|EACCES|EPERM/i, '下次先确认权限档位和目标目录，不要绕过权限重试'],
  [/验收|测试|verify|test|assert/i, '下次改完立即跑验收命令，修到通过再收尾'],
  [/截断|truncat|too large|过大/i, '下次缩小输入或分段处理，避免一次提交过大内容'],
];

/** 从失败摘要生成 ≤120 字的反思，供下次同执行器任务前置注入。 */
export function deriveFailureLesson({ summary = '', status = '' } = {}) {
  const raw = String(summary || '').replace(/\s+/g, ' ').trim();
  const match = FAILURE_LESSONS.find(([pattern]) => pattern.test(raw));
  const base = match ? match[1] : status === 'blocked'
    ? '下次先确认阻塞项（数据、权限或依赖）已就绪，再重新执行'
    : '下次先复现失败，做最小改动后立即跑验收，再收尾';
  const reason = raw ? `（${text(raw, 60)}）` : '';
  return text(`${base}${reason}`, MEMORY_LIMITS.reflectionChars);
}

// 没有向量库时的轻量语义近似：英文按词、中文按二元组切。
// 比 includes 整句好得多——用户搜「登录失败」也能命中「token 校验导致登录 401」。
const CJK_STOP = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '一些', '以及', '或者', '但是', '然后',
  '如果', '因为', '所以', '可以', '需要', '进行', '已经', '还是', '就是', '不是', '没有',
]);
export function tokenizeQuery(query) {
  const value = String(query || '').toLowerCase();
  const tokens = new Set();
  for (const match of value.matchAll(/[a-z0-9][a-z0-9_./:-]{1,}/g)) tokens.add(match[0]);
  for (const match of value.matchAll(/[一-鿿]+/g)) {
    const run = match[0];
    if (run.length === 1) { tokens.add(run); continue; }
    for (let index = 0; index < run.length - 1; index += 1) {
      const pair = run.slice(index, index + 2);
      if (!CJK_STOP.has(pair)) tokens.add(pair);
    }
  }
  return [...tokens].slice(0, 24);
}

const normalizeScope = value => String(value || '')
  .replaceAll('\\', '/')
  .replace(/^\.?\//, '')
  .replace(/\/\*\*$/, '')
  .replace(/\/+$/, '')
  .toLowerCase();

/** 记忆条目的目录范围与任务范围是否相交（`server` 与 `server/work` 视为相交）。 */
export function scopeMatches(entryScope, scopes = []) {
  const target = normalizeScope(entryScope);
  if (!target) return false;
  return (Array.isArray(scopes) ? scopes : [scopes]).some(raw => {
    const scope = normalizeScope(raw);
    if (!scope) return false;
    return target === scope || target.startsWith(`${scope}/`) || scope.startsWith(`${target}/`);
  });
}

const recencyBoost = entry => {
  const stamp = Date.parse(entry.updatedAt || entry.createdAt || '') || 0;
  return Math.max(0, 1 - (Date.now() - stamp) / (90 * 86400000));
};

const SCORE_FIELDS = entry => [
  [entry.title, 3],
  [entry.scope, 2.5],
  [(entry.files || []).join(' '), 2],
  [(entry.tags || []).join(' '), 2],
  [entry.summary, 1.5],
  [(entry.improvements || []).join(' '), 1],
  [(entry.openQuestions || []).join(' '), 1],
];

/** 返回 null 表示一个词都没命中，这条不参与排序。 */
export function scoreMemoryEntry(entry, terms, { scopes = [] } = {}) {
  const fields = SCORE_FIELDS(entry).map(([value, weight]) => [String(value || '').toLowerCase(), weight]);
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    let hit = 0;
    for (const [value, weight] of fields) {
      if (!value.includes(term)) continue;
      hit += weight * Math.min(4, value.split(term).length - 1);
    }
    if (hit > 0) { matched += 1; score += hit; }
  }
  if (terms.length && !matched) return null;
  // 命中词越多越靠前，避免只命中一个高频词的长摘要压过精准条目。
  score += matched * 2;
  if (scopeMatches(entry.scope, scopes)) score += 4;
  score += recencyBoost(entry);
  return score;
}

const dayLabel = iso => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export function createProjectMemory(db, { now = () => new Date().toISOString() } = {}) {
  function list(projectId, limit = 20) {
    if (typeof projectId !== 'string' || !projectId.trim()) return [];
    return db
      .list('project-memory')
      .filter(entry => entry.projectId === projectId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.min(Math.max(Number(limit) || 20, 1), MEMORY_LIMITS.maxEntries));
  }

  function prune(projectId) {
    const rows = db
      .list('project-memory')
      .filter(entry => entry.projectId === projectId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    for (const row of rows.slice(MEMORY_LIMITS.maxEntries)) db.delete('project-memory', row.id);
  }

  const reflections = projectId => db
    .list('project-memory')
    .filter(entry => entry.projectId === projectId && entry.kind === 'reflection');

  // 反思单独限流：它比普通记忆短，但更新频繁；只保留最近 200 条。
  function pruneReflections(projectId) {
    const rows = reflections(projectId)
      .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')));
    for (const row of rows.slice(MEMORY_LIMITS.maxReflections)) db.delete('project-memory', row.id);
  }

  /**
   * 失败后写一条反思：同执行器、同失败类型、同教训只累加次数，不堆流水账。
   * 反思不被 update/remove 之外的路径改写，保证 playbook 条目只增、只合并、只淘汰。
   */
  function reflect(projectId, input = {}) {
    if (typeof projectId !== 'string' || !projectId.trim()) throw Object.assign(new Error('项目 id 无效'), { status: 400 });
    const lesson = text(input.summary || input.lesson, MEMORY_LIMITS.reflectionChars);
    if (!lesson) return null;
    const executorId = text(input.executorId, 60) || null;
    const failureCode = text(input.failureCode, 40) || 'failed';
    const files = textList(input.files, MEMORY_LIMITS.files, 200);
    const duplicate = reflections(projectId).find(row => row.executorId === executorId && row.failureCode === failureCode && row.lesson === lesson);
    if (duplicate) {
      const next = {
        ...duplicate,
        occurrences: (duplicate.occurrences || 1) + 1,
        negative: (duplicate.negative || 1) + 1,
        updatedAt: now(),
      };
      db.put('project-memory', next);
      pruneReflections(projectId);
      return next;
    }
    const entry = {
      id: randomUUID(),
      projectId,
      ticketId: text(input.ticketId, 80) || null,
      projectChatId: text(input.projectChatId, 80) || null,
      executorId,
      title: text(input.title ? `失败反思 · ${input.title}` : '失败反思', MEMORY_LIMITS.titleChars),
      status: text(input.status, 40) || 'failed',
      kind: 'reflection',
      failureCode,
      lesson,
      summary: lesson,
      files,
      improvements: [],
      openQuestions: [],
      scope: scopeOf(input, files),
      tags: ['reflection', failureCode, executorId].filter(Boolean).slice(0, MEMORY_LIMITS.tags),
      confidence: confidenceOf(input.confidence),
      source: 'local',
      model: null,
      occurrences: 1,
      positive: 0,
      negative: 1,
      createdAt: now(),
      updatedAt: now(),
    };
    db.put('project-memory', entry);
    pruneReflections(projectId);
    return entry;
  }

  /**
   * 任务成功后给同执行器、同目录的反思记一次正例；同一天只记一次，避免刷分。
   * 这不会改反思正文，只增加权重信号。
   */
  function reinforce(projectId, { executorId = '', success = false, scopes = [] } = {}) {
    if (typeof projectId !== 'string' || !projectId.trim() || !success) return 0;
    const today = now().slice(0, 10);
    let changed = 0;
    for (const row of reflections(projectId)) {
      if (executorId && row.executorId && row.executorId !== executorId) continue;
      if (scopes.length && row.scope && !scopeMatches(row.scope, scopes)) continue;
      if (row.lastPositiveOn === today) continue;
      db.put('project-memory', {
        ...row,
        positive: (row.positive || 0) + 1,
        lastPositiveOn: today,
        updatedAt: now(),
      });
      changed += 1;
    }
    return changed;
  }

  const reflectionWeight = row => {
    const positive = row.positive || 0;
    const negative = row.negative || 1;
    let weight = (1 + positive * 2) / (1 + negative);
    if (positive > 0 && negative === 0) weight *= 0.5;
    weight += Math.min(5, row.occurrences || 1) * 0.2 + recencyBoost(row);
    return weight;
  };

  /** 取同执行器最值得前置的失败教训；按目标与目录做轻量加权。 */
  function playbook(projectId, { executorId = '', goal = '', scopes = [], limit = MEMORY_LIMITS.playbookItems } = {}) {
    if (typeof projectId !== 'string' || !projectId.trim()) return [];
    const terms = tokenizeQuery(goal);
    const size = Math.min(Math.max(Number(limit) || MEMORY_LIMITS.playbookItems, 1), 10);
    return reflections(projectId)
      .filter(row => !executorId || !row.executorId || row.executorId === executorId)
      .map(row => {
        let score = reflectionWeight(row);
        if (terms.length) {
          const lexical = scoreMemoryEntry({ ...row, summary: row.lesson || row.summary }, terms, { scopes });
          if (lexical !== null) score += lexical;
        }
        if (scopes.length && row.scope && scopeMatches(row.scope, scopes)) score += 4;
        return { row, score };
      })
      .sort((left, right) => right.score - left.score || String(right.row.updatedAt || '').localeCompare(String(left.row.updatedAt || '')))
      .slice(0, size)
      .map(item => item.row);
  }

  function playbookDigest(projectId, options = {}) {
    const rows = playbook(projectId, options);
    if (!rows.length) return '';
    const lines = rows.map(row => {
      const times = (row.occurrences || 1) > 1 ? `（已出现 ${row.occurrences} 次）` : '';
      const credit = row.positive ? `已验证 ${row.positive} 次` : '尚未验证';
      return `- ${row.executorId || 'Agent'}：${row.lesson || row.summary}${times} · ${credit}`;
    });
    const body = ['【失败教训 · 同执行器上次踩过的坑】', ...lines].join('\n');
    return body.length > MEMORY_LIMITS.playbookChars ? `${body.slice(0, MEMORY_LIMITS.playbookChars)}…` : body;
  }

  // 同一项目里「标题 + 摘要 + 文件」完全一致时合并，而不是堆一条新的流水账。
  const fingerprint = (title, summary, files) => createHash('sha1')
    .update(`${title}\u0000${summary}\u0000${files.join('\u0000')}`)
    .digest('hex');
  const confidenceOf = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
  const scopeOf = (input, files) => {
    const explicit = text(input.scope, MEMORY_LIMITS.scopeChars);
    if (explicit) return explicit;
    const first = files[0];
    if (!first) return '';
    const parts = String(first).replaceAll('\\', '/').split('/');
    return parts.length > 1 ? parts.slice(0, -1).join('/').slice(0, MEMORY_LIMITS.scopeChars) : '';
  };

  function merge(existing, entry) {
    const next = {
      ...existing,
      status: entry.status || existing.status,
      summary: entry.summary || existing.summary,
      files: [...new Set([...(existing.files || []), ...entry.files])].slice(0, MEMORY_LIMITS.files),
      improvements: [...new Set([...(existing.improvements || []), ...entry.improvements])].slice(0, MEMORY_LIMITS.items),
      openQuestions: [...new Set([...(existing.openQuestions || []), ...entry.openQuestions])].slice(0, MEMORY_LIMITS.items),
      tags: [...new Set([...(existing.tags || []), ...entry.tags])].slice(0, MEMORY_LIMITS.tags),
      scope: entry.scope || existing.scope,
      confidence: Math.max(existing.confidence ?? 0, entry.confidence),
      source: entry.source === 'model' ? 'model' : existing.source,
      model: entry.model || existing.model,
      updatedAt: now(),
    };
    db.put('project-memory', next);
    return next;
  }

  function add(projectId, input = {}) {
    if (typeof projectId !== 'string' || !projectId.trim()) throw Object.assign(new Error('项目 id 无效'), { status: 400 });
    const files = textList(input.files, MEMORY_LIMITS.files, 200);
    const title = text(input.title, MEMORY_LIMITS.titleChars) || '一次执行';
    const summary = text(input.summary, MEMORY_LIMITS.summaryChars);
    const entry = {
      id: randomUUID(),
      projectId,
      ticketId: text(input.ticketId, 80) || null,
      projectChatId: text(input.projectChatId, 80) || null,
      executorId: text(input.executorId, 60) || null,
      title,
      status: text(input.status, 40) || null,
      // change：动了文件；note：没动文件但留下了结论（取舍、约束、待办）。
      kind: input.kind === 'note' ? 'note' : 'change',
      summary,
      files,
      improvements: textList(input.improvements, MEMORY_LIMITS.items, MEMORY_LIMITS.itemChars),
      openQuestions: textList(input.openQuestions, MEMORY_LIMITS.items, MEMORY_LIMITS.itemChars),
      scope: scopeOf(input, files),
      tags: textList(input.tags, MEMORY_LIMITS.tags, MEMORY_LIMITS.tagChars),
      confidence: confidenceOf(input.confidence),
      fingerprint: fingerprint(title, summary, files),
      source: input.source === 'model' ? 'model' : input.source === 'external' ? 'external' : 'local',
      model: input.model && typeof input.model === 'object' ? { provider: text(input.model.provider, 60), model: text(input.model.model, 80) } : null,
      createdAt: now(),
      updatedAt: now(),
    };
    // 同一条结论重复写入时合并到已有记录，避免记忆被流水账淹没。
    const duplicate = db.list('project-memory').find(row => row.projectId === projectId && row.fingerprint === entry.fingerprint);
    if (duplicate) return merge(duplicate, entry);
    db.put('project-memory', entry);
    prune(projectId);
    return entry;
  }

  function update(id, patch = {}) {
    const entry = db.get('project-memory', id);
    if (!entry) throw Object.assign(new Error('记忆不存在'), { status: 404 });
    const next = {
      ...entry,
      summary: patch.summary === undefined ? entry.summary : text(patch.summary, MEMORY_LIMITS.summaryChars),
      improvements: patch.improvements === undefined ? entry.improvements : textList(patch.improvements, MEMORY_LIMITS.items, MEMORY_LIMITS.itemChars),
      openQuestions: patch.openQuestions === undefined ? entry.openQuestions : textList(patch.openQuestions, MEMORY_LIMITS.items, MEMORY_LIMITS.itemChars),
      scope: patch.scope === undefined ? entry.scope : text(patch.scope, MEMORY_LIMITS.scopeChars),
      tags: patch.tags === undefined ? entry.tags : textList(patch.tags, MEMORY_LIMITS.tags, MEMORY_LIMITS.tagChars),
      confidence: patch.confidence === undefined ? entry.confidence : confidenceOf(patch.confidence),
      source: patch.source === 'model' ? 'model' : patch.source === 'external' ? 'external' : entry.source,
      model: patch.model && typeof patch.model === 'object' ? { provider: text(patch.model.provider, 60), model: text(patch.model.model, 80) } : entry.model,
      updatedAt: now(),
    };
    db.put('project-memory', next);
    return next;
  }

  /**
   * 按关键词/目录范围检索，返回最相关的前 N 条。
   * - query 走分词打分（英文词 + 中文二元组），不再要求整句命中；
   * - scopes 是当前任务要改的目录，命中的条目加分；不传时保持旧行为；
   * - 不传关键词也不传 scopes 时按最近排序。
   */
  function search(projectId, { query = '', scope = '', scopes = [], limit = 20 } = {}) {
    if (typeof projectId !== 'string' || !projectId.trim()) return [];
    const scopeFilter = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
    const requestedScopes = (Array.isArray(scopes) ? scopes : [scopes]).filter(item => typeof item === 'string' && item.trim());
    const terms = tokenizeQuery(query);
    const size = Math.min(Math.max(Number(limit) || 20, 1), MEMORY_LIMITS.maxEntries);
    const scored = [];
    for (const entry of db.list('project-memory')) {
      if (entry.projectId !== projectId) continue;
      if (scopeFilter && !String(entry.scope || '').toLowerCase().includes(scopeFilter)) continue;
      if (!terms.length && requestedScopes.length && !scopeMatches(entry.scope, requestedScopes)) continue;
      const score = terms.length || requestedScopes.length
        ? scoreMemoryEntry(entry, terms, { scopes: requestedScopes })
        : recencyBoost(entry);
      if (score === null) continue;
      scored.push({ entry, score });
    }
    return scored
      .sort((left, right) => right.score - left.score
        || String(right.entry.updatedAt || right.entry.createdAt || '').localeCompare(String(left.entry.updatedAt || left.entry.createdAt || '')))
      .slice(0, size)
      .map(row => row.entry);
  }

  function remove(id) {
    const entry = db.get('project-memory', id);
    if (!entry) throw Object.assign(new Error('记忆不存在'), { status: 404 });
    db.delete('project-memory', id);
    return { ok: true };
  }

  /** 最近若干条 + 跨会话还没解决的问题，拼成给模型/执行器看的一段话。 */
  function digest(projectId, { limit = 6, goal = '', scopes = [] } = {}) {
    const relevant = Boolean(String(goal || '').trim() || (Array.isArray(scopes) && scopes.length));
    const history = () => db
      .list('project-memory')
      .filter(entry => entry.projectId === projectId && entry.kind !== 'reflection')
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, Math.min(Math.max(Number(limit) || 6, 1), MEMORY_LIMITS.maxEntries));
    const searches = () => search(projectId, { query: goal, scopes, limit }).filter(row => row.kind !== 'reflection');
    let rows = relevant ? searches() : history();
    const relevantHit = relevant && rows.length > 0;
    // 命中不到相关条目时退回最近记录：总比让执行器以为项目没有历史要好。
    if (!rows.length) rows = history();
    if (!rows.length) return '';
    const total = db.list('project-memory').filter(entry => entry.projectId === projectId && entry.kind !== 'reflection').length;
    const lines = [];
    for (const row of rows) {
      const who = row.executorId || 'Agent';
      const what = row.kind === 'note' ? '结论' : '改动';
      lines.push(`- ${dayLabel(row.createdAt)} · ${who} · ${what}：${row.title}`);
      if (row.summary) lines.push(`  做了什么：${row.summary}`);
      if (row.improvements.length) lines.push(`  改进：${row.improvements.join('；')}`);
      if (row.openQuestions.length) lines.push(`  待办：${row.openQuestions.join('；')}`);
      if (row.files.length) lines.push(`  改动文件：${row.files.slice(0, 6).join('、')}${row.files.length > 6 ? ` 等 ${row.files.length} 个` : ''}`);
    }
    // 待办跟着选中的条目走：按任务检索时，不要把别的目录、别的任务的问题一起塞进来。
    const open = [];
    const selected = new Set(rows.map(row => row.id));
    for (const row of db.list('project-memory').filter(entry => entry.projectId === projectId && selected.has(entry.id))) {
      for (const question of row.openQuestions) if (!open.includes(question)) open.push(question);
    }
    const header = relevantHit
      ? `项目记忆（与本任务相关的 ${rows.length} 条 / 共 ${total} 条）`
      : `项目记忆（最近 ${rows.length} 条 / 共 ${total} 条）`;
    const body = [header, '只记项目的关键改动：动了文件，或留下了结论；同一项目下的所有对话共享，单次对话的闲聊不写进来。', ...lines, ...(open.length ? ['还没解决的问题：', ...open.slice(0, 8).map(item => `- ${item}`)] : [])].join('\n');
    return body.length > MEMORY_LIMITS.digestChars ? `${body.slice(0, MEMORY_LIMITS.digestChars)}…` : body;
  }

  return { list, add, update, remove, digest, search, reflect, reinforce, playbook, playbookDigest };
}

/** 不依赖模型的兜底总结：从执行报告里提取「做了什么」，文件清单来自 git 快照。 */
export function summarizeExecution({ ticket, report, files = [], status } = {}) {
  const title = text(ticket?.title, MEMORY_LIMITS.titleChars) || '一次执行';
  const raw = text(report?.summary, 2400) || text(ticket?.command, 600);
  const summary = raw.replace(/\s+/g, ' ').slice(0, MEMORY_LIMITS.summaryChars);
  const openQuestions = [];
  if (status === 'failed' || status === 'blocked') openQuestions.push(`上次执行${status === 'failed' ? '失败' : '受阻'}，需要重新安排：${title}`);
  return {
    title,
    summary,
    files: textList(files, MEMORY_LIMITS.files, 200),
    improvements: [],
    openQuestions,
    status: status || null,
  };
}
