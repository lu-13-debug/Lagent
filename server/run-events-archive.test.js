import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonlArchive } from './work/run-events-archive.js';

test('createJsonlArchive 按事件日期分文件追加，重复调用不覆盖', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-archive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = createJsonlArchive(join(dir, 'out'));

  archive([
    { seq: 1, createdAt: '2026-11-26T00:00:00.000Z' },
    { seq: 2, createdAt: '2026-11-26T01:00:00.000Z' },
    { seq: 3, createdAt: '2026-11-25T23:00:00.000Z' }
  ]);
  archive([{ seq: 4, createdAt: '2026-11-26T02:00:00.000Z' }]);

  const day = readFileSync(join(dir, 'out', '2026-11-26.jsonl'), 'utf8').trim().split('\n');
  assert.equal(day.length, 3, '第二批追加而不是覆盖');
  assert.equal(JSON.parse(day[0]).seq, 1);
  assert.equal(JSON.parse(day[2]).seq, 4);
  assert.ok(existsSync(join(dir, 'out', '2026-11-25.jsonl')));
});

test('createJsonlArchive 对空列表与缺日期的记录保持宽容', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-archive-edge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const archive = createJsonlArchive(join(dir, 'out'));
  assert.doesNotThrow(() => archive([]));
  archive([{ seq: 5 }]);
  const unknown = readFileSync(join(dir, 'out', 'unknown.jsonl'), 'utf8').trim();
  assert.equal(JSON.parse(unknown).seq, 5);
});
