import { closeSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import { workError } from './domain.js';

export const PROJECT_FILE_LIMITS = Object.freeze({
  maxEntries: 800,
  maxSearchResults: 300,
  maxScanEntries: 12000,
  maxScanDepth: 8,
  maxPathChars: 1200,
  maxTextBytes: 2 * 1024 * 1024,
  maxOfficeBytes: 30 * 1024 * 1024,
  maxStreamBytes: 80 * 1024 * 1024,
  maxSlides: 200,
  maxSlideChars: 20000,
  maxTableRows: 200,
  maxTableColumns: 24,
  maxSheets: 3
});

// 目录浏览里永远不展开这些目录：既拖慢读取，也不是用户此刻想预览的内容。
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__', '.pytest_cache', '.lagent', 'target', 'bower_components']);
// 敏感文件只显示名称，不返回内容；.env.example 这类模板仍然可以预览。
const SENSITIVE_FILE = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials\.json|secrets?\.json|.+\.(?:pem|key|pfx|p12|kdbx))$/i;
const SENSITIVE_TEMPLATE = /^\.env\.(?:example|sample|template)$/i;

const MARKDOWN_EXT = new Set(['md', 'markdown']);
const HTML_EXT = new Set(['html', 'htm']);
const TEXT_EXT = new Set(['txt', 'log', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'env', 'xml', 'xsl', 'xslt', 'svg', 'properties', 'lock', 'sql', 'gitignore', 'gitattributes', 'dockerignore', 'editorconfig', 'prettierrc', 'eslintrc', 'babelrc', 'nvmrc', 'npmrc', 'yarnrc', 'readme', 'license', 'licence', 'changelog', 'authors', 'notice']);
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'scss', 'sass', 'less', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'vue', 'svelte', 'astro', 'dart', 'lua', 'r', 'm', 'mm', 'gradle', 'dockerfile', 'makefile', 'cmake', 'nginx', 'proto', 'graphql', 'gql']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const CSV_EXT = new Set(['csv', 'tsv']);
const SHEET_EXT = new Set(['xlsx']);
const LEGACY_OFFICE_EXT = new Set(['doc', 'ppt', 'xls']);

const MIME_BY_EXT = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonc: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  ppt: 'application/vnd.ms-powerpoint',
  xls: 'application/vnd.ms-excel'
};

const EXTENSIONLESS = new Set(['dockerfile', 'makefile', 'readme', 'license', 'licence', 'changelog', 'authors', 'notice', 'procfile', 'gemfile', 'rakefile', 'vagrantfile']);

const toPosix = value => String(value || '').replaceAll('\\', '/');
const basename = value => path.basename(String(value || '').replaceAll('\\', '/'));
const extOf = name => {
  const lower = basename(name).toLowerCase();
  if (EXTENSIONLESS.has(lower)) return lower;
  if (lower.startsWith('.env.')) return 'env';
  const dot = lower.lastIndexOf('.');
  if (dot > 0) return lower.slice(dot + 1);
  // `.gitignore`、`.editorconfig` 这类点文件没有第二个点，按名称本身当扩展名。
  return lower.startsWith('.') ? lower.slice(1) : '';
};
const mimeOf = ext => MIME_BY_EXT[ext] || 'application/octet-stream';
const kindOf = ext => EXTENSIONLESS.has(ext) && !CODE_EXT.has(ext) ? 'text'
  : MARKDOWN_EXT.has(ext) ? 'markdown'
  : HTML_EXT.has(ext) ? 'html'
    : ext === 'pdf' ? 'pdf'
      : ext === 'docx' ? 'docx'
        : ext === 'doc' ? 'doc'
          : ext === 'pptx' ? 'pptx'
            : ext === 'ppt' ? 'ppt'
              : CSV_EXT.has(ext) ? 'csv'
                : SHEET_EXT.has(ext) ? 'sheet'
                  : LEGACY_OFFICE_EXT.has(ext) ? 'legacy'
                    : IMAGE_EXT.has(ext) ? 'image'
                      : CODE_EXT.has(ext) ? 'code'
                        : TEXT_EXT.has(ext) ? 'text'
                          : 'unsupported';
const previewableKind = kind => !['unsupported', 'legacy'].includes(kind);
const isSensitive = name => {
  const lower = basename(name).toLowerCase();
  if (SENSITIVE_TEMPLATE.test(lower)) return false;
  return SENSITIVE_FILE.test(lower);
};

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statSafe(value) {
  try { return statSync(value); } catch { return null; }
}

function readHead(file, bytes = 8192) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(bytes, 8192));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function looksBinary(buffer) {
  for (let index = 0; index < buffer.length; index += 1) if (buffer[index] === 0) return true;
  return false;
}

const decodeXml = value => String(value || '')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'")
  .replaceAll('&apos;', "'")
  .replaceAll('&amp;', '&');

