// 把 DSH 里指向旧目录 D:\datagent 的记录统一改成 D:\lagent。
// 场景：项目文件夹从 D:\datagent 改名成 D:\lagent 之后，DSH 的工作区配置与会话缓存里
// 仍然写着旧路径，于是「Lagent」工作区下的会话列表变空、新建会话报
// working-directory: directory does not exist: "D:\datagent"。
//
// 用法（务必先完全退出 DSH，否则运行中的应用会把内存里的旧值再写回去）：
//   node scripts/fix-workspace-path.mjs          真正执行
//   node scripts/fix-workspace-path.mjs --dry-run 只报告不落地
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const OLD = 'datagent';
const NEW = 'lagent';
const dryRun = process.argv.includes('--dry-run');

const dshRoot = path.join(os.homedir(), '.dsh');
const storages = path.join(dshRoot, 'storages');
const workspaceFile = path.join(storages, 'workspace.json');
const sessionDir = path.join(storages, 'session_projcache', 'sessions');

const report = { files: 0, changed: 0, skipped: [], errors: [] };

// 改写前先整份备份，出问题可以原样放回
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(storages, `.fix-backup-${stamp}`);
let backupReady = false;
function backup(file, label) {
  if (dryRun) return;
  if (!backupReady) {
    fs.mkdirSync(backupDir, { recursive: true });
    backupReady = true;
  }
  const safe = label.replace(/[\\/]/g, '__');
  fs.copyFileSync(file, path.join(backupDir, safe));
}

function writeJson(file, value) {
  if (dryRun) return;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function rewriteString(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/datagent/gi, NEW);
}

// 只改「路径字段」，不碰对话正文与工具输出，避免改动历史记录里的文字
function fixPathField(holder, key, hits) {
  if (!holder || typeof holder !== 'object') return;
  const value = holder[key];
  if (typeof value === 'string' && value.toLowerCase().includes(OLD)) {
    holder[key] = rewriteString(value);
    hits.n += 1;
  }
}

function handle(file, label, kind) {
  report.files += 1;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    report.errors.push(`${label}: 读取失败 ${error.message}`);
    return;
  }
  if (!raw.toLowerCase().includes(OLD)) {
    report.skipped.push(label);
    return;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    report.errors.push(`${label}: 不是合法 JSON，跳过（${error.message}）`);
    return;
  }
  const hits = { n: 0 };
  if (kind === 'workspace') {
    const workspaces = json?.tables?.workspaces || {};
    for (const id of Object.keys(workspaces)) fixPathField(workspaces[id], 'path', hits);
  } else {
    const record = json?.record || {};
    fixPathField(record.identity || {}, 'cwd', hits);
    const row = record.rows?.workingDirectory;
    if (row && typeof row.val === 'string') fixPathField(row, 'val', hits);
  }
  if (!hits.n) {
    report.skipped.push(label);
    return;
  }
  backup(file, label);
  writeJson(file, json);
  report.changed += 1;
  console.log(`${dryRun ? '[dry] ' : ''}${label} 改了 ${hits.n} 处`);
}

// 1) 工作区配置
if (fs.existsSync(workspaceFile)) handle(workspaceFile, 'workspace.json', 'workspace');
else report.errors.push(`找不到 ${workspaceFile}`);

// 2) 每个会话缓存（含 workingDirectory 与 identity.cwd）
if (fs.existsSync(sessionDir)) {
  const files = fs.readdirSync(sessionDir).filter(name => name.endsWith('.json'));
  for (const name of files) handle(path.join(sessionDir, name), `session/${name}`);
} else {
  report.errors.push(`找不到 ${sessionDir}`);
}

// 3) 指向旧目录的联接/空目录：确认新目录是真的，再把旧名字清掉
const oldDir = 'D:\\' + OLD;
const newDir = 'D:\\' + NEW;
let linkNote = '';
try {
  const stat = fs.lstatSync(oldDir);
  if (stat.isSymbolicLink()) linkNote = `${oldDir} 是联接，删除它（不改动目标）`;
  else if (stat.isDirectory()) {
    const entries = fs.readdirSync(oldDir);
    if (entries.length === 0 || (entries.length === 1 && entries[0] === '.memsearch')) {
      linkNote = `${oldDir} 只剩 ${entries.join(', ') || '空'}，删除`;
    } else {
      linkNote = `${oldDir} 里还有 ${entries.length} 项，没有自动删除，请人工确认`;
    }
  }
  if (linkNote && !dryRun) {
    if (stat.isSymbolicLink()) fs.rmSync(oldDir, { recursive: false, force: true });
    else if (linkNote.startsWith(oldDir) && /删除$/.test(linkNote)) fs.rmSync(oldDir, { recursive: true, force: true });
  }
} catch {
  linkNote = `${oldDir} 已不存在，无需处理`;
}
if (!fs.existsSync(newDir)) report.errors.push(`注意：${newDir} 不存在`);

console.log('');
console.log(`扫描文件 ${report.files} 个，改写 ${report.changed} 个，跳过 ${report.skipped.length} 个`);
if (report.errors.length) {
  console.log('需要留意：');
  for (const line of report.errors) console.log('  - ' + line);
}
if (linkNote) console.log(`旧目录：${linkNote}`);
if (!dryRun && backupReady) console.log(`改动前的副本：${backupDir}`);
console.log(dryRun ? '\n（dry-run，没有改动任何文件）' : '\n完成。现在重新打开 DSH，会话列表应恢复，新建会话也不会再报目录不存在。');
