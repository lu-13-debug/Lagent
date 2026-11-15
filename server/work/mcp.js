import { workError } from './domain.js';
import { MCP_WRITE_TOOLS } from './mcp-tokens.js';
import { APP_VERSION } from '../version.js';

const PROTOCOL_VERSION = '2024-11-05';
const PROJECT_TOOLS = new Set(['work_project_brief', 'work_project_memory', 'work_memory_search', 'work_update_project_brief', 'work_record_change']);
const toolAllowed = (scope, name) => !scope?.tools?.length || scope.tools.includes(name);
const scopedInput = (scope, name, input) => {
  if (!scope?.projectId || !PROJECT_TOOLS.has(name)) return input;
  const next = { ...(input || {}) };
  if (!next.projectId) next.projectId = scope.projectId;
  if (next.projectId !== scope.projectId) throw workError('该 MCP 令牌只能访问绑定的项目', 403);
  return next;
};

const tool = (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler });

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function requiredString(input, key) {
  if (typeof input?.[key] !== 'string' || !input[key].trim()) throw workError(`${key} 必须是非空字符串`);
  return input[key].trim();
}

export function createMcpHandler({ engine, windowBridge, actor = 'mcp' } = {}) {
  if (!engine) throw new TypeError('MCP handler 需要 Work engine');
  const tools = [
    tool('work_list_tickets', '列出当前工作区的 Work 工单', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ tickets: engine.bootstrap().tickets })),
    tool('work_get_ticket', '读取单个工单详情', { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, async input => textResult(engine.detail(requiredString(input, 'id')))),
    tool('work_task_contract_read', '读取工单的任务契约与验收命令；接手任务前先看它', {
      type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false
    }, async input => {
      const detail = engine.detail(requiredString(input, 'id'));
      return textResult({ contract: detail.ticket.contract || null, verify: detail.ticket.verify || null });
    }),
    tool('work_acceptance_read', '读取工单最近一次验收结果（通过/失败、命令、退出码与输出摘要）', {
      type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false
    }, async input => {
      const detail = engine.detail(requiredString(input, 'id'));
      return textResult({ acceptance: detail.ticket.acceptance || null, verify: detail.ticket.verify || null, status: detail.ticket.status });
    }),
    tool('work_artifact_read', '读取工单最新报告里的产物；传 name 只取指定产物', {
      type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id'], additionalProperties: false
    }, async input => {
      const detail = engine.detail(requiredString(input, 'id'));
      // 报告是新的在前：从旧到新合并，保证最新一次的产物覆盖旧的，但不会丢掉终端/github 等较早的产物。
      const artifacts = {};
      for (const report of [...(detail.reports || [])].reverse()) {
        for (const [key, value] of Object.entries(report.artifacts || {})) artifacts[key] = value;
      }
      if (input.name !== undefined) {
        const name = requiredString(input, 'name');
        const value = artifacts[name];
        return textResult({ name, found: value !== undefined, value: typeof value === 'string' ? value.slice(0, 20000) : value ?? null });
      }
      const preview = {};
      for (const [key, value] of Object.entries(artifacts)) preview[key] = typeof value === 'string' ? value.slice(0, 20000) : value;
      return textResult({ artifacts: preview });
    }),
    tool('work_send_command', '向指挥台发送一条指令', {
      type: 'object',
      properties: { text: { type: 'string' }, executorId: { type: 'string' }, datasetId: { type: 'string' }, projectId: { type: 'string' }, executorInput: { type: 'object' }, clientRequestId: { type: 'string' }, verify: { type: 'object' } },
      required: ['text'], additionalProperties: false
    }, async input => textResult({ ticket: engine.command({ ...input, origin: actor }) })),
    tool('work_ticket_action', '对工单执行 approve/reject/stop/retry/resume', {
      type: 'object',
      properties: { id: { type: 'string' }, action: { type: 'string' }, input: { type: 'object' } },
      required: ['id', 'action'], additionalProperties: false
    }, async input => {
      const action = requiredString(input, 'action');
      // MCP 是外部 Agent 的入口，不能让发起者批准/重试自己的动作；这些动作只接受界面会话。
      if (['approve', 'resume', 'retry'].includes(action)) throw workError('MCP 不能批准或重试工单，请回到界面操作', 403);
      return textResult({ ticket: engine.action(requiredString(input, 'id'), action, input.input) });
    }),
    tool('work_ticket_handoff', '把已完成工单交接给另一个 Agent；可带结构化交接简报（已完成/产物/证据/决定/未解问题/下一步）', {
      type: 'object',
      properties: {
        id: { type: 'string' },
        executorId: { type: 'string' },
        text: { type: 'string' },
        executorInput: { type: 'object' },
        datasetId: { type: 'string' },
        handoff: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            artifacts: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
            decisions: { type: 'array', items: { type: 'string' } },
            openQuestions: { type: 'array', items: { type: 'string' } },
            nextSteps: { type: 'array', items: { type: 'string' } },
            budgetUsed: { type: 'object' }
          }
        }
      },
      required: ['id', 'executorId'], additionalProperties: false
    }, async input => {
      const { id, ...rest } = input;
      const result = engine.handoff(requiredString(input, 'id'), rest);
      return textResult({ created: result.created, ticket: result.ticket });
    }),
    tool('work_list_agents', '列出当前可调度的执行器及其状态', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ agents: engine.bootstrap().agents || [] })),
    tool('work_list_plans', '列出最近的 Work 计划', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ plans: engine.bootstrap().plans || [] })),
    tool('work_list_projects', '列出已接入的项目工作区', { type: 'object', properties: {}, additionalProperties: false }, async () => textResult({ projects: engine.listProjects() })),
    tool('work_project_brief', '读取项目简报：目标、进展、任务要点、关键决定、约束与变更记录（Markdown，可直接作为其他 Agent 的项目上下文）', {
      type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'], additionalProperties: false
    }, async input => textResult(engine.projectBriefMarkdown(requiredString(input, 'projectId')))),
    tool('work_project_memory', '读取项目记忆：之前每次执行谁做了什么、对项目的改进、还没解决的问题（新会话开工前先读它，避免从头开始）', {
      type: 'object', properties: { projectId: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, query: { type: 'string' }, scope: { type: 'string' } }, required: ['projectId'], additionalProperties: false
    }, async input => textResult(engine.projectMemoryDigest(requiredString(input, 'projectId'), { query: input.query, scope: input.scope, limit: input.limit }))),
    tool('work_memory_search', '按关键词或目录范围检索项目记忆，返回最相关的条目（带 scope/tags/confidence）', {
      type: 'object', properties: { projectId: { type: 'string' }, query: { type: 'string' }, scope: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['projectId'], additionalProperties: false
    }, async input => textResult({ entries: engine.projectMemorySearch(requiredString(input, 'projectId'), { query: input.query, scope: input.scope, limit: input.limit }) })),
    tool('work_update_project_brief', '更新项目简报的目标、进展、任务要点、关键决定与约束', {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        goal: { type: 'string' },
        summary: { type: 'string' },
        keyPoints: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
        nextSteps: { type: 'array', items: { type: 'string' } },
        verifyCommands: { type: 'array', items: { type: 'string' } }
      },
      required: ['projectId'], additionalProperties: false
    }, async input => {
      const projectId = requiredString(input, 'projectId');
      const { projectId: _ignored, ...patch } = input;
      return textResult({ brief: engine.saveProjectBrief(projectId, patch, { source: actor }) });
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
      return textResult({ change: engine.recordProjectChange(projectId, change, { source: actor }) });
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
    tool('work_verify_ticket', '对已完成的工单执行白名单内的验收命令，并记录通过/失败与输出', {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'], additionalProperties: false
    }, async input => textResult(await engine.verifyTicket(requiredString(input, 'id')))),
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
              dependsOn: { type: 'array', items: { type: 'number' } },
              verify: { type: 'object' }
            },
            required: ['executorId', 'text'],
            additionalProperties: false
          }
        },
        autoRun: { type: 'boolean' },
        projectId: { type: 'string' },
        clientRequestId: { type: 'string' }
      },
      required: ['goal', 'steps'], additionalProperties: false
    }, async input => {
      if (!Array.isArray(input.steps)) throw workError('steps 必须是数组');
      if (typeof input.goal !== 'string' || !input.goal.trim()) throw workError('goal 必须是非空字符串');
      return textResult({ plan: engine.plan({ ...input, origin: actor }) });
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

  // 作用域令牌只能看到、只能调用自己被授权的工具；返回列表也要按项目过滤，
  // 否则「绑定项目」只是摆设，外部 Agent 仍能读到别的项目工单。
  function scopedResult(name, result, scope) {
    if (!scope?.projectId) return result;
    try {
      const value = JSON.parse(result?.content?.[0]?.text || 'null');
      if (name === 'work_list_tickets' && Array.isArray(value?.tickets)) {
        value.tickets = value.tickets.filter(ticket => engine.ticketProjectId(ticket.id) === scope.projectId);
      } else if (name === 'work_list_projects' && Array.isArray(value?.projects)) {
        value.projects = value.projects.filter(project => project.id === scope.projectId);
      } else if (name === 'work_list_plans' && Array.isArray(value?.plans)) {
        value.plans = value.plans.filter(plan => engine.planProjectId?.(plan.id) === scope.projectId);
      } else return result;
      return textResult(value);
    } catch { return result; }
  }

  async function handle(payload, { scope } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw workError('MCP 请求必须是 JSON-RPC 对象');
    if (payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') throw workError('MCP 请求格式无效');
    if (payload.method === 'initialize') {
      return {
        protocolVersion: typeof payload.params?.protocolVersion === 'string' ? payload.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'Lagent', version: APP_VERSION }
      };
    }
    if (payload.method === 'notifications/initialized' || payload.method === 'notifications/cancelled') return null;
    if (payload.method === 'ping') return {};
    if (payload.method === 'tools/list') {
      const visible = scope
        ? tools.filter(entry => toolAllowed(scope, entry.name) && !(scope.readOnly && MCP_WRITE_TOOLS.includes(entry.name)))
        : tools;
      return { tools: visible.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    }
    if (payload.method === 'tools/call') {
      const name = requiredString(payload.params, 'name');
      const entry = byName.get(name);
      if (!entry) throw Object.assign(workError('未知 MCP 工具', 404), { code: 'MCP_TOOL_NOT_FOUND' });
      if (scope && !toolAllowed(scope, name)) throw workError('该 MCP 令牌无权调用此工具', 403);
      if (scope?.readOnly && MCP_WRITE_TOOLS.includes(name)) throw workError('该 MCP 令牌是只读令牌，不能修改工作区', 403);
      let input = payload.params?.arguments;
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw workError('MCP 工具参数必须是对象');
      input = scopedInput(scope, name, input || {});
      if (scope?.projectId && ['work_send_command', 'work_create_plan'].includes(name)) {
        if (input.projectId && input.projectId !== scope.projectId) throw workError('该 MCP 令牌只能访问绑定的项目', 403);
        input = { ...input, projectId: scope.projectId };
      }
      return scopedResult(name, await entry.handler(input), scope);
    }
    throw Object.assign(workError('未知 MCP 方法', 404), { code: 'MCP_METHOD_NOT_FOUND' });
  }

  return { handle, tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
}

export function registerMcpRoutes(app, { engine, gateway, ownerId, windowBridge, actor = 'mcp', mcpTokens = null } = {}) {
  if (!engine || !gateway) throw new TypeError('MCP 路由需要 engine 与 gateway');
  const handler = createMcpHandler({ engine, windowBridge, actor });
  const authenticate = req => gateway.authenticateRequest(req, { ownerId });
  const scopedToken = req => {
    const value = String(req.get?.('authorization') || '').trim();
    return value.toLowerCase().startsWith('bearer lagent_mcp_') ? value.slice(7).trim() : '';
  };
  const ticketIdOf = result => {
    try {
      const value = JSON.parse(result?.content?.[0]?.text || 'null');
      return typeof value?.ticket?.id === 'string' ? value.ticket.id : null;
    } catch { return null; }
  };

  app.post('/api/mcp/token', (req, res) => {
    if (scopedToken(req)) return res.status(403).json({ error: '作用域令牌不能签发新的令牌' });
    const pair = gateway.createPair(ownerId);
    const device = gateway.claim(pair.code, typeof req.body?.name === 'string' ? req.body.name : 'MCP 客户端', `mcp-${ownerId}`);
    engine.auditExternal('mcp/token', 'mcp', 'created');
    res.status(201).json({ endpoint: '/api/mcp', token: device.deviceToken, deviceId: device.deviceId, expiresAt: device.expiresAt });
  });

  if (mcpTokens) {
    // 作用域令牌管理只接受界面会话；云端的会话校验在父级中间件完成。
    app.get('/api/mcp/tokens', (req, res) => {
      if (scopedToken(req)) return res.status(403).json({ error: '作用域令牌不能管理令牌' });
      res.json({ tokens: mcpTokens.list() });
    });
    app.post('/api/mcp/tokens', (req, res) => {
      if (scopedToken(req)) return res.status(403).json({ error: '作用域令牌不能管理令牌' });
      const knownTools = new Set(handler.tools.map(tool => tool.name));
      const issued = mcpTokens.issue(req.body, { knownTools });
      engine.auditExternal('mcp/token', 'mcp', 'scoped', issued.record.id.slice(0, 8));
      res.status(201).json({ endpoint: '/api/mcp', ...issued });
    });
    app.delete('/api/mcp/tokens/:id', (req, res) => {
      if (scopedToken(req)) return res.status(403).json({ error: '作用域令牌不能管理令牌' });
      res.json({ token: mcpTokens.revoke(req.params.id) });
    });
  }

  app.post('/api/mcp', async (req, res) => {
    let scope = null; let release = () => {}; let toolName = '';
    try {
      const token = scopedToken(req);
      if (token) {
        if (!mcpTokens) throw workError('该服务未启用作用域 MCP 令牌', 403);
        scope = mcpTokens.authenticate(token);
        release = mcpTokens.enter(scope);
      } else authenticate(req);
      const payload = req.body;
      const id = payload && typeof payload === 'object' && 'id' in payload ? payload.id : undefined;
      toolName = payload?.method === 'tools/call' ? payload?.params?.name : '';
      if (scope && toolName) mcpTokens.assertTool(scope, toolName, payload?.params?.arguments || {});
      if (id === undefined) {
        try { await handler.handle(payload, { scope }); res.status(202).end(); }
        catch { res.status(202).end(); }
        return;
      }
      try {
        const result = await handler.handle(payload, { scope });
        if (scope && toolName) mcpTokens.recordCall(scope, { ticketId: ticketIdOf(result) });
        res.json({ jsonrpc: '2.0', id, result });
      } catch (error) {
        if (scope && toolName) engine.auditExternal('mcp/call', 'mcp', 'denied', `${toolName}: ${String(error?.message || '').slice(0, 120)}`);
        const status = Number.isInteger(error?.status) ? error.status : 400;
        res.status(status === 401 ? 401 : 200).json({ jsonrpc: '2.0', id, error: { code: status, message: error?.message || 'MCP 请求失败' } });
      }
    } catch (error) {
      // 令牌鉴权、工具白名单与项目绑定都在这里被拒绝：同样写入脱敏审计。
      if (scope) engine.auditExternal('mcp/call', 'mcp', 'denied', `${toolName || 'request'}: ${String(error?.message || '').slice(0, 120)}`);
      const status = Number.isInteger(error?.status) ? error.status : 400;
      res.status(status).json({ error: error?.message || 'MCP 请求失败' });
    } finally { release(); }
  });
}