const clipText = (value, max) => {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max)}\n…（已截断）` : text;
};

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.result === 'string' || typeof value.result === 'number') return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map(part => part?.text || '').join('');
    if (value.error) return '';
  }
  return String(value);
}

function tableFromRows(rows) {
  const width = Math.min(PROJECT_FILE_LIMITS.maxTableColumns, Math.max(0, ...rows.map(row => row.length)));
  if (!width) return { headers: [], rows: [] };
  const padded = rows.map(row => Array.from({ length: width }, (_, index) => cellText(row[index])));
  return { headers: padded[0] || [], rows: padded.slice(1) };
}

/**
 * 项目内文件浏览与预览。所有路径都相对项目根目录解析，并做 realpath 校验，
 * 防止 `..`、绝对路径或符号链接跳出项目；敏感文件只列名称，不返回内容。
 */
export function createProjectFiles({ getProject, now = () => new Date().toISOString() } = {}) {
  if (typeof getProject !== 'function') throw new TypeError('createProjectFiles 需要 getProject');

  function rootOf(projectId) {
    const project = getProject(projectId);
    if (!project || typeof project.path !== 'string' || !project.path) throw workError('项目不存在', 404);
    let root;
    try {
      root = realpathSync(project.path);
      if (!statSync(root).isDirectory()) throw new Error('not a directory');
    } catch {
      throw workError('项目文件夹已不在本机，请重新导入', 409);
    }
    return { project, root };
  }

  function cleanRelative(value) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value !== 'string') throw workError('文件路径必须是字符串', 400);
    if (value.length > PROJECT_FILE_LIMITS.maxPathChars) throw workError('文件路径过长', 400);
    if (value.includes('\0')) throw workError('文件路径无效', 400);
    if (path.isAbsolute(value) || path.win32.isAbsolute(value)) throw workError('只能访问项目内的相对路径', 400);
    const normalized = toPosix(value).replace(/^\/+/, '');
    const segments = normalized.split('/');
    if (segments.some(segment => segment === '..')) throw workError('不能访问项目目录之外的文件', 403);
    // 文件树里隐藏的目录也不能通过手写 URL 绕进去；.git、依赖目录和 .lagent 内部数据都不该预览。
    if (segments.some(segment => HIDDEN_DIRS.has(segment.toLowerCase()))) throw workError('这个目录不提供预览', 403);
    return normalized.replace(/\/+$/, '');
  }

  function resolveInside(root, relative, { mustExist = true } = {}) {
    const cleaned = cleanRelative(relative);
    const target = path.resolve(root, cleaned);
    if (!inside(root, target)) throw workError('不能访问项目目录之外的文件', 403);
    let real = target;
    if (mustExist) {
      try { real = realpathSync(target); } catch { throw workError('文件不存在或无法访问', 404); }
      if (!inside(root, real)) throw workError('不能访问项目目录之外的符号链接', 403);
    }
    return { absolute: real, relative: toPosix(path.relative(root, real)), cleaned };
  }

  function entryOf(root, absolute, name, type, { locked = false } = {}) {
    const info = statSafe(absolute);
    const ext = extOf(name);
    const kind = type === 'dir' ? 'dir' : kindOf(ext);
    const sensitive = type === 'file' && (locked || isSensitive(name));
    return {
      name,
      path: toPosix(path.relative(root, absolute)),
      type,
      ...(info ? { size: info.size, modifiedAt: info.mtime.toISOString() } : {}),
      ext,
      kind,
      previewable: type === 'file' && previewableKind(kind) && !sensitive,
      ...(sensitive ? { locked: true } : {})
    };
  }

  function list(projectId, relative = '') {
    const { root } = rootOf(projectId);
    const resolved = resolveInside(root, relative, { mustExist: true });
    let info;
    try { info = statSync(resolved.absolute); } catch { throw workError('目录不存在或无法访问', 404); }
    if (!info.isDirectory()) throw workError('该路径不是文件夹', 400);
    let dirents;
    try { dirents = readdirSync(resolved.absolute, { withFileTypes: true }); } catch { throw workError('没有权限读取该目录', 403); }
    const entries = [];
    for (const dirent of dirents) {
      const absolute = path.join(resolved.absolute, dirent.name);
      let type = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other';
      let locked = false;
      if (dirent.isSymbolicLink()) {
        const real = statSafe(absolute) ? (() => { try { return realpathSync(absolute); } catch { return null; } })() : null;
        if (!real || !inside(root, real)) {
          if (type !== 'file') continue;
          locked = true;
        } else {
          const realInfo = statSafe(real);
          type = realInfo?.isDirectory() ? 'dir' : realInfo?.isFile() ? 'file' : 'other';
        }
      }
      if (type === 'other') continue;
      if (type === 'dir' && HIDDEN_DIRS.has(dirent.name.toLowerCase())) continue;
      entries.push(entryOf(root, absolute, dirent.name, type, { locked }));
      if (entries.length >= PROJECT_FILE_LIMITS.maxEntries + 1) break;
    }
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    const parent = resolved.relative ? toPosix(path.dirname(resolved.relative)) : null;
    return {
      root: path.basename(root),
      path: resolved.relative,
      parent: parent === '.' ? '' : parent,
      entries: entries.slice(0, PROJECT_FILE_LIMITS.maxEntries),
      truncated: entries.length > PROJECT_FILE_LIMITS.maxEntries
    };
  }

  // 侧栏搜索：只扫文件名，不读内容；限制深度与访问量，避免在大仓库里卡住。
  function search(projectId, query = '') {
    const { root } = rootOf(projectId);
    const q = typeof query === 'string' ? query.trim().toLowerCase() : '';
    if (q.length < 2) return { query: q, entries: [], truncated: false };
    const results = [];
    let scanned = 0;
    let truncated = false;
    const queue = [{ absolute: root, relative: '', depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      let dirents;
      try { dirents = readdirSync(current.absolute, { withFileTypes: true }); } catch { continue; }
      for (const dirent of dirents) {
        if (scanned >= PROJECT_FILE_LIMITS.maxScanEntries) { truncated = true; break; }
        scanned += 1;
        const absolute = path.join(current.absolute, dirent.name);
        if (dirent.isDirectory()) {
          if (current.depth >= PROJECT_FILE_LIMITS.maxScanDepth) continue;
          if (HIDDEN_DIRS.has(dirent.name.toLowerCase())) continue;
          if (dirent.isSymbolicLink()) continue;
          queue.push({ absolute, relative: toPosix(path.relative(root, absolute)), depth: current.depth + 1 });
          continue;
        }
        if (!dirent.isFile()) continue;
        if (!dirent.name.toLowerCase().includes(q)) continue;
        results.push(entryOf(root, absolute, dirent.name, 'file'));
        if (results.length >= PROJECT_FILE_LIMITS.maxSearchResults) { truncated = true; break; }
      }
      if (results.length >= PROJECT_FILE_LIMITS.maxSearchResults) break;
    }
    results.sort((left, right) => {
      const leftStarts = left.name.toLowerCase().startsWith(q) ? 0 : 1;
      const rightStarts = right.name.toLowerCase().startsWith(q) ? 0 : 1;
      if (leftStarts !== rightStarts) return leftStarts - rightStarts;
      return left.path.localeCompare(right.path, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    return { query: q, entries: results, truncated };
  }

  function readText(file, size) {
    if (looksBinary(readHead(file))) throw workError('这个文件看起来是二进制文件，暂不支持文本预览', 415);
    const truncated = size > PROJECT_FILE_LIMITS.maxTextBytes;
    if (!truncated) return { text: readFileSync(file, 'utf8'), truncated };
    let fd;
    try {
      fd = openSync(file, 'r');
      const buffer = Buffer.alloc(PROJECT_FILE_LIMITS.maxTextBytes);
      const read = readSync(fd, buffer, 0, buffer.length, 0);
      return { text: buffer.subarray(0, read).toString('utf8'), truncated };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  async function pptxPreview(file) {
    const { default: JSZip } = await import('jszip');
    const buffer = readFileSync(file);
    const zip = await JSZip.loadAsync(buffer);
    const names = Object.keys(zip.files)
      .map(name => ({ name, match: /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name) }))
      .filter(item => item.match)
      .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
      .slice(0, PROJECT_FILE_LIMITS.maxSlides);
    const slides = [];
    let used = 0;
    for (const item of names) {
      if (used >= PROJECT_FILE_LIMITS.maxSlideChars) break;
      const xml = await zip.files[item.name].async('string');
      // PPT 把同一段文字拆成多个 run；先按段落聚合，再拼 run，避免每个词组单独换行。
      const paragraphs = [];
      const blocks = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)].map(match => match[1]);
      for (const block of blocks.length ? blocks : [xml]) {
        const runs = [];
        for (const match of block.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
          const text = decodeXml(match[1]);
          if (text) runs.push(text);
        }
        const line = runs.join('').trim();
        if (line) paragraphs.push(line);
      }
      const text = clipText(paragraphs.join('\n'), Math.min(4000, PROJECT_FILE_LIMITS.maxSlideChars - used));
      used += text.length;
      slides.push({ index: Number(item.match[1]), title: paragraphs[0]?.slice(0, 120) || `第 ${Number(item.match[1])} 页`, text });
    }
    return slides;
  }

  async function docxPreview(file) {
    const mammoth = (await import('mammoth')).default;
    const result = await mammoth.convertToHtml({ buffer: readFileSync(file) });
    return clipText(String(result.value || ''), 2 * 1024 * 1024);
  }

  async function sheetPreview(file) {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(readFileSync(file));
    const sheets = [];
    workbook.worksheets.slice(0, PROJECT_FILE_LIMITS.maxSheets).forEach(worksheet => {
      const rows = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber > PROJECT_FILE_LIMITS.maxTableRows + 1) return;
        const values = Array.isArray(row.values) ? row.values.slice(1) : [];
        if (rowNumber === 1 || values.some(value => cellText(value))) rows.push(values);
      });
      const table = tableFromRows(rows.slice(0, PROJECT_FILE_LIMITS.maxTableRows + 1));
      sheets.push({ name: worksheet.name, ...table, truncated: rows.length > PROJECT_FILE_LIMITS.maxTableRows });
    });
    return sheets;
  }

  async function preview(projectId, relative) {
    const { root } = rootOf(projectId);
    const resolved = resolveInside(root, relative, { mustExist: true });
    const name = basename(resolved.absolute);
    const info = statSync(resolved.absolute);
    if (!info.isFile()) throw workError('只能预览文件', 400);
    if (isSensitive(name)) throw workError('这是敏感文件，出于安全考虑不提供预览', 403);
    if (info.size > PROJECT_FILE_LIMITS.maxStreamBytes) throw workError('文件过大，暂不支持预览', 413);
    const ext = extOf(name);
    const kind = kindOf(ext);
    const base = {
      path: resolved.relative,
      name,
      ext,
      kind,
      mime: mimeOf(ext),
      size: info.size,
      modifiedAt: info.mtime.toISOString()
    };

    if (kind === 'markdown' || kind === 'text' || kind === 'code') {
      const { text, truncated } = readText(resolved.absolute, info.size);
      return { ...base, text, ...(truncated ? { truncated: true } : {}) };
    }
    if (kind === 'csv') {
      const { text, truncated } = readText(resolved.absolute, info.size);
      try {
        const records = parseCsv(text, {
          bom: true,
          relax_column_count: true,
          relax_quotes: true,
          skip_empty_lines: true,
          to: PROJECT_FILE_LIMITS.maxTableRows + 1
        });
        return { ...base, ...tableFromRows(records), ...(truncated ? { truncated: true } : {}) };
      } catch {
        return { ...base, text, ...(truncated ? { truncated: true } : {}) };
      }
    }
    if (kind === 'docx') {
      if (info.size > PROJECT_FILE_LIMITS.maxOfficeBytes) throw workError('文档过大，暂不支持预览', 413);
      try { return { ...base, html: await docxPreview(resolved.absolute) }; }
      catch { throw workError('无法解析这个 Word 文档，请下载后查看', 422); }
    }
    if (kind === 'pptx') {
      if (info.size > PROJECT_FILE_LIMITS.maxOfficeBytes) throw workError('演示文稿过大，暂不支持预览', 413);
      try { return { ...base, slides: await pptxPreview(resolved.absolute) }; }
      catch { throw workError('无法解析这个 PPT，请下载后查看', 422); }
    }
    if (kind === 'sheet') {
      if (info.size > PROJECT_FILE_LIMITS.maxOfficeBytes) throw workError('表格过大，暂不支持预览', 413);
      try { return { ...base, sheets: await sheetPreview(resolved.absolute) }; }
      catch { throw workError('无法解析这个表格，请下载后查看', 422); }
    }
    if (kind === 'doc') return { ...base, message: '旧版 .doc 暂不支持在线预览，可以下载后用本机 Office 打开。' };
    if (kind === 'ppt') return { ...base, message: '旧版 .ppt 暂不支持在线预览，可以下载后用本机 Office 打开。' };
    if (kind === 'unsupported') return { ...base, message: '这个格式暂不支持在线预览，可以下载后查看。' };
    // PDF、HTML、图片走原始文件接口，由 iframe / img 直接加载。
    return base;
  }

  function file(projectId, relative) {
    const { root } = rootOf(projectId);
    const resolved = resolveInside(root, relative, { mustExist: true });
    const name = basename(resolved.absolute);
    const info = statSync(resolved.absolute);
    if (!info.isFile()) throw workError('只能打开文件', 400);
    if (isSensitive(name)) throw workError('这是敏感文件，出于安全考虑不提供内容', 403);
    if (info.size > PROJECT_FILE_LIMITS.maxStreamBytes) throw workError('文件过大，暂不支持直接打开', 413);
    return { absolute: resolved.absolute, path: resolved.relative, name, mime: mimeOf(extOf(name)), size: info.size, generatedAt: now() };
  }

  return { list, search, preview, file };
}

// iframe 里加载项目 HTML/SVG 时套一层沙箱：禁用同源、插件与顶层跳转，只允许内联样式和脚本。
export const PROJECT_FILE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:;";
export const PROJECT_IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:;";
