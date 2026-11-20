import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exposedWorkError, workError } from '../domain.js';

const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 640 * 1024;
const MAX_DEPTH = 4;
const CLONE_TIMEOUT_MS = 120_000;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SENSITIVE_DIRS = new Set(['.git', '.ssh', '.gnupg']);
const SENSITIVE_FILES = /^(?:\.env(?:\.|$)|id_(?:rsa|dsa|ed25519)(?:\.|$)|.*\.(?:pem|p12|pfx|key))$/i;

const posix = value => value.replaceAll('\\', '/');
// fs.cpSync 在部分 Windows 临时目录上会报 EIO，这里用逐项复制兜底。
function copyDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export function readCatalog() {
  const raw = readFileSync(new URL('./catalog.json', import.meta.url), 'utf8');
  const list = JSON.parse(raw);
  return Array.isArray(list) ? list : [];
}

export function catalogEntry(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  return readCatalog().find(item => item.id === value) || null;
}

function cleanPath(value) {
  const raw = typeof value === 'string' ? value.trim().replaceAll('\\', '/') : '';
  if (!raw) return '';
  const normalized = raw.replace(/^\/+|\/+$/g, '');
  if (!normalized) return '';
  // 「.」表示仓库根目录：按空路径处理，走完整克隆，避免 sparse-checkout 把根目录排除掉。
  if (normalized === '.') return '';
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(part => part === '..' || part === '')) {
    throw workError('技能路径不能包含上级目录或盘符', 400);
  }
  return normalized;
}

function cleanRef(value) {
  const ref = typeof value === 'string' ? value.trim() : '';
  if (!ref) return '';
  if (!/^[A-Za-z0-9._\/-]{1,120}$/.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')) {
    throw workError('Git ref 无效', 400);
  }
  return ref;
}

function normalizeRepo(value) {
  const raw = typeof value === 'string' ? value.trim().replace(/^git@github\.com:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') : '';
  const repo = raw.replace(/^\/+|\/+$/g, '');
  if (!SAFE_REPO.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) throw workError('只支持 owner/repo 或 GitHub 仓库地址', 400);
  return repo;
}

function githubUrl(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/tree\/([^/]+)\/(.+?))?\/?$/i.exec(raw);
  if (https) return { repo: `${https[1]}/${https[2]}`, ref: https[3] ? decodeURIComponent(https[3]) : '', path: https[4] ? decodeURIComponent(https[4]) : '' };
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return { repo: `${ssh[1]}/${ssh[2]}`, ref: '', path: '' };
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
  if (short) return { repo: raw, ref: '', path: '' };
  return null;
}

/** 把推荐 id、GitHub 地址或结构化来源统一成 {repo, path, ref, catalogId}。 */
export function parseSkillSource(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    // 只给自动化测试用：生产接口不暴露本地路径。
    if (input.localPath && process.env.LAGENT_SKILL_ALLOW_LOCAL === '1') {
      return { localPath: path.resolve(String(input.localPath)), path: cleanPath(input.path), ref: '', catalogId: '' };
    }
    if (input.catalogId) {
      const entry = catalogEntry(input.catalogId);
      if (!entry) throw workError('未知的推荐技能', 404);
      return { repo: entry.repo, path: cleanPath(entry.path), ref: cleanRef(entry.ref || ''), catalogId: entry.id };
    }
    if (input.repo) return { repo: normalizeRepo(input.repo), path: cleanPath(input.path), ref: cleanRef(input.ref), catalogId: '' };
    if (input.url) return parseSkillSource(input.url);
  }
  if (typeof input === 'string') {
    const entry = readCatalog().find(item => item.id === input.trim());
    if (entry) return { repo: entry.repo, path: cleanPath(entry.path), ref: cleanRef(entry.ref || ''), catalogId: entry.id };
    const parsed = githubUrl(input);
    if (parsed) return { repo: normalizeRepo(parsed.repo), path: cleanPath(parsed.path), ref: cleanRef(parsed.ref), catalogId: '' };
    if (/^[a-z]+:\/\//i.test(input.trim())) throw workError('只支持 GitHub 仓库地址', 400);
  }
  throw workError('请填写 GitHub 仓库地址，例如 owner/repo 或 https://github.com/owner/repo', 400);
}

