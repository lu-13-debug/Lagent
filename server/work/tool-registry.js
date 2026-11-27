import { createHash } from 'node:crypto';

// 工具注册表：把「能派活的执行器、MCP 暴露的工具、已安装的技能、内置工具」
// 汇成一份统一清单。执行器注册表负责「怎么跑」，这里负责「有什么、能不能用」，
// 启停状态单独落库，不修改任何执行器本身。

const BUILTIN_TOOLS = Object.freeze([
  { id: 'builtin:terminal', name: '受控终端', source: 'builtin', risk: 'high', description: '在项目目录内执行白名单命令' },
  { id: 'builtin:window', name: '窗口 Agent', source: 'builtin', risk: 'high', description: '读取并操作本机窗口，发送文本与快捷键' },
  { id: 'builtin:browser', name: '网页读取', source: 'builtin', risk: 'low', description: '按 URL 抓取页面正文' },
  { id: 'builtin:github', name: '仓库检索', source: 'builtin', risk: 'medium', description: '读取 GitHub 仓库文件、提交与议题' }
]);

const SOURCES = ['builtin', 'executor', 'mcp', 'skill'];
export const TOOL_SOURCES = Object.freeze(SOURCES);
const RISKS = ['low', 'medium', 'high'];

const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const listOf = value => Array.isArray(value) ? value : [];
const riskOf = value => RISKS.includes(value) ? value : 'medium';
// 工具 id 含冒号且可能很长，Store 只接受 [A-Za-z0-9_-]{1,100}；用摘要做存储键，原 id 另存。
const stateId = id => createHash('sha1').update(id).digest('hex');

export function createToolRegistry({ store, listExecutors = () => [], listSkills = () => [], listMcpServers = () => [] } = {}) {
  if (!store?.list || !store?.put) throw new TypeError('工具注册表需要 Store');

  const states = () => new Map(listOf(store.list('tool-state')).map(row => [row.toolId || row.id, row]));

  function executorTools() {
    return listOf(listExecutors()).map(executor => ({
      id: `executor:${executor.id}`,
      name: executor.name || executor.id,
      source: 'executor',
      risk: executor.kind === 'terminal' || executor.kind === 'window' ? 'high' : 'medium',
      description: `执行器 · ${executor.kind || 'agent'}${executor.available === false ? '（当前不可用）' : ''}`,
      available: executor.available !== false,
      detail: { kind: executor.kind || '', capabilities: listOf(executor.capabilities) }
    }));
  }

  function mcpTools() {
    return listOf(listMcpServers()).flatMap(server => {
      const serverName = text(server.name || server.id, 80);
      return listOf(server.tools).map(tool => {
        const name = text(typeof tool === 'string' ? tool : tool?.name, 120);
        if (!serverName || !name) return null;
        return {
          id: `mcp:${serverName}:${name}`,
          name: `${serverName} · ${name}`,
          source: 'mcp',
          risk: 'medium',
          description: `MCP 工具 · ${serverName}${server.enabled === false ? '（服务器已停用）' : ''}`,
          available: server.enabled !== false,
          detail: { server: serverName }
        };
      }).filter(Boolean);
    });
  }

  function skillTools() {
    return listOf(listSkills()).map(skill => {
      const id = text(skill.id || skill.name, 120);
      if (!id) return null;
      return {
        id: `skill:${id}`,
        name: skill.name || id,
        source: 'skill',
        risk: 'medium',
        description: `技能 · ${text(skill.description, 160) || '按需加载的指令包'}`,
        available: skill.enabled !== false,
        detail: { enabled: skill.enabled !== false }
      };
    }).filter(Boolean);
  }

  function catalog() {
    const byId = new Map();
    for (const tool of [...BUILTIN_TOOLS, ...executorTools(), ...mcpTools(), ...skillTools()]) {
      if (!byId.has(tool.id)) byId.set(tool.id, tool);
    }
    return [...byId.values()];
  }

  function list({ source = '', enabled } = {}) {
    const overrides = states();
    return catalog()
      .filter(tool => !source || tool.source === source)
      .map(tool => {
        const state = overrides.get(tool.id);
        return {
          ...tool,
          enabled: state ? state.enabled !== false : true,
          risk: riskOf(state?.risk || tool.risk)
        };
      })
      .filter(tool => enabled === undefined ? true : tool.enabled === Boolean(enabled));
  }

  function summary() {
    const tools = list();
    return {
      total: tools.length,
      enabled: tools.filter(tool => tool.enabled).length,
      bySource: Object.fromEntries(TOOL_SOURCES.map(source => [source, tools.filter(tool => tool.source === source).length])),
      byRisk: Object.fromEntries(RISKS.map(risk => [risk, tools.filter(tool => tool.risk === risk).length]))
    };
  }

  function find(id) {
    const key = text(id, 200);
    const tool = list().find(item => item.id === key);
    if (!tool) {
      const error = new Error('工具不存在');
      error.status = 404;
      throw error;
    }
    return tool;
  }

  // 只允许改启停与风险级别；工具本身来自执行器/MCP/技能，不在这里复制实现。
  function setState(id, { enabled, risk } = {}) {
    const tool = find(id);
    const previous = states().get(tool.id);
    const next = {
      id: stateId(tool.id),
      toolId: tool.id,
      enabled: typeof enabled === 'boolean' ? enabled : tool.enabled,
      risk: risk === undefined ? (previous?.risk || tool.risk) : riskOf(risk),
      updatedAt: new Date().toISOString()
    };
    store.put('tool-state', next);
    return find(tool.id);
  }

  function removeState(id) {
    const tool = find(id);
    if (states().has(tool.id)) store.delete('tool-state', stateId(tool.id));
    return find(tool.id);
  }

  return { list, summary, find, setState, removeState, sources: TOOL_SOURCES };
}
