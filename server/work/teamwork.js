// 协作任务：把一个目标拆成互补的几部分，分给不同 Agent，最后由软件组装成一个可运行的小游戏。
// 拆法与契约都在这里：Agent 只填自己那一份，软件的职责是「搭骨架 + 验收 + 组装」。
import fs from 'node:fs';
import path from 'node:path';

export const TEAMWORK_PARTS = Object.freeze([
  {
    id: 'rules',
    name: '玩法规则',
    file: 'coop/rules.js',
    global: 'Coop.rules',
    duty: '负责游戏规则：初始化世界、每帧推进（移动、碰撞、计分、胜负与阶段切换）。'
  },
  {
    id: 'view',
    name: '画面表现',
    file: 'coop/view.js',
    global: 'Coop.view',
    duty: '负责画面：背景、实体绘制、粒子或光效。只画，不改世界状态。'
  },
  {
    id: 'hud',
    name: '界面状态',
    file: 'coop/hud.js',
    global: 'Coop.hud',
    duty: '负责界面：分数、生命、开始/暂停/结束遮罩与操作提示。只画，不改世界状态。'
  }
]);

export const TEAMWORK_DIR = 'coop';

// 世界对象与输入对象的形状由软件固定。三份实现共享同一份形状，才能拼起来。
const WORLD_SHAPE = `world = {
  w, h,            // 画布逻辑尺寸（像素），随窗口变化
  t,               // 累计秒数
  phase,           // 'ready' | 'playing' | 'paused' | 'over'
  score, best,     // 分数与最高分（best 由骨架从 localStorage 读写）
  lives,           // 剩余生命，可自行使用
  entities: [],    // 实体数组，形状见下
  banner           // 一行短提示，可为空字符串
}
entity = { kind, x, y, w, h, vx, vy, color, alive }  // kind 由规则自定义：'paddle' | 'ball' | 'brick' ……`;

const CONTRACT = `# 协作游戏契约

这个目录由 DataAgent 生成：三个 Agent 各写一份文件，软件负责把它们组装成 \`coop/index.html\`。

## 谁负责什么

${TEAMWORK_PARTS.map(part => `- **${part.name}**（\`${part.file}\`）→ 必须定义 \`${part.global}\`：${part.duty}`).join('\n')}

## 共享形状（不要改）

\`\`\`js
${WORLD_SHAPE}
\`\`\`

输入对象（每帧由骨架维护）：

\`\`\`js
input = { left, right, up, down, action, pointer: { x, y, down } }
input.pressed = { ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Space }  // 这一帧刚按下
\`\`\`

## 接口

\`\`\`js
Coop.rules = { init(world), update(world, input, dt), resize?(world) }
Coop.view  = { draw(ctx, world) }
Coop.hud   = { draw(ctx, world) }
\`\`\`

骨架已经提供：画布与高分屏适配、requestAnimationFrame 主循环、键盘/指针输入、\`Coop.util\`（\`clamp\` / \`rand\` / \`hit\` / \`circleHit\`）、每帧顺序 \`rules.update → view.draw → hud.draw\`。
骨架**不提供**玩法、画面与界面，这三件事就是三份文件要写的。

## 硬性约束

1. 只写自己那一个文件，不要动别人的文件、不要改 \`skeleton.js\` 与 \`index.html\`。
2. 纯浏览器 JS（不要 import/require、不要打包器语法），不使用任何外部资源（无 CDN、无图片、无字体）。
3. 单文件 ≤ 220 行；写完用 \`node --check\` 自查语法。
4. 结束时只回复：文件路径 + 60 字以内的说明。不要写 README、不要跑游戏测试。
`;

const SKELETON = `(() => {
  const Coop = window.Coop = window.Coop || {};
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let width = 960, height = 600;
  const input = { left: false, right: false, up: false, down: false, action: false, pressed: {}, pointer: { x: 480, y: 480, down: false } };
  Coop.util = {
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    rand: (min, max) => min + Math.random() * (max - min),
    hit: (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y,
    circleHit: (a, b, radius) => Math.hypot((a.x + a.w / 2) - (b.x + b.w / 2), (a.y + a.h / 2) - (b.y + b.h / 2)) < radius
  };
  const world = {
    w: width, h: height, t: 0, phase: 'ready',
    score: 0, best: Number(localStorage.getItem('coop.best') || 0) || 0,
    lives: 3, entities: [], banner: ''
  };
  const keys = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    a: 'left', d: 'right', w: 'up', s: 'down', A: 'left', D: 'right', W: 'up', S: 'down',
    ' ': 'action'
  };
  const pressedKeys = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ' ': 'Space' };
  window.addEventListener('keydown', event => {
    const mapped = keys[event.key];
    if (mapped) { input[mapped] = true; if (pressedKeys[event.key]) input.pressed[pressedKeys[event.key]] = true; event.preventDefault(); }
  });
  window.addEventListener('keyup', event => { const mapped = keys[event.key]; if (mapped) { input[mapped] = false; event.preventDefault(); } });
  canvas.addEventListener('pointermove', event => {
    const rect = canvas.getBoundingClientRect();
    input.pointer.x = event.clientX - rect.left;
    input.pointer.y = event.clientY - rect.top;
  });
  canvas.addEventListener('pointerdown', event => {
    input.pointer.down = true; input.action = true; input.pressed.Space = true;
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointerup', () => { input.pointer.down = false; input.action = false; });
  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(320, Math.round(rect.width));
    height = Math.max(240, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    world.w = width; world.h = height;
    if (window.Coop.rules && typeof window.Coop.rules.resize === 'function') window.Coop.rules.resize(world);
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    world.t += dt;
    if (Coop.rules && typeof Coop.rules.update === 'function') Coop.rules.update(world, input, dt);
    ctx.clearRect(0, 0, world.w, world.h);
    // 三份实现各自独立绘制：进入前把状态归零，绘制后恢复，避免一份的阴影/透明度泄漏到下一份。
    const paint = part => {
      if (!part || typeof part.draw !== 'function') return;
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      try { part.draw(ctx, world); } catch (error) { console.error('协作片段绘制失败：', error); }
      ctx.restore();
    };
    paint(Coop.view);
    paint(Coop.hud);
    if (world.score > world.best) { world.best = world.score; localStorage.setItem('coop.best', String(world.best)); }
    input.pressed = {};
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', resize);
  resize();
  if (Coop.rules && typeof Coop.rules.init === 'function') Coop.rules.init(world);
  requestAnimationFrame(frame);
  window.Coop.ready = true;
})();
`;

