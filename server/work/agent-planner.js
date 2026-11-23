import { execFile } from 'node:child_process';
import { resolveLocalCommand } from './providers.js';
import { findCodexBinary } from './executors/discover.js';

// 没有配置规划模型时，用本机已安装的 Agent 自己来拆任务：
// 软件把「目标 + 可用执行器清单 + 输出格式」交给一个 Agent，只取它回的 JSON 步骤。
// 注意：规划器只负责「想」，不需要出现在本次要分发的执行器里；
// 用户点名的 Agent 优先，其次再按顺序找本机可用的。
const PLANNERS = [
  {
    id: 'dsh',
    command: env => resolveLocalCommand('dsh', env),
    args: prompt => ['--profile', 'headless', prompt]
  },
  {
    id: 'claude-code',
    command: env => resolveLocalCommand('claude', env),
    args: prompt => ['-p', '--output-format', 'text', prompt]
  },
  {
    id: 'codex',
    command: env => (findCodexBinary(env) ? { command: findCodexBinary(env), args: [], shell: false } : resolveLocalCommand('codex', env)),
    args: prompt => ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', prompt]
  }
];

const SYSTEM = [
  '你是任务规划器，只做拆解，不执行任务。',
  '不要调用任何工具，不要读取或修改文件，只根据目标、执行器清单和数据集清单来拆解。',
  '把目标拆成 2–5 步，每步交给一个最合适的执行器；有先后依赖时用 dependsOn 指定前面的步骤下标（从 0 开始）。',
  '每个执行器的说明要具体到「谁、在什么范围内、产出哪些文件」，一条不超过 200 字。禁止「执行任务第 1 部分」「完成剩余工作」这类没有文件名的空话。',
  '写文件的步骤必须带 scope（要改的目录或文件）和 contract：{"objective":"这一步交付什么","deliverables":["必须真实落盘的项目内相对路径"],"acceptance":["可检查的完成条件"]}。交付物多时拆成多个文件，不要用一份总结文档代替。',
  '如果目标本身是一套作业/项目交付（需求、数据库、代码、测试、报告、PPT 等），每一步只负责其中一组文件，并在 contract.deliverables 里逐项列出；后续步骤只补自己那组，不重复写前面的。',
  '某一步要跑测试时，在 verify 或 contract.acceptance 里写清命令与期望结果，不要让执行器自己猜验收标准。',
  '要查开源项目怎么做的，就把第一步交给 github（它只读、能搜索仓库），不要交给会被沙箱禁网的 CLI。',
  '交给 github 的步骤必须带 executorInput，格式 {"action":"search","query":"英文关键词，2-5 个词","limit":5}，query 不要写整句中文，也不要加 open source / github 这类词。',
  '成本高的执行器（codex / claude-code）尽量只用在真正要改文件的那几步。',
  '实现/验证类步骤可选带 verify：{"command":"npm test","expect":"exit=0"}；命令只能用 npm test / npm run test|build|lint|typecheck / pytest / go test / cargo test / dotnet test / node --test，不要写 shell 管道、重定向或变量。',
  '只输出一个 JSON 对象，格式：{"steps":[{"executorId":"...","text":"...","scope":["src/**"],"dependsOn":[0],"contract":{"objective":"...","deliverables":["src/a.ts"],"acceptance":["npm test 通过"]},"verify":{"command":"npm test","expect":"exit=0"}}]}',
  '除了这个 JSON，不要输出任何解释或其它内容。'
].join('\n');

function ordered(executors) {
  const wanted = new Set(executors);
  const preferred = PLANNERS.filter(planner => wanted.has(planner.id));
  const rest = PLANNERS.filter(planner => !wanted.has(planner.id));
  return [...preferred, ...rest];
}

function extractJson(text) {
  const source = String(text || '');
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const input = fenced ? fenced[1] : source;
  const start = input.indexOf('{');
  if (start === -1) throw new Error('规划结果里没有 JSON');
  for (let end = input.lastIndexOf('}'); end > start; end = input.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(input.slice(start, end + 1)); } catch { /* 继续缩小范围。 */ }
  }
  throw new Error('规划结果不是合法 JSON');
}

function run(command, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(command.command, [...(command.args || []), ...args], {
      env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(String(stderr || error.message || '规划器执行失败').trim().slice(0, 300))); return; }
      resolve(String(stdout || ''));
    });
  });
}

export function createAgentPlanner({ env = process.env, timeoutMs = 180000 } = {}) {
  return async function agentPlanner(input) {
    const executors = Array.isArray(input?.executors) ? input.executors : [];
    const agents = Array.isArray(input?.agents) ? input.agents : [];
    const analysis = input?.analysis;
    const analysisLines = analysis && Array.isArray(analysis.steps) && analysis.steps.length
      ? [
          '预设理解（供参考，可调整）：',
          ...(Array.isArray(analysis.understanding) ? analysis.understanding.map(line => `- ${line}`) : []),
          `- 建议分工：${analysis.steps.map((step, index) => `${index + 1}. ${step.executorId} → ${step.title}${Array.isArray(step.scope) && step.scope.length ? `（写 ${step.scope.join('、')}）` : '（只读）'}`).join('；')}`,
          analysis.conflicts && analysis.conflicts.length ? `- 已知冲突：${analysis.conflicts.map(item => item.reason).join('；')}，请串行安排` : '- 写文件的步骤互不重叠，可以并行'
        ]
      : [];
    const prompt = [
      SYSTEM,
      '',
      `目标：${String(input?.goal || '').slice(0, 300)}`,
      `可用执行器：${agents.map(agent => `${agent.id}（${agent.name}${Array.isArray(agent.capabilities) && agent.capabilities.length ? `：${agent.capabilities.join('、')}` : ''}）`).join('；')}`,
      Array.isArray(input?.datasets) && input.datasets.length ? `可用数据集：${input.datasets.map(dataset => `${dataset.id}（${dataset.name}）`).join('；')}` : '',
      input?.project ? `项目：${input.project.name}（${input.project.path}${input.project.gitBranch ? `，分支 ${input.project.gitBranch}` : ''}）` : '',
      input?.project?.memory ? `项目记忆（之前的会话留下的结论，别重复踩坑）：\n${String(input.project.memory).slice(0, 1600)}` : '',
      ...analysisLines
    ].filter(Boolean).join('\n');
    const failures = [];
    for (const planner of ordered(executors)) {
      const resolved = planner.command(env);
      if (!resolved || !resolved.command) { failures.push(`${planner.id} 未安装`); continue; }
      try {
        const stdout = await run(resolved, planner.args(prompt), { env, timeoutMs });
        const parsed = extractJson(stdout);
        if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) throw new Error('规划结果缺少 steps');
        return { steps: parsed.steps, model: { provider: 'local', model: planner.id } };
      } catch (error) {
        failures.push(`${planner.id}：${String(error?.message || '失败').slice(0, 120)}`);
      }
    }
    throw new Error(`自动拆解失败：${failures.join('；') || '没有可用的规划器'}`);
  };
}
