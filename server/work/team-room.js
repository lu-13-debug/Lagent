import { randomUUID } from 'node:crypto';
import { workError } from './domain.js';

// 团队房间：把计划、工单、报告与团队事件聚合成一个可读的协作现场。
// 房间本身只保存标题、成员、消息、认领和决定；执行仍复用计划/工单，不另起一套调度。
const MAX_ROOMS = 50;
const MAX_MESSAGES = 500;
const MAX_DECISIONS = 200;
const ROOM_KIND = 'team-room';

const text = (value, label, max) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw workError(`${label}不能超过 ${max} 字`, 400);
  return result;
};

export function createTeamRoomService(db, { engine, now = () => new Date().toISOString(), projects = null } = {}) {
  if (!engine) throw new TypeError('团队房间需要引擎');
  const rows = () => db.list(ROOM_KIND).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const find = id => {
    if (typeof id !== 'string' || !id.trim()) throw workError('房间 id 无效', 400);
    const row = db.get(ROOM_KIND, id.trim());
    if (!row) throw workError('团队房间不存在', 404);
    return row;
  };

  function planOf(row) {
    if (!row.planId) return null;
    try { return engine.getPlan(row.planId); } catch { return null; }
  }

  function projectOf(row) {
    if (row.projectId) {
      try { return projects ? projects.getProject(row.projectId) : engine.getProject(row.projectId); } catch { return null; }
    }
    const plan = planOf(row);
    if (plan?.projectId) {
      try { return projects ? projects.getProject(plan.projectId) : engine.getProject(plan.projectId); } catch { return null; }
    }
    return null;
  }

  function syntheticMessages(row, plan) {
    const messages = [];
    if (!plan) return messages;
    for (const step of plan.steps || []) {
      if (!step.ticketId) continue;
      let detail;
      try { detail = engine.detail(step.ticketId); } catch { continue; }
      const ticket = detail?.ticket;
      if (!ticket) continue;
      messages.push({ id: `ticket-${ticket.id}`, kind: 'status', agent: step.executorId || ticket.executor || '', at: ticket.updatedAt || ticket.createdAt, text: `${step.index + 1}. ${ticket.title} · ${ticket.status}${ticket.summary ? `：${ticket.summary}` : ''}` });
      for (const report of (detail.reports || []).slice(-2)) {
        messages.push({ id: `report-${report.id}`, kind: 'report', agent: step.executorId || '', at: report.createdAt, text: String(report.summary || '').slice(0, 600) });
      }
      if (ticket.attention?.question) {
        messages.push({ id: `attention-${ticket.id}`, kind: 'attention', agent: step.executorId || '', at: ticket.updatedAt || ticket.createdAt, text: `需要确认：${ticket.attention.question}` });
      }
    }
    return messages;
  }

  function publicRoom(row) {
    const plan = planOf(row);
    const project = projectOf(row);
    const steps = (plan?.steps || []).map(step => {
      let ticket = null;
      try { ticket = step.ticketId ? engine.detail(step.ticketId)?.ticket : null; } catch { /* ignore */ }
      return {
        index: step.index,
        ticketId: step.ticketId,
        executorId: step.executorId,
        title: step.title,
        status: ticket?.status || step.status || 'missing',
        dependsOn: step.dependsOn || [],
        attention: ticket?.attention?.question || '',
        claimedBy: row.claims?.[step.ticketId] || ''
      };
    });
    const members = [...new Set([
      ...(Array.isArray(row.members) ? row.members : []),
      ...steps.map(step => step.executorId).filter(Boolean),
      ...(row.lead ? [row.lead] : [])
    ])];
    const messages = [...(Array.isArray(row.messages) ? row.messages : []), ...syntheticMessages(row, plan)]
      .sort((left, right) => String(left.at || '').localeCompare(String(right.at || '')))
      .slice(-MAX_MESSAGES);
    const decisions = [...(Array.isArray(row.decisions) ? row.decisions : [])].slice(-MAX_DECISIONS);
    const artifacts = [];
    if (plan) {
      for (const step of plan.steps || []) {
        if (!step.ticketId) continue;
        try {
          const detail = engine.detail(step.ticketId);
          for (const report of detail?.reports || []) {
            artifacts.push({ ticketId: step.ticketId, executorId: step.executorId, title: step.title, summary: String(report.summary || '').slice(0, 800), at: report.createdAt, files: Array.isArray(report.files) ? report.files.slice(0, 20) : [] });
          }
        } catch { /* ignore */ }
      }
    }
    const counts = steps.reduce((acc, step) => { acc[step.status] = (acc[step.status] || 0) + 1; return acc; }, {});
    return {
      id: row.id,
      projectId: row.projectId || plan?.projectId || null,
      projectName: project?.name || '',
      planId: row.planId || null,
      title: row.title,
      goal: row.goal || plan?.goal || '',
      lead: row.lead || steps[0]?.executorId || '',
      members,
      status: plan?.status === 'active' ? 'active' : plan?.status || row.status || 'open',
      steps,
      counts,
      messages,
      decisions,
      artifacts: artifacts.slice(-50),
      claims: { ...(row.claims || {}) },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  function create(input = {}) {
    if (rows().length >= MAX_ROOMS) throw workError(`最多创建 ${MAX_ROOMS} 个团队房间`, 429);
    const planId = text(input.planId, '计划 id', 100);
    let plan = null;
    if (planId) {
      try { plan = engine.getPlan(planId); } catch { throw workError('计划不存在', 404); }
    }
    const projectId = text(input.projectId, '项目 id', 100) || plan?.projectId || '';
    if (!projectId && !plan) throw workError('团队房间需要项目或计划', 400);
    if (projectId) {
      try { (projects || engine).getProject(projectId); } catch { throw workError('项目不存在', 404); }
    }
    const steps = plan?.steps || [];
    const members = [...new Set([
      ...(Array.isArray(input.members) ? input.members.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean).slice(0, 12) : []),
      ...steps.map(step => step.executorId).filter(Boolean)
    ])];
    const row = {
      id: randomUUID(),
      projectId: projectId || null,
      planId: planId || null,
      title: text(input.title, '房间标题', 100) || plan?.goal?.slice(0, 60) || '团队房间',
      goal: text(input.goal, '房间目标', 2000) || plan?.goal || '',
      lead: text(input.lead, '负责人', 40) || members[0] || '',
      members,
      status: 'open',
      messages: [],
      decisions: [],
      claims: {},
      createdAt: now(),
      updatedAt: now()
    };
    db.put(ROOM_KIND, row);
    return publicRoom(row);
  }

  function update(id, input = {}) {
    const row = find(id);
    const next = { ...row, updatedAt: now() };
    if (input.title !== undefined) next.title = text(input.title, '房间标题', 100);
    if (input.goal !== undefined) next.goal = text(input.goal, '房间目标', 2000);
    if (input.lead !== undefined) next.lead = text(input.lead, '负责人', 40);
    if (input.members !== undefined) next.members = Array.isArray(input.members) ? [...new Set(input.members.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 40)))].slice(0, 12) : [];
    db.put(ROOM_KIND, next);
    return publicRoom(next);
  }

  function postMessage(id, input = {}) {
    const row = find(id);
    const body = text(input.text, '消息内容', 3000);
    if (!body) throw workError('消息不能为空', 400);
    const message = {
      id: randomUUID(),
      kind: ['chat', 'note', 'system'].includes(input.kind) ? input.kind : 'chat',
      agent: text(input.agent, '发送者', 40) || 'user',
      at: now(),
      text: body
    };
    const next = { ...row, messages: [...(row.messages || []), message].slice(-MAX_MESSAGES), updatedAt: now() };
    db.put(ROOM_KIND, next);
    return { room: publicRoom(next), message };
  }

  function claim(id, input = {}) {
    const row = find(id);
    const plan = planOf(row);
    const member = text(input.member, '成员', 40);
    const ticketId = text(input.ticketId, '工单 id', 100);
    if (!member) throw workError('请指定认领成员', 400);
    if (!ticketId) throw workError('请指定要认领的工单', 400);
    if (!(plan?.steps || []).some(step => step.ticketId === ticketId)) throw workError('该工单不属于此房间的计划', 404);
    const next = { ...row, claims: { ...(row.claims || {}), [ticketId]: member }, updatedAt: now() };
    db.put(ROOM_KIND, next);
    return publicRoom(next);
  }

  function decide(id, input = {}) {
    const row = find(id);
    const decision = text(input.decision, '决定内容', 2000);
    if (!decision) throw workError('决定内容不能为空', 400);
    const record = {
      id: randomUUID(),
      by: text(input.by, '决定人', 40) || 'user',
      ticketId: text(input.ticketId, '工单 id', 100),
      decision,
      at: now()
    };
    const next = { ...row, decisions: [...(row.decisions || []), record].slice(-MAX_DECISIONS), updatedAt: now() };
    db.put(ROOM_KIND, next);
    return { room: publicRoom(next), decision: record };
  }

  function remove(id) {
    const row = find(id);
    db.delete(ROOM_KIND, row.id);
    return { ok: true, id: row.id };
  }

  return {
    list: projectId => rows().filter(row => !projectId || row.projectId === projectId).map(publicRoom),
    get: id => publicRoom(find(id)),
    create,
    update,
    postMessage,
    claim,
    decide,
    remove
  };
}
