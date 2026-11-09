/**
 * 任务大脑：用已配置的模型 API 先想清楚，再决定分派。
 *
 * 与本地启发式（task-analyzer）互补：
 * - 有可用模型时，模型可以先调用只读工具（搜 GitHub、读网页、看项目目录）再产出步骤；
 * - 没有模型、模型报错或返回不合规时，调用方回退到本地分析，不能让界面卡住。
 *
 * 这里只负责「一次思考」与「一次总结」，不碰执行器、不派工单。
 */
import { modelRequest, readModelResponse, providerUsage } from '../model-protocol.js';

const MAX_ROUNDS = 3;
const MAX_TOOL_CHARS = 6000;
const MAX_PAGE_CHARS = 4000;
const MAX_FILES = 120;

export function brainError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, brainFailure: true, status });
}

const THINK_SYSTEM = [
  '你是 DataAgent 的任务大脑。用户给一个目标，你要先理解、再调研、最后给出可执行的分派步骤。',
  '工作方式：',
  '1) 先判断这个目标真正要解决的问题、涉及哪些层（前端/后端/数据/文档/测试）；',
  '2) 需要外部资料时调用工具（github_search 找同类开源项目、fetch_page 读网页、project_files 看项目目录），不要凭空假设；',
  '3) 再决定每一步交给哪个执行器，避免两个步骤同时改同一批文件；',
  '4) 只读的调研步骤可以并行，写文件的步骤要按目录分开，验证步骤放在所有写步骤之后。',
  '约束：',
  '- 步骤 1–5 个，只能用给定的执行器 id；',
  '- 每一步写清 scope（要改的目录或文件前缀，例如 src/**、server/**），只读步骤 scope 留空；',
  '- 不要编造工具结果；没有工具可用时就说明「基于已有信息判断」。',
  '输出：先写 1–3 行 reasoning（你判断的关键点），最后输出一个 JSON 对象，不要用代码块包裹。',
  'JSON 结构：{"understanding":["…","…"],"steps":[{"title":"…","executorId":"…","scope":["src/**"],"readOnly":false,"output":"…","dependsOn":[0]}]}',
].join('\n');

const SUMMARY_SYSTEM = [
  '你是 DataAgent 的项目记忆整理员。给你一次已完成的执行记录，写一条可以给后续会话直接使用的记忆。',
  '要求：',
  '- summary：这次到底做了什么，1–2 句，不要复述目标；',
  '- improvements：这次对项目产生的实际改进，0–3 条，没有就留空数组；',
  '- openQuestions：还没做完或需要确认的问题，0–3 条；',
  '- 不要编造没有出现过的文件名或结论。',
  '只输出 JSON：{"summary":"…","improvements":["…"],"openQuestions":["…"]}',
].join('\n');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'github_search',
      description: '在 GitHub 搜索开源仓库，用来找同类项目的实现方式。返回仓库名、星数、语言与简介。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '英文关键词，2–5 个词，不要写整句中文。' },
          limit: { type: 'integer', description: '返回条数，1–8，默认 5。' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_page',
      description: '读取一个公开网页的正文（已去掉标签），用来确认文档、API 用法或方案细节。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'https 地址。' } },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'project_files',
      description: '列出当前项目目录下的文件与子目录（只读，最多两层），用来判断改动应该落在哪里。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '相对项目根目录的路径，留空表示根目录。' } },
      },
    },
  },
];

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const list = (value, max, chars) =>
  Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).slice(0, max).map(item => text(item, chars)) : [];

function parseJsonObject(raw) {
  const source = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) throw brainError('BRAIN_FORMAT', '模型没有返回可解析的 JSON。', 502);
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    throw brainError('BRAIN_FORMAT', '模型返回的 JSON 无法解析。', 502);
  }
}

