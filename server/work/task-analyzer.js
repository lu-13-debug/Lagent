// 任务理解器：在分发之前先把任务读一遍。
// 纯本地启发式，不调用模型、不联网，因此每次派活前都能立刻给出一份「我理解的任务 + 需要的工具 + 分工」。
// 模型规划器（agent-planner）仍然负责更细的步骤，这里的结果会作为它的上下文，并用于调度时的冲突检查。

import fs from 'node:fs';
import path from 'node:path';

const CATEGORIES = [
  { id: 'game', label: '游戏功能开发', match: ['游戏', '关卡', '角色', '像素', '射击', '塔防', 'roguelike', '肉鸽', 'phaser', 'unity', '玩法', '画面'] },
  { id: 'web', label: '前端 / 接口开发', match: ['网站', '页面', '前端', 'react', 'vue', '界面', '样式', '接口', 'api', '组件', '按钮'] },
  { id: 'data', label: '数据分析', match: ['数据', '报表', '指标', '图表', '分析', 'excel', 'csv', '漏斗', '留存', '付费'] },
  { id: 'docs', label: '文档撰写', match: ['文档', 'readme', '说明', '教程', '注释', '手册'] },
  { id: 'bugfix', label: '缺陷修复', match: ['修复', 'bug', '报错', '失败', '崩溃', '异常', '测试不过'] },
  { id: 'research', label: '调研对比', match: ['调研', '对比', '选型', '参考', '开源', '方案', '可行性'] },
  { id: 'automation', label: '自动化脚本', match: ['脚本', '批量', '定时', '爬取', '自动化', '流水线', 'ci'] }
];

const RESEARCH_HINTS = ['参考', '类似', '开源', '最佳实践', '调研', '对比', '选型', '怎么做', '方案'];
const BROWSER_HINTS = ['网页', '官网', '文档站', '下载', '登录', '抓取', '网站内容'];
const WRITE_HINTS = ['实现', '开发', '写', '搭建', '新增', '改造', '重构', '生成', '做一个', '添加'];
const VERIFY_HINTS = ['测试', '单测', '用例', '验证', '检查', '跑通', '回归'];

const lower = value => String(value || '').toLowerCase();
const hit = (text, words) => words.filter(word => text.includes(word.toLowerCase()));

// 看一眼项目目录长什么样，拆任务时才知道「要改的东西」在哪个文件夹里。
// 只读一层 + 一层子目录的文件名，不递归扫全仓（几十万文件的项目也秒回）。
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'data', '.lagent', '__pycache__', '.venv', 'venv', 'coverage', '.spec-workflow', '.browser-smoke-profile', '.playwright-mcp']);
const SHAPE_FILE_LIMIT = 60;

export function projectShape(root) {
  const shape = { root: String(root || ''), dirs: [], rootFiles: [], scopes: [], code: [], ui: [], docs: [] };
  if (!root) return shape;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return shape; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true })
          .filter(item => item.isFile() && !item.name.startsWith('.')).map(item => item.name).slice(0, SHAPE_FILE_LIMIT);
      } catch { files = []; }
      shape.dirs.push({ name: entry.name, files });
      shape.scopes.push(`${entry.name}/**`);
      if (/^(src|js|lib|app|server|packages)$/i.test(entry.name)) shape.code.push(entry.name);
      if (/^(css|styles?|assets|ui|public)$/i.test(entry.name)) shape.ui.push(entry.name);
      if (/^(docs?|doc)$/i.test(entry.name)) shape.docs.push(entry.name);
    } else if (!entry.name.endsWith('.md')) {
      shape.rootFiles.push(entry.name);
      if (/\.(html?|css)$/i.test(entry.name)) shape.ui.push(entry.name);
      else if (/\.(m?js|tsx?|jsx|py|go|rs|java)$/i.test(entry.name)) shape.code.push(entry.name);
    }
  }
  shape.rootFiles.sort();
  return shape;
}

function pickCategory(text) {
  let best = { id: 'general', label: '通用任务', score: 0 };
  for (const category of CATEGORIES) {
    const score = hit(text, category.match).length;
    if (score > best.score) best = { id: category.id, label: category.label, score };
  }
  return best;
}

// 从任务描述里猜要动的目录，用来判断两个步骤会不会撞车。
const SCOPE_RULES = [
  { scope: ['src/**'], match: ['前端', '页面', '界面', '样式', '组件', 'react', '按钮', 'css'] },
  { scope: ['server/**'], match: ['接口', '服务端', '后端', 'api', '数据库', '路由'] },
  { scope: ['docs/**'], match: ['文档', 'readme', '说明'] },
  { scope: ['tests/**', 'e2e/**'], match: ['测试', '用例', '回归'] }
];

function guessScope(text, category) {
  const scopes = new Set();
  for (const rule of SCOPE_RULES) if (hit(text, rule.match).length) rule.scope.forEach(item => scopes.add(item));
  if (!scopes.size) {
    if (category === 'docs') scopes.add('docs/**');
    else if (category === 'data') scopes.add('data/**');
    else scopes.add('src/**');
  }
  return [...scopes];
}

