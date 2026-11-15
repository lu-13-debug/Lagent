import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { workError } from './domain.js';
import { splitLibraryByAgent } from './agent-context.js';

// Library 同步：把项目简报与项目记忆写成各 Agent 认识的上下文文件。
// 只改带标记的托管块，避免覆盖用户手写的 CLAUDE.md / AGENTS.md；
// 每次写入前备份原文件，回滚时恢复或删除新建文件。
export const LIBRARY_TARGETS = Object.freeze([
  { id: 'claude', path: 'CLAUDE.md', label: 'Claude Code', mode: 'managed' },
  { id: 'agents', path: 'AGENTS.md', label: '通用 Agent', mode: 'managed' },
  { id: 'cursor', path: '.cursor/rules/lagent.mdc', label: 'Cursor 规则', mode: 'managed' },
  { id: 'mcp', path: '.mcp.json', label: 'Claude Code MCP', mode: 'json', optIn: true }
]);

const BEGIN = '<!-- lagent:begin -->';
const END = '<!-- lagent:end -->';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SYNCS = 30;
const SYNC_KIND = 'library-sync';
const DEFAULT_TARGETS = ['claude', 'agents', 'cursor'];

const targetOf = id => LIBRARY_TARGETS.find(entry => entry.id === id) || null;
const nowIso = now => new Date(now()).toISOString();
const relPosix = value => value.replaceAll('\\', '/');

function normalizeTargets(value) {
  if (value === undefined || value === null) return DEFAULT_TARGETS.slice();
  if (!Array.isArray(value) || value.length > LIBRARY_TARGETS.length) throw workError('library.targets 必须是不超过 4 项的数组', 400);
  const result = [];
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!targetOf(id)) throw workError(`未知的同步目标：${id || '（空）'}`, 400);
    if (!result.includes(id)) result.push(id);
  }
  return result.length ? result : DEFAULT_TARGETS.slice();
}

// 路径必须落在项目目录内；不跟随符号链接逃逸，也拒绝明显敏感的目录名。
function safeTargetPath(projectPath, relative) {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, relative);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  if (!inside) throw workError('同步目标超出项目目录', 400);
  const lowered = relPosix(path.relative(root, resolved)).toLowerCase();
  if (lowered.split('/').some(part => ['.git', '.ssh', '.gnupg'].includes(part))) throw workError('该路径受保护，不能写入', 403);
  if (/(^|\/)(id_rsa|id_ed25519|\.env)(\.|$)/.test(lowered)) throw workError('该文件受保护，不能写入', 403);
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    const realRoot = fs.realpathSync(root);
    const realExisting = fs.realpathSync(existing);
    if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) throw workError('同步目标通过符号链接指向项目外', 403);
  } catch (error) {
    if (error?.status) throw error;
  }
  return resolved;
}

function readText(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile()) throw workError('同步目标不是普通文件', 400);
  if (stat.size > MAX_FILE_BYTES) throw workError('目标文件过大，拒绝覆盖（上限 512KB）', 400);
  return fs.readFileSync(file, 'utf8');
}

function replaceBlock(existing, block) {
  const text = typeof existing === 'string' ? existing : '';
  const begin = text.indexOf(BEGIN);
  const end = begin >= 0 ? text.indexOf(END, begin + BEGIN.length) : -1;
  if (begin >= 0 && end > begin) {
    const before = text.slice(0, begin);
    const after = text.slice(end + END.length);
    return `${before}${block}${after}`;
  }
  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
}

function libraryLines(library) {
  // 不按已知执行器白名单过滤：用户写了 `[cursor]`、`[window]` 也应该保留在托管块里。
  const split = splitLibraryByAgent(library, []);
  const common = split.common;
  const hasCommon = common.instructions.length || common.skills.length || common.mcpServers.length;
  const agentIds = Object.keys(split.agents);
  if (!hasCommon && !agentIds.length) return [];
  const lines = ['### 工作区配置（来自 Lagent 配置档）', ''];
  if (common.instructions.length) {
    lines.push('#### 通用约定', '');
    for (const item of common.instructions) lines.push(`- ${item}`);
    lines.push('');
  }
  if (common.skills.length) lines.push('#### 登记技能', '', `- ${common.skills.join('、')}`, '');
  if (common.mcpServers.length) lines.push('#### MCP 服务', '', `- ${common.mcpServers.join('、')}`, '');
  for (const id of agentIds) {
    const value = split.agents[id];
    lines.push(`#### 给 ${id} 的约定`, '');
    for (const item of value.instructions) lines.push(`- ${item}`);
    if (value.skills.length) lines.push(`- 技能：${value.skills.join('、')}`);
    if (value.mcpServers.length) lines.push(`- MCP：${value.mcpServers.join('、')}`);
    if (!value.instructions.length && !value.skills.length && !value.mcpServers.length) lines.push('- （无）');
    lines.push('');
  }
  return lines;
}

