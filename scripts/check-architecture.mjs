// 结构闸门：application/ 是内层，只允许标准库与本层模块。
// 出现 Web 框架、数据库驱动、子进程、文件系统或网络客户端就说明有东西放错了层。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const layer = path.join(root, 'server', 'application');
// platform/ 是内核：纯技术函数（脱敏、时间、env），内层可以用，但不能反向变成业务依赖。
const kernel = path.join(root, 'server', 'platform');

const FORBIDDEN = [
  { name: 'express', pattern: /from\s+['"]express['"]|require\(['"]express['"]\)/ },
  { name: 'sqlite', pattern: /from\s+['"]node:sqlite['"]|require\(['"]node:sqlite['"]\)|from\s+['"]sqlite3?['"]/ },
  { name: 'child_process', pattern: /from\s+['"]node:child_process['"]|require\(['"]child_process['"]\)/ },
  { name: 'fs', pattern: /from\s+['"]node:fs(\/promises)?['"]|from\s+['"]fs(\/promises)?['"]|require\(['"]fs['"]\)/ },
  { name: 'http', pattern: /from\s+['"]node:https?['"]|from\s+['"]https?['"]|require\(['"]https?['"]\)/ },
  { name: 'net', pattern: /from\s+['"]node:(?:net|tls|dgram)['"]/ },
  { name: 'fetch', pattern: /\bfetch\s*\(/ }
];

const imported = source => {
  const names = new Set();
  for (const match of source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) names.add(match[1]);
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) names.add(match[1]);
  return [...names];
};

const walk = directory => {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  return entries.flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : entry.name.endsWith('.js') ? [target] : [];
  });
};

const files = walk(layer);
const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const rule of FORBIDDEN) if (rule.pattern.test(source)) violations.push(`${path.relative(root, file)} → ${rule.name}`);
  // 相对 import 只能留在 application/ 或引用 platform/；内层不能反向依赖 adapter。
  for (const specifier of imported(source)) {
    if (!specifier.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(file), specifier);
    const inLayer = resolved.startsWith(layer + path.sep);
    const inKernel = resolved.startsWith(kernel + path.sep);
    if (!inLayer && !inKernel) violations.push(`${path.relative(root, file)} → 越界引用 ${specifier}`);
  }
}

if (violations.length) {
  console.error('application/ 层出现违禁依赖：');
  for (const item of violations) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`structure-ok：application/ 共 ${files.length} 个文件，没有框架、数据库、子进程、文件系统或网络依赖。`);
