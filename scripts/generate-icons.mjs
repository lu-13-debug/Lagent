// 从 build/icon.svg 生成 Windows 图标、PWA 图标与网页 favicon。
// 优先使用本机 Edge（Playwright channel: msedge），不可用时回退内置 Chromium。
// 用法：node scripts/generate-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const svgPath = path.join(root, 'build', 'icon.svg');
const svg = fs.readFileSync(svgPath, 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 192, 256, 512];
const outDir = path.join(root, 'build');

let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
} catch {
  console.warn('msedge 不可用，回退到 Playwright 内置 Chromium。');
  browser = await chromium.launch({ headless: true });
}
try {
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    const sized = svg.replace('width="512" height="512"', `width="${size}" height="${size}"`);
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style>${sized}`);
    await page.screenshot({ path: path.join(outDir, `icon-${size}.png`), omitBackground: true });
    await page.close();
  }

  // 预览图：浅色/深色背景上的多尺寸对比。
  const previewPage = await browser.newPage({ viewport: { width: 900, height: 260 }, deviceScaleFactor: 2 });
  const cell = size => `<div style="text-align:center"><img src="data:image/png;base64,${fs.readFileSync(path.join(outDir, `icon-${size}.png`)).toString('base64')}" width="${size}" height="${size}" style="display:block;margin:0 auto 6px"><small style="color:#777">${size}</small></div>`;
  await previewPage.setContent(`<!doctype html><body style="margin:0;background:#f5f6fa;font-family:Segoe UI,sans-serif;display:flex;gap:22px;align-items:flex-end;padding:40px">${[16, 24, 32, 48, 64, 128, 256].map(cell).join('')}</body>`);
  await previewPage.screenshot({ path: path.join(outDir, 'icon-sizes-check.png') });
  await previewPage.close();
} finally {
  await browser.close();
}

// 512 主图；electron-builder 的 build/icon.png 需要是正方形大图。
fs.copyFileSync(path.join(outDir, 'icon-512.png'), path.join(outDir, 'icon.png'));
// 托盘图标用彩色小图，深浅任务栏都可见。
fs.copyFileSync(path.join(outDir, 'icon-32.png'), path.join(outDir, 'tray.png'));

// PWA / 移动端图标与桌面图标同源，避免两套品牌。
const publicDir = path.join(root, 'public');
for (const [from, to] of [
  ['icon-192.png', 'icon-192.png'],
  ['icon-512.png', 'icon-512.png'],
  ['icon-512.png', 'icon-512-maskable.png'],
]) {
  fs.copyFileSync(path.join(outDir, from), path.join(publicDir, to));
}

// favicon 使用同一套图形，网页按需缩放。
const favicon = svg
  .replace('width="512" height="512"', 'width="48" height="48"')
  .replace('role="img" aria-label="Lagent"', '');
fs.writeFileSync(path.join(root, 'public', 'favicon.svg'), favicon, 'utf8');

// 组装 ICO：PNG 压缩条目，Windows Vista 以上原生支持。
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = icoSizes.map(size => ({ size, data: fs.readFileSync(path.join(outDir, `icon-${size}.png`)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const entries = [];
let offset = 6 + pngs.length * 16;
for (const { size, data } of pngs) {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += data.length;
}
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map(item => item.data)]));

console.log('图标已生成：icon.ico / icon.png / icon-16..512.png / tray.png / public/favicon.svg / public/icon-192|512|512-maskable.png');