function runGit(args, { cwd, timeoutMs = CLONE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      finish(exposedWorkError('拉取技能超时，请检查网络后重试', 504));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-64 * 1024); });
    child.on('error', error => finish(error.code === 'ENOENT' ? exposedWorkError('未找到 Git，请先安装 Git 后再安装技能', 503) : error));
    child.on('close', code => {
      if (code === 0) return finish(null, stdout.trim());
      finish(exposedWorkError(`Git 操作失败：${(stderr || stdout || `退出码 ${code}`).trim().slice(0, 300)}`, 502));
    });
  });
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const hit = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!hit) continue;
    let value = hit[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && !/^[>|]$/.test(value)) data[hit[1]] = value;
  }
  return data;
}

function firstParagraph(text) {
  return text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#') && !line.startsWith('---')) || '';
}

export function readSkillMeta(directory, fallbackName) {
  const file = path.join(directory, 'SKILL.md');
  let content = '';
  try { content = readFileSync(file, 'utf8'); } catch { throw workError('技能目录缺少 SKILL.md', 400); }
  const data = frontmatter(content);
  const name = typeof data.name === 'string' && SAFE_NAME.test(data.name.trim()) ? data.name.trim() : fallbackName;
  if (!name || !SAFE_NAME.test(name)) throw workError('SKILL.md 的技能名称不合法', 400);
  const description = String(data.description || firstParagraph(content) || '').trim().slice(0, 500);
  return { name, description };
}

function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function collectFiles(root) {
  const files = [];
  let total = 0;
  const walk = (directory, relative, depth) => {
    if (depth > MAX_DEPTH) throw workError('技能目录层级过深', 400);
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(directory, entry.name);
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw workError(`技能里包含符号链接，已拒绝：${rel}`, 400);
      if (entry.isDirectory()) {
        if (SENSITIVE_DIRS.has(entry.name)) throw workError(`技能里包含受保护目录，已拒绝：${rel}`, 400);
        walk(abs, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SENSITIVE_FILES.test(entry.name)) throw workError(`技能里包含受保护文件，已拒绝：${rel}`, 400);
      const stat = statSync(abs);
      if (stat.size > MAX_FILE_BYTES) throw workError(`技能文件过大（上限 640KB）：${rel}`, 413);
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw workError('技能总大小超过 5MB', 413);
      files.push({ path: rel, size: stat.size, sha256: hashFile(abs) });
      if (files.length > MAX_FILES) throw workError('技能文件数量超过 100 个', 413);
    }
  };
  walk(root, '', 0);
  if (!files.length) throw workError('技能目录是空的', 400);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash('sha256').update(files.map(file => `${file.path}:${file.sha256}`).join('\n')).digest('hex');
  return { files, digest, bytes: total };
}

function findLicense(skillDir, repoRoot) {
  for (const directory of [skillDir, repoRoot]) {
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    const found = entries.find(entry => entry.isFile() && /^(?:license|licence|copying)(?:\..*)?$/i.test(entry.name));
    if (found) return found.name;
  }
  return '';
}

function discoverCandidates(repoRoot) {
  const result = [];
  const walk = (directory, depth) => {
    if (depth > 3 || result.length >= 50) return;
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) result.push(posix(path.relative(repoRoot, directory)) || '.');
    for (const entry of entries) {
      if (!entry.isDirectory() || SENSITIVE_DIRS.has(entry.name) || entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(path.join(directory, entry.name), depth + 1);
    }
  };
  walk(repoRoot, 0);
  return result;
}

