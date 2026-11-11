import { rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * 外部 Agent（codex / claude / dsh…）在项目目录里顺手留下的脚手架和调试产物。
 * 这些目录不该出现在用户的游戏/网站项目里：删掉它们只影响工具自己的临时文件，
 * 而且用 mtime 兜底——只清这次执行期间新产生的，之前就存在的一律不碰。
 */
export const CLUTTER = Object.freeze([
  '.spec-workflow',
  '.browser-smoke-profile',
  '.playwright-mcp',
  '.spec-workflow.yml',
  '__smoke.html'
]);

/**
 * 清理一次执行留下的脚手架。
 * @param {string} root 工作目录绝对路径
 * @param {string} since ISO 时间串（本次执行开始时间）
 * @returns {string[]} 实际删掉的名字
 */
export function pruneClutter(root, since) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return [];
  const cutoff = Date.parse(since || '');
  if (!Number.isFinite(cutoff)) return [];
  const removed = [];
  for (const name of CLUTTER) {
    const target = path.join(root, name);
    let stat;
    try {
      stat = statSync(target);
    } catch {
      continue;
    }
    if (stat.mtimeMs < cutoff - 2000) continue;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* 删不掉就留着，不影响任务结果 */
    }
  }
  return removed;
}