function generatedBody({ project, brief, digest, library }) {
  const lines = [
    '<!-- 由 Lagent 自动生成。请修改 Lagent 里的项目简报，不要手工编辑本段。 -->',
    `## Lagent 项目上下文：${project.name}`,
    '',
    `- 路径：${project.path}`,
    `- Git 分支：${project.gitBranch || '（未检测到）'}`,
    ''
  ];
  const briefData = brief?.brief || brief || {};
  const sections = [
    ['项目目标', briefData.goal],
    ['当前进展', briefData.summary],
    ['任务要点', briefData.keyPoints],
    ['关键决定', briefData.decisions],
    ['约束与边界', briefData.constraints],
    ['未解问题', briefData.openQuestions],
    ['下一步', briefData.nextSteps],
    ['接手先跑', briefData.verifyCommands]
  ];
  for (const [title, value] of sections) {
    const items = Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
    if (!items.length) continue;
    lines.push(`### ${title}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push(...libraryLines(library));
  if (digest) lines.push('### 项目记忆', '', digest, '');
  if (!briefData.goal && !briefData.summary && !digest) {
    lines.push('> 项目简报还是空的。先在 Lagent 里填写目标与当前进展，再同步一次。', '');
  }
  return `${BEGIN}\n${lines.join('\n').trimEnd()}\n${END}`;
}

function cursorDocument(body) {
  // Cursor 规则文件必须带 frontmatter；托管块本身仍然可被替换。
  return `---\ndescription: Lagent 项目上下文\nalwaysApply: true\n---\n\n${body}\n`;
}

function mcpDocument(existing, { url, token }) {
  let data = {};
  if (typeof existing === 'string' && existing.trim()) {
    try { data = JSON.parse(existing); } catch { throw workError('.mcp.json 不是合法 JSON，请先修正后再同步', 409); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw workError('.mcp.json 顶层必须是对象', 409);
  const servers = data.mcpServers && typeof data.mcpServers === 'object' && !Array.isArray(data.mcpServers) ? data.mcpServers : {};
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return JSON.stringify({
    ...data,
    mcpServers: {
      ...servers,
      lagent: { type: 'http', url, ...(Object.keys(headers).length ? { headers } : {}) }
    }
  }, null, 2) + '\n';
}

export function createLibrarySync(db, { projects, memory, now = Date.now } = {}) {
  if (!projects || !memory) throw new TypeError('Library 同步需要项目与记忆服务');

  function syncRows(projectId) {
    return db.list(SYNC_KIND)
      .filter(row => row.projectId === projectId)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, MAX_SYNCS);
  }

  function build(projectId, options = {}) {
    const project = projects.getProject(projectId);
    const stamp = nowIso(now);
    const brief = projects.getBrief(project.id);
    const digest = memory.digest(project.id, { limit: 12 });
    const body = generatedBody({ project, brief, digest, library: options.library });
    const ids = normalizeTargets(options.targets);
    const mcpUrl = typeof options.mcpUrl === 'string' && options.mcpUrl.trim() ? options.mcpUrl.trim() : '';
    if (mcpUrl && !/^https?:\/\/[^\s]+$/i.test(mcpUrl)) throw workError('MCP 地址必须是 http(s) URL', 400);
    const token = typeof options.mcpToken === 'string' ? options.mcpToken.trim() : '';
    const previews = [];
    for (const id of ids) {
      const target = targetOf(id);
      const file = safeTargetPath(project.path, target.path);
      const before = readText(file);
      let after;
      if (target.mode === 'json') {
        if (!mcpUrl) {
          previews.push({
            id, label: target.label, path: target.path, exists: before !== null,
            changed: false, error: '需要提供 Lagent MCP 地址和可选令牌', before: before || '', after: before || ''
          });
          continue;
        }
        after = mcpDocument(before, { url: mcpUrl, token });
      } else if (target.id === 'cursor') {
        // 只有新建文件时才写 frontmatter；已有文件无论有没有托管块都只替换正文，避免 frontmatter 出现在文件中段。
        after = before === null ? cursorDocument(body) : replaceBlock(before, body);
      } else {
        after = replaceBlock(before, body);
      }
      previews.push({
        id,
        label: target.label,
        path: target.path,
        exists: before !== null,
        changed: before !== after,
        before: before || '',
        after,
        // 预览里绝不回显令牌。
        ...(target.mode === 'json' ? { redacted: Boolean(token) } : {})
      });
    }
    return { project, stamp, targets: previews };
  }

  function preview(projectId, options = {}) {
    const built = build(projectId, options);
    return {
      projectId: built.project.id,
      stamp: built.stamp,
      targets: built.targets.map(row => ({ ...row, after: row.redacted ? row.after.replace(/Bearer\s+[^\s"]+/g, 'Bearer ***') : row.after }))
    };
  }

  function apply(projectId, options = {}) {
    const built = build(projectId, options);
    // 备份目录必须每次唯一：同一秒内多次同步不能互相覆盖备份。
    const stamp = `${built.stamp.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const backupRoot = path.join(built.project.path, '.lagent', 'library', 'backups', stamp);
    const files = [];
    let order = 0;
    for (const row of built.targets) {
      if (row.error) throw workError(`${row.label}：${row.error}`, 400);
      if (!row.changed) {
        files.push({ target: row.id, path: row.path, changed: false, existed: row.exists });
        continue;
      }
      const file = safeTargetPath(built.project.path, row.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existed = row.exists;
      let backup = '';
      if (existed) {
        const backupFile = path.join(backupRoot, row.id, path.basename(row.path));
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.copyFileSync(file, backupFile);
        backup = relPosix(path.relative(built.project.path, backupFile));
      }
      // 先写临时文件再 rename，避免编辑器读到半截内容。
      const temporary = `${file}.lagent-${process.pid}-${order++}.tmp`;
      fs.writeFileSync(temporary, row.after, 'utf8');
      fs.renameSync(temporary, file);
      files.push({ target: row.id, path: row.path, changed: true, existed, backup });
    }
    const changed = files.filter(row => row.changed);
    const row = {
      id: randomUUID(),
      projectId: built.project.id,
      createdAt: nowIso(now),
      files,
      changed: changed.length,
      stamp
    };
    db.put(SYNC_KIND, row);
    for (const extra of syncRows(built.project.id).slice(MAX_SYNCS)) db.delete(SYNC_KIND, extra.id);
    // 自动刷新只更新托管块；不记项目变更，否则每次任务完成都会多一条「同步」噪音。
    if (changed.length && options.silent !== true) {
      projects.recordChange(built.project.id, {
        title: '同步项目上下文到 Agent',
        summary: `已更新 ${changed.map(item => item.path).join('、')}。内容来自项目简报、项目记忆与工作区配置档。`,
        files: changed.map(item => item.path)
      }, { source: 'auto' });
    }
    return { sync: publicSync(row) };
  }

  function rollback(projectId, syncId) {
    const project = projects.getProject(projectId);
    if (typeof syncId !== 'string' || !syncId.trim()) throw workError('同步记录 id 无效', 400);
    const row = db.get(SYNC_KIND, syncId.trim());
    if (!row || row.projectId !== project.id) throw workError('同步记录不存在', 404);
    const restored = [];
    for (const entry of [...(row.files || [])].reverse()) {
      if (!entry.changed) continue;
      const file = safeTargetPath(project.path, entry.path);
      if (entry.existed) {
        if (!entry.backup) throw workError(`缺少 ${entry.path} 的备份，无法回滚`, 409);
        const backupFile = safeTargetPath(project.path, entry.backup);
        if (!fs.existsSync(backupFile)) throw workError(`备份已丢失：${entry.path}`, 409);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(backupFile, file);
      } else {
        try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      restored.push(entry.path);
    }
    db.put(SYNC_KIND, { ...row, rolledBackAt: nowIso(now), rolledBackFiles: restored });
    if (restored.length) {
      projects.recordChange(project.id, {
        title: '回滚 Agent 上下文同步',
        summary: `已恢复 ${restored.join('、')} 到同步前状态。`,
        files: restored
      }, { source: 'auto' });
    }
    return { sync: publicSync({ ...row, rolledBackAt: nowIso(now), rolledBackFiles: restored }), restored };
  }

  function publicSync(row) {
    return {
      id: row.id,
      projectId: row.projectId,
      createdAt: row.createdAt,
      changed: row.changed,
      changedFiles: (row.files || []).filter(entry => entry.changed).map(entry => entry.path),
      files: (row.files || []).map(entry => ({
        target: entry.target, path: entry.path, changed: entry.changed, existed: entry.existed,
        ...(entry.backup ? { backup: entry.backup } : {})
      })),
      ...(row.rolledBackAt ? { rolledBackAt: row.rolledBackAt, rolledBackFiles: row.rolledBackFiles || [] } : {})
    };
  }

  /**
   * 用户手动同步过至少一次，说明这些文件已经归 Lagent 托管；
   * 之后项目记忆更新时自动刷新托管块，跳过这一步就会让 Agent 一直读到过期上下文。
   */
  function managedTargets(projectId) {
    for (const row of syncRows(projectId)) {
      if (row.rolledBackAt) continue;
      const targets = [...new Set((row.files || []).map(entry => entry.target).filter(id => targetOf(id)))];
      if (targets.length) return targets;
    }
    return null;
  }

  function shouldAutoSync(projectId) {
    try { return Boolean(managedTargets(projectId)); } catch { return false; }
  }

  function autoApply(projectId, options = {}) {
    const targets = managedTargets(projectId);
    if (!targets) return null;
    return apply(projectId, { ...options, targets, silent: true });
  }

  return {
    targets: () => LIBRARY_TARGETS.map(row => ({ ...row })),
    preview,
    apply,
    autoApply,
    shouldAutoSync,
    list: projectId => { projects.getProject(projectId); return syncRows(projectId).map(publicSync); },
    rollback
  };
}