function safeInside(root, relative) {
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw workError('技能路径越界', 400);
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(target);
    if (!within(realRoot, realTarget)) throw workError('技能路径通过符号链接指向仓库外', 400);
  } catch (error) {
    if (error?.status) throw error;
    throw workError('技能目录不存在', 404);
  }
  return target;
}

/**
 * 克隆并校验一个技能来源。
 * 返回的临时目录由调用方负责清理；preview 会把它缓存到安装阶段。
 */
export async function fetchSkillSource(source, { commit = '', timeoutMs = CLONE_TIMEOUT_MS } = {}) {
  const target = parseSkillSource(source);
  const tmp = path.join(os.tmpdir(), `lagent-skill-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  let keep = false;
  try {
    let actualCommit;
    if (target.localPath) {
      if (!existsSync(target.localPath)) throw workError('本地技能目录不存在', 404);
      rmSync(tmp, { recursive: true, force: true });
      copyDirectory(target.localPath, tmp);
      actualCommit = 'local';
    } else {
      const args = ['clone', '--depth', '1', '--quiet'];
      if (target.ref) args.push('--branch', target.ref);
      // 已知技能子目录时只拉这个目录：官方 skills 仓库整包很大，完整克隆会拖到超时。
      if (target.path) args.push('--filter=blob:none', '--sparse');
      args.push(`https://github.com/${target.repo}.git`, tmp);
      await runGit(args, { timeoutMs });
      if (target.path) await runGit(['-C', tmp, 'sparse-checkout', 'set', '--no-cone', target.path], { timeoutMs });
      actualCommit = await runGit(['-C', tmp, 'rev-parse', 'HEAD'], { timeoutMs });
    }
    if (commit && actualCommit.toLowerCase() !== commit.toLowerCase()) {
      throw workError('来源已经变化，请重新预览后再安装', 409);
    }
    // 仓库根目录本身就是技能时，.git 只是克隆元数据，不应参与文件收集与安全审查。
    if (!target.localPath) {
      try { rmSync(path.join(tmp, '.git'), { recursive: true, force: true }); } catch { /* 清理失败不影响后续校验 */ }
    }
    if (!target.path) {
      const candidates = discoverCandidates(tmp);
      if (candidates.length === 1) target.path = candidates[0] === '.' ? '' : candidates[0];
      else if (!candidates.length) throw workError('这个仓库里没有找到 SKILL.md', 404);
      else return { ok: false, candidates, repo: target.repo || 'local', ...(target.localPath ? { localPath: target.localPath } : {}), ref: target.ref, commit: actualCommit };
    }
    const skillDir = target.path ? safeInside(tmp, target.path) : tmp;
    if (!statSync(skillDir).isDirectory()) throw workError('技能路径不是目录', 400);
    const meta = readSkillMeta(skillDir, path.basename(target.path || (target.repo ? target.repo.split('/')[1] : '') || 'skill'));
    const collected = collectFiles(skillDir);
    const license = findLicense(skillDir, tmp);
    keep = true;
    return {
      ok: true,
      ...(target.catalogId ? { catalogId: target.catalogId } : {}),
      name: meta.name,
      description: meta.description,
      repo: target.repo || 'local',
      ...(target.localPath ? { localPath: target.localPath } : {}),
      path: target.path || '.',
      ref: target.ref,
      commit: actualCommit,
      license,
      skillDir,
      files: collected.files,
      digest: collected.digest,
      bytes: collected.bytes,
      tempDir: tmp,
      cleanup: () => rmSync(tmp, { recursive: true, force: true })
    };
  } finally {
    if (!keep) rmSync(tmp, { recursive: true, force: true });
  }
}

export function cleanupSource(info) {
  try { info?.cleanup?.(); } catch { /* 临时目录清理失败不影响主流程 */ }
}

export { MAX_FILES, MAX_TOTAL_BYTES, MAX_FILE_BYTES };
