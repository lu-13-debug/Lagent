import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { artifactGap, describeGap, expectedFiles, missingFiles } from './work/artifacts.js';

test('从目标文本里认出被点名的文件，忽略链接与目录名', () => {
  const names = expectedFiles('做一个贪吃蛇：写 index.html、styles.css 与 game.js，README.md 里写说明；参考 https://example.com/a.js 和 node_modules/x/y.js');
  assert.deepEqual(names.slice(0, 4), ['index.html', 'styles.css', 'game.js', 'README.md']);
  assert.ok(!names.includes('a.js'), '链接里的文件名不算');
  assert.ok(!names.includes('node_modules/x/y.js'), '依赖里的文件不算');
});

test('缺文件能算出来，越界的名字不当产出', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/app.js'), '// ok');
  assert.deepEqual(missingFiles(dir, ['src/app.js', 'input.js']), ['input.js']);
  assert.deepEqual(missingFiles(dir, ['../outside.js']), [], '项目外的路径既不查也不算缺');
  assert.deepEqual(artifactGap('', 'a.js'), [], '没有项目目录就不判定');
});

test('缺件说明能直接给人看', () => {
  assert.equal(describeGap([]), '');
  assert.match(describeGap(['input.js']), /产出不完整：input\.js/);
  const many = Array.from({ length: 8 }, (_, index) => `f${index}.js`);
  assert.match(describeGap(many), /等 8 个文件/);
});
