import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createProjectFiles } from './work/project-files.js';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lagent-project-files-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# 示例项目\n\n这是说明。\n');
  writeFileSync(path.join(root, 'src', 'app.ts'), 'export const answer = 42;\n');
  writeFileSync(path.join(root, 'docs', 'guide.md'), '# 指南\n');
  writeFileSync(path.join(root, 'notes.csv'), '姓名,数量\n苹果,3\n香蕉,5\n');
  writeFileSync(path.join(root, '.env'), 'SECRET_TOKEN=should-not-leak\n');
  writeFileSync(path.join(root, '.env.example'), 'SECRET_TOKEN=\n');
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n  url = https://example.com/secret.git\n');
  writeFileSync(path.join(root, 'page.html'), '<!doctype html><title>预览</title><h1>Hello</h1>');
  return root;
}

function service(root) {
  return createProjectFiles({ getProject: id => id === 'p1' ? { id: 'p1', name: '示例', path: root } : null });
}

test('项目文件：列出目录时隐藏依赖目录，敏感文件只标记不返回内容', t => {
  const root = fixture(t);
  const files = service(root);
  const list = files.list('p1');
  assert.equal(list.path, '');
  assert.equal(list.root, path.basename(root));
  assert.deepEqual(list.entries.filter(entry => entry.type === 'dir').map(entry => entry.name), ['docs', 'src']);
  assert.equal(list.entries.some(entry => entry.name === 'node_modules'), false);
  const env = list.entries.find(entry => entry.name === '.env');
  assert.equal(env?.locked, true);
  assert.equal(env?.previewable, false);
  const example = list.entries.find(entry => entry.name === '.env.example');
  assert.equal(example?.locked, undefined);
  assert.equal(example?.previewable, true);
  const readme = list.entries.find(entry => entry.name === 'README.md');
  assert.equal(readme?.kind, 'markdown');
  assert.equal(readme?.previewable, true);
});

test('项目文件：Markdown、代码、CSV 与 HTML 返回对应预览类型', async t => {
  const root = fixture(t);
  const files = service(root);
  const markdown = await files.preview('p1', 'README.md');
  assert.equal(markdown.kind, 'markdown');
  assert.match(markdown.text, /示例项目/);
  const code = await files.preview('p1', 'src/app.ts');
  assert.equal(code.kind, 'code');
  assert.match(code.text, /answer/);
  const csv = await files.preview('p1', 'notes.csv');
  assert.deepEqual(csv.headers, ['姓名', '数量']);
  assert.deepEqual(csv.rows, [['苹果', '3'], ['香蕉', '5']]);
  const html = await files.preview('p1', 'page.html');
  assert.equal(html.kind, 'html');
  assert.equal(html.mime, 'text/html; charset=utf-8');
  const raw = files.file('p1', 'page.html');
  assert.equal(raw.mime, 'text/html; charset=utf-8');
  assert.equal(raw.name, 'page.html');
});

test('项目文件：拒绝越界路径和敏感文件', async t => {
  const root = fixture(t);
  const files = service(root);
  assert.throws(() => files.list('p1', '..'), error => error.status === 403);
  assert.throws(() => files.list('p1', '../outside'), error => error.status === 403);
  assert.throws(() => files.list('p1', path.join(root, 'src')), error => error.status === 400);
  assert.throws(() => files.file('p1', '.env'), error => error.status === 403);
  await assert.rejects(files.preview('p1', '.env'), error => error.status === 403);
  assert.throws(() => files.list('p1', 'node_modules'), error => error.status === 403);
  assert.throws(() => files.file('p1', 'node_modules/pkg/index.js'), error => error.status === 403);
  assert.throws(() => files.file('p1', '.git/config'), error => error.status === 403);
  assert.throws(() => files.file('p1', 'does-not-exist.md'), error => error.status === 404);
});

test('项目文件：搜索只返回文件名匹配的文件，并跳过依赖目录', t => {
  const root = fixture(t);
  const files = service(root);
  const result = files.search('p1', 'guide');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, 'docs/guide.md');
  assert.equal(files.search('p1', 'index').entries.length, 0);
  assert.equal(files.search('p1', 'a').entries.length, 0);
});

test('项目文件：PPTX 按页提取文字', async t => {
  const root = fixture(t);
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>封面标题</a:t></a:r></a:p><a:p><a:r><a:t>第一页内容</a:t></a:r></a:p></p:sld>');
  zip.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>第二页标题</a:t></a:r></a:p></p:sld>');
  writeFileSync(path.join(root, 'deck.pptx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const files = service(root);
  const preview = await files.preview('p1', 'deck.pptx');
  assert.equal(preview.kind, 'pptx');
  assert.equal(preview.slides.length, 2);
  assert.equal(preview.slides[0].title, '封面标题');
  assert.match(preview.slides[0].text, /第一页内容/);
  assert.equal(preview.slides[1].title, '第二页标题');
});
