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
});

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const textList = (value, max, chars) =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, max).map(item => text(item, chars)) : [];

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

  /** 按关键词/范围检索，返回最相关的前 N 条；不传关键词时按最近排序。 */
  function search(projectId, { query = '', scope = '', limit = 20 } = {}) {
    if (typeof projectId !== 'string' || !projectId.trim()) return [];
    const keyword = typeof query === 'string' ? query.trim().toLowerCase() : '';
    const scopeFilter = typeof scope === 'string' ? scope.trim().toLowerCase() : '';
    const size = Math.min(Math.max(Number(limit) || 20, 1), MEMORY_LIMITS.maxEntries);
    const scored = [];
    for (const entry of db.list('project-memory')) {
      if (entry.projectId !== projectId) continue;
      if (scopeFilter && !String(entry.scope || '').toLowerCase().includes(scopeFilter)) continue;
      let score = 0;
      if (keyword) {
        const haystack = [entry.title, entry.summary, entry.scope, ...(entry.files || []), ...(entry.openQuestions || []), ...(entry.tags || [])]
          .filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(keyword)) continue;
        score += haystack.split(keyword).length - 1;
        if (String(entry.title || '').toLowerCase().includes(keyword)) score += 2;
      }
      const stamp = Date.parse(entry.updatedAt || entry.createdAt || '') || 0;
      score += Math.max(0, 1 - (Date.now() - stamp) / (90 * 86400000));
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
  function digest(projectId, { limit = 6 } = {}) {
    const rows = list(projectId, limit);
    if (!rows.length) return '';
    const total = db.list('project-memory').filter(entry => entry.projectId === projectId).length;
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
    const open = [];
    for (const row of db.list('project-memory').filter(entry => entry.projectId === projectId)) {
      for (const question of row.openQuestions) if (!open.includes(question)) open.push(question);
    }
    const body = [`项目记忆（最近 ${rows.length} 条 / 共 ${total} 条）`, '只记项目的关键改动：动了文件，或留下了结论；同一项目下的所有对话共享，单次对话的闲聊不写进来。', ...lines, ...(open.length ? ['还没解决的问题：', ...open.slice(0, 8).map(item => `- ${item}`)] : [])].join('\n');
    return body.length > MEMORY_LIMITS.digestChars ? `${body.slice(0, MEMORY_LIMITS.digestChars)}…` : body;
  }

  return { list, add, update, remove, digest, search };
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
