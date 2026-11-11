/**
 * 产出校验：一个步骤说「我做完了」，不等于它承诺的文件真的出现了。
 *
 * 实测教训（trio 那次）：Codex 进程退出码 0、工单报完成，但它该写的 input.js
 * 根本没落盘；index.html 里 `<script src="input.js">` 指向空气，页面控制台一
 * 条 404。整条计划却因为「每步都成功」而认为自己成功了。
 *
 * 这里做两件事：
 * 1. 从目标/步骤文本里认出被点名的文件（input.js、src/app.tsx…）；
 * 2. 检查它们相对项目根目录是否真的存在。
 * 只做「点名文件」这一层，不做全量扫描：判据明确，误报可控。
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE_PATTERN = /[A-Za-z0-9_\-\u4e00-\u9fa5]+(?:\/[A-Za-z0-9_\-.]+)*\.(?:js|mjs|cjs|tsx?|jsx|css|html|json|md|txt|py|yml|yaml)\b/g;

export function expectedFiles(...texts) {
  const found = [];
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const match of text.match(FILE_PATTERN) || []) {
      const value = match.replace(/^\.\//, '');
      if (!value || value.length > 120) continue;
      // 链接、依赖目录、域名开头的东西都不是本项目的产出。
      if (/^(?:https?|data):/i.test(value)) continue;
      if (/(^|\/)(?:node_modules|\.git)\//.test(value)) continue;
      if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\//i.test(value)) continue;
      if (!found.includes(value)) found.push(value);
    }
  }
  return found.slice(0, 16);
}

export function missingFiles(root, names) {
  if (!root || !Array.isArray(names) || !names.length) return [];
  const base = path.resolve(root);
  const missing = [];
  for (const name of names) {
    const absolute = path.resolve(base, name);
    // 越界的名字（../xxx）不当产出：既不算缺，也不去碰项目外的东西。
    if (absolute !== base && !absolute.startsWith(base + path.sep)) continue;
    try {
      if (!fs.existsSync(absolute)) missing.push(name);
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

/** 一次算清：这段文本点名的文件里，哪些还没出现。 */
export function artifactGap(root, ...texts) {
  return missingFiles(root, expectedFiles(...texts));
}

export function describeGap(missing) {
  if (!Array.isArray(missing) || !missing.length) return '';
  const list = missing.slice(0, 6).join('、');
  return `产出不完整：${list}${missing.length > 6 ? ` 等 ${missing.length} 个文件` : ''}没有出现`;
}
