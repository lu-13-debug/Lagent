import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseStatus, safeRelativePath } from './checkpoints.js';

// 隔离工作树：把一次任务放进独立的 git worktree 里跑，改坏也只坏在这个工作树，
// 主工作区不动。默认关闭（LAGENT_WORKTREE=1 开启）；任务结束后改动提交到
// 独立分支 lagent/<短 id>，不合回当前分支——合不合、什么时候合由人决定。
const MAX_COPY_FILES = 200;
const DEFAULT_KEEP_DAYS = 7;

const text = (value, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';

// 文件内容摘要：目录或读不到的文件记为空串，等价于「不在基线里」。
function hashFile(file) {
  try {
    if (!statSync(file).isFile()) return '';
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  } catch { return ''; }
}

function worktreeError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    cwd: tmpdir(), timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options
  });
}

export function createWorktreeService(store, {
  dataDir = store?.dbPath ? path.dirname(store.dbPath) : path.join(process.cwd(), 'data'),
  enabled = false,
  now = () => new Date().toISOString(),
  keepDays = DEFAULT_KEEP_DAYS
} = {}) {
  if (!store?.put) throw new TypeError('工作树服务需要 Store');
  const root = path.join(dataDir, 'worktrees');

  function isRepo(projectPath) {
    try { return String(git(projectPath, ['rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] })).trim() === 'true'; }
    catch { return false; }
  }

  function hasCommit(projectPath) {
    try { git(projectPath, ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
    catch { return false; }
  }

  // 把主工作区里未提交的改动复制到新工作树：Agent 看到的应该是用户此刻的项目，
  // 而不是上一次提交的版本。
  function copyDirtyFiles(projectPath, targetPath) {
    let status = '';
    try { status = git(projectPath, ['status', '--porcelain']); } catch { return 0; }
    let copied = 0;
    for (const entry of parseStatus(status).slice(0, MAX_COPY_FILES)) {
      const source = safeRelativePath(entry.path);
      if (!source) continue;
      const from = path.join(projectPath, source);
      const to = path.join(targetPath, source);
      let fromIsFile = false;
      try { fromIsFile = statSync(from).isFile(); } catch { fromIsFile = false; }
      if (fromIsFile) {
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
        copied += 1;
        continue;
      }
      // 主工作区删掉的文件，在工作树里也要删，否则 Agent 会以为它还在。
      if (entry.state === 'deleted' && existsSync(to)) { try { unlinkSync(to); } catch { /* ignore */ } }
    }
    return copied;
  }

  // 准备隔离工作树。关闭、非 git、空仓库都返回 null，调用方回退到直接执行。
  function prepare({ projectPath, ticketId = '', threadId = '', changeId = '' } = {}) {
    if (!enabled) return null;
    const project = typeof projectPath === 'string' && projectPath.trim() ? path.resolve(projectPath.trim()) : '';
    if (!project || !existsSync(project) || !isRepo(project) || !hasCommit(project)) return null;
    if (!ticketId) throw worktreeError('隔离执行需要工单 id', 400);
    const existing = byTicket(ticketId);
    if (existing && existing.status === 'active' && existsSync(existing.path)) return existing;
    const id = randomUUID();
    const branch = `lagent/${id.slice(0, 8)}`;
    const target = path.join(root, id);
    mkdirSync(root, { recursive: true });
    try {
      git(project, ['worktree', 'add', '-b', branch, target, 'HEAD']);
    } catch (error) {
      throw worktreeError(`创建隔离工作树失败：${String(error?.stderr || error?.message || error).slice(0, 200)}`, 409);
    }
    const copied = copyDirtyFiles(project, target);
    // 基线：复制完用户已有改动后，工作树里本来就脏的文件及其内容摘要。
    // 任务结束后按摘要比对：新增文件、内容又变过的文件才算「本次运行改的」，
    // 不能简单用路径差集，否则 Agent 接着改同一个文件会被漏掉。
    let baseline = {};
    try {
      for (const entry of parseStatus(git(target, ['status', '--porcelain']))) {
        baseline[entry.path] = hashFile(path.join(target, entry.path));
      }
    } catch { baseline = {}; }
    let base = '';
    try { base = String(git(project, ['rev-parse', 'HEAD'])).trim(); } catch { /* ignore */ }
    const row = {
      id, ticketId, ...(text(threadId, 120) ? { threadId: text(threadId, 120) } : {}),
      ...(text(changeId, 200) ? { changeId: text(changeId, 200) } : {}),
      projectPath: project, path: target, branch, base, baseline,
      status: 'active', copied, createdAt: now()
    };
    store.put('worktree', row);
    return row;
  }

  function list({ projectPath = '', threadId = '', status = 'active', limit = 30 } = {}) {
    const cap = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30;
    return store.list('worktree')
      .filter(row => (!projectPath || row.projectPath === path.resolve(projectPath)) && (!threadId || row.threadId === threadId) && (!status || row.status === status))
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, cap);
  }

  function get(id) {
    const row = store.get('worktree', text(id, 100));
    if (!row) throw worktreeError('隔离工作树不存在', 404);
    return row;
  }

  function byTicket(ticketId) {
    const key = text(ticketId, 120);
    if (!key) return null;
    return store.list('worktree').find(row => row.ticketId === key && row.status === 'active') || null;
  }

  // 本次运行真正造成的改动：新出现的文件，或内容相对基线又变过的文件。
  function changedSince(id) {
    const row = get(id);
    if (!existsSync(row.path)) return [];
    let files = [];
    try { files = parseStatus(git(row.path, ['status', '--porcelain'])).map(entry => entry.path); } catch { return []; }
    const baseline = row.baseline && !Array.isArray(row.baseline) ? row.baseline : {};
    return files.filter(file => baseline[file] === undefined || baseline[file] !== hashFile(path.join(row.path, file)));
  }

  // 工作树相对基线的改动：文件列表 + 统计。供界面在合并前查看。
  function status(id) {
    const row = get(id);
    if (!existsSync(row.path)) return { ...row, files: [], missing: true };
    let files = [];
    try { files = parseStatus(git(row.path, ['status', '--porcelain'])).map(entry => entry.path); } catch { files = []; }
    let stat = '';
    try { stat = String(git(row.path, ['diff', '--stat', 'HEAD'])).trim().slice(0, 4000); } catch { stat = ''; }
    return { ...row, files, diffStat: stat };
  }

  // 提交工作树里的全部改动到独立分支。不合回、不推送。
  function commit(id, message = '') {
    const row = get(id);
    if (!existsSync(row.path)) throw worktreeError('隔离工作树目录已不存在', 409);
    const body = text(message, 200) || `lagent: 工单 ${row.ticketId || row.id}`;
    try { git(row.path, ['add', '-A']); } catch (error) { throw worktreeError(`暂存改动失败：${String(error?.message || error).slice(0, 200)}`, 409); }
    let committed = false;
    try {
      git(row.path, ['-c', 'user.name=Lagent', '-c', 'user.email=lagent@local', 'commit', '-m', body]);
      committed = true;
    } catch (error) {
      const output = `${error?.stdout || ''}${error?.stderr || ''}`;
      if (!/nothing to commit|无文件要提交|nothing added/i.test(output)) throw worktreeError(`提交失败：${String(error?.message || error).slice(0, 200)}`, 409);
    }
    let head = '';
    try { head = String(git(row.path, ['rev-parse', 'HEAD'])).trim(); } catch { /* ignore */ }
    store.put('worktree', { ...row, status: 'committed', commit: head, committedAt: now(), message: body });
    return { ...row, status: 'committed', commit: head, committed, committedAt: now(), message: body };
  }

  // 清理工作树目录，保留分支（分支在主仓库里，供人工 diff / merge）。
  function release(id, { deleteBranch = false } = {}) {
    const row = get(id);
    try { git(row.projectPath, ['worktree', 'remove', '--force', row.path]); }
    catch { try { rmSync(row.path, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (deleteBranch) { try { git(row.projectPath, ['branch', '-D', row.branch]); } catch { /* 已合并或已删除。 */ } }
    store.put('worktree', { ...row, status: deleteBranch ? 'removed' : 'released', releasedAt: now() });
    return { id: row.id, branch: row.branch, deleteBranch };
  }

  // 到期清理：只动已提交/已释放且超过保留期的工作树，活跃的不碰。
  function prune({ days = keepDays } = {}) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const row of store.list('worktree')) {
      if (row.status === 'active') continue;
      const at = Date.parse(row.committedAt || row.releasedAt || row.createdAt || '') || 0;
      if (at && at > cutoff) continue;
      release(row.id);
      removed += 1;
    }
    return removed;
  }

  return { enabled, prepare, list, get, byTicket, status, changedSince, commit, release, prune, root: () => root };
}
