import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 检查点：执行前把「项目里此刻已经脏掉的文件」原始内容存档，运行结束后可以按
// 单文件 / 工作区 / 整条会话三档退回。只碰检查点记录过的文件 + 调用方明确列出的文件，
// 不去动与本次任务无关的未跟踪文件，避免一键回滚吞掉用户自己的编辑。
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const PREVIEW_DIFF_CHARS = 3000;
const PREVIEW_MAX_FILES = 60;
const KEEP_PER_PROJECT = 30;

const text = (value, max = 400) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';

function checkpointError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 相对路径归一化：统一用 /、拒绝绝对路径与 ..，保证任何读写都落在项目目录内。
export function safeRelativePath(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replaceAll('\\', '/');
  if (!raw || raw.length > 400 || raw.includes('\0')) return '';
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return '';
  const parts = raw.split('/').filter(part => part && part !== '.');
  if (!parts.length || parts.some(part => part === '..')) return '';
  return parts.join('/');
}

function withinRoot(root, target) {
  const base = path.resolve(root);
  const full = path.resolve(base, target);
  const relative = path.relative(base, full);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? full : '';
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    cwd: tmpdir(), timeout: 8000, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options
  });
}

function isGitRepo(root) {
  try {
    return String(git(root, ['rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] })).trim().toLowerCase() === 'true';
  } catch { return false; }
}

// porcelain 输出：XY 状态 + 路径；重命名/复制形如 `R  old -> new`，两个路径都要记，
// 否则回滚后旧文件名会凭空消失。
export function parseStatus(stdout) {
  const entries = [];
  const seen = new Set();
  const push = (file, state) => {
    const safe = safeRelativePath(file);
    if (!safe || seen.has(safe)) return;
    seen.add(safe);
    entries.push({ path: safe, state });
  };
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim() || line.length < 4) continue;
    const code = line.slice(0, 2);
    let raw = line.slice(3).trim();
    if (!raw) continue;
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    if (code === '??') { push(raw, 'untracked'); continue; }
    const arrow = raw.indexOf(' -> ');
    if (arrow > 0) {
      push(raw.slice(0, arrow), 'renamed-from');
      push(raw.slice(arrow + 4), 'renamed-to');
      continue;
    }
    const letter = code.trim()[0] || 'M';
    push(raw, letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'R' ? 'renamed' : 'modified');
  }
  return entries;
}

export function createCheckpointService(store, {
  dataDir = store?.dbPath ? path.dirname(store.dbPath) : path.join(process.cwd(), 'data'),
  now = () => new Date().toISOString(),
  limits = {}
} = {}) {
  if (!store?.put) throw new TypeError('检查点服务需要 Store');
  const root = path.join(dataDir, 'checkpoints');
  const maxFiles = Number.isSafeInteger(limits.maxFiles) ? limits.maxFiles : MAX_FILES;
  const maxFileBytes = Number.isSafeInteger(limits.maxFileBytes) ? limits.maxFileBytes : MAX_FILE_BYTES;
  const maxTotalBytes = Number.isSafeInteger(limits.maxTotalBytes) ? limits.maxTotalBytes : MAX_TOTAL_BYTES;

  function archivePath(checkpointId, relative) {
    return withinRoot(root, path.join(checkpointId, 'files', relative));
  }

  // 执行前拍检查点：只读 git，不修改工作区；失败时返回 null，绝不影响工单创建。
  function capture({ projectPath, projectId = '', threadId = '', ticketId = '', reason = 'ticket' } = {}) {
    const project = typeof projectPath === 'string' && projectPath.trim() ? path.resolve(projectPath.trim()) : '';
    if (!project || !existsSync(project) || !isGitRepo(project)) return null;
    let status = '';
    try { status = git(project, ['status', '--porcelain']); } catch { return null; }
    const entries = parseStatus(status);
    if (!entries.length) return null;
    const id = randomUUID();
    const dir = path.join(root, id);
    mkdirSync(path.join(dir, 'files'), { recursive: true });
    let bytes = 0;
    const files = [];
    for (const entry of entries.slice(0, maxFiles)) {
      const full = withinRoot(project, entry.path);
      if (!full) continue;
      let size = 0;
      let isFile = false;
      try { const info = statSync(full); isFile = info.isFile(); size = isFile ? info.size : 0; } catch { isFile = false; size = 0; }
      if (!isFile) {
        // 执行前就被删掉的已跟踪文件：现场没有内容，回滚时从 HEAD 找回。
        if (!existsSync(full) && (entry.state === 'deleted' || entry.state === 'renamed-from')) {
          files.push({ ...entry, before: 'head' });
        }
        // 未跟踪的目录（包括我们自己的数据目录）不是可回滚的「文件」，跳过不记。
        continue;
      }
      if (size > maxFileBytes || bytes + size > maxTotalBytes) {
        files.push({ ...entry, before: 'unreadable', size });
        continue;
      }
      const target = archivePath(id, entry.path);
      if (!target) continue;
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(full, target);
        bytes += size;
        files.push({ ...entry, before: 'saved', size });
      } catch {
        files.push({ ...entry, before: 'unreadable', size });
      }
    }
    let head = '';
    try { head = String(git(project, ['rev-parse', 'HEAD'])).trim(); } catch { /* 空仓库没有 HEAD。 */ }
    const checkpoint = {
      id,
      projectPath: project,
      ...(text(projectId, 100) ? { projectId: text(projectId, 100) } : {}),
      ...(text(threadId, 120) ? { threadId: text(threadId, 120) } : {}),
      ...(text(ticketId, 120) ? { ticketId: text(ticketId, 120) } : {}),
      reason: text(reason, 30) || 'ticket',
      head,
      createdAt: now(),
      files,
      stats: { files: files.length, bytes }
    };
    store.put('checkpoint', checkpoint);
    prune(project);
    return checkpoint;
  }

  function list({ projectId = '', threadId = '', limit = 30 } = {}) {
    const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30;
    return store.list('checkpoint')
      .filter(item => (!projectId || item.projectId === projectId) && (!threadId || item.threadId === threadId))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, cap);
  }

  function get(id) {
    const row = store.get('checkpoint', text(id, 100));
    if (!row) throw checkpointError('检查点不存在', 404);
    return row;
  }

  // 二次确认令牌：客户端必须先把要回滚的文件看清楚，再把令牌原样带回来。
  function tokenOf(scope, ids, paths) {
    const material = ['lagent-checkpoint', scope, [...ids].sort().join(','), [...paths].sort().join(',')].join('|');
    return createHash('sha256').update(material).digest('hex').slice(0, 32);
  }

  // 解析要处理的范围：单文件 / 单个检查点的工作区 / 整条会话（取最早的检查点作为基线）。
  function resolveScope({ checkpointId = '', threadId = '', scope = 'workspace', path: single = '', paths = [] } = {}) {
    if (!['file', 'workspace', 'session'].includes(scope)) throw checkpointError('scope 只能是 file / workspace / session', 400);
    let rows;
    if (scope === 'session') {
      const thread = text(threadId, 120);
      if (!thread) throw checkpointError('整条会话回滚需要 threadId', 400);
      rows = store.list('checkpoint').filter(item => item.threadId === thread)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
      if (!rows.length) throw checkpointError('该会话还没有检查点', 404);
      rows = [rows[0]];
    } else {
      rows = [get(checkpointId)];
    }
    if (rows.some(row => !existsSync(row.projectPath))) throw checkpointError('项目目录已不存在', 409);
    const extra = [...new Set((Array.isArray(paths) ? paths : []).map(safeRelativePath).filter(Boolean))].slice(0, maxFiles);
    const known = new Set(rows.flatMap(row => row.files.map(file => file.path)));
    const requested = scope === 'file' ? [safeRelativePath(single)].filter(Boolean) : [];
    if (scope === 'file' && !requested.length) throw checkpointError('单文件回滚需要合法的 path', 400);
    const boundaries = scope === 'file' ? requested : [...new Set([...known, ...extra])];
    return { rows, scope, paths: boundaries, extra, ids: rows.map(row => row.id) };
  }

  function diffOf(project, relative) {
    try {
      const output = String(git(project, ['diff', '--no-color', 'HEAD', '--', relative], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }));
      const trimmed = output.trim();
      if (trimmed) return trimmed.slice(0, PREVIEW_DIFF_CHARS);
      const staged = String(git(project, ['diff', '--no-color', '--cached', 'HEAD', '--', relative], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }));
      return staged.trim().slice(0, PREVIEW_DIFF_CHARS);
    } catch { return ''; }
  }

  // 预览：只读。列出这次回滚会碰哪些文件、每个文件恢复成什么、以及差异片段。
  function preview(input = {}) {
    const { rows, scope, paths, extra, ids } = resolveScope(input);
    const byPath = new Map();
    for (const row of rows) for (const file of row.files) if (!byPath.has(file.path)) byPath.set(file.path, { ...file, checkpointId: row.id });
    const files = [];
    let shownDiffs = 0;
    for (const relative of paths) {
      const recorded = byPath.get(relative);
      const full = withinRoot(rows[0].projectPath, relative);
      const exists = Boolean(full && existsSync(full));
      const item = recorded
        ? { path: relative, state: recorded.state, before: recorded.before, checkpointId: recorded.checkpointId, exists }
        : { path: relative, state: 'changed-by-run', before: 'head', checkpointId: null, exists };
      if (item.before === 'unreadable') item.warning = '文件超过存档上限，回滚时跳过';
      if (shownDiffs < PREVIEW_MAX_FILES) {
        const diff = diffOf(rows[0].projectPath, relative);
        if (diff) item.diff = diff;
        shownDiffs += 1;
      }
      files.push(item);
    }
    return {
      scope,
      checkpointIds: ids,
      ...(scope === 'session' ? { threadId: text(input.threadId, 120) } : { checkpointId: rows[0].id }),
      projectPath: rows[0].projectPath,
      files,
      token: tokenOf(scope, ids, paths),
      confirmRequired: true
    };
  }

  function restoreFile(project, row, file) {
    const full = withinRoot(project, file.path);
    if (!full) return { path: file.path, action: 'skipped', reason: '路径越界' };
    if (file.before === 'unreadable') return { path: file.path, action: 'skipped', reason: '超过存档上限' };
    if (file.before === 'saved') {
      const source = archivePath(row.id, file.path);
      if (!source || !existsSync(source)) return { path: file.path, action: 'skipped', reason: '存档缺失' };
      mkdirSync(path.dirname(full), { recursive: true });
      copyFileSync(source, full);
      return { path: file.path, action: 'restored' };
    }
    if (file.before === 'absent') {
      try { if (existsSync(full)) unlinkSync(full); return { path: file.path, action: 'deleted' }; }
      catch (error) { return { path: file.path, action: 'skipped', reason: error?.message || '删除失败' }; }
    }
    // before === 'head'：执行前就没有内容的已跟踪文件，或检查点之后才出现的文件。
    try {
      git(project, ['checkout', 'HEAD', '--', file.path], { timeout: 8000 });
      return { path: file.path, action: 'reverted' };
    } catch {
      try { if (existsSync(full)) unlinkSync(full); return { path: file.path, action: 'deleted' }; }
      catch (error) { return { path: file.path, action: 'skipped', reason: error?.message || '无法退回' }; }
    }
  }

  // 执行回滚：必须带 preview 返回的 token，并要求 confirm === true。
  function restore(input = {}) {
    if (input.confirm !== true) throw checkpointError('回滚需要显式二次确认（confirm: true）', 400);
    const { rows, scope, paths, ids } = resolveScope(input);
    const expected = tokenOf(scope, ids, paths);
    if (text(input.token, 100) !== expected) throw checkpointError('确认令牌不匹配，请重新预览再确认', 409);
    const row = rows[0];
    const project = row.projectPath;
    const recorded = new Map();
    for (const file of row.files) if (!recorded.has(file.path)) recorded.set(file.path, file);
    const results = [];
    for (const relative of paths) {
      const file = recorded.get(relative) || { path: relative, before: 'head', state: 'changed-by-run' };
      results.push(restoreFile(project, row, file));
    }
    const summary = {
      checkpointId: row.id,
      ...(scope === 'session' ? { threadId: text(input.threadId, 120) } : {}),
      scope,
      restoredAt: now(),
      files: results,
      counts: results.reduce((acc, item) => { acc[item.action] = (acc[item.action] || 0) + 1; return acc; }, {})
    };
    store.put('checkpoint-restore', { id: randomUUID(), ...summary });
    // 回滚后工作区已经不是检查点的状态，避免同一份检查点被反复「恢复」造成误解。
    store.put('checkpoint', { ...row, lastRestoredAt: summary.restoredAt, lastRestoreScope: scope });
    return summary;
  }

  // 每个项目只保留最近 N 个检查点，删记录同时删存档目录。
  function prune(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath) return 0;
    const rows = store.list('checkpoint')
      .filter(item => item.projectPath === projectPath)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
    let removed = 0;
    for (const row of rows.slice(KEEP_PER_PROJECT)) {
      try { store.delete('checkpoint', row.id); } catch { /* 已删除。 */ }
      try { rmSync(path.join(root, row.id), { recursive: true, force: true }); } catch { /* 存档清理失败可忽略。 */ }
      removed += 1;
    }
    return removed;
  }

  function remove(id) {
    const row = get(id);
    store.delete('checkpoint', row.id);
    try { rmSync(path.join(root, row.id), { recursive: true, force: true }); } catch { /* ignore */ }
    return { removed: true, id: row.id };
  }

  function restores({ threadId = '', checkpointId = '', limit = 20 } = {}) {
    return store.list('checkpoint-restore')
      .filter(item => (!threadId || item.threadId === threadId) && (!checkpointId || item.checkpointId === checkpointId))
      .sort((left, right) => String(right.restoredAt || '').localeCompare(String(left.restoredAt || '')))
      .slice(0, limit);
  }

  return { capture, list, get, preview, restore, restores, prune, remove, root: () => root };
}

export const CHECKPOINT_LIMITS = { MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
