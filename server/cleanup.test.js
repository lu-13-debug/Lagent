import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLUTTER, pruneClutter } from './work/cleanup.js';

const temp = (prefix = 'cleanup-') => mkdtempSync(path.join(os.tmpdir(), prefix));

test('执行期间新出现的脚手架会被清掉，之前就在的不动', () => {
  const root = temp();
  const old = path.join(root, '.spec-workflow');
  mkdirSync(old);
  writeFileSync(path.join(old, 'keep.md'), 'old');
  // 三分钟前就存在
  const past = (Date.now() - 180000) / 1000;
  utimesSync(old, past, past);

  const fresh = path.join(root, '.browser-smoke-profile');
  mkdirSync(fresh);
  writeFileSync(path.join(fresh, 'profile.txt'), 'junk');
  writeFileSync(path.join(root, '__smoke.html'), '<html></html>');

  const removed = pruneClutter(root, new Date(Date.now() - 60000).toISOString());
  assert.deepEqual(removed.sort(), ['.browser-smoke-profile', '__smoke.html']);
  assert.ok(existsSync(path.join(old, 'keep.md')), '老脚手架不该被动');
  assert.ok(!existsSync(fresh));
  assert.equal(CLUTTER.includes('.spec-workflow'), true);
});

test('没有工作目录或时间无效时什么都不做', () => {
  assert.deepEqual(pruneClutter('', new Date().toISOString()), []);
  assert.deepEqual(pruneClutter('relative/path', new Date().toISOString()), []);
  const root = temp();
  mkdirSync(path.join(root, '.spec-workflow'));
  assert.deepEqual(pruneClutter(root, 'not-a-date'), []);
  assert.ok(existsSync(path.join(root, '.spec-workflow')));
});
