import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workError } from './domain.js';

export const PROJECT_LIMITS = Object.freeze({
  maxProjects: 100,
  maxChatsPerProject: 50,
  maxScannedSessions: 200,
  headBytes: 64 * 1024
});

export const PROJECT_CHAT_EXECUTORS = Object.freeze(['claude-code', 'codex', 'claude-acp', 'dsh-acp', 'codex-acp', 'opencode', 'gemini', 'qwen', 'cursor-agent', 'dsh', 'codebuddy', 'qoder', 'iflow', 'kimi', 'window']);

export const CHANGE_LIMITS = Object.freeze({
  maxChanges: 300,
  maxFiles: 100,
  itemChars: 500,
  titleChars: 200,
  summaryChars: 4000
});

const normalizePath = value => path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const samePath = (left, right) => typeof left === 'string' && typeof right === 'string' && normalizePath(left) === normalizePath(right);

function readHead(file, bytes = PROJECT_LIMITS.headBytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseLines(text) {
  const events = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) events.push(value);
    } catch { /* 会话文件可能被截断，跳过坏行。 */ }
  }
  return events;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join(' ').trim();
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function claudeHead(file, expectedPath) {
  const text = readHead(file);
  let sessionId = '';
  let cwd = '';
  let title = '';
  for (const event of parseLines(text)) {
    if (!sessionId && typeof event.sessionId === 'string') sessionId = event.sessionId;
    if (!cwd && typeof event.cwd === 'string') cwd = event.cwd;
    if (!title && event.type === 'user' && !event.isSidechain && !event.isMeta) {
      const candidate = cleanTitle(textOfContent(event.message?.content ?? event.content));
      if (candidate && !candidate.startsWith('<')) title = candidate;
    }
    if (sessionId && cwd && title) break;
  }
  if (!sessionId) sessionId = path.basename(file, '.jsonl');
  if (cwd && !samePath(cwd, expectedPath)) return null;
  return { sessionId, cwd: cwd || expectedPath, title: title || '未命名会话' };
}

function codexHead(file, expectedPath) {
  const text = readHead(file);
  let sessionId = '';
  let cwd = '';
  let title = '';
  for (const event of parseLines(text)) {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : null;
    if (event.type === 'session_meta' && payload) {
      if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd;
      if (!sessionId && typeof payload.session_id === 'string') sessionId = payload.session_id;
      if (!sessionId && typeof payload.id === 'string') sessionId = payload.id;
    }
    if (!title && payload) {
      if (payload.type === 'user_message' && typeof payload.message === 'string') title = cleanTitle(payload.message);
      else if (event.type === 'response_item' && payload.role === 'user') title = cleanTitle(textOfContent(payload.content));
    }
    if (sessionId && cwd && title) break;
  }
  if (!sessionId) {
    const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(path.basename(file));
    sessionId = match?.[1] || path.basename(file, '.jsonl');
  }
  if (cwd && !samePath(cwd, expectedPath)) return null;
  return { sessionId, cwd: cwd || expectedPath, title: title || '未命名会话' };
}

function listFiles(dir, suffix, depth = 3, collected = []) {
  if (depth < 0 || collected.length >= 2000) return collected;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return collected; }
  for (const entry of entries) {
    if (collected.length >= 2000) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, suffix, depth - 1, collected);
    else if (entry.isFile() && entry.name.endsWith(suffix)) collected.push(full);
  }
  return collected;
}

function statSafe(file) {
  try { return statSync(file); } catch { return null; }
}

/**
 * 项目文件夹与会话服务。所有路径都保存在本地工作区，不读取文件内容（导入只扫描元数据）。
 * 会话扫描只读取每个文件的前 64KB，用于确认会话属于哪个目录。
 */
