import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workError } from '../domain.js';
import { classifyCommand } from '../command-risk.js';
import { modelRequest, readModelResponse, providerUsage, toolCallsOf, visibleReply } from '../../model-protocol.js';

// Lagent：用已经接入的模型自己推理 + 调工具，把一个任务在项目目录里做完。
// 与 CLI 执行器不同，它的每一步都写进 task.activity，界面因此能像看 dsh 一样看到过程。
const statusError = (message, status = 400) => Object.assign(workError(message, status), { status });
const MAX_STEPS = 20;
// read_file 一次默认读 240 行、最多 800 行：模型不需要也不该整篇吞下大文件。
const READ_LIMIT = 240;
const READ_MAX_LINES = 800;
const LIST_LIMIT = 120;
const HITS_LIMIT = 40;
const ACTIVITY_LIMIT = 60;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.lagent', 'data', '.venv', '__pycache__', 'coverage', '.spec-workflow', '.browser-smoke-profile', '.playwright-mcp']);
const WRITE_TOOLS = new Set(['write_file', 'replace_in_file', 'move_path', 'delete_path']);
const READ_COMMAND = /^(git\s+(status|diff|log|show|branch)\b[^|;&<>]*|node\s+--check\s+\S+)$/i;
// 纯查看类命令：只列、只看，不写不改。
const SAFE_READ = /^(?:Get-ChildItem|Get-Content|Get-Item|Get-Location|Get-ChildItem|Test-Path|Resolve-Path|dir|ls|type|cat)\b[^;|&<>$]*$/i;
// 管道后面接这些「只是整理输出」的 cmdlet 也算查看：`Get-Content x | Select -First 80`。
// 只要有一段不在名单里（比如 ForEach-Object、Set-Content），仍然要问用户。
const READ_CMDLETS = new Set([
  'get-childitem', 'get-content', 'get-item', 'get-location', 'test-path', 'resolve-path',
  'select-object', 'select-string', 'where-object', 'sort-object', 'measure-object', 'group-object',
  'format-table', 'format-list', 'out-string', 'select', 'get-unique', 'dir', 'ls', 'type', 'cat'
]);
function isReadOnlyShell(command) {
  const value = String(command || '').trim();
  if (!value) return false;
  // `< > & $ \`` 都能写文件或起子命令，一律不算查看；分号只是「连着跑几条」，逐条判断。
  if (/[<>&$`]/.test(value)) return false;
  const segments = value.split(';').map(part => part.trim()).filter(Boolean);
  if (!segments.length) return false;
  return segments.every(segment => {
    // 每条都可能是「git status; git log」这种只读命令，也可能是一串管道。
    if (isReadOnlySegment(segment)) return true;
    const stages = segment.split('|').map(part => part.trim()).filter(Boolean);
    if (!stages.length) return false;
    return stages.every(stage => {
      const name = stage.split(/\s+/)[0].replace(/^\.\\/, '').toLowerCase();
      return READ_CMDLETS.has(name);
    });
  });
}
// 单条只读命令：git 的只读子命令、node --check，或白名单里的查看命令。
function isReadOnlySegment(segment) {
  const value = String(segment || '').trim();
  if (!value) return false;
  if (READ_COMMAND.test(value) || SAFE_READ.test(value)) return true;
  return false;
}
// 三档权限，语义与 dsh 一致：仅查看 / 只在工作区内修改 / 完全权限。
const PERMISSIONS = ['read', 'workspace', 'full'];
const PERMISSION_LABELS = { read: '仅查看', workspace: '仅工作区内修改', full: '完全权限' };
// 模型明确说「没做成」的措辞：一个文件都没改、结论却是这些，就按失败上报。
const REFUSAL = /无法(执行|完成|删除|修改|写入|创建)|未执行|没有(?:写)?权限|无权限|不能(删除|修改|写入|创建)|未完成/;
// 「只做了一部分」也算没完成：用户看到的「已完成」必须是真做完了，不能是半成品。
const PARTIAL = /只完成(?:了)?部分|部分工作|还不能|没(?:有)?机会|尚未完成|没能完成|只做了/;

const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

export function normalizeModelInput(input, { maxPromptBytes = 16 * 1024 } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw statusError('executorInput 必须为结构化对象');
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt) throw statusError('Lagent 的 prompt 必须是非空字符串');
  if (prompt.includes('\0')) throw statusError('prompt 不允许 NUL 字符');
  if (Buffer.byteLength(prompt) > maxPromptBytes) throw statusError(`prompt 不能超过 ${maxPromptBytes} 字节`);
  // 8 步太紧：列目录 + 逐项删除 + 复查就刚好用光，连给结论的余量都没有。
  const steps = input.maxSteps === undefined ? 12 : input.maxSteps;
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

// 读文件按「行」算，返回带行号的正文。
// 之前 offset 被当成字符下标，模型要「第 100 行」拿到的是第 100 个字符，
// 于是它只能整篇读或者反复试，白白烧步数。
function readFile(guard, target, offset, limit) {
  const absolute = guard.resolve(target).absolute;
  const stat = fs.statSync(absolute);
  if (!stat.isFile()) throw new Error('只能读取文件');
  if (stat.size > 400 * 1024) throw new Error('文件超过 400KB，请改用 search_code 定位要看的片段');
  const content = fs.readFileSync(absolute, 'utf8');
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const from = Number.isInteger(offset) && offset > 0 ? Math.min(offset - 1, total) : 0;
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, READ_MAX_LINES) : READ_LIMIT;
  const slice = lines.slice(from, from + take);
  const numbered = slice.map((line, index) => `${String(from + index + 1).padStart(String(total).length, ' ')}| ${line}`).join('\n');
  const end = from + slice.length;
  return {
    path: guard.display(absolute),
    size: stat.size,
    totalLines: total,
    fromLine: from + 1,
    toLine: end,
    truncated: end < total,
    ...(end < total ? { hint: `还有 ${total - end} 行没读：要接着看就再调 read_file{path:"${guard.display(absolute)}",offset:${end + 1},limit:${take}}，不要整篇重读。` } : {}),
    content: numbered
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

// 写完 JS 立刻做一次语法检查：模型经常写出「缺一个函数声明」这类错，
// 等它自己想起来跑 node --check 往往已经用完步数（实测就是这样交了半成品）。
function syntaxCheck(absolute) {
  if (!/\.(?:c|m)?js$/i.test(absolute)) return null;
  try {
    execFileSync(process.execPath, ['--check', absolute], { encoding: 'buffer', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (error) {
    const raw = `${error?.stdout ? decodeOutput(error.stdout) : ''}${error?.stderr ? decodeOutput(error.stderr) : ''}`.trim();
    const line = raw.split(/\r?\n/).find(item => /SyntaxError|Unexpected|Error:/.test(item)) || raw.split(/\r?\n/)[0] || '';
    return line.trim().slice(0, 200) || '语法检查没通过';
  }
}

function writeFile(guard, target, content, { append = false } = {}) {
  const absolute = guard.resolve(target).absolute;
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  if (Buffer.byteLength(content) > 200 * 1024) throw new Error('单次写入不能超过 200KB');
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const existed = fs.existsSync(absolute);
  const before = existed ? fs.readFileSync(absolute, 'utf8') : '';
  // append：大文件分几次写。模型一次输出有上限，长文件必须先写骨架再往后追加。
  if (append) {
    fs.appendFileSync(absolute, content, 'utf8');
    return {
      path: guard.display(absolute),
      created: !existed,
      appended: true,
      before: before.length,
      after: before.length + content.length,
    };
  }
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

const PWSH = process.platform === 'win32'
  ? (process.env.LAGENT_POWERSHELL || 'powershell.exe')
  : (process.env.LAGENT_POWERSHELL || 'pwsh');

// execFileSync 默认按 utf8 解码，而 Windows 的 cmd / powershell 输出的是代码页（GBK）。
// 先按 utf8 解，出现替换字符（U+FFFD）就退回 GBK —— 否则报错信息会变成一片乱码。
function decodeOutput(chunk) {
  if (chunk === undefined || chunk === null) return '';
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(buffer); } catch { return utf8; }
}

// `cmd.exe /d /s /c "powershell -NoProfile -Command "a;b""` 会把内层引号吃掉：
// PowerShell 只回显脚本、退出码还可能是 0，看起来像成功其实什么都没做（真实踩过）。
// 所以把 powershell 调用整个解包出来，脚本作为单独的 argv 传给 pwsh，不经过 cmd。
export function unwrapPowerShell(value) {
  const head = /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+([\s\S]*)$/i.exec(value);
  if (!head) return null;
  let rest = head[1].trim();
  const flags = [];
  for (;;) {
    const flag = /^-(NoProfile|NonInteractive|NoLogo|ExecutionPolicy|NoExit)\b(?:\s+(Bypass|Unrestricted|RemoteSigned|AllSigned|Restricted))?/i.exec(rest);
    if (!flag) break;
    flags.push(flag[1] === 'ExecutionPolicy' && flag[2] ? `-ExecutionPolicy ${flag[2]}` : `-${flag[1]}`);
    rest = rest.slice(flag[0].length).trim();
  }
  const commandFlag = /^-(?:Command|c)\b\s*/i.exec(rest);
  if (!commandFlag) return null;
  let script = rest.slice(commandFlag[0].length).trim();
  if (script.length > 1 && ((script.startsWith('"') && script.endsWith('"')) || (script.startsWith("'") && script.endsWith("'")))) script = script.slice(1, -1);
  if (!script) return null;
  return { flags, script };
}

// 回显没执行：有些 shell 会把整条命令原样打印出来、退出码却是 0。
function echoOnly(command, output) {
  const text_ = String(output || '').trim();
  const value = String(command || '').trim();
  if (!text_) return false;
  return text_ === value || (text_.length < 40 && value.includes(text_) && text_ === value.slice(0, text_.length));
}

// 只读白名单直接跑（不起 shell，避免命令拼接）；其它命令必须先拿到用户确认，再交给 shell 执行。
function runCommand(guard, command, { approved = false, shell = '' } = {}) {
  const value = text(command, 4000);
  if (!value) throw new Error('command 不能为空');
  // 先过风险分类：阻断级永不执行；危险级即使已有读取白名单也要人工确认。
  const risk = classifyCommand(value);
  if (risk.level === 'blocked') throw new Error(`命令被安全策略拒绝：${risk.reasons.join('；') || '高风险操作'}`);
  if (risk.level === 'danger' && !approved) throw new Error(`这条命令被判定为高风险（${risk.reasons.join('；') || '不可逆操作'}），需要用户确认后才能执行`);
  const explicitShell = shell === 'powershell' ? 'powershell' : '';
  const readOnly = !explicitShell && READ_COMMAND.test(value);
  // 查看类命令走 PowerShell：Get-ChildItem 这类是 cmdlet，交给 cmd 会报"不是内部或外部命令"。
  const safeRead = !explicitShell && !readOnly && (SAFE_READ.test(value) || isReadOnlyShell(value));
  if (!readOnly && !safeRead && !approved) throw new Error('这条命令不在只读白名单内：需要用户在弹窗里确认后才能执行');
  const options = { cwd: guard.base, timeout: readOnly || safeRead ? 15000 : 60000, encoding: 'buffer', windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  const unwrapped = explicitShell ? { flags: [], script: value } : unwrapPowerShell(value);
  try {
    if (readOnly) {
      const parts = value.split(/\s+/);
      const output = decodeOutput(execFileSync(parts[0], parts.slice(1), options));
      return { command: value, exitCode: 0, output: output.slice(0, 4000) };
    }
    if (safeRead) {
      const output = decodeOutput(execFileSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', value], options));
      return { command: value, exitCode: 0, output: output.slice(0, 4000) };
    }
    if (unwrapped) {
      // 默认带上 -NoProfile：加载用户 profile 会让每条命令多等十几秒。
      const flags = [...new Set(['-NoProfile', '-NonInteractive', ...unwrapped.flags])];
      const output = decodeOutput(execFileSync(PWSH, [...flags, '-Command', unwrapped.script], options));
      if (echoOnly(value, output) || echoOnly(unwrapped.script, output)) {
        return { command: value, exitCode: 900, output: `命令只被回显、没有真正执行（多半是引号被 shell 吃掉了）。改用 run_command{command:"<脚本本体>", shell:"powershell"} 会更稳。` };
      }
      return { command: value, exitCode: 0, output: output.slice(0, 4000) };
    }
    const output = decodeOutput(execFileSync(SHELL.file, SHELL.args(value), options));
    if (echoOnly(value, output)) {
      return { command: value, exitCode: 900, output: '命令只被回显、没有真正执行（多半是引号被 shell 吃掉了）。改用 run_command{command:"<脚本本体>", shell:"powershell"} 会更稳。' };
    }
    return { command: value, exitCode: 0, output: output.slice(0, 4000) };
  } catch (error) {
    const raw = error?.stdout || error?.stderr || error?.message || '';
    return {
      command: value,
      exitCode: typeof error?.status === 'number' ? error.status : 1,
      output: decodeOutput(raw).slice(0, 4000),
    };
  }
}

export function modelSystemPrompt({ maxSteps, write, permission = write ? 'workspace' : 'read', roots = [] }) {
  const mode = PERMISSIONS.includes(permission) ? permission : 'workspace';
  const extra = roots.length ? `已获得长期授权的其它目录：${roots.join('、')}。` : '';
  return [
    '你是 Lagent，是这个软件内置的 Agent，在一个本地工作目录里独立完成任务。',
    '每一步只输出一个 JSON 对象，不要输出任何其它文字、不要用代码块包裹：',
    '· 调用工具：{"tool":"read_file","args":{"path":"src/app.tsx"}}',
    '· 结束任务：{"final":{"done":true,"summary":"做了什么、结论是什么","files":["改动过的文件"]}}',
    '· 只有确实全部做完才写 done:true；没做完、缺东西、需要人接手，写 done:false 并在 summary 里说清还差什么。',
    '',
    `可用工具：list_files{path?}、read_file{path,offset?,limit?}、search_code{pattern,path?}${write ? '、write_file{path,content,append?}、replace_in_file{path,find,replace,all?}、move_path{from,to}、delete_path{path,recursive?,dryRun?}' : ''}、run_command{command,shell?}、project_changes{}。`,
    '接手一个已经有改动的项目时，先调 project_changes：它会告诉你谁在什么时候改了什么文件；然后按需 read_file 读那一段（offset/limit 都是行号，返回带行号，超长会提示下次从第几行接着读），或 run_command 跑 git diff 看差异，不要动辄把整个文件从头读一遍。',
    '注意：环境是 Windows。要跑 PowerShell 就写 run_command{command:"<脚本本体>",shell:"powershell"}，command 直接给脚本，不要自己再拼 powershell -Command 和引号。',
    '查文件内容一律用 search_code；不要用 Select-String / findstr / Get-Content 管道去搜（管道里带 ForEach-Object、脚本块会被当成写操作，卡在等用户确认上）。真要跑命令，先只用 git status / git diff / node --check 这类。',
    '检查语法就一条一条跑 run_command{command:"node --check js/game.js"}，一个文件一条；不要写 foreach / for 循环把多个文件包起来（脚本块会被判成需要确认，任务会停在那里等用户点允许）。',
    '路径可以写相对工作目录的路径，也可以写绝对路径。',
    '每次工具调用的 content 控制在一两百行以内：输出有长度上限，写长文件就先 write_file 骨架，再用 write_file{path,content:"<后续片段>",append:true} 一段段追加，最后 read_file 复核。',
    `当前权限档位：${PERMISSION_LABELS[mode]}（${mode}）。`,
    write
      ? '你被允许修改文件：先读再改，一次改一处，改动要小、要能说清理由。小改用 replace_in_file，整文件重写才用 write_file；文件较长时先写上半段，再 append 追加下半段，不要一次写完整个大文件（会被输出上限截断）。删除不可恢复：只有用户明确要求删除时才做，先 delete_path{path,dryRun:true} 看清将删掉什么，再真正删；dryRun 只是预览，确认要删就**去掉 dryRun 再调一次**。删目录必须显式传 recursive:true；工作目录本身不许删。删除文件和目录优先用 delete_path，不要用 run_command 拼 Remove-Item。'
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

// 模型输出 JSON 经常不严格：包一层代码块、字符串里有没转义的换行、末尾多个逗号。
// 直接 JSON.parse 会失败并要求重试，一次重试就浪费一步（实测写游戏时 8 步里废掉 4 步），
// 所以这里做一层容错修复，能救回来的就不重试。
function repairJson(source) {
  const body = source.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/```$/, '').trim();
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of body) {
    if (inString) {
      if (escaped) { out += char; escaped = false; continue; }
      if (char === '\\') { out += char; escaped = true; continue; }
      if (char === '"') { inString = false; out += char; continue; }
      // 字符串里的裸换行/制表符必须转义，否则整段 JSON 不合法。
      if (char === '\n') { out += '\\n'; continue; }
      if (char === '\r') { out += '\\r'; continue; }
      if (char === '\t') { out += '\\t'; continue; }
      out += char;
      continue;
    }
    if (char === '"') { inString = true; out += char; continue; }
    out += char;
  }
  // 去掉对象/数组里多余的尾逗号。
  return out.replace(/,\s*([}\]])/g, '$1');
}

