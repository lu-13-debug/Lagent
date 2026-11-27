import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// 按天归档被裁剪的 run-event：一行一个 JSON，文件名取事件自身日期。
// 归档只是审计副本，读取仍只走 SQLite；文件写失败会让 prune 跳过删除。
export function createJsonlArchive(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('归档目录不能为空');
  const root = dir.trim();
  return rows => {
    if (!Array.isArray(rows) || !rows.length) return;
    const byDay = new Map();
    for (const row of rows) {
      const day = String(row?.createdAt || '').slice(0, 10) || 'unknown';
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(row);
    }
    mkdirSync(root, { recursive: true });
    for (const [day, list] of byDay) {
      appendFileSync(path.join(root, `${day}.jsonl`), `${list.map(item => JSON.stringify(item)).join('\n')}\n`, 'utf8');
    }
  };
}