const stripHtml = html => String(html || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

export function createWorkBrain({ modelHub, fetchImpl = fetch, perCallTimeoutMs = 60000 } = {}) {
  const planStage = () => {
    if (!modelHub?.captureWorkflow || !modelHub?.context) return null;
    const captured = modelHub.captureWorkflow();
    const stage = captured?.stages?.plan;
    if (!stage) return null;
    const context = modelHub.context(stage);
    if (!context?.key || !context?.settings?.model) return null;
    return context;
  };

  const availability = () => {
    try {
      const context = planStage();
      if (!context) return { ok: false, reason: '还没有可用的规划模型：请在「模型与 API」里配置并选择默认模型。' };
      return { ok: true, model: { provider: context.settings.provider || '自定义接口', model: context.settings.model } };
    } catch (error) {
      return { ok: false, reason: error?.message || '规划模型不可用。' };
    }
  };

  async function callModel(context, messages, tools) {
    const settings = context.settings;
    const request = modelRequest(settings.baseUrl, settings.model, messages, context.key, Math.min(2048, Number(context.maxTokens) || 2048), false, settings);
    const body = tools && request.protocol === 'chat-completions' ? { ...request.body, tools, tool_choice: 'auto' } : request.body;
    const timeout = Math.min(Number(context.timeoutMs) || perCallTimeoutMs, perCallTimeoutMs);
    let response;
    try {
      response = await fetchImpl(request.endpoint, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch (error) {
      throw brainError('BRAIN_UNREACHABLE', `模型接口无法访问：${error?.message || '网络错误'}`, 502);
    }
    if (!response.ok) throw brainError('BRAIN_HTTP', `模型接口返回 HTTP ${response.status}。`, 502);
    const payload = await readModelResponse(response);
    return { payload, protocol: request.protocol, usage: providerUsage(payload?.usage, request.protocol) };
  }

  async function callTool(name, args, { projectPath, browserHosts }) {
    if (name === 'github_search') {
      const query = text(args?.query, 120);
      const limit = Math.min(8, Math.max(1, Number(args?.limit) || 5));
      if (!query) return { ok: false, summary: '搜索词为空', data: { error: 'query required' } };
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`;
      try {
        const response = await fetchImpl(url, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'DataAgent' },
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) return { ok: false, summary: `GitHub 返回 ${response.status}`, data: { error: `HTTP ${response.status}` } };
        const payload = await response.json();
        const items = (Array.isArray(payload?.items) ? payload.items : []).slice(0, limit).map(item => ({
          fullName: text(item?.full_name, 120),
          stars: Number(item?.stargazers_count) || 0,
          language: text(item?.language, 40),
          description: text(item?.description, 240),
          url: text(item?.html_url, 300),
        }));
        return { ok: true, summary: `命中 ${items.length} 个仓库`, data: { query, count: items.length, items } };
      } catch (error) {
        return { ok: false, summary: `搜索失败：${error?.message || '网络错误'}`, data: { error: 'network' } };
      }
    }
    if (name === 'fetch_page') {
      const raw = text(args?.url, 500);
      let target;
      try {
        target = new URL(raw);
      } catch {
        return { ok: false, summary: '地址无效', data: { error: 'invalid url' } };
      }
      if (target.protocol !== 'https:') return { ok: false, summary: '只允许 https 地址', data: { error: 'https only' } };
      if (Array.isArray(browserHosts) && browserHosts.length) {
        const host = target.hostname.toLowerCase();
        const allowed = browserHosts.some(item => host === String(item).toLowerCase() || host.endsWith(`.${String(item).toLowerCase()}`));
        if (!allowed) return { ok: false, summary: `域名不在白名单：${host}`, data: { error: 'host blocked' } };
      }
      try {
        const response = await fetchImpl(target.toString(), { headers: { 'user-agent': 'DataAgent' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
        if (!response.ok) return { ok: false, summary: `网页返回 ${response.status}`, data: { error: `HTTP ${response.status}` } };
        const body = stripHtml(await response.text()).slice(0, MAX_PAGE_CHARS);
        return { ok: true, summary: `读取 ${body.length} 字`, data: { url: target.toString(), title: text(await Promise.resolve(target.hostname), 80), text: body } };
      } catch (error) {
        return { ok: false, summary: `读取失败：${error?.message || '网络错误'}`, data: { error: 'network' } };
      }
    }
    if (name === 'project_files') {
      if (!projectPath) return { ok: false, summary: '没有绑定工作文件夹', data: { error: 'no project' } };
      try {
        const { readdirSync, statSync } = await import('node:fs');
        const path = await import('node:path');
        const relative = text(args?.path, 200).replace(/^[\\/]+/, '');
        const base = path.resolve(projectPath);
        const target = path.resolve(base, relative);
        if (target !== base && !target.startsWith(`${base}${path.sep}`)) return { ok: false, summary: '路径越界', data: { error: 'outside project' } };
        const entries = readdirSync(target, { withFileTypes: true })
          .filter(entry => !['node_modules', '.git', 'dist', 'build', '.dataagent'].includes(entry.name))
          .slice(0, MAX_FILES)
          .map(entry => ({ name: entry.name, dir: entry.isDirectory() }));
        return { ok: true, summary: `${entries.length} 项`, data: { path: relative || '.', entries } };
      } catch (error) {
        return { ok: false, summary: `读取失败：${error?.message || '未知错误'}`, data: { error: 'read failed' } };
      }
    }
    return { ok: false, summary: `未知工具 ${name}`, data: { error: 'unknown tool' } };
  }

  function normalizeSteps(rawSteps, executors) {
    const allowed = new Set(Array.isArray(executors) ? executors : []);
    const source = Array.isArray(rawSteps) ? rawSteps.slice(0, 5) : [];
    const steps = [];
    source.forEach((step, index) => {
      const executorId = text(step?.executorId, 60);
      if (!allowed.has(executorId)) return;
      const scope = list(step?.scope, 6, 120);
      const readOnly = step?.readOnly === true || scope.length === 0;
      const dependsOn = Array.isArray(step?.dependsOn)
        ? [...new Set(step.dependsOn.filter(value => Number.isSafeInteger(value) && value >= 0 && value < index))].sort((a, b) => a - b)
        : [];
      steps.push({
        index: steps.length,
        title: text(step?.title, 120) || `第 ${steps.length + 1} 步`,
        executorId,
        scope: readOnly ? [] : scope,
        readOnly,
        output: text(step?.output, 200),
        dependsOn,
        needsApproval: true,
        kind: readOnly ? 'research' : /验证|测试|回归|检查/.test(text(step?.title, 120)) ? 'verify' : 'write',
      });
    });
    return steps.map((step, index) => ({ ...step, index }));
  }

  async function think({ goal, executors = [], project = null, digest = '', browserHosts = [] } = {}) {
    const context = planStage();
    if (!context) throw brainError('BRAIN_UNAVAILABLE', '还没有可用的规划模型。');
    const messages = [
      { role: 'system', content: THINK_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          goal: text(goal, 300),
          executors: executors.map(id => ({ id })),
          project: project ? { name: text(project.name, 80), path: text(project.path, 300), branch: text(project.gitBranch, 80) } : null,
          memory: text(digest, 4000),
        }),
      },
    ];
    const toolCalls = [];
    const notes = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const { payload, protocol } = await callModel(context, messages, TOOLS);
      const choice = payload?.choices?.[0];
      const message = choice?.message;
      if (!message) throw brainError('BRAIN_FORMAT', '模型没有返回消息体。', 502);
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) notes.push(text(message.reasoning_content, 600));
      const calls = protocol === 'chat-completions' && Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (!calls.length) {
        const parsed = parseJsonObject(typeof message.content === 'string' ? message.content : '');
        const steps = normalizeSteps(parsed?.steps, executors);
        if (!steps.length) throw brainError('BRAIN_EMPTY_PLAN', '模型没有给出可执行的步骤。', 502);
        return {
          source: 'model',
          model: { provider: context.settings.provider || '自定义接口', model: context.settings.model },
          understanding: list(parsed?.understanding, 5, 220),
          notes,
          steps,
          toolCalls,
        };
      }
      messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
      for (const call of calls) {
        const name = text(call?.function?.name, 40);
        let args = {};
        try {
          args = JSON.parse(call?.function?.arguments || '{}');
        } catch {
          args = {};
        }
        const outcome = await callTool(name, args, { projectPath: project?.path || '', browserHosts });
        toolCalls.push({ name, query: text(args?.query || args?.url || args?.path, 160), ok: outcome.ok, summary: outcome.summary });
        messages.push({ role: 'tool', tool_call_id: text(call?.id, 120), content: JSON.stringify(outcome.data).slice(0, MAX_TOOL_CHARS) });
      }
    }
    throw brainError('BRAIN_ROUNDS', '模型连续调用工具但没有给出结论，请把目标写得更具体。', 502);
  }

  async function summarize({ goal, project, executorId, summary, files = [], kind = 'ticket' } = {}) {
    const context = planStage();
    if (!context) throw brainError('BRAIN_UNAVAILABLE', '还没有可用的规划模型。');
    const { payload } = await callModel(
      context,
      [
        { role: 'system', content: SUMMARY_SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            goal: text(goal, 300),
            project: project?.name || '',
            executorId,
            kind,
            executed: text(summary, 6000),
            files: list(files, 30, 200),
          }),
        },
      ],
      null,
    );
    const message = payload?.choices?.[0]?.message;
    const parsed = parseJsonObject(typeof message?.content === 'string' ? message.content : '');
    return {
      summary: text(parsed?.summary, 600),
      improvements: list(parsed?.improvements, 3, 240),
      openQuestions: list(parsed?.openQuestions, 3, 240),
      model: { provider: context.settings.provider || '自定义接口', model: context.settings.model },
    };
  }

  return { availability, think, summarize, __test__: { callTool, normalizeSteps } };
}