// 写文件时最容易坏的地方是 content 里带了没转义的双引号（HTML 属性、JS 字符串），
// 整段 JSON 因此不合法。这种情况不该浪费一步重试：直接从 "content":" 取到最后一个引号当正文。
function salvageWrite(raw) {
  const toolHit = raw.match(/"tool"\s*:\s*"([a-z_]+)"/);
  if (!toolHit) return null;
  const tool = toolHit[1];
  const field = name => {
    const hit = raw.match(new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return hit ? hit[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : '';
  };
  const flag = name => {
    const hit = raw.match(new RegExp(`"${name}"\\s*:\\s*(true|false)`));
    return hit ? hit[1] === 'true' : undefined;
  };
  const args = {};
  for (const name of ['path', 'from', 'to', 'pattern', 'command', 'find', 'replace', 'shell']) {
    const value = field(name);
    if (value) args[name] = value;
  }
  for (const name of ['recursive', 'dryRun', 'append', 'all']) {
    const value = flag(name);
    if (value !== undefined) args[name] = value;
  }
  // 正文单独取：从 content 的开引号一直到最后一条引号，中间的引号都当正文。
  const contentHit = raw.match(/"content"\s*:\s*"/);
  if (contentHit) {
    const start = contentHit.index + contentHit[0].length;
    const end = raw.lastIndexOf('"');
    if (end > start) {
      args.content = raw.slice(start, end)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
  }
  const known = ['write_file', 'read_file', 'list_files', 'search_code', 'replace_in_file', 'move_path', 'delete_path', 'run_command'];
  if (!known.includes(tool) || !Object.keys(args).length) return null;
  return { type: 'tool', tool, args, salvaged: true };
}

export function parseModelStep(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed;
  const candidate = raw.slice(start, end + 1);
  try {
    parsed = JSON.parse(candidate);
  } catch {
    try {
      parsed = JSON.parse(repairJson(candidate));
    } catch {
      const salvaged = salvageWrite(raw);
      if (salvaged) return salvaged;
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.final && typeof parsed.final === 'object') {
    return {
      type: 'final',
      summary: text(parsed.final.summary, 4000),
      files: Array.isArray(parsed.final.files) ? parsed.final.files.filter(item => typeof item === 'string').slice(0, 40) : [],
      // done:false 明确表示「没做完」——比在摘要里猜措辞可靠，用于决定工单成败。
      done: typeof parsed.final.done === 'boolean' ? parsed.final.done : undefined,
    };
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
  project_changes: '看改动',
  run_command: '运行命令',
};

// 原生工具调用的声明。声明了它，模型就不用把文件内容塞进手写 JSON 的字符串里，
// 长文件也不会因为一个没转义的双引号整段作废（实测这是最常坏的一环）。
export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'list_files', description: '列出目录里的文件与子目录', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对工作目录的路径，省略表示根目录' } } } } },
  { type: 'function', function: { name: 'read_file', description: '按行读取文本文件，返回带行号的正文（默认 240 行，最多 800 行）', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: '从第几行开始（1 起，按行不是按字符）' }, limit: { type: 'number', description: '最多读多少行' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_code', description: '在项目里按正则搜索文本', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入文件；append=true 时追加到末尾，适合分多次写长文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, append: { type: 'boolean' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: '把文件里的一段原文替换成新内容', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean', description: '有多处时是否全部替换' } }, required: ['path', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'move_path', description: '移动或重命名文件/目录', parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'delete_path', description: '删除文件或目录；dryRun 只预览不删，删目录必须 recursive=true', parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' }, dryRun: { type: 'boolean' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: '执行命令。查看类命令（Get-ChildItem/dir/ls 等）直接跑；其它命令需要用户确认。要跑 PowerShell 脚本就传 shell="powershell"', parameters: { type: 'object', properties: { command: { type: 'string' }, shell: { type: 'string', enum: ['powershell'] } }, required: ['command'] } } },
  { type: 'function', function: { name: 'project_changes', description: '查看项目最近谁改了什么：改动清单、涉及文件、当前未提交的改动。接手任务前先看它，别整篇重读文件', parameters: { type: 'object', properties: {} } } },
];

// 有些模型会把工具调用当文本吐出来（内部标记 + 一串 XML）。解析不出来就白丢一步，
// 所以这里按纯 ASCII 片段兜底识别：能认出来就照常执行。
export function parseMarkupCalls(text) {
  if (typeof text !== 'string' || !/invoke name="/.test(text)) return [];
  const calls = [];
  const pattern = /invoke name="([a-z_]+)"[\s\S]*?parameter name="args"[^>]*>([\s\S]*?)<\/parameter>/g;
  let hit;
  while ((hit = pattern.exec(text)) !== null) {
    let args = {};
    try { args = JSON.parse(repairJson(hit[2])); } catch { try { args = salvageArgs(hit[2]); } catch { args = {}; } }
    if (args && typeof args === 'object') calls.push({ id: `markup-${calls.length}`, name: hit[1], args });
  }
  return calls;
}

function salvageArgs(raw) {
  const args = {};
  const pattern = /name="([a-z_]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
  let hit;
  while ((hit = pattern.exec(raw)) !== null) {
    if (hit[1] === 'args') continue;
    args[hit[1]] = hit[2].trim();
  }
  return args;
}

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
  if (tool === 'project_changes') return '查看项目最近的改动';
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
  if (tool === 'project_changes') {
    return String(output.changes || '').split('\n').slice(0, 4).join(' / ').slice(0, 240);
  }
  return '';
}

export function modelExecutor({ store, cwd, context, contextFor, fetchImpl = fetch, perCallTimeoutMs = 120000, totalTimeoutMs = 900000, projectState = () => '' }) {
  if (!store || typeof cwd !== 'string' || !cwd) throw new TypeError('model 执行器需要 store 和 cwd');
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
    // 写文件动辄几千字，4096 的输出预算经常不够；先按 8192 要，供应商不认再退回 4096。
    const budget = Math.min(8192, Number(ctx.maxTokens) || 8192);
    // 原生工具调用优先：协议支持就声明，供应商拒绝（有的兼容接口不认 tools）就退回文本 JSON。
    const toolOptions = task.noTools ? {} : { tools: TOOL_SCHEMAS };
    const request = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, budget, false, { ...ctx.settings, ...toolOptions, sessionId: task.projectChatId || task.id });
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
      // 有的兼容接口不认 tools 字段：退回纯文本 JSON 协议重试，别让整个任务因为一个可选能力失败。
      if (!task.noTools && [400, 422].includes(response.status) && /tool|function|unsupported|unknown (?:parameter|field)/i.test(detail)) {
        task.noTools = true;
        const retry = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, budget, false, { ...ctx.settings, sessionId: task.projectChatId || task.id });
        const second = await fetchImpl(retry.endpoint, { method: 'POST', headers: retry.headers, body: JSON.stringify(retry.body), signal, redirect: 'error' });
        if (second.ok) {
          const payload = await readModelResponse(second);
          return { payload, protocol: retry.protocol, usage: providerUsage(payload?.usage, retry.protocol) };
        }
        try { detail = (await second.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* 同上 */ }
      }
      // 未验证的思考强度可能被供应商拒绝：自动退回默认档重试一次，并在结果里说明，
      // 避免用户只是选了个档位就整条任务失败。
      if (ctx.settings.effort && ctx.settings.effort !== 'default' && [400, 422].includes(response.status) && /effort|reasoning/i.test(detail)) {
        task.effortFallback = true;
        const retry = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, budget, false, { ...ctx.settings, effort: 'default', sessionId: task.projectChatId || task.id });
        const second = await fetchImpl(retry.endpoint, { method: 'POST', headers: retry.headers, body: JSON.stringify(retry.body), signal, redirect: 'error' });
        if (second.ok) {
          const payload = await readModelResponse(second);
          return { payload, protocol: retry.protocol, usage: providerUsage(payload?.usage, retry.protocol) };
        }
        try { detail = (await second.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* 同上 */ }
        throw statusError(`模型接口返回 HTTP ${second.status}${detail ? `：${detail}` : ''}`, 502);
      }
      // 有些供应商的输出上限比 8192 低：被拒时按 4096 再试一次，而不是让整个任务失败。
      if (budget > 4096 && [400, 422].includes(response.status) && /max_tokens|max output|too (?:large|long)|exceed/i.test(detail)) {
        const retry = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, 4096, false, { ...ctx.settings, sessionId: task.projectChatId || task.id });
        const third = await fetchImpl(retry.endpoint, { method: 'POST', headers: retry.headers, body: JSON.stringify(retry.body), signal, redirect: 'error' });
        if (third.ok) {
          const payload = await readModelResponse(third);
          return { payload, protocol: retry.protocol, usage: providerUsage(payload?.usage, retry.protocol) };
        }
        try { detail = (await third.text()).replace(/\s+/g, ' ').trim().slice(0, 300); } catch { /* 同上 */ }
        throw statusError(`模型接口返回 HTTP ${third.status}${detail ? `：${detail}` : ''}`, 502);
      }
      throw statusError(`模型接口返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`, 502);
    }
    let payload;
    try {
      payload = await readModelResponse(response);
    } catch (error) {
      // 网关偶尔回空正文 / 推理模型把预算全花在 thinking 上：各重试一次，比让任务直接失败有用。
      const retryable = ['REASONING_ONLY', 'EMPTY_RESPONSE'].includes(error?.code);
      if (retryable) {
        const settings = error.code === 'REASONING_ONLY' ? { ...ctx.settings, thinking: 'off' } : ctx.settings;
        const retry = modelRequest(ctx.settings.baseUrl, ctx.settings.model, messages, ctx.key, budget, false, { ...settings, sessionId: task.projectChatId || task.id });
        const second = await fetchImpl(retry.endpoint, { method: 'POST', headers: retry.headers, body: JSON.stringify(retry.body), signal, redirect: 'error' });
        if (second.ok) {
          task.emptyRetry = true;
          const retried = await readModelResponse(second);
          return { payload: retried, protocol: retry.protocol, usage: providerUsage(retried?.usage, retry.protocol) };
        }
      }
      throw error;
    }
    return { payload, protocol: request.protocol, usage: providerUsage(payload?.usage, request.protocol) };
  }

  function replyOf(payload, protocol) {
    return visibleReply(payload, protocol);
  }

  // 一步的产出可能是原生工具调用、也可能仍是文本（JSON 或模型自己写的调用标记）。
  // 统一成 { calls, text }：有调用就先执行调用，文本留作兜底解析。
  function envelopeOf(payload, protocol) {
    const native = toolCallsOf(payload, protocol);
    if (native.length) {
      const message = payload?.choices?.[0]?.message;
      const text = protocol === 'anthropic' || typeof message?.content !== 'string' ? '' : message.content;
      return { calls: native, text: typeof text === 'string' ? text : '' };
    }
    const text = replyOf(payload, protocol);
    const marked = parseMarkupCalls(text);
    if (marked.length) return { calls: marked, text };
    return { calls: [], text };
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
    if (name === 'project_changes') {
      // 接手别人的改动前先看这份清单：谁、什么时候、动了哪些文件、为什么。
      const brief = String(projectState(guard.base) || '').trim();
      return { changes: brief || '这个目录还没有记录到任何改动。' };
    }
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
      const written = writeFile(guard, args?.path, args?.content, { append: args?.append === true });
      const syntaxError = syntaxCheck(guard.resolve(args?.path).absolute);
      if (syntaxError) {
        pushActivity(task, { kind: 'error', text: `${shortPath(written.path)} 语法检查没通过`, detail: syntaxError });
        return { ...written, syntaxError, hint: '文件已写入但语法不对：读一下报错那一带，用 replace_in_file 修掉再继续。' };
      }
      return written;
    }
    if (name === 'replace_in_file') {
      await guardAccess(task, guard.resolve(args?.path), 'write', undefined, permission);
      const replaced = replaceInFile(guard, args?.path, { find: args?.find, replace: args?.replace, all: args?.all === true });
      const syntaxError = syntaxCheck(guard.resolve(args?.path).absolute);
      if (syntaxError) {
        pushActivity(task, { kind: 'error', text: `${shortPath(replaced.path)} 改完语法没通过`, detail: syntaxError });
        return { ...replaced, syntaxError, hint: '改完语法不对：再读一遍这一带，用 replace_in_file 修正。' };
      }
      return replaced;
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
      const value = text(args?.command, 4000);
      const shell = args?.shell === 'powershell' ? 'powershell' : '';
      if (!value) throw new Error('command 不能为空');
      // 模型爱把只读命令包一层 powershell -Command：剥出脚本本体再判断，否则 node --check 也要弹窗。
      const body = shell ? value : (unwrapPowerShell(value)?.script || value);
      // 只读的查看类命令（列目录/看文件/语法检查）不该每次都弹窗——用户已经抱怨过"点不完"。
      const readable = READ_COMMAND.test(body) || SAFE_READ.test(body) || isReadOnlyShell(body);
      if (readable) return runCommand(guard, value);
      if (permission === 'read') throw new Error(`当前是「${PERMISSION_LABELS.read}」模式，只能执行只读命令（查看目录/文件、git status/diff/log/show/branch、node --check）。`);
      if (permission === 'workspace') {
        const answer = await requestAccess(task, { path: value, mode: 'command', reason: '不在只读白名单内，需要确认后执行' });
        if (!answer.allow) throw new Error('用户拒绝了这条命令，请不要绕道执行');
      }
      return runCommand(guard, value, { approved: true, shell });
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
    // 输出被截断只值得重试一次：第二次还截断说明这个任务本身超出了模型的输出预算。
    let truncationRetried = false;
    const deadline = Date.now() + totalTimeoutMs;
    for (let step = 0; step < input.maxSteps; step += 1) {
      if (task.cancelled) throw statusError('Lagent 已停止', 499);
      const remaining = deadline - Date.now();
      if (remaining <= 1000) throw statusError('Lagent 超出总时长限制', 504);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(perCallTimeoutMs, remaining));
      let reply = '';
      let envelope = { calls: [], text: '' };
      try {
        const result = await askModel(messages, task, controller.signal, input.profileId, input.effort);
        for (const [key, value] of Object.entries(result.usage || {})) usage[key] = (usage[key] || 0) + (Number(value) || 0);
        envelope = envelopeOf(result.payload, result.protocol);
        reply = envelope.text;
        task.protocol = result.protocol;
      } catch (error) {
        // 输出超上限常见于「一次写整个大文件」：告诉它拆小重来，比直接判失败有用得多。
        if (error?.code === 'OUTPUT_TRUNCATED' && !truncationRetried) {
          truncationRetried = true;
          pushActivity(task, { kind: 'note', text: '这次输出被长度上限截断，让它拆小重来' });
          messages.push({ role: 'user', content: '上一次输出因为超过长度上限被截断了。请把这一步拆小：每次只输出一个工具调用 JSON；写文件时先写前 60–100 行，再用 write_file{path:"同一个文件",content:"<后续片段>",append:true} 追加剩下的部分；不要一次输出整个大文件。' });
          step -= 1;
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
      // 原生工具调用（可能一次给多个）：直接执行，结果按协议回填，省掉一整层文本解析。
      if (envelope.calls.length) {
        const chat = task.protocol === 'chat-completions';
        if (chat) {
          messages.push({
            role: 'assistant',
            content: reply || '',
            tool_calls: envelope.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
          });
        }
        for (const call of envelope.calls) {
          pushActivity(task, { kind: 'tool', text: describeCall(call.name, call.args) });
          try {
            const output = await runTool(task, call.name, call.args, guard, { write: input.write, permission: input.permission, confirmDanger: input.confirmDanger !== false });
            if (call.name === 'write_file' || call.name === 'replace_in_file') files = [...new Set([...files, output.path])];
            if (call.name === 'move_path') files = [...new Set([...files, `${output.from} → ${output.to}`])];
            if (call.name === 'delete_path' && output.removed) files = [...new Set([...files, `${output.path}（已删除）`])];
            const brief = JSON.stringify(output).slice(0, 6000);
            messages.push(chat ? { role: 'tool', tool_call_id: call.id, content: brief } : { role: 'user', content: `工具结果（${call.name}）：\n${brief}` });
            pushActivity(task, { kind: 'observation', text: `${TOOL_LABELS[call.name] || call.name} 完成`, detail: describeOutput(call.name, output) });
          } catch (error) {
            const message = error?.message || '工具执行失败';
            messages.push(chat ? { role: 'tool', tool_call_id: call.id, content: `失败：${message}` } : { role: 'user', content: `工具错误（${call.name}）：${message}` });
            pushActivity(task, { kind: 'error', text: `${TOOL_LABELS[call.name] || call.name} 失败：${message}` });
          }
        }
        continue;
      }
      const parsed = parseModelStep(reply);
      if (!parsed) {
        messages.push({ role: 'assistant', content: reply.slice(0, 2000) });
        messages.push({ role: 'user', content: '你没有按要求输出 JSON。请只输出一个 JSON 对象：{"tool":"..."} 或 {"final":{...}}。' });
        // 把坏掉的开头留在过程里：否则只能看到「不是合法 JSON」，没法判断是转义问题还是被截断。
        pushActivity(task, { kind: 'error', text: '模型回复不是合法 JSON，已要求重试', detail: reply.slice(0, 300).replace(/\s+/g, ' ') });
        continue;
      }
      if (parsed.type === 'final') {
        summary = parsed.summary;
        files = [...new Set([...files, ...parsed.files])];
        // 模型自己说「没做」时不能对外报成功：done:false、或写着只做了一部分/无法完成，
        // 都说明任务没达成，标成失败比显示「已完成」诚实。
        const refused = parsed.done === false || PARTIAL.test(summary) || (files.length === 0 && REFUSAL.test(summary));
        pushActivity(task, refused
          ? { kind: 'error', text: summary || '任务没有完成', detail: '模型表示没有做完' }
          : { kind: 'result', text: summary || 'Lagent 完成' });
        return { summary, files, usage, steps: step + 1, ...(refused ? { failed: `任务没有完成：${summary.slice(0, 300)}` } : {}) };
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
    // 步数用完了：不要立刻判失败，先让它基于已经看到的东西直接给结论（不再调工具）。
    // 真实任务常在最后一步刚好做完，差一步就报失败会让人以为没干活。
    pushActivity(task, { kind: 'note', text: '步数快用完了，让它直接收尾给结论' });
    try {
      const remaining = deadline - Date.now();
      if (remaining > 1000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(perCallTimeoutMs, remaining));
        let reply = '';
        try {
          const result = await askModel([
            ...messages,
            { role: 'user', content: '步数已经用完，不能再调用任何工具。请只输出一个 JSON：{"final":{"done":false/true,"summary":"已经做完什么、还有什么没做","files":["改动过的文件"]}}。没做完就写 done:false。' },
          ], task, controller.signal, input.profileId, input.effort);
          for (const [key, value] of Object.entries(result.usage || {})) usage[key] = (usage[key] || 0) + (Number(value) || 0);
          reply = replyOf(result.payload, result.protocol);
        } finally {
          clearTimeout(timer);
        }
        const parsed = parseModelStep(reply);
        if (parsed?.type === 'final') {
          summary = parsed.summary || '步数用完，任务收尾';
          files = [...new Set([...files, ...parsed.files])];
          // 步数是用完的，本身就说明「不完整」；模型写 done:false 或说部分/没机会，就直接判失败。
          const refused = parsed.done !== true || PARTIAL.test(summary) || (files.length === 0 && REFUSAL.test(summary));
          pushActivity(task, refused
            ? { kind: 'error', text: summary, detail: '步数用完，任务只做了一部分' }
            : { kind: 'result', text: summary });
          return { summary, files, usage, steps: input.maxSteps, ...(refused ? { failed: `任务没有完成：${summary.slice(0, 300)}` } : {}) };
        }
      }
    } catch { /* 收尾也失败就按步数上限处理 */ }
    summary = summary || '已达到步数上限，任务未完全完成。';
    pushActivity(task, { kind: 'error', text: summary, detail: `用完了 ${input.maxSteps} 步还没得出结论` });
    // 步数用完 = 任务没做完，不能对外报成「已完成」。
    return { summary, files, usage, steps: input.maxSteps, exhausted: true };
  }

  function finalize(task, { summary, error, usage, files, steps, startedAt }) {
    const stamp = new Date().toISOString();
    const cancelled = task.cancelled === true;
    const failed = Boolean(error);
    task.status = cancelled ? 'cancelled' : failed ? 'failed' : 'completed';
    task.endedAt = stamp;
    task.updatedAt = stamp;
    task.error = cancelled ? 'Lagent 已停止' : failed ? String(error).slice(0, 2000) : undefined;
    task.artifacts = {
      ...(task.artifacts || {}),
      cli: {
        executorId: 'model',
        summary: (task.effortFallback ? `（所选思考强度未被该模型接受，已按默认档执行）\n` : '') + String(summary || (failed ? 'Lagent 执行失败' : '')).slice(0, 6000),
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
    name: 'Lagent',
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
        // 步数用完 / 模型自己说没做成：如实标成失败，别人看到「已完成」会以为事情做完了。
        .then(result => {
          const error = result.exhausted
            ? `到达步数上限（${result.steps} 步），任务没有做完`
            : result.failed;
          return finalize(task, error ? { ...result, startedAt, error } : { ...result, startedAt });
        })
        .catch(error => {
          const cancelled = task.cancelled === true;
          finalize(task, {
            summary: cancelled ? 'Lagent 已停止' : '',
            error: cancelled ? 'Lagent 已停止' : error?.message || 'Lagent 执行失败',
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
      task.error = 'Lagent 已停止';
      persist(task);
    },
    close() {
      for (const taskId of running.keys()) {
        const task = store.get('task', taskId);
        if (task && task.status === 'running') {
          task.status = 'cancelled';
          task.cancelled = true;
          task.error = '服务重启，Lagent 已中断';
          persist(task);
        }
      }
      running.clear();
    },
  };
}