export function projectService(db, { environment = process.env, home = os.homedir(), now = () => new Date().toISOString() } = {}) {
  const claudeRoot = () => environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexRoot = () => environment.CODEX_HOME || path.join(home, '.codex');

  function listProjects() {
    return db.list('project').sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }
  function getProject(id) {
    if (typeof id !== 'string' || !id.trim()) throw workError('项目 id 无效', 400);
    const project = db.get('project', id);
    if (!project) throw workError('项目不存在', 404);
    return project;
  }
  function listChats(projectId) {
    return db.list('project-chat')
      .filter(chat => chat.projectId === projectId)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }
  function getChat(id) {
    if (typeof id !== 'string' || !id.trim()) throw workError('项目对话 id 无效', 400);
    const chat = db.get('project-chat', id);
    if (!chat) throw workError('项目对话不存在', 404);
    return chat;
  }
  function deleteChat(id) {
    const chat = getChat(id);
    db.delete('project-chat', chat.id);
    return { id: chat.id };
  }
  function renameChat(id, input = {}) {
    const chat = getChat(id);
    const title = typeof input?.title === 'string' ? input.title.replace(/\s+/g, ' ').trim() : '';
    if (!title) throw workError('会话标题不能为空', 400);
    if (title.length > 200) throw workError('会话标题最长 200 字', 400);
    const next = { ...chat, title, autoTitle: false, updatedAt: now() };
    db.put('project-chat', next);
    return next;
  }
  // 占位标题的会话在收到第一条消息后自动改名为消息摘要，避免侧栏出现多条同名「datagent · Claude Code」。
  function adoptTitle(id, text) {
    const chat = db.get('project-chat', id);
    if (!chat || !chat.autoTitle) return chat;
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    if (!flat) return chat;
    const title = flat.length > 42 ? `${flat.slice(0, 42)}…` : flat;
    const next = { ...chat, title, autoTitle: false, updatedAt: now() };
    db.put('project-chat', next);
    return next;
  }
  function deleteProject(id) {
    const project = getProject(id);
    for (const chat of listChats(project.id)) db.delete('project-chat', chat.id);
    for (const change of db.list('project-change').filter(row => row.projectId === project.id)) db.delete('project-change', change.id);
    db.delete('project-brief', project.id);
    db.delete('project', project.id);
    return { id: project.id };
  }
  function updateProject(id, patch) {
    const project = getProject(id);
    const next = { ...project, ...patch, id: project.id, path: project.path, updatedAt: now() };
    db.put('project', next);
    return next;
  }
  function renameProject(id, input = {}) {
    const project = getProject(id);
    const name = typeof input?.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
    if (!name) throw workError('工作文件夹名称不能为空', 400);
    if (name.length > 80) throw workError('工作文件夹名称最长 80 字', 400);
    const next = { ...project, name, updatedAt: now() };
    db.put('project', next);
    return next;
  }
  function touchChat(id, patch) {
    const chat = getChat(id);
    const next = { ...chat, ...patch, id: chat.id, projectId: chat.projectId, updatedAt: now() };
    db.put('project-chat', next);
    return next;
  }

  function validatePath(value) {
    if (typeof value !== 'string') throw workError('项目路径必须是字符串', 400);
    const raw = value.trim();
    if (!raw || raw.includes('\0')) throw workError('项目路径不能为空', 400);
    if (raw.length > 500) throw workError('项目路径过长', 400);
    if (!path.isAbsolute(raw) && !path.win32.isAbsolute(raw)) throw workError('请填写本地文件夹的绝对路径', 400);
    let real;
    try {
      real = realpathSync(raw);
      if (!statSync(real).isDirectory()) throw new Error('not a directory');
    } catch {
      throw workError('文件夹不存在或不可访问', 400);
    }
    const parsed = path.parse(real);
    if (normalizePath(parsed.root) === normalizePath(real)) throw workError('不能把磁盘根目录作为项目', 400);
    const lower = normalizePath(real);
    const blocked = ['c:/windows', 'c:/windows/system32', 'c:/program files', 'c:/program files (x86)', 'c:/programdata'];
    if (blocked.some(item => lower === item || lower.startsWith(`${item}/`))) throw workError('该目录属于系统目录，不能作为项目导入', 400);
    return real;
  }

  function gitBranchOf(dir) {
    try {
      let gitDir = path.join(dir, '.git');
      const stat = statSafe(gitDir);
      if (stat?.isFile()) {
        const pointer = readFileSync(gitDir, 'utf8').trim();
        const match = /^gitdir:\s*(.+)$/i.exec(pointer);
        if (!match) return '';
        gitDir = path.resolve(dir, match[1].trim());
      }
      const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      if (head.startsWith('ref: refs/heads/')) return head.slice(16).trim().slice(0, 120);
      return head.slice(0, 12);
    } catch {
      return '';
    }
  }

  function importProject(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw workError('项目参数必须为对象', 400);
    const real = validatePath(input.path);
    const existing = listProjects().find(project => samePath(project.path, real));
    if (existing) return { project: existing, created: false };
    if (listProjects().length >= PROJECT_LIMITS.maxProjects) throw workError(`最多导入 ${PROJECT_LIMITS.maxProjects} 个项目`, 400);
    let entryCount = 0;
    try { entryCount = readdirSync(real, { withFileTypes: true }).length; } catch { /* ignore */ }
    const requested = typeof input.name === 'string' ? cleanTitle(input.name) : '';
    const stamp = now();
    const project = {
      id: randomUUID(),
      name: requested || path.basename(real) || real,
      path: real,
      gitBranch: gitBranchOf(real),
      entryCount,
      createdAt: stamp,
      updatedAt: stamp
    };
    db.put('project', project);
    return { project, created: true };
  }

  function createChat(projectId, input = {}) {
    const project = getProject(projectId);
    const executorId = typeof input.executorId === 'string' ? input.executorId.trim() : '';
    if (!PROJECT_CHAT_EXECUTORS.includes(executorId)) throw workError('该执行器暂不支持项目对话', 400);
    if (listChats(project.id).length >= PROJECT_LIMITS.maxChatsPerProject) throw workError('每个项目最多 50 个项目对话', 400);
    const stamp = now();
    const chat = {
      id: randomUUID(),
      projectId: project.id,
      executorId,
      title: typeof input.title === 'string' && input.title.trim() ? cleanTitle(input.title) : `${project.name} · ${executorId === 'window' ? '窗口 Agent' : executorId === 'codex' ? 'Codex' : 'Claude Code'}`,
      // 没有显式标题时先放一个占位标题，等第一条消息到了再用消息内容替换。
      autoTitle: !(typeof input.title === 'string' && input.title.trim()),
      sessionId: '',
      writable: input.writable !== false,
      source: 'manual',
      createdAt: stamp,
      updatedAt: stamp
    };
    if (executorId === 'window') {
      const handle = Number(input.handle);
      if (!Number.isSafeInteger(handle) || handle <= 0) throw workError('窗口项目对话需要有效的窗口句柄', 400);
      // 窗口标题只用于定位窗口，不复用为会话标题，否则每个窗口会话都会叫成窗口名。
      chat.window = {
        handle,
        process: typeof input.process === 'string' ? input.process.trim().slice(0, 80) : '',
        title: typeof input.windowTitle === 'string' ? input.windowTitle.trim().slice(0, 200) : ''
      };
    }
    db.put('project-chat', chat);
    return chat;
  }

  function claudeSessions(project) {
    const encoded = project.path.replace(/[^A-Za-z0-9]/g, '-');
    const dir = path.join(claudeRoot(), 'projects', encoded);
    if (!existsSync(dir)) return [];
    let files = [];
    try {
      files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => path.join(dir, name));
    } catch {
      return [];
    }
    const rows = [];
    for (const file of files.slice(0, PROJECT_LIMITS.maxScannedSessions)) {
      const stat = statSafe(file);
      if (!stat) continue;
      const head = claudeHead(file, project.path);
      if (!head) continue;
      rows.push({
        executorId: 'claude-code',
        sessionId: head.sessionId,
        title: head.title,
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size
      });
    }
    return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  function codexSessions(project) {
    const root = path.join(codexRoot(), 'sessions');
    if (!existsSync(root)) return [];
    const files = listFiles(root, '.jsonl', 3);
    const stats = files.map(file => ({ file, stat: statSafe(file) })).filter(item => item.stat);
    stats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    const rows = [];
    for (const { file, stat } of stats.slice(0, PROJECT_LIMITS.maxScannedSessions)) {
      const head = codexHead(file, project.path);
      if (!head) continue;
      rows.push({
        executorId: 'codex',
        sessionId: head.sessionId,
        title: head.title,
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size
      });
    }
    return rows;
  }

  function scanSessions(projectId, executorId = '') {
    const project = getProject(projectId);
    const wanted = typeof executorId === 'string' ? executorId.trim() : '';
    const rows = [
      ...(wanted && wanted !== 'claude-code' ? [] : claudeSessions(project)),
      ...(wanted && wanted !== 'codex' ? [] : codexSessions(project))
    ];
    const imported = new Set(listChats(project.id).map(chat => `${chat.executorId}:${chat.sessionId}`));
    return rows
      .map(row => ({ ...row, imported: imported.has(`${row.executorId}:${row.sessionId}`) }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 60);
  }

  function importSession(projectId, input) {
    const project = getProject(projectId);
    const executorId = typeof input?.executorId === 'string' ? input.executorId.trim() : '';
    const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!['claude-code', 'codex'].includes(executorId)) throw workError('只能导入 Claude Code 或 Codex 的会话', 400);
    if (!sessionId || sessionId.length > 200) throw workError('会话 id 无效', 400);
    const match = scanSessions(project.id, executorId).find(row => row.sessionId === sessionId);
    if (!match) throw workError('未找到该项目对应的会话', 404);
    const existing = listChats(project.id).find(chat => chat.executorId === executorId && chat.sessionId === sessionId);
    if (existing) return { chat: existing, created: false };
    if (listChats(project.id).length >= PROJECT_LIMITS.maxChatsPerProject) throw workError('每个项目最多 50 个项目对话', 400);
    const stamp = now();
    const chat = {
      id: randomUUID(),
      projectId: project.id,
      executorId,
      title: match.title,
      sessionId,
      writable: true,
      source: 'imported',
      createdAt: stamp,
      updatedAt: stamp
    };
    db.put('project-chat', chat);
    return { chat, created: true };
  }

  function projectSummary(project) {
    const chats = listChats(project.id);
    // 侧栏要用「最近一次工单状态 / 是否有未读结果」，这里一次性把工单聚合成会话字段，避免前端再拉一轮。
    const byChat = new Map();
    for (const ticket of db.list('ticket')) {
      if (!ticket || typeof ticket.projectChatId !== 'string' || !ticket.projectChatId) continue;
      const rows = byChat.get(ticket.projectChatId);
      if (rows) rows.push(ticket);
      else byChat.set(ticket.projectChatId, [ticket]);
    }
    let lastActivity = String(project.updatedAt || '');
    const enriched = chats.slice(0, PROJECT_LIMITS.maxChatsPerProject).map(chat => {
      const rows = byChat.get(chat.id) || [];
      const last = rows.reduce((acc, row) => (!acc || String(row.updatedAt) > String(acc.updatedAt) ? row : acc), null);
      const pending = rows.filter(row => row.status === 'awaiting_review').length;
      const stamp = String(chat.updatedAt || chat.createdAt || '');
      if (stamp > lastActivity) lastActivity = stamp;
      return {
        ...chat,
        ticketCount: rows.length,
        pendingCount: pending,
        lastTicketStatus: last ? last.status : '',
        lastTicketAt: last ? String(last.updatedAt || last.createdAt || '') : ''
      };
    });
    return { ...project, chatCount: chats.length, lastActivity, chats: enriched };
  }

  // 只列文件夹，供浏览器端选择项目目录；不读取或返回任何文件内容。
  function listDirectory(input = {}) {
    const raw = typeof input.path === 'string' ? input.path.trim() : '';
    if (raw.length > 400) throw workError('路径过长', 400);
    const toPosix = value => String(value).replaceAll('\\', '/');
    if (!raw) {
      const roots = [];
      if (process.platform === 'win32') {
        for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
          const candidate = `${letter}:\\`;
          try { if (statSync(candidate).isDirectory()) roots.push(toPosix(candidate)); } catch { /* 未挂载的盘符 */ }
        }
      } else roots.push('/');
      return { path: '', parent: null, roots, entries: roots.map(item => ({ name: item, path: item, isDir: true })), truncated: false };
    }
    const absolute = path.resolve(raw);
    let info;
    try { info = statSync(absolute); } catch { throw workError('目录不存在或无法访问', 400); }
    if (!info.isDirectory()) throw workError('该路径不是文件夹', 400);
    let dirents;
    try { dirents = readdirSync(absolute, { withFileTypes: true }); } catch { throw workError('没有权限读取该目录', 403); }
    const entries = [];
    for (const dirent of dirents) {
      let isDir = dirent.isDirectory();
      if (!isDir && dirent.isSymbolicLink()) {
        try { isDir = statSync(path.join(absolute, dirent.name)).isDirectory(); } catch { isDir = false; }
      }
      if (isDir) entries.push({ name: dirent.name, path: toPosix(path.join(absolute, dirent.name)), isDir: true });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    const parent = path.dirname(absolute);
    return {
      path: toPosix(absolute),
      parent: toPosix(parent) === toPosix(absolute) ? null : toPosix(parent),
      roots: [],
      entries: entries.slice(0, 500),
      truncated: entries.length > 500
    };
  }

  const clip = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const clipList = (value, maxItems) => Array.isArray(value)
    ? value.map(item => clip(item, CHANGE_LIMITS.itemChars)).filter(Boolean).slice(0, maxItems)
    : [];
  const emptyBrief = projectId => ({ projectId, goal: '', summary: '', keyPoints: [], decisions: [], constraints: [], updatedAt: '' });
  function getBrief(projectId) {
    const project = getProject(projectId);
    const stored = db.get('project-brief', project.id);
    if (!stored) return emptyBrief(project.id);
    return {
      projectId: project.id,
      goal: typeof stored.goal === 'string' ? stored.goal : '',
      summary: typeof stored.summary === 'string' ? stored.summary : '',
      keyPoints: Array.isArray(stored.keyPoints) ? stored.keyPoints : [],
      decisions: Array.isArray(stored.decisions) ? stored.decisions : [],
      constraints: Array.isArray(stored.constraints) ? stored.constraints : [],
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : ''
    };
  }
  function saveBrief(projectId, input = {}) {
    const project = getProject(projectId);
    const current = getBrief(project.id);
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const next = {
      id: project.id,
      projectId: project.id,
      goal: body.goal === undefined ? current.goal : clip(body.goal, 300),
      summary: body.summary === undefined ? current.summary : clip(body.summary, CHANGE_LIMITS.summaryChars),
      keyPoints: body.keyPoints === undefined ? current.keyPoints : clipList(body.keyPoints, 20),
      decisions: body.decisions === undefined ? current.decisions : clipList(body.decisions, 20),
      constraints: body.constraints === undefined ? current.constraints : clipList(body.constraints, 20),
      updatedAt: now()
    };
    db.put('project-brief', next);
    return { ...next, projectId: project.id };
  }
  function listChanges(projectId) {
    const project = getProject(projectId);
    return db.list('project-change')
      .filter(change => change.projectId === project.id)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, CHANGE_LIMITS.maxChanges);
  }
  // 用 git 读取项目工作区的改动文件；失败、非 Git 目录或超时都静默返回空数组。
  // 以临时目录为 cwd（用 git -C 指定项目），避免子进程锁住项目目录导致删除/清理失败。
  const parsePorcelain = stdout => {
    const files = [];
    for (const line of stdout.split(/\r?\n/)) {
      const raw = line.trim().slice(3).trim();
      if (!raw) continue;
      files.push(raw.replace(/^"|"$/g, '').replaceAll('\\', '/'));
    }
    return [...new Set(files)].slice(0, CHANGE_LIMITS.maxFiles);
  };
  function gitChangedFiles(projectPath, callback) {
    if (typeof projectPath !== 'string' || !projectPath) { callback([]); return; }
    execFile('git', ['-C', projectPath, 'status', '--porcelain'], { cwd: os.tmpdir(), timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (error || typeof stdout !== 'string') { callback([]); return; }
      callback(parsePorcelain(stdout));
    });
  }
  // 同步版本：用于「执行前快照 / 执行后对比」，只取本次运行新增的改动文件。
  function gitChangedFilesSync(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath) return [];
    try {
      const stdout = execFileSync('git', ['-C', projectPath, 'status', '--porcelain'], { cwd: os.tmpdir(), timeout: 5000, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' });
      return typeof stdout === 'string' ? parsePorcelain(stdout) : [];
    } catch {
      return [];
    }
  }
  function recordChange(projectId, input = {}, { source = 'manual' } = {}) {
    const project = getProject(projectId);
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const ticketId = clip(body.ticketId, 200);
    const summary = clip(body.summary, CHANGE_LIMITS.summaryChars);
    const title = clip(body.title, CHANGE_LIMITS.titleChars) || summary.slice(0, 60);
    if (!title && !summary) throw workError('变更记录需要标题或摘要', 400);
    // 同一工单始终对应同一条变更记录，重复写入做幂等更新。
    const id = ticketId || randomUUID();
    const prior = db.get('project-change', id);
    const change = {
      id,
      projectId: project.id,
      projectChatId: clip(body.projectChatId, 200),
      ticketId,
      executorId: clip(body.executorId, 40),
      title: title || '未命名变更',
      summary: summary || title,
      files: clipList(body.files, CHANGE_LIMITS.maxFiles),
      sessionId: clip(body.sessionId, 200),
      status: clip(body.status, 40) || 'recorded',
      source: source === 'auto' ? 'auto' : 'manual',
      createdAt: prior?.createdAt || clip(body.createdAt, 40) || now(),
      updatedAt: now()
    };
    db.put('project-change', change);
    if (source === 'auto' && body.files === undefined && !change.files.length) {
      gitChangedFiles(project.path, files => {
        if (!files.length) return;
        try {
          const latest = db.get('project-change', id);
          if (latest && latest.projectId === project.id) db.put('project-change', { ...latest, files });
        } catch { /* 存储已关闭时忽略自动采集结果。 */ }
      });
    }
    return change;
  }
  function deleteChange(projectId, changeId) {
    const project = getProject(projectId);
    if (typeof changeId !== 'string' || !changeId.trim()) throw workError('变更 id 无效', 400);
    const change = db.get('project-change', changeId);
    if (!change || change.projectId !== project.id) throw workError('变更记录不存在', 404);
    db.delete('project-change', change.id);
    return { id: change.id };
  }
  function briefMarkdown(projectId) {
    const project = getProject(projectId);
    const brief = getBrief(project.id);
    const changes = listChanges(project.id);
    const lines = [`# 项目简报：${project.name}`, '', `- 路径：${project.path}`, `- Git 分支：${project.gitBranch || '（未检测到）'}`, `- 更新时间：${brief.updatedAt || '尚未编辑'}`, ''];
    lines.push('## 项目目标', '', brief.goal || '（未填写）', '');
    lines.push('## 当前进展', '', brief.summary || '（未填写）', '');
    const section = (title, items) => {
      lines.push(`## ${title}`, '');
      if (!items.length) lines.push('（暂无）');
      else for (const item of items) lines.push(`- ${item}`);
      lines.push('');
    };
    section('任务要点', brief.keyPoints);
    section('关键决定', brief.decisions);
    section('约束与边界', brief.constraints);
    lines.push('## 变更记录', '');
    if (!changes.length) lines.push('（暂无）');
    for (const change of changes) {
      lines.push(`### ${change.createdAt} · ${change.title}`);
      lines.push('');
      lines.push(`- 来源：${change.source === 'auto' ? '自动采集' : '手动补充'} · 执行器：${change.executorId || '未知'} · 状态：${change.status}`);
      if (change.summary) lines.push('', change.summary);
      if (change.files?.length) lines.push('', `- 改动文件：${change.files.join('、')}`);
      lines.push('');
    }
    return { project, brief, changes, markdown: lines.join('\n').trimEnd() + '\n' };
  }

  return {
    listProjects: () => listProjects().map(projectSummary),
    getProject: id => projectSummary(getProject(id)),
    importProject,
    deleteProject,
    updateProject,
    renameProject,
    listChats,
    getChat,
    createChat,
    deleteChat,
    renameChat,
    adoptTitle,
    touchChat,
    scanSessions,
    importSession,
    listDirectory,
    getBrief,
    saveBrief,
    listChanges,
    recordChange,
    deleteChange,
    gitChangedFilesSync,
    briefMarkdown
  };
}