// 按项目真实结构把「要写的文件」分成互不重叠的几组：
// 界面（html/css）、逻辑（js/src）、文档。每组交给一个执行器，
// 组之间不共享文件，才能真正并行；组内多人时再按文件轮着分。
const pretty = value => `\`${value}\``;
function writeGroups(shape) {
  const toScope = item => (/[./]/.test(item) && /\.[a-z0-9]+$/i.test(item) ? item : `${item}/**`);
  const ui = (shape?.ui || []).map(toScope);
  const code = (shape?.code || []).map(toScope);
  const docs = (shape?.docs || []).map(toScope);
  const groups = [];
  if (ui.length) groups.push({ key: 'ui', label: '界面与样式', scopes: ui });
  if (code.length) groups.push({ key: 'code', label: '逻辑与实现', scopes: code });
  if (docs.length) groups.push({ key: 'docs', label: '文档与说明', scopes: docs });
  return groups;
}

function overlaps(left, right) {
  const touch = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`) || a.split('/')[0] === b.split('/')[0];
  return left.some(a => right.some(b => touch(a, b)));
}

/**
 * @param {{goal:string, executors?:string[], project?:{name?:string,path?:string,gitBranch?:string}|null, hasDataset?:boolean, hasWindow?:boolean}} input
 */
export function analyzeTask(input) {
  const goal = String(input?.goal || '').trim();
  const text = lower(goal);
  const executors = Array.isArray(input?.executors) ? input.executors.filter(id => typeof id === 'string') : [];
  const has = id => executors.includes(id);

  const category = pickCategory(text);
  const research = hit(text, RESEARCH_HINTS);
  const browsing = hit(text, BROWSER_HINTS);
  const writing = hit(text, WRITE_HINTS);
  const verifying = hit(text, VERIFY_HINTS);

  const needs = [];
  const bound = Boolean(input?.project?.path);
  if (research.length && has('github')) {
    needs.push({ id: 'github', label: 'GitHub 只读检索', reason: `任务里提到「${research.slice(0, 2).join('、')}」，先查同类开源项目再动手` });
  }
  if (browsing.length && has('browser')) {
    needs.push({ id: 'browser', label: '受控浏览器', reason: `需要读取网页内容（${browsing.slice(0, 2).join('、')}）` });
  }
  if (writing.length || ['game', 'web', 'automation'].includes(category.id)) {
    needs.push({ id: 'claude-code', label: bound ? '写代码的 Agent' : '只读的 Agent', reason: bound ? '真正改文件的只有它，其他步骤保持只读' : '没有绑定工作文件夹，只能读代码、给结论' });
  }
  if (input?.hasWindow) needs.push({ id: 'window', label: '已打开的 Agent 窗口', reason: '可以直接把指令送到现成的窗口里' });

  const writeScope = guessScope(text, category.id);
  const steps = [];
  const conflicts = [];

  if (research.length && has('github')) {
    steps.push({
      title: '查同类项目怎么做',
      executorId: 'github',
      scope: [],
      output: '同类项目的做法与可复用点',
      kind: 'research',
      readOnly: true
    });
  }
  if (browsing.length && has('browser')) {
    steps.push({
      title: '读取指定网页并提取要点',
      executorId: 'browser',
      scope: [],
      output: '页面要点与限制条件',
      kind: 'research',
      readOnly: true
    });
  }
  // 没绑工作文件夹时不主动拆「写文件」的步骤：那里没有可写的目标，拆了只会给出空范围。
  const wantsWrite = writing.length > 0 || (bound && ['game', 'web', 'automation', 'docs'].includes(category.id));
  if (wantsWrite) {
    // 前端 / 后端 / 文档分属不同目录时，拆成互不重叠的写步骤：可以并行，不会互相覆盖。
    const writers = ['claude-code', 'codex'].filter(id => has(id));
    if (!writers.length) writers.push(executors[0] || 'claude-code');
    // 优先按项目真实结构分工：界面、逻辑、文档各一组，谁写哪些文件一目了然。
    const shaped = bound ? writeGroups(projectShape(input?.project?.path)) : [];
    if (shaped.length) {
      shaped.forEach((group, position) => {
        steps.push({
          title: `实现主体（${group.label}）：${goal.slice(0, 30)}${goal.length > 30 ? '…' : ''}`,
          executorId: writers[position % writers.length],
          scope: group.scopes,
          files: group.scopes,
          output: `改动只落在 ${group.scopes.map(pretty).join('、')}；不要改别的目录里的文件`,
          kind: 'write',
          readOnly: false
        });
      });
    } else {
      const groups = new Map();
      for (const scope of writeScope) {
        const root = scope.split('/')[0];
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(scope);
      }
      [...groups.entries()].forEach(([root, scopes], position) => {
        steps.push({
          title: groups.size > 1 ? `实现主体（${root}）：${goal.slice(0, 32)}${goal.length > 32 ? '…' : ''}` : `实现主体：${goal.slice(0, 40)}${goal.length > 40 ? '…' : ''}`,
          executorId: writers[position % writers.length],
          scope: bound ? scopes : [],
          output: bound ? `改动落在 ${scopes.join('、')}` : '只出方案与改动建议（未绑定工作文件夹）',
          kind: bound ? 'write' : 'research',
          readOnly: !bound
        });
      });
    }
  }
  if (verifying.length && (has('codex') || has('claude-code'))) {
    // 验证尽量交给没参与写代码的执行器，避免「自己写、自己判卷」。
    const writers = new Set(steps.filter(step => !step.readOnly).map(step => step.executorId));
    const verifiers = ['dsh', 'claude-code', 'codex', 'gemini', 'qwen', 'opencode'].filter(id => has(id) && !writers.has(id));
    steps.push({
      title: '跑测试并复核结果',
      executorId: verifiers[0] || (has('codex') ? 'codex' : 'claude-code'),
      scope: [],
      output: '通过/失败结论与需要补的改动',
      kind: 'verify',
      readOnly: true
    });
  }

  if (!steps.length) {
    steps.push({
      title: `完成：${goal.slice(0, 40)}${goal.length > 40 ? '…' : ''}`,
      executorId: has('claude-code') ? 'claude-code' : executors[0] || 'terminal',
      scope: has('claude-code') ? writeScope : [],
      output: '任务结果',
      kind: has('claude-code') ? 'write' : 'research',
      readOnly: !has('claude-code')
    });
  }

  // 冲突：两个都要写文件、且目录重叠 → 只能串行；只读步骤可以并行。
  for (let left = 0; left < steps.length; left += 1) {
    for (let right = left + 1; right < steps.length; right += 1) {
      const a = steps[left];
      const b = steps[right];
      if (a.readOnly || b.readOnly) continue;
      if (!overlaps(a.scope, b.scope)) continue;
      conflicts.push({
        between: [left, right],
        reason: `两步都要改 ${a.scope.join('、')}`,
        resolution: '串行执行，前一步的产出作为后一步的输入'
      });
    }
  }

  // 依赖：调研/数据 → 实现；实现 → 验证。范围重叠的两步写操作改成串行。
  // 顺序：先调研（readOnly + research），再写文件，最后验证——验证永远压在最后。
  const kindRank = { research: 0, write: 1, verify: 2 };
  const rankOf = step => kindRank[step.kind] ?? (step.readOnly ? 0 : 1);
  const ranked = steps
    .map((step, index) => ({ step, index, rank: rankOf(step) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  const serial = [];
  ranked.forEach((item, position) => {
    const dependsOn = [];
    for (let before = 0; before < position; before += 1) {
      const previous = ranked[before].step;
      // 写步骤要吃前面调研的结论；验证步骤要吃所有写步骤的产出；范围重叠的两步写改成串行。
      const waitingOnResearch = item.step.kind === 'write' && previous.kind === 'research';
      const waitingOnWrite = item.step.kind === 'verify' && previous.kind !== 'research';
      const sameScope = item.step.kind === 'write' && previous.kind === 'write' && overlaps(previous.scope, item.step.scope);
      if (waitingOnResearch || waitingOnWrite || sameScope) dependsOn.push(before);
    }
    serial.push({ ...item.step, dependsOn: [...new Set(dependsOn)].slice(0, 3) });
  });

  const writeCount = serial.filter(step => !step.readOnly).length;
  const shape = bound ? projectShape(input?.project?.path) : null;
  const shapeLine = shape && (shape.dirs.length || shape.rootFiles.length)
    ? `项目里现有的东西：${[...shape.dirs.map(item => `${item.name}/`), ...shape.rootFiles].slice(0, 10).join('、')}`
    : '';
  const understanding = [
    `我理解的目标：${goal}`,
    `任务类型：${category.label}${input?.project?.name ? `；工作目录 ${input.project.name}（${input.project.path || ''}）` : '；没有绑定工作文件夹，Agent 只能读代码给结论'}`,
    ...(shapeLine ? [shapeLine] : []),
    needs.length
      ? `需要用到的能力：${needs.map(item => item.label).join('、')}`
      : '需要用到的能力：直接执行，不需要额外工具',
    writeCount
      ? `拆成 ${serial.length} 个步骤，其中 ${serial.filter(step => !step.dependsOn.length).length} 个可以先跑，${conflicts.length ? `有 ${conflicts.length} 处写冲突已改成串行` : '写文件的步骤互不重叠，可以并行'}`
      : `拆成 ${serial.length} 个步骤，全部只读，可以并行执行`
  ];

  return {
    goal,
    category: category.id,
    categoryLabel: category.label,
    project: input?.project || null,
    needs,
    understanding,
    conflicts,
    steps: serial.map((step, index) => ({
      index,
      title: step.title,
      executorId: step.executorId,
      scope: step.scope,
      output: step.output,
      kind: step.kind || (step.readOnly ? 'research' : 'write'),
      readOnly: step.readOnly === true,
      dependsOn: step.dependsOn,
      needsApproval: true
    }))
  };
}
