import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workError } from '../domain.js';
import { modelRequest, readModelResponse, providerUsage, visibleReply } from '../../model-protocol.js';

// 模型 Agent：用已经接入的模型自己推理 + 调工具，把一个任务在项目目录里做完。
// 与 CLI 执行器不同，它的每一步都写进 task.activity，界面因此能像看 dsh 一样看到过程。
const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const MAX_STEPS = 12;
const READ_LIMIT = 8000;
const LIST_LIMIT = 120;
const HITS_LIMIT = 40;
const ACTIVITY_LIMIT = 60;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.dataagent', 'data', '.venv', '__pycache__', 'coverage']);
const WRITE_TOOLS = new Set(['write_file', 'replace_in_file', 'move_path', 'delete_path']);
const READ_COMMAND = /^(git\s+(status|diff|log|show|branch)\b[^|;&<>]*|node\s+--check\s+\S+)$/i;
// 三档权限，语义与 dsh 一致：仅查看 / 只在工作区内修改 / 完全权限。
const PERMISSIONS = ['read', 'workspace', 'full'];
const PERMISSION_LABELS = { read: '仅查看', workspace: '仅工作区内修改', full: '完全权限' };

const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

export function normalizeModelInput(input, { maxPromptBytes = 16 * 1024 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('executorInput 必须为结构化对象');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw statusError('模型 Agent 的 prompt 必须是非空字符串');
  if (prompt.includes('\0')) throw statusError('prompt 不允许 NUL 字符');
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw statusError(`prompt 不能超过 ${maxPromptBytes} 字节`);
  const steps = input.maxSteps === undefined ? 8 : input.maxSteps;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STEPS) throw statusError(`maxSteps 必须是 1-${MAX_STEPS} 的整数`);
  const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : '';
  if (workspace && (!path.isAbsolute(workspace) || workspace.length > 500)) throw statusError('workspace 必须是有效的工作目录绝对路径');
  // 会话级模型：可以指定用哪个已保存的模型配置，不传则用工作流默认模型。
  const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : '';
  if (profileId && !/^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) throw statusError('profileId 无效');
  // 思考强度也是会话级选项；是否真支持由模型能力表在取上下文时校验。
  const effort = typeof input.effort === 'string' ? input.effort.trim() : '';
  if (effort && !/^[a-z]{2,10}$/.test(effort)) throw statusError('effort 无效');
  // 额外可访问目录由策略给出（用户在设置里添加）：只接受绝对路径，最多 10 个。
  const roots = Array.isArray(input.roots)
    ? [...new Set(input.roots.filter(item => typeof item === 'string' && path.isAbsolute(item.trim())).map(item => path.resolve(item.trim())))].slice(0, 10)
    : [];
  // 权限模式：read 只读、workspace 只在工作区（含额外授权目录）内改、full 完全权限。
  const permission = PERMISSIONS.includes(input.permission) ? input.permission : (input.write === true ? 'workspace' : 'read');
  return {
    prompt,
    maxSteps: steps,
    permission,
    ...(workspace ? { workspace: path.resolve(workspace) } : {}),
    ...(profileId ? { profileId } : {}),
    ...(effort ? { effort } : {}),
    ...(roots.length ? { roots } : {}),
    confirmDanger: input.confirmDanger !== false,
    write: permission !== 'read',
  };
}

// 权限边界：项目工作目录 + 策略里登记的额外目录。越界的路径不直接拒绝，而是先问用户。
const insideRoot = (root, absolute) => {
  const relative = path.relative(root, absolute);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
// 无论用户怎么授权，这些地方永远不碰：系统目录、密钥材料、版本库内部文件、环境变量文件。
const WINDOWS_SYSTEM_ROOTS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
const POSIX_SYSTEM_ROOTS = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/System', '/Library'];
const SECRET_RULES = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.env(\.|$)/i,
  /(^|[\\/])id_(rsa|dsa|ed25519)(\.|$)/i,
  /\.(pem|p12|pfx|key)$/i,
];
const SYSTEM_ROOTS = process.platform === 'win32' ? WINDOWS_SYSTEM_ROOTS : POSIX_SYSTEM_ROOTS;
const isForbiddenPath = absolute =>
  SYSTEM_ROOTS.some(root => insideRoot(path.resolve(root), absolute)) || SECRET_RULES.some(rule => rule.test(absolute));

