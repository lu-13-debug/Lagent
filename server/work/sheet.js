// 交接单：把一次编排的结果压成一页 Markdown，给下一位 Agent 或人接手用。
// 只做聚合，不新增存储；数据来自计划步骤、工单验收、变更档案与项目简报。

const STATUS = {
  active: '进行中',
  completed: '已完成',
  failed: '已失败',
  cancelled: '已取消',
  missing: '缺失',
  queued: '排队中',
  working: '执行中',
  awaiting_review: '等待确认',
  blocked: '受阻',
  waiting: '等待依赖'
};

const text = value => typeof value === 'string' ? value.trim() : '';
const list = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [];
const integer = value => Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
const money = value => Number.isFinite(value) && value > 0 ? `$${value.toFixed(4)}` : '';

function line(label, value) {
  const content = text(value);
  return content ? `- ${label}：${content}` : '';
}

function acceptanceLine(row) {
  const command = text(row.acceptance?.command) || text(row.verify?.command);
  if (!command) return '';
  if (!row.acceptance) return `- 验收：\`${command}\` → 待验收`;
  const passed = row.acceptance.status === 'passed';
  const exit = Number.isInteger(row.acceptance.exitCode) ? `退出码 ${row.acceptance.exitCode}` : '退出码未知';
  return `- 验收：\`${command}\` → ${passed ? '验收通过' : '验收未通过'}（${exit}）`;
}

export function buildSheetMarkdown({ plan = {}, rows = [], brief = null } = {}) {
  const goal = text(plan.goal) || '未命名任务';
  const done = rows.filter(row => row.status === 'completed').length;
  const agents = [...new Set(rows.map(row => text(row.executorName) || text(row.executorId)).filter(Boolean))];
  const lines = [`# 交接单：${goal}`, ''];
  lines.push(line('计划', plan.id));
  lines.push(line('状态', `${STATUS[plan.status] || plan.status || '未知'} · ${done}/${rows.length} 步已完成`));
  lines.push(line('参与 Agent', agents.join('、')));
  lines.push(line('更新时间', plan.updatedAt));
  lines.push('', '## 执行结果', '');

  for (const row of rows) {
    lines.push(`### ${(integer(row.index) || 0) + 1}. ${text(row.title) || '未命名步骤'}`, '');
    lines.push(`- 执行：${text(row.executorName) || text(row.executorId) || '未知'} · ${STATUS[row.status] || row.status || '未知'}`);
    const summary = line('结论', row.summary);
    if (summary) lines.push(summary);
    const verify = acceptanceLine(row);
    if (verify) lines.push(verify);
    const files = list(row.files);
    if (files.length) lines.push(`- 改动文件：${files.slice(0, 12).join('、')}${files.length > 12 ? ` 等 ${files.length} 个` : ''}`);
    const tokens = integer(row.tokens);
    const cost = money(row.cost);
    if (tokens || cost) lines.push(`- 用量：${tokens ? `${tokens.toLocaleString('en-US')} tokens` : '0 tokens'}${cost ? ` · ${cost}` : ''}`);
    lines.push('');
  }

  const questions = list(brief?.openQuestions);
  if (questions.length) {
    lines.push('## 未解问题', '', ...questions.map(item => `- ${item}`), '');
  }
  const next = list(brief?.nextSteps);
  if (next.length) {
    lines.push('## 下一步', '', ...next.map(item => `- ${item}`), '');
  }
  const commands = list(brief?.verifyCommands);
  if (commands.length) {
    lines.push('## 接手先跑', '', ...commands.map(item => `- \`${item}\``), '');
  }
  return lines.join('\n').trimEnd();
}