const compactContract = () => `共享形状：
${WORLD_SHAPE}

输入：input = { left, right, up, down, action, pointer:{x,y,down} }，input.pressed 记录这一帧刚按下的键（'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Space'）。
骨架已提供画布、主循环、高分屏、输入、Coop.util（clamp/rand/hit/circleHit），每帧顺序 rules.update → view.draw → hud.draw。`;

export const buildPartTask = ({ part, goal, executorName }) => `你正在参与一个由软件拆分的协作游戏任务，只负责其中一份。

## 目标
${goal}

## 你的部分：${part.name}（${executorName}）
在项目根目录创建并只写这一个文件：\`${part.file}\`
必须定义 \`${part.global}\`。${part.duty}

${compactContract()}

## 约束
- 只写 \`${part.file}\`，不要碰 \`coop/\` 里的其它文件，也不要写 README。
- 纯浏览器 JS：不要 import/require，不要外部资源（无 CDN/图片/字体）。
- 单文件 ≤ 220 行，写完用 \`node --check ${part.file}\` 自查语法。
- 画文字前先把阴影关掉（\`ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0\`），
  否则残留的阴影会把同一段文字画成两层重影。
- 开始/暂停/结束遮罩只在 \`${part.id === 'hud' ? '自己这一份' : 'Coop.hud 那一份'}\` 里画，别越界重复画一遍。
- 结束时只回复：文件路径 + 60 字以内说明。`;

export const writeSkeleton = projectPath => {
  const dir = path.join(projectPath, TEAMWORK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'contract.md'), CONTRACT, 'utf8');
  fs.writeFileSync(path.join(dir, 'skeleton.js'), SKELETON, 'utf8');
  return dir;
};

export const readPart = (projectPath, part) => {
  const target = path.join(projectPath, part.file);
  let stat = null;
  try { stat = fs.statSync(target); } catch { return { part, exists: false, size: 0, content: '' }; }
  const content = stat.isFile() ? fs.readFileSync(target, 'utf8') : '';
  return { part, exists: true, size: stat.size, content };
};

// 组装的最后一道关：文件在不在、有没有定义约定的全局、有没有偷偷引外部资源。
export const inspectParts = (projectPath, parts = TEAMWORK_PARTS) => {
  const files = parts.map(part => readPart(projectPath, part));
  const problems = [];
  for (const file of files) {
    const { part } = file;
    if (!file.exists) { problems.push({ part: part.id, message: `缺少 ${part.file}` }); continue; }
    if (file.size < 120) { problems.push({ part: part.id, message: `${part.file} 只有 ${file.size} 字节，像是没写完` }); continue; }
    if (!new RegExp(`${part.global.replace('.', '\\s*\\.\\s*')}\\s*=`).test(file.content)) {
      problems.push({ part: part.id, message: `${part.file} 没有定义 ${part.global}` });
    }
    if (/<\/?script/i.test(file.content)) { problems.push({ part: part.id, message: `${part.file} 里不应出现 <script> 标签` }); }
    if (/https?:\/\//.test(file.content)) { problems.push({ part: part.id, message: `${part.file} 里出现了外部 URL` }); }
  }
  return { files, problems };
};

const escapeScript = content => content.replace(/<\/script/gi, '<\\/script');

export const buildGameHtml = ({ title, files, agents }) => {
  const head = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #07080b; color: #e8ebf1; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  body { display: grid; place-items: center; padding: 18px; }
  .frame { width: min(100%, 1040px); display: grid; gap: 10px; }
  .frame header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 12px; color: #8d94a3; letter-spacing: .02em; }
  .frame header strong { flex: 1 1 auto; min-width: 0; color: #e8ebf1; font-size: 14px; font-weight: 600; letter-spacing: -.01em; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .frame header span { flex: none; }
  canvas { width: 100%; height: min(72vh, 640px); display: block; border-radius: 14px; background: #0b0d12; box-shadow: inset 0 0 0 1px #232833, 0 24px 60px rgb(0 0 0 / .55); }
  .frame footer { font-size: 11.5px; color: #6f7787; }
</style>
</head>
<body>
<div class="frame">
  <header><strong>${title}</strong><span>${agents || 3} 个 Agent 分工，由软件组装</span></header>
  <canvas id="stage" width="960" height="600"></canvas>
  <footer>方向键 / WASD 操作 · 空格开始或暂停</footer>
</div>
<script>window.Coop = {};</script>
`;
  const body = files
    .map(file => `<script>/* ${file.part.name} · ${path.basename(file.part.file)} */\n${escapeScript(file.content)}\n</script>`)
    .join('\n');
  const boot = `<script>\n${escapeScript(SKELETON)}\n</script>\n</body>\n</html>\n`;
  return `${head}${body}\n${boot}`;
};

export const teamworkTaskText = ({ part, goal, executorName }) => buildPartTask({ part, goal, executorName });
