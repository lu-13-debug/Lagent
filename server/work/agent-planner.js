import { execFile } from 'node:child_process';
import { resolveLocalCommand } from './providers.js';

// 没有配置规划模型时，用本机已安装的 Agent 自己来拆任务：
// 软件把「目标 + 可用执行器清单 + 输出格式」交给一个 Agent，只取它回的 JSON 步骤。
const PLANNERS = [
  { id: 'dsh', args: (prompt) => ['--profile', 'headless', prompt] },
  { id: 'claude-code', args: (prompt) => ['-p', '--output-format', 'text', prompt] },
  { id: 'codex', args: (prompt) => ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', prompt] }
];

const SYSTEM = [
  '你是任务规划器，只做拆解，不执行任务。',
  '把目标拆成 2–5 步，每步交给一个最合适的执行器；有先后依赖时用 dependsOn 指定前面的步骤下标。',
  '每个执行器的说明要具体到「谁、在什么范围内、产出什么」，一条不超过 200 字。',
  '只输出一个 JSON 对象，格式：{"steps":[{"executorId":"...","text":"...","dependsOn":[0]}]}',
  '不要输出解释、Markdown 代码块以外的东西。'
].join('\n');

function candidates(executors) {
  return executors.map(id => PLANNERS.find(planner => planner.id === id)).filter(Boolean);
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
      if (error) { reject(new Error(String(stderr || error.message || '规划器执行失败').trim().slice(0, 400))); return; }
      resolve(String(stdout || ''));
    });
  });
}

export function createAgentPlanner({ env = process.env, timeoutMs = 150000 } = {}) {
  return async function agentPlanner(input) {
    const executors = Array.isArray(input?.executors) ? input.executors : [];
    const agents = Array.isArray(input?.agents) ? input.agents : [];
    const usable = candidates(executors);
    if (!usable.length) throw new Error('本机没有可以用来自动拆解任务的 Agent');
    const prompt = [
      SYSTEM,
      '',
      `目标：${String(input?.goal || '').slice(0, 300)}`,
      `可用执行器：${agents.map(agent => `${agent.id}（${agent.name}${Array.isArray(agent.capabilities) && agent.capabilities.length ? `：${agent.capabilities.join('、')}` : ''}）`).join('；')}`,
      Array.isArray(input?.datasets) && input.datasets.length ? `可用数据集：${input.datasets.map(dataset => `${dataset.id}（${dataset.name}）`).join('；')}` : '',
      input?.project ? `项目：${input.project.name}（${input.project.path}${input.project.gitBranch ? `，分支 ${input.project.gitBranch}` : ''}）` : ''
    ].filter(Boolean).join('\n');
    let lastError = null;
    for (const planner of usable) {
      const resolved = resolveLocalCommand(planner.id, env);
      if (!resolved) { lastError = new Error(`找不到 ${planner.id} 可执行文件`); continue; }
      try {
        const stdout = await run(resolved, planner.args(prompt), { env, timeoutMs });
        const parsed = extractJson(stdout);
        if (!parsed || !Array.isArray(parsed.steps)) throw new Error('规划结果缺少 steps');
        return { steps: parsed.steps, model: { provider: 'local', model: planner.id } };
      } catch (error) { lastError = error; }
    }
    throw new Error(`自动拆解失败：${lastError?.message || '没有可用的规划器'}`);
  };
}