function pathGuard(workspace, roots) {
  const base = path.resolve(workspace);
  const extras = [...new Set((Array.isArray(roots) ? roots : []).map(root => path.resolve(root)))].filter(root => root !== base);
  const known = absolute => insideRoot(base, absolute) || extras.some(root => insideRoot(root, absolute));
  const display = absolute => (insideRoot(base, absolute) ? path.relative(base, absolute) || '.' : absolute);
  const resolve = target => {
    const raw = typeof target === 'string' ? target.trim() : '';
    if (!raw) throw new Error('path 不能为空');
    const absolute = path.resolve(base, raw);
    if (isForbiddenPath(absolute)) {
      throw new Error(`拒绝访问受保护路径：${display(absolute)}（系统目录、.git、.ssh、密钥与 .env 一类文件不开放）`);
    }
    return { absolute, known: known(absolute) };
  };
  return { base, extras, resolve, display, known };
}

function listFiles(guard, target) {
  const start = target ? guard.resolve(target).absolute : guard.base;
  const stat = fs.statSync(start);
  if (!stat.isDirectory()) return { entries: [{ name: path.basename(start), type: 'file', size: stat.size }] };
  const entries = [];
  for (const entry of fs.readdirSync(start, { withFileTypes: true }).slice(0, LIST_LIMIT)) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(start, entry.name);
    let size = 0;
    try { size = fs.statSync(absolute).size; } catch { size = 0; }
    entries.push({ name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', size });
  }
  return { path: guard.display(start) || '.', entries };
}

function readFile(guard, target, offset, limit) {
  const absolute = guard.resolve(target).absolute;
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('只能读取文件');
  if (stat.size > 400 * 1024) throw new Error('文件超过 400KB，请改用 search_code 定位');
  const content = fs.readFileSync(absolute, 'utf8');
  const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, READ_LIMIT) : READ_LIMIT;
  return {
    path: guard.display(absolute),
    size: stat.size,
    offset: from,
    content: content.slice(from, from + take),
    truncated: content.length > from + take,
  };
}

function searchCode(guard, pattern, target) {
  const start = target ? guard.resolve(target).absolute : guard.base;
  const expression = new RegExp(pattern, 'i');
  const hits = [];
  const walk = directory => {
    if (hits.length >= HITS_LIMIT) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (hits.length >= HITS_LIMIT) return;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(absolute); continue; }
      let stat;
      try { stat = fs.statSync(absolute); } catch { continue; }
      if (!stat.isFile() || stat.size > 200 * 1024) continue;
      let content;
      try { content = fs.readFileSync(absolute, 'utf8'); } catch { continue; }
      if (content.includes('\0')) continue;
      content.split(/\r?\n/).forEach((line, index) => {
        if (hits.length >= HITS_LIMIT || !expression.test(line)) return;
        hits.push({ file: guard.display(absolute), line: index + 1, text: line.trim().slice(0, 200) });
      });
    }
  };
  walk(start);
  return { pattern, count: hits.length, hits };
}

function writeFile(guard, target, content) {
  const absolute = guard.resolve(target).absolute;
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  if (Buffer.byteLength(content) > 200 * 1024) throw new Error('单次写入不能超过 200KB');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const existed = fs.existsSync(absolute);
  const before = existed ? fs.readFileSync(absolute, 'utf8') : '';
  fs.writeFileSync(absolute, content, 'utf8');
  return {
    path: guard.display(absolute),
    created: !existed,
    before: before.length,
    after: content.length,
  };
}

// 精确替换：比整文件重写省 token，也更不容易误伤别的内容。
function replaceInFile(guard, target, { find, replace, all = false } = {}) {
  const absolute = guard.resolve(target).absolute;
  if (typeof find !== 'string' || !find) throw new Error('find 必须是非空字符串');
  if (typeof replace !== 'string') throw new Error('replace 必须是字符串');
  const before = fs.readFileSync(absolute, 'utf8');
  const occurrences = before.split(find).length - 1;
  if (occurrences === 0) throw new Error(`没有在 ${guard.display(absolute)} 里找到要替换的文本`);
  if (occurrences > 1 && all !== true) throw new Error(`找到 ${occurrences} 处相同文本；请提供更长的 find，或显式传 all:true`);
  const after = all === true ? before.split(find).join(replace) : before.replace(find, () => replace);
  if (Buffer.byteLength(after) > 200 * 1024) throw new Error('替换后文件超过 200KB');
  fs.writeFileSync(absolute, after, 'utf8');
  return { path: guard.display(absolute), replaced: all === true ? occurrences : 1, before: before.length, after: after.length };
}

