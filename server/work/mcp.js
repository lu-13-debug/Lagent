import { workError } from './domain.js';

const PROTOCOL_VERSION = '2024-11-05';

const tool = (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler });

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function requiredString(input, key) {
  if (typeof input?.[key] !== 'string' || !input[key].trim()) throw workError(`${key} 必须是非空字符串`);
  return input[key].trim();
}

export function createMcpHandler({ engine, windowBridge } = {}) {
  if (!engine) throw new TypeError('MCP handler 需要 Work engine');
  const tools = [
    tool('work_list_tickets', '列出当前工作区的 Work 工单', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ tickets: engine.bootstrap().tickets })),
    tool('work_get_ticket', '读取单个工单详情', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, async input => textResult(engine.detail(requiredString(input, 'id')))),
    tool('work_send_command', '向指挥台发送一条指令', {
      type: 'object',
      properties: { text: { type: 'string' }, executorId: { type: 'string' }, datasetId: { type: 'string' }, executorInput: { type: 'object' }, clientRequestId: { type: 'string' } },
      required: ['text'], additionalProperties: false
    }, async input => textResult({ ticket: engine.command(input) })),
    tool('work_ticket_action', '对工单执行 approve/reject/stop/retry/resume', {
      type: 'object',
      properties: { id: { type: 'string' }, action: { type: 'string' }, input: { type: 'object' } },
      required: ['id', 'action'], additionalProperties: false
    }, async input => textResult({ ticket: engine.action(requiredString(input, 'id'), requiredString(input, 'action'), input.input) })),
    tool('work_list_agents', '列出当前可调度的执行器及其状态', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ agents: engine.bootstrap().agents || [] })),
    tool('work_list_plans', '列出最近的 Work 计划', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ plans: engine.bootstrap().plans || [] })),
    tool('work_list_projects', '列出已接入的项目工作区', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ projects: engine.listProjects() })),
    tool('work_project_brief', '读取项目简报：目标、进展、任务要点、关键决定、约束与变更记录（Markdown，可直接作为其他 Agent 的项目上下文）', {
      type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false
    }, async input => textResult(engine.projectBriefMarkdown(requiredString(input, 'projectId')))),
    tool('work_project_memory', '读取项目记忆：之前每次执行谁做了什么、对项目的改进、还没解决的问题（新会话开工前先读它，避免从头开始）', {
      type: 'object', properties: { projectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['projectId'], additionalProperties: false
    }, async input => textResult(engine.projectMemoryDigest(requiredString(input, 'projectId')))),
    tool('work_update_project_brief', '更新项目简报的目标、进展、任务要点、关键决定与约束', {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        goal: { type: 'string' },
        summary: { type: 'string' },
        keyPoints: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } }
      },
      required: ['projectId'], additionalProperties: false
    }, async input => {
      const projectId = requiredString(input, 'projectId');
      const { projectId: _ignored, ...patch } = input;
      return textResult({ brief: engine.saveProjectBrief(projectId, patch) });
    }),
    tool('work_record_change', '记录一条项目变更（标题、摘要、改动文件），供后续 Agent 读取', {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        title: { type: 'string' },
        summary: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        executorId: { type: 'string' },
        ticketId: { type: 'string' }
      },
      required: ['projectId'], additionalProperties: false
    }, async input => {
      const projectId = requiredString(input, 'projectId');
      const { projectId: _ignored, ...change } = input;
      return textResult({ change: engine.recordProjectChange(projectId, change) });
    }),
    tool('work_get_report', '读取工单的最新报告摘要与产物结构', {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'], additionalProperties: false
    }, async input => {
      const detail = engine.detail(requiredString(input, 'id'));
      const reports = Array.isArray(detail?.reports) ? detail.reports : [];
      const latest = reports[reports.length - 1] || null;
      return textResult({
        ticketId: detail?.ticket?.id || null,
        status: detail?.ticket?.status || null,
        reportCount: reports.length,
        summary: latest?.summary || null,
        report: latest?.artifacts?.report || null,
        artifactKeys: latest?.artifacts && typeof latest.artifacts === 'object' ? Object.keys(latest.artifacts) : []
      });
    }),
    tool('work_create_plan', '创建一个多步 Work 计划（可并行依赖）', {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              executorId: { type: 'string' },
              text: { type: 'string' },
              executorInput: { type: 'object' },
              datasetId: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'number' } }
            },
            required: ['executorId', 'text'],
            additionalProperties: false
          }
        },
        autoRun: { type: 'boolean' },
        clientRequestId: { type: 'string' }
      },
      required: ['goal', 'steps'], additionalProperties: false
    }, async input => {
      if (!Array.isArray(input.steps)) throw workError('steps 必须是数组');
      if (typeof input.goal !== 'string' || !input.goal.trim()) throw workError('goal 必须是非空字符串');
      return textResult({ plan: engine.plan(input) });
    }),
    ...(windowBridge ? [
      tool('work_list_windows', '列出本机可操作的 Agent 窗口', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ windows: await windowBridge.listWindows() })),
      tool('work_send_window', '向白名单 Agent 窗口发送指令', {
        type: 'object',
        properties: { handle: { type: 'number' }, process: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' } },
        required: ['handle', 'text'], additionalProperties: false
      }, async input => {
        const result = await windowBridge.sendToWindow(input.handle, input.text, { submit: input.submit !== false, ...(input.process ? { process: input.process } : {}) });
        engine.auditExternal('mcp/window-send', 'window', 'sent');
        return textResult(result);
      })
    ] : [])
  ];
  const byName = new Map(tools.map(item => [item.name, item]));

  async function handle(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw workError('MCP 请求必须是 JSON-RPC 对象');
    if (payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') throw workError('MCP 请求格式无效');
    if (payload.method === 'initialize') {
      return {
        protocolVersion: typeof payload.params?.protocolVersion === 'string' ? payload.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'DataAgent', version: '1.1.0' }
      };
    }
    if (payload.method === 'notifications/initialized' || payload.method === 'notifications/cancelled') return null;
    if (payload.method === 'ping') return {};
    if (payload.method === 'tools/list') {
      return { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    }
    if (payload.method === 'tools/call') {
      const name = requiredString(payload.params, 'name');
      const entry = byName.get(name);
      if (!entry) throw Object.assign(workError('未知 MCP 工具', 404), { code: 'MCP_TOOL_NOT_FOUND' });
      const input = payload.params?.arguments;
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw workError('MCP 工具参数必须是对象');
      return entry.handler(input || {});
    }
    throw Object.assign(workError('未知 MCP 方法', 404), { code: 'MCP_METHOD_NOT_FOUND' });
  }

  return { handle, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
}

export function registerMcpRoutes(app, { engine, gateway, ownerId, windowBridge } = {}) {
  if (!engine || !gateway) throw new TypeError('MCP 路由需要 engine 与 gateway');
  const handler = createMcpHandler({ engine, windowBridge });
  const authenticate = req => gateway.authenticateRequest(req, { ownerId });

  app.post('/api/mcp/token', (req, res) => {
    const pair = gateway.createPair(ownerId);
    const device = gateway.claim(pair.code, typeof req.body?.name === 'string' ? req.body.name : 'MCP 客户端', `mcp-${ownerId}`);
    engine.auditExternal('mcp/token', 'mcp', 'created');
    res.status(201).json({ endpoint: '/api/mcp', token: device.deviceToken, deviceId: device.deviceId, expiresAt: device.expiresAt });
  });

  app.post('/api/mcp', async (req, res) => {
    authenticate(req);
    const payload = req.body;
    const id = payload && typeof payload === 'object' && 'id' in payload ? payload.id : undefined;
    if (id === undefined) {
      try { await handler.handle(payload); res.status(202).end(); }
      catch { res.status(202).end(); }
      return;
    }
    try {
      const result = await handler.handle(payload);
      res.json({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 400;
      res.status(status === 401 ? 401 : 200).json({ jsonrpc: '2.0', id, error: { code: status, message: error?.message || 'MCP 请求失败' } });
    }
  });
}
