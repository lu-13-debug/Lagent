import { workError } from './domain.js';

// 报告中心只读聚合：以 report 为主表，点查工单/会话/项目补齐归属。
// 不整表反序列化工单与会话，列表默认只取最近一页报告，再按需要批量补关联。
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const KIND_TEXT = {
  ready: '完成',
  completed: '完成',
  failed: '失败',
  blocked: '受阻',
  dropped: '已停止',
  cancelled: '已取消',
  skipped: '已跳过',
  progress: '进展'
};
const textOf = value => (typeof value === 'string' ? value.trim() : '');
const pageSize = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return DEFAULT_LIMIT;
  return Math.min(number, MAX_LIMIT);
};
const pageOffset = value => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};
const artifactList = artifacts => {
  if (!artifacts || typeof artifacts !== 'object') return [];
  return Object.entries(artifacts)
    .filter(([name]) => name !== 'taskId')
    .map(([name, value]) => ({
      name,
      kind: textOf(value?.kind) || name,
      ...(textOf(value?.summary) ? { summary: textOf(value.summary).slice(0, 800) } : {})
    }));
};

export function createReportCenter({ store }) {
  const reportOf = id => store.get('work-report', id);
  const ticketOf = id => (textOf(id) ? store.get('work-ticket', id) : null);
  const conversationOf = id => (textOf(id) ? store.get('work-conversation', id) : null);
  const projectOf = id => (textOf(id) ? store.get('work-project', id) : null);

  const projectIdOf = ticket => {
    const conversation = conversationOf(ticket?.conversationId);
    if (conversation?.projectId) return conversation.projectId;
    const chat = textOf(ticket?.projectChatId) ? store.get('work-project-chat', ticket.projectChatId) : null;
    return chat?.projectId || '';
  };

  const ticketView = ticket => ticket ? {
    id: ticket.id,
    title: ticket.title || '',
    status: ticket.status || '',
    executorId: ticket.executor || '',
    role: ticket.role || '',
    summary: textOf(ticket.summary),
    conversationId: ticket.conversationId || '',
    turnId: ticket.turnId || '',
    projectId: projectIdOf(ticket),
    createdAt: ticket.createdAt || '',
    updatedAt: ticket.updatedAt || ''
  } : null;

  const baseItem = (report, ticket) => {
    const projectId = ticket?.projectId || projectIdOf(ticket) || '';
    const project = projectOf(projectId);
    return {
      reportId: report.id,
      kind: report.kind || '',
      kindLabel: KIND_TEXT[report.kind] || report.kind || '报告',
      summary: textOf(report.summary),
      createdAt: report.createdAt || '',
      ticketId: report.ticketId || ticket?.id || '',
      ticketTitle: ticket?.title || '',
      ticketStatus: ticket?.status || '',
      conversationId: report.conversationId || ticket?.conversationId || '',
      turnId: report.turnId || ticket?.turnId || '',
      executorId: report.executorId || ticket?.executor || '',
      role: report.role || ticket?.role || '',
      projectId,
      projectName: project?.name || ''
    };
  };

  const matchesFilters = (item, ticket, filters) => {
    if (filters.projectId && item.projectId !== filters.projectId) return false;
    if (filters.conversationId && item.conversationId !== filters.conversationId) return false;
    if (filters.ticketId && item.ticketId !== filters.ticketId) return false;
    if (filters.executorId && item.executorId !== filters.executorId) return false;
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.q) {
      const query = filters.q.toLowerCase();
      const haystack = `${item.summary}\n${item.ticketTitle}\n${item.projectName}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  };

  function list(input = {}) {
    const group = input.group === 'ticket' || input.group === 'report' ? input.group : 'conversation';
    const filters = {
      projectId: textOf(input.projectId),
      conversationId: textOf(input.conversationId),
      ticketId: textOf(input.ticketId),
      executorId: textOf(input.executorId),
      kind: textOf(input.kind),
      q: textOf(input.q)
    };
    // 默认只列结论性报告；进展类需要显式筛选，避免把过程日志当成结论。
    const includeProgress = filters.kind === 'progress' || input.includeProgress === true || input.includeProgress === '1';
    const limit = pageSize(input.limit);
    const offset = pageOffset(input.cursor ?? input.offset);
    const raw = store.list('work-report');
    // 工单与会话按需批量补查，避免逐条 get 把 SQLite 调用放大到报告数量级。
    const ticketIds = [...new Set(raw.map(report => report.ticketId).filter(Boolean))];
    const tickets = new Map(store.listWhere('work-ticket', 'id', ticketIds).map(ticket => [ticket.id, ticket]));
    const items = [];
    for (const report of raw) {
      if (!includeProgress && report.kind === 'progress') continue;
      const ticket = tickets.get(report.ticketId) || null;
      const item = baseItem(report, ticket);
      if (!matchesFilters(item, ticket, filters)) continue;
      items.push(item);
    }
    if (group === 'report') {
      const page = items.slice(offset, offset + limit);
      return {
        group,
        total: items.length,
        cursor: offset + page.length < items.length ? String(offset + page.length) : null,
        items: page.map(item => ({ ...item, id: item.reportId, group: 'report', groupId: item.reportId }))
      };
    }
    const groups = new Map();
    // items 已经按报告从新到旧排列；第一次见到的报告就是该分组的最近结论。
    for (const item of items) {
      const groupId = group === 'conversation'
        ? (item.conversationId || `ticket:${item.ticketId}`)
        : item.ticketId;
      if (!groupId) continue;
      const existing = groups.get(groupId);
      if (existing) {
        existing.reportCount += 1;
        if (existing.reportIds.length < 20) existing.reportIds.push(item.reportId);
        continue;
      }
      groups.set(groupId, {
        ...item,
        id: groupId,
        group,
        groupId,
        title: group === 'conversation'
          ? (conversationOf(item.conversationId)?.title || item.ticketTitle || item.summary.slice(0, 60) || '未命名会话')
          : (item.ticketTitle || item.summary.slice(0, 60) || '未命名工单'),
        reportCount: 1,
        reportIds: [item.reportId]
      });
    }
    const grouped = [...groups.values()];
    const page = grouped.slice(offset, offset + limit);
    return {
      group,
      total: grouped.length,
      reportTotal: items.length,
      cursor: offset + page.length < grouped.length ? String(offset + page.length) : null,
      items: page
    };
  }

  function detail(id) {
    const report = reportOf(id);
    if (!report) throw workError('报告不存在', 404);
    const ticket = ticketOf(report.ticketId);
    const item = baseItem(report, ticket);
    const conversation = conversationOf(item.conversationId);
    const project = projectOf(item.projectId);
    return {
      report: {
        id: report.id,
        ticketId: report.ticketId,
        assignmentId: report.assignmentId || '',
        kind: report.kind || '',
        kindLabel: KIND_TEXT[report.kind] || report.kind || '报告',
        summary: textOf(report.summary),
        createdAt: report.createdAt || '',
        conversationId: item.conversationId,
        turnId: item.turnId,
        executorId: item.executorId,
        role: item.role
      },
      ticket: ticketView(ticket),
      conversation: conversation ? {
        id: conversation.id,
        title: conversation.title || '',
        goal: conversation.goal || '',
        projectId: conversation.projectId || '',
        participants: Array.isArray(conversation.participants) ? [...conversation.participants] : [],
        createdAt: conversation.createdAt || ''
      } : null,
      project: project ? { id: project.id, name: project.name || '' } : null,
      artifacts: artifactList(report.artifacts)
    };
  }

  // 导出 Markdown 只带结论和产物名称：executorInput、模型提示词等执行输入不能出现在分享文本里。
  function markdown(id) {
    const data = detail(id);
    const lines = [`# ${data.report.kindLabel}报告`, ''];
    lines.push(`- 时间：${data.report.createdAt || '未知'}`);
    if (data.report.executorId) lines.push(`- 执行者：${data.report.executorId}`);
    if (data.report.role) lines.push(`- 轮次角色：${data.report.role}`);
    if (data.project) lines.push(`- 项目：${data.project.name}`);
    if (data.ticket) lines.push(`- 源工单：${data.ticket.title || data.ticket.id}（${data.ticket.status || '未知'}）`);
    if (data.conversation) lines.push(`- 会话：${data.conversation.title || data.conversation.id}`);
    lines.push('', '## 结论', '', data.report.summary || '（没有结论正文）', '');
    if (data.artifacts.length) {
      lines.push('## 产物', '');
      for (const artifact of data.artifacts) {
        lines.push(`- ${artifact.name}${artifact.summary ? `：${artifact.summary}` : ''}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  return { list, detail, markdown };
}