// 移动/重命名：源和目标都走同一套权限判定，跨目录移动时目标目录可能也需要授权。
function movePath(guard, from, to) {
  const source = guard.resolve(from).absolute;
  const target = guard.resolve(to).absolute;
  if (source === guard.base) throw new Error('不能移动工作目录本身');
  if (!fs.existsSync(source)) throw new Error(`源路径不存在：${guard.display(source)}`);
  if (fs.existsSync(target)) throw new Error(`目标已存在：${guard.display(target)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(source, target);
  return { from: guard.display(source), to: guard.display(target) };
}

// 删除是不可恢复的：先算清楚要删什么，再动手；工作目录本身永远不许删。
function deletePath(guard, target, { recursive = false, dryRun = false } = {}) {
  const root = guard.base;
  const absolute = guard.resolve(target).absolute;
  const atRoot = absolute === root;
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    throw new Error(`路径不存在：${guard.display(absolute)}`);
  }
  const isDirectory = stat.isDirectory();
  if (atRoot && dryRun !== true) throw new Error('不能删除工作目录本身；要清空它就只能逐个删里面的条目');
  if (isDirectory && !recursive) {
    throw new Error('这是一个目录；确认要连同目录内的全部内容一起删除时，请传 recursive: true');
  }
  // 统计范围（有上限，避免在大目录上卡住）；dryRun 只报告不删。
  let files = 0;
  let dirs = 0;
  const sample = [];
  const walk = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs += 1;
        if (dirs + files <= 500) walk(path.join(directory, entry.name));
      } else {
        files += 1;
      }
      if (sample.length < 20) sample.push(guard.display(path.join(directory, entry.name)) + (entry.isDirectory() ? '/' : ''));
    }
  };
  if (isDirectory) walk(absolute);
  else files = 1;
  const summary = { path: guard.display(absolute) || '.', kind: isDirectory ? 'dir' : 'file', recursive: isDirectory ? recursive === true : false, files, dirs, sample };
  if (dryRun) return { ...summary, dryRun: true, ...(atRoot ? { note: '工作目录本身不会被删除，这里只是它内容的清单' } : {}) };
  fs.rmSync(absolute, { recursive, force: false });
  return { ...summary, removed: true };
}

const SHELL = process.platform === 'win32'
  ? { file: process.env.ComSpec || 'cmd.exe', args: value => ['/d', '/s', '/c', value] }
  : { file: '/bin/sh', args: value => ['-c', value] };

// 只读白名单直接跑（不起 shell，避免命令拼接）；其它命令必须先拿到用户确认，再交给系统 shell 执行。
function runCommand(guard, command, { approved = false } = {}) {
  const value = text(command, 300);
  if (!value) throw new Error('command 不能为空');
  const readOnly = READ_COMMAND.test(value);
  if (!readOnly && !approved) throw new Error('这条命令不在只读白名单内：需要用户在弹窗里确认后才能执行');
  const options = { cwd: guard.base, timeout: readOnly ? 15000 : 60000, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  try {
    if (readOnly) {
      const parts = value.split(/\s+/);
      return { command: value, exitCode: 0, output: String(execFileSync(parts[0], parts.slice(1), options)).slice(0, 4000) };
    }
    const output = execFileSync(SHELL.file, SHELL.args(value), { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    return { command: value, exitCode: 0, output: String(output).slice(0, 4000) };
  } catch (error) {
    return {
      command: value,
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      output: String(error?.stdout || error?.stderr || error?.message || '').slice(0, 4000),
    };
  }
}

export function modelSystemPrompt({ maxSteps, write, permission = write ? 'workspace' : 'read', roots = [] }) {
  const mode = PERMISSIONS.includes(permission) ? permission : 'workspace';
  const extra = roots.length ? `已获得长期授权的其它目录：${roots.join('、')}。` : '';
  return [
    '你是 DataAgent 的模型 Agent，在一个本地工作目录里独立完成任务。',
    '每一步只输出一个 JSON 对象，不要输出任何其它文字、不要用代码块包裹：',
    '· 调用工具：{"tool":"read_file","args":{"path":"src/app.tsx"}}',
    '· 结束任务：{"final":{"summary":"做了什么、结论是什么","files":["改动过的文件"]}}',
    '',
    `可用工具：list_files{path?}、read_file{path,offset?,limit?}、search_code{pattern,path?}${write ? '、write_file{path,content}、replace_in_file{path,find,replace,all?}、move_path{from,to}、delete_path{path,recursive?,dryRun?}' : ''}、run_command{command}。`,
    '路径可以写相对工作目录的路径，也可以写绝对路径。',
    `当前权限档位：${PERMISSION_LABELS[mode]}（${mode}）。`,
    write
      ? '你被允许修改文件：先读再改，一次改一处，改动要小、要能说清理由。小改用 replace_in_file，整文件重写才用 write_file。删除不可恢复：只有用户明确要求删除时才做，先 delete_path{path,dryRun:true} 看清将删掉什么，再真正删；删目录必须显式传 recursive:true；工作目录本身不许删。'
      : '你没有写权限：不要尝试 write_file、replace_in_file、move_path 或 delete_path，只读取与检索，最后给出结论和改动建议。',
    mode === 'full'
      ? `权限规则：当前是完全权限，工作目录内外都可直接读写，不再逐次询问。受保护路径（系统目录、.git、.ssh、.env、密钥）仍然拒绝。${extra}`
      : `权限规则：工作目录内的读写直接执行；工作目录之外的路径会先弹窗问用户，用户拒绝就必须停止并说明。受保护路径（系统目录、.git、.ssh、.env、密钥）永远拒绝。${extra}`,
    mode === 'read'
      ? 'run_command：只能执行只读的 git 命令（status/diff/log/show/branch）与 node --check，其它命令会被拒绝。'
      : mode === 'full'
        ? 'run_command：直接执行，注意不要做不可逆的危险操作。'
        : 'run_command：只读的 git 命令（status/diff/log/show/branch）与 node --check 直接执行；其它命令会先弹窗让用户确认，被拒绝就不要绕道。',
    '规则：不要编造文件、函数或结论；读不懂就先 list_files / search_code。',
    `最多 ${maxSteps} 步，步数用完必须给出 final。`,
  ].join('\n');
}

export function parseModelStep(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.final && typeof parsed.final === 'object') {
    return { type: 'final', summary: text(parsed.final.summary, 4000), files: Array.isArray(parsed.final.files) ? parsed.final.files.filter(item => typeof item === 'string').slice(0, 40) : [] };
  }
  if (typeof parsed.tool === 'string' && parsed.tool.trim()) {
    const args = parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args) ? parsed.args : {};
    return { type: 'tool', tool: parsed.tool.trim(), args };
  }
  return null;
}

// 过程流是给人看的：这里把工具调用与结果压成一句话，避免界面上出现整段原始 JSON。
const TOOL_LABELS = {
  list_files: '列目录',
  read_file: '读文件',
  search_code: '搜代码',
  write_file: '写文件',
  replace_in_file: '改文件',
  move_path: '移动',
  delete_path: '删除',
  run_command: '运行命令',
};

function shortPath(value) {
  return String(value || '.').replace(/\\/g, '/').slice(0, 120);
}

export function describeCall(tool, args = {}) {
  const label = TOOL_LABELS[tool] || tool;
  if (tool === 'list_files') return `${label} ${shortPath(args.path || '.') === '.' ? '根目录' : shortPath(args.path)}`;
  if (tool === 'read_file') return `${label} ${shortPath(args.path)}`;
  if (tool === 'search_code') return `${label} ${String(args.pattern || '').slice(0, 60)}`;
  if (tool === 'write_file') return `${label} ${shortPath(args.path)}`;
  if (tool === 'replace_in_file') return `${label} ${shortPath(args.path)}${args.all === true ? '（全部）' : ''}`;
  if (tool === 'move_path') return `${label} ${shortPath(args.from)} → ${shortPath(args.to)}`;
  if (tool === 'delete_path') return `${label} ${shortPath(args.path)}${args.recursive === true ? '（递归）' : ''}${args.dryRun === true ? '（试运行）' : ''}`;
  if (tool === 'run_command') return `${label} ${String(args.command || '').slice(0, 80)}`;
  return tool;
}

export function describeOutput(tool, output = {}) {
  if (tool === 'list_files') {
    const entries = Array.isArray(output.entries) ? output.entries : [];
    const names = entries.map(entry => `${entry.name}${entry.type === 'dir' ? '/' : ''}`);
    const head = names.slice(0, 8).join('、');
    return `${names.length} 项${head ? `：${head}` : ''}${names.length > 8 ? ' …' : ''}`;
  }
  if (tool === 'read_file') {
    const lines = String(output.content || '').split(/\r?\n/).length;
    return `${shortPath(output.path)} · ${lines} 行${output.truncated ? '（已截断）' : ''}`;
  }
  if (tool === 'search_code') {
    const hits = (Array.isArray(output.hits) ? output.hits : []).slice(0, 3).map(hit => `${hit.file}:${hit.line}`);
    return `${output.count || 0} 处命中${hits.length ? `：${hits.join('、')}` : ''}`;
  }
  if (tool === 'write_file') {
    return `${shortPath(output.path)} · ${output.created ? '新建' : '覆盖'} · ${output.after || 0} 字符`;
  }
  if (tool === 'replace_in_file') {
    return `${shortPath(output.path)} · 替换 ${output.replaced || 0} 处 · ${output.after || 0} 字符`;
  }
  if (tool === 'move_path') {
    return `${shortPath(output.from)} → ${shortPath(output.to)}`;
  }
  if (tool === 'delete_path') {
    const scope = `${output.files || 0} 个文件${output.dirs ? `、${output.dirs} 个目录` : ''}`;
    return `${shortPath(output.path)} · ${scope}${output.dryRun ? '（试运行，未删除）' : ' 已删除'}`;
  }
  if (tool === 'run_command') {
    const first = String(output.output || '').trim().split(/\r?\n/)[0] || '';
    return `退出码 ${output.exitCode ?? 0}${first ? `：${first.slice(0, 100)}` : ''}`;
  }
  return '';
}

export function modelExecutor({ store, cwd, context, contextFor, fetchImpl = fetch, perCallTimeoutMs = 60000, totalTimeoutMs = 300000 }) {  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError('model 执行器需要 store 和 cwd');
  const workspace = path.resolve(cwd);
  const running = new Map();
  const persist = task => { store.put('task', task); return task; };

  const pushActivity = (task, entry) => {
    const list = Array.isArray(task.activity) ? task.activity : [];
    list.push({ at: new Date().toISOString(), ...entry });
    task.activity = list.slice(-ACTIVITY_LIMIT);
    task.updatedAt = new Date().toISOString();
    persist(task);
  };

  async function askModel(messages, task, signal, profileId, effort) {
    const ctx = profileId && typeof contextFor === 'function' ? contextFor(profileId, effort) : (typeof context === 'function' ? context() : context);
    if (!ctx?.key || !ctx?.settings?.model) throw statusError('还没有可用的模型：请在「设置 → 规划设置」里配置并选择默认模型', 503);
    task.modelLabel = ctx.profileName || ctx.settings.model;
    const request = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, Math.min(4096, Number(ctx.maxTokens) || 4096), false, { ...ctx.settings, sessionId: task.projectChatId || task.id });
    let response;
    try {
      response = await fetchImpl(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal,
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw statusError('模型调用超时', 504);
      throw statusError(`模型接口无法访问：${error?.message || '网络错误'}`, 502);
    }
    if (!response.ok) {
      // 把供应商返回的错误正文带出来，否则只剩「HTTP 400」无法判断是参数不被支持还是模型名不存在。
      let detail = '';
      try {
        detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
      } catch { /* 读取失败就只报状态码 */ }
      // 未验证的思考强度可能被供应商拒绝：自动退回默认档重试一次，并在结果里说明，
      // 避免用户只是选了个档位就整条任务失败。
      if (ctx.settings.effort && ctx.settings.effort !== 'default' && [400, 422].includes(response.status) && /effort|reasoning/i.test(detail)) {
        task.effortFallback = true;
        const retry = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, Math.min(4096, Number(ctx.maxTokens) || 4096), false, { ...ctx.settings, effort: 'default', sessionId: task.projectChatId || task.id });
        const second = await fetchImpl(retry.endpoint, { method: 'POST', headers: retry.headers, body: JSON.stringify(retry.body), signal, redirect: 'error' });
        if (second.ok) {
          const payload = await readModelResponse(second);
          return { payload, protocol: retry.protocol, usage: providerUsage(payload?.usage, retry.protocol) };
        }
        try { detail = (await second.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* 同上 */ }
        throw statusError(`模型接口返回 HTTP ${second.status}${detail ? `：${detail}` : ''}`, 502);
      }
      throw statusError(`模型接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`, 502);
    }
    const payload = await readModelResponse(response);
    return { payload, protocol: request.protocol, usage: providerUsage(payload?.usage, request.protocol) };
  }

  function replyOf(payload, protocol) {
    return visibleReply(payload, protocol);
  }

  // 越界访问不是直接拒绝，而是挂起等用户回答：task 进入 awaiting_approval，
  // 引擎把这个状态映射成工单的「待确认」，前端就是一次弹窗。
  const pendingAccess = new Map();
  // 同一任务里，同一个位置只问一次：批准之后同一路径（及其子路径）不再弹窗。
  const grantedAccess = new Map();
  const grantedFor = taskId => {
    if (!grantedAccess.has(taskId)) grantedAccess.set(taskId, new Set());
    return grantedAccess.get(taskId);
  };
  const ACCESS_TIMEOUT_MS = 5 * 60 * 1000;
  const MODE_LABELS = { read: '读取', write: '写入', delete: '删除', command: '执行命令' };

  function requestAccess(task, request) {
    const id = `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    task.accessRequest = { id, ...request, at: new Date().toISOString() };
    task.status = 'awaiting_approval';
    task.updatedAt = new Date().toISOString();
    pushActivity(task, {
      kind: 'waiting',
      text: `请求${MODE_LABELS[request.mode] || '访问'}：${shortPath(request.path)}`,
      detail: request.reason || '',
    });
    return new Promise(resolve => {
      const finish = answer => {
        clearTimeout(timer);
        pendingAccess.delete(task.id);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        pendingAccess.delete(task.id);
        resolve({ allow: false, reason: '等待用户确认超时（5 分钟），按拒绝处理' });
      }, ACCESS_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pendingAccess.set(task.id, { resolve: finish, request });
    });
  }

  // 统一入口：完全权限直接放行；命中已知目录直接放行；工作区模式下越界先问；
  // 危险动作（递归删除、白名单外命令）也按模式决定要不要问。
  async function guardAccess(task, { absolute, known }, mode, reason, permission = 'workspace') {
    if (permission === 'full') return { allow: true };
    if (known) return { allow: true };
    if ([...grantedFor(task.id)].some(root => insideRoot(root, absolute))) return { allow: true };
    const answer = await requestAccess(task, { path: absolute, mode, reason });
    // 不管允许还是拒绝都要回到 running 并清掉请求：拒绝的结论通过工具错误回给模型。
    task.status = 'running';
    delete task.accessRequest;
    task.updatedAt = new Date().toISOString();
    persist(task);
    if (!answer.allow) throw new Error(`用户拒绝了${MODE_LABELS[mode] || '访问'}权限：${absolute}${answer.reason ? `（${answer.reason}）` : ''}`);
    grantedFor(task.id).add(absolute);
    return answer;
  }

  async function runTool(task, name, args, guard, { write, confirmDanger, permission = 'workspace' }) {
    const writeTools = WRITE_TOOLS;
    if (writeTools.has(name) && !write) throw new Error(`当前是「${PERMISSION_LABELS.read}」模式，不能修改文件；要改动请在设置里切换到「${PERMISSION_LABELS.workspace}」。`);
    if (name === 'list_files') {
      await guardAccess(task, guard.resolve(args?.path), 'read', undefined, permission);
      return listFiles(guard, args?.path);
    }
    if (name === 'read_file') {
      await guardAccess(task, guard.resolve(args?.path), 'read', undefined, permission);
      return readFile(guard, args?.path, args?.offset, args?.limit);
    }
    if (name === 'search_code') {
      await guardAccess(task, guard.resolve(args?.path), 'read', undefined, permission);
      return searchCode(guard, text(args?.pattern, 200) || '.', args?.path);
    }
    if (name === 'write_file') {
      await guardAccess(task, guard.resolve(args?.path), 'write', undefined, permission);
      return writeFile(guard, args?.path, args?.content);
    }
    if (name === 'replace_in_file') {
      await guardAccess(task, guard.resolve(args?.path), 'write', undefined, permission);
      return replaceInFile(guard, args?.path, { find: args?.find, replace: args?.replace, all: args?.all === true });
    }
    if (name === 'move_path') {
      await guardAccess(task, guard.resolve(args?.from), 'write', undefined, permission);
      await guardAccess(task, guard.resolve(args?.to), 'write', undefined, permission);
      return movePath(guard, args?.from, args?.to);
    }
    if (name === 'delete_path') {
      const resolved = guard.resolve(args?.path);
      await guardAccess(task, resolved, 'delete', undefined, permission);
      const recursive = args?.recursive === true;
      // 递归删除不可恢复：只在「仅工作区内修改」下再问一次；完全权限不再打断。
      if (recursive && permission === 'workspace' && confirmDanger && args?.dryRun !== true) {
        const answer = await requestAccess(task, { path: resolved.absolute, mode: 'delete', reason: '递归删除整个目录，不可恢复' });
        if (!answer.allow) throw new Error(`用户拒绝了这次删除：${resolved.absolute}`);
      }
      return deletePath(guard, args?.path, { recursive, dryRun: args?.dryRun === true });
    }
    if (name === 'run_command') {
      const value = text(args?.command, 300);
      if (!READ_COMMAND.test(value)) {
        if (permission === 'read') throw new Error(`当前是「${PERMISSION_LABELS.read}」模式，只能执行只读命令（git status/diff/log/show/branch、node --check）。`);
        if (permission === 'workspace') {
          const answer = await requestAccess(task, { path: value, mode: 'command', reason: '不在只读白名单内，需要确认后执行' });
          if (!answer.allow) throw new Error('用户拒绝了这条命令，请不要绕道执行');
        }
        return runCommand(guard, value, { approved: true });
      }
      return runCommand(guard, value);
    }
    throw new Error(`未知工具：${name}`);
  }

  async function execute(task, input, runWorkspace) {
    const guard = pathGuard(runWorkspace, input.roots);
    const messages = [
      { role: 'system', content: modelSystemPrompt({ maxSteps: input.maxSteps, write: input.write, permission: input.permission, roots: guard.extras }) },
      { role: 'user', content: `任务：${input.prompt}\n\n工作目录：${runWorkspace}` },
    ];
    const usage = {};
    let files = [];
    let summary = '';
    const deadline = Date.now() + totalTimeoutMs;
    for (let step = 0; step < input.maxSteps; step += 1) {
      if (task.cancelled) throw statusError('模型 Agent 已停止', 499);
      const remaining = deadline - Date.now();
      if (remaining <= 1000) throw statusError('模型 Agent 超出总时长限制', 504);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(perCallTimeoutMs, remaining));
      let reply = '';
      try {
        const result = await askModel(messages, task, controller.signal, input.profileId, input.effort);
        for (const [key, value] of Object.entries(result.usage || {})) usage[key] = (usage[key] || 0) + (Number(value) || 0);
        reply = replyOf(result.payload, result.protocol);
      } finally {
        clearTimeout(timer);
      }
      const parsed = parseModelStep(reply);
      if (!parsed) {
        messages.push({ role: 'assistant', content: reply.slice(0, 2000) });
        messages.push({ role: 'user', content: '你没有按要求输出 JSON。请只输出一个 JSON 对象：{"tool":"..."} 或 {"final":{...}}。' });
        pushActivity(task, { kind: 'error', text: '模型回复不是合法 JSON，已要求重试' });
        continue;
      }
      if (parsed.type === 'final') {
        summary = parsed.summary;
        files = [...new Set([...files, ...parsed.files])];
        pushActivity(task, { kind: 'result', text: summary || '模型 Agent 完成' });
        return { summary, files, usage, steps: step + 1 };
      }
      messages.push({ role: 'assistant', content: reply.slice(0, 4000) });
      pushActivity(task, { kind: 'tool', text: describeCall(parsed.tool, parsed.args) });
      let output;
      try {
        output = await runTool(task, parsed.tool, parsed.args, guard, { write: input.write, permission: input.permission, confirmDanger: input.confirmDanger !== false });
        if (parsed.tool === 'write_file' || parsed.tool === 'replace_in_file') files = [...new Set([...files, output.path])];
        if (parsed.tool === 'move_path') files = [...new Set([...files, `${output.from} → ${output.to}`])];
        if (parsed.tool === 'delete_path' && output.removed) files = [...new Set([...files, `${output.path}（已删除）`])];
        messages.push({ role: 'user', content: `工具结果（${parsed.tool}）：\n${JSON.stringify(output).slice(0, 6000)}` });
        pushActivity(task, { kind: 'observation', text: `${TOOL_LABELS[parsed.tool] || parsed.tool} 完成`, detail: describeOutput(parsed.tool, output) });
      } catch (error) {
        const message = error?.message || '工具执行失败';
        messages.push({ role: 'user', content: `工具错误（${parsed.tool}）：${message}` });
        pushActivity(task, { kind: 'error', text: `${parsed.tool} 失败：${message}` });
      }
    }
    summary = summary || '已达到步数上限，任务未完全完成。';
    pushActivity(task, { kind: 'result', text: summary });
    return { summary, files, usage, steps: input.maxSteps, exhausted: true };
  }

  function finalize(task, { summary, error, usage, files, steps, startedAt }) {
    const stamp = new Date().toISOString();
    const cancelled = task.cancelled === true;
    const failed = Boolean(error);
    task.status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    task.endedAt = stamp;
    task.updatedAt = stamp;
    task.error = cancelled ? '模型 Agent 已停止' : failed ? String(error).slice(0, 2000) : undefined;
    task.artifacts = {
      ...(task.artifacts || {}),
      cli: {
        executorId: 'model',
        summary: (task.effortFallback ? `（所选思考强度未被该模型接受，已按默认档执行）\n` : '') + String(summary || (failed ? '模型 Agent 执行失败' : '')).slice(0, 6000),
        usage: usage || {},
        error: failed ? String(error).slice(0, 2000) : undefined,
        artifacts: [...new Set(files || [])].slice(0, 100),
        stats: { steps: steps || 0 },
        modelLabel: typeof task.modelLabel === 'string' ? task.modelLabel : '',
        effort: typeof task.effort === 'string' ? task.effort : 'default',
        ...(task.effortFallback ? { effortFallback: true } : {}),
        exitCode: failed ? 1 : 0,
        durationMs: Date.now() - startedAt,
        workspace: task.workspace,
      },
    };
    persist(task);
    return task;
  }

  return {
    id: 'model',
    name: '模型 Agent',
    kind: 'cli',
    available: true,
    requiresDataset: false,
    capabilities: ['cli', 'model', 'text-output', 'project-write', 'tools'],
    validateInput: input => normalizeModelInput(input),
    defaultInput: value => normalizeModelInput({ prompt: value }),
    start(ticket, assignment, input) {
      const normalized = normalizeModelInput(input?.executorInput ?? input);
      // 没有可用模型时立刻报错：不要让用户以为任务在跑，结果几秒后才失败。
      const ctx = typeof context === 'function' ? context() : context;
      if (!ctx?.key || !ctx?.settings?.model) {
        throw statusError('还没有可用的模型：请在「设置 → 规划设置」里配置并选择默认模型', 503);
      }
      const runWorkspace = normalized.workspace ? path.resolve(normalized.workspace) : workspace;
      try {
        if (!fs.statSync(runWorkspace).isDirectory()) throw new Error('not a directory');
      } catch {
        throw statusError('项目工作目录不存在或不可访问', 400);
      }
      const prior = store.get('task', assignment.id);
      if (prior) return prior;
      const stamp = new Date().toISOString();
      const task = {
        id: assignment.id,
        workAssignmentId: assignment.id,
        executorId: 'model',
        goal: ticket.command,
        status: 'running',
        createdAt: stamp,
        updatedAt: stamp,
        workspace: runWorkspace,
        activity: [],
        artifacts: {},
        ...(normalized.profileId ? { profileId: normalized.profileId } : {}),
        ...(normalized.effort ? { effort: normalized.effort } : {}),
        ...(normalized.roots?.length ? { roots: normalized.roots } : {}),
      };
      persist(task);
      running.set(task.id, true);
      const startedAt = Date.now();
      const controller = new AbortController();
      task.controller = controller;
      void execute(task, normalized, runWorkspace)
        .then(result => finalize(task, { ...result, startedAt }))
        .catch(error => {
          const cancelled = task.cancelled === true;
          finalize(task, {
            summary: cancelled ? '模型 Agent 已停止' : '',
            error: cancelled ? '模型 Agent 已停止' : error?.message || '模型 Agent 执行失败',
            usage: {},
            files: [],
            steps: 0,
            startedAt,
          });
        })
        .finally(() => { running.delete(task.id); grantedAccess.delete(task.id); });
      return task;
    },
    get: taskId => (taskId && store.get('task', taskId)) || null,
    // 越界访问的确认：引擎把 task.status=awaiting_approval 映射成工单待确认，
    // 用户点「批准」就走 approve，点「退回」走 reject。
    approval(task) {
      const request = task?.accessRequest;
      if (!request || task.status !== 'awaiting_approval') return undefined;
      return { version: 1, kind: 'access', requestId: request.id, path: request.path, mode: request.mode };
    },
    approve(task, input) {
      if (!task) return;
      const pending = pendingAccess.get(task.id);
      if (!pending) return;
      const allow = input?.decision !== 'deny';
      task.status = 'running';
      persist(task);
      pending.resolve({ allow, reason: allow ? '' : '用户在确认弹窗里拒绝了这次请求' });
    },
    reject(task) {
      const pending = task ? pendingAccess.get(task.id) : null;
      if (!pending) return;
      task.status = 'running';
      persist(task);
      pending.resolve({ allow: false, reason: '用户退回了这次请求' });
    },
    stop(task) {
      if (!task) return;
      const pending = pendingAccess.get(task.id);
      if (pending) pending.resolve({ allow: false, reason: '任务已停止' });
      task.cancelled = true;
      task.status = 'cancelled';
      task.endedAt = new Date().toISOString();
      task.updatedAt = task.endedAt;
      task.error = '模型 Agent 已停止';
      persist(task);
    },
    close() {
      for (const taskId of running.keys()) {
        const task = store.get('task', taskId);
        if (task && task.status === 'running') {
          task.status = 'cancelled';
          task.cancelled = true;
          task.error = '服务重启，模型 Agent 已中断';
          persist(task);
        }
      }
      running.clear();
    },
  };
}
