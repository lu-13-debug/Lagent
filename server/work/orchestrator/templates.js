// 任务模板：先判断这是哪一类活，再套对应的步骤骨架。
// 模板只给「做什么、需要什么能力」，具体派谁由 capabilities 决定，
// 具体怎么执行由现有工单体系负责——这里不碰执行器内部。
//
// kind 用词与 UI 对齐：
//   research  先看清现状（只读）
//   implement 真正动文件
//   verify    跑起来验证（命令）
//   summarize 归纳结论（只读，内置模型优先）
export const TEMPLATES = Object.freeze([
  {
    id: 'code-change',
    label: '改代码',
    keywords: ['改', '修', '实现', '重构', '添加', '新增', '删除', '样式', '组件', '接口', '报错', 'bug', '测试', '优化', '补', '写', '文档', 'readme', '注释'],
    steps: [
      {
        role: '摸清现状',
        kind: 'research',
        need: { reads: true },
        prompt: goal => `先只读地摸清现状，为「${goal}」做准备：找出相关文件与关键函数，说明它们现在怎么工作、改动会牵动哪里。不要修改任何文件。`
      },
      {
        role: '动手实现',
        kind: 'implement',
        need: { reads: true, writes: true },
        prompt: goal => `按计划完成「${goal}」：在工作目录内修改文件，保持现有代码风格，不要顺手重构无关部分。做完后用几句话说明改了哪些文件、每个文件改了什么。`
      },
      {
        role: '跑起来验证',
        kind: 'verify',
        need: { commands: true },
        prompt: goal => `验证「${goal}」是否真的做成了：运行相关的测试或构建命令，把关键输出贴出来。如果失败，直接说清楚失败原因与可疑位置，不要假装成功。`
      }
    ]
  },
  {
    id: 'data-analysis',
    label: '数据分析',
    keywords: ['数据', '统计', '分析', '报表', '图表', '趋势', '指标', 'sql', 'csv', 'excel'],
    steps: [
      {
        role: '读数据',
        kind: 'research',
        need: { reads: true },
        prompt: goal => `为「${goal}」准备数据：确认数据在哪、字段含义、时间范围与缺失情况，列出你打算用的字段。不要修改文件。`
      },
      {
        role: '算结果',
        kind: 'implement',
        need: { reads: true, writes: true },
        prompt: goal => `完成「${goal}」的计算：写出可复跑的分析步骤，给出关键数字与它们的口径。数字必须来自真实数据，不要估算。`
      },
      {
        role: '核对口径',
        kind: 'verify',
        need: { commands: true },
        prompt: goal => `复核「${goal}」的结果：抽查 1–2 个数字能否复现，检查口径（时间范围、分母、去重规则）是否一致。有问题直接指出。`
      }
    ]
  },
  {
    id: 'research',
    label: '调研',
    keywords: ['调研', '对比', '选型', '看看', '了解', '搜索', '资料', '方案', '评估'],
    steps: [
      {
        role: '收集材料',
        kind: 'research',
        need: { reads: true },
        prompt: goal => `围绕「${goal}」收集材料：优先看仓库里已有的实现与文档，指出哪些事实是你能确认的、哪些是猜测。不要修改文件。`
      },
      {
        role: '补外部信息',
        kind: 'research',
        need: { browser: true },
        prompt: goal => `为「${goal}」补充外部信息：查官方文档或权威来源，逐条给出来源地址与结论。查不到就说查不到。`
      },
      {
        role: '出结论',
        kind: 'summarize',
        need: { summarize: true },
        prompt: goal => `把前面的材料收敛成「${goal}」的结论：可选项、各自代价、推荐哪一个以及为什么。控制在 10 行以内。`
      }
    ]
  },
  {
    id: 'ops',
    label: '运维排查',
    keywords: ['部署', '启动', '端口', '日志', '进程', '环境', 'docker', '服务', '慢', '内存', '崩溃'],
    steps: [
      {
        role: '看现场',
        kind: 'research',
        need: { commands: true },
        prompt: goal => `先只读地看现场，为「${goal}」定位问题：查进程、端口、日志、配置，把观察到的证据逐条列出。除只读命令外不要改动任何东西。`
      },
      {
        role: '处置',
        kind: 'implement',
        need: { reads: true, writes: true },
        prompt: goal => `针对「${goal}」做最小必要的处置：改配置或改代码，一次只改一处，说明为什么这么改。`
      },
      {
        role: '确认恢复',
        kind: 'verify',
        need: { commands: true },
        prompt: goal => `确认「${goal}」已经恢复：重新观察同样的指标，把改前改后的对比贴出来。没恢复就直说。`
      }
    ]
  }
]);

const DEFAULT_ID = 'code-change';

function score(template, goal) {
  const text = String(goal || '').toLowerCase();
  return template.keywords.reduce((sum, word) => (text.includes(word.toLowerCase()) ? sum + 1 : sum), 0);
}

// 返回 {template, confidence}：confidence 为 0 时说明没命中关键词，用默认模板。
export function detectTemplate(goal) {
  const ranked = TEMPLATES.map(template => ({ template, hit: score(template, goal) }))
    .sort((left, right) => right.hit - left.hit);
  const best = ranked[0];
  if (!best || best.hit === 0) return { template: TEMPLATES.find(item => item.id === DEFAULT_ID) || TEMPLATES[0], confidence: 0 };
  return { template: best.template, confidence: Math.min(1, best.hit / 3) };
}

export function templateById(id) {
  return TEMPLATES.find(template => template.id === id) || null;
}

// 把模板展开成带序号的步骤；goal 会被塞进每一步的提示里。
export function buildSteps(template, goal) {
  return template.steps.map((step, index) => ({
    index,
    role: step.role,
    kind: step.kind,
    need: step.need,
    prompt: step.prompt(goal)
  }));
}

export function repairStep(goal, evidence) {
  return {
    role: '修掉问题',
    kind: 'implement',
    need: { reads: true, writes: true },
    prompt: `上一轮验证没有通过，针对「${goal}」修掉这个问题：\n${evidence}\n只做必要的修改，改完说明改了什么。`
  };
}