import { randomUUID } from 'node:crypto';
import { CONVERSATION_ROLES, LAGENT_EXECUTOR_ID, normalizeManagedAgents } from '../application/conversation/model.js';
import { workError } from './domain.js';

// 会话（conversation）：用户看到的唯一对话容器。
// 对话只由 Lagent 创建；每个被选中的 Agent 在同一条会话里只是一次 run，
// 底层仍用 ticket 执行，ticket 通过 conversationId / turnId / agentId 挂回来。
// 这样复核、自动、计划、项目协作都只有一条会话，不再给每个 Agent 各开一个对话。

const KIND = 'conversation';
const MAX_CONVERSATIONS = 500;
const MAX_TURNS = 200;
const MAX_RUNS_PER_TURN = 8;
const MODES = new Set(['auto', 'review', 'plan', 'multi']);
const ROLES = new Set(CONVERSATION_ROLES);

const text = (value, label, max) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > max) throw workError(`${label}不能超过 ${max} 字`, 400);
  return result;
};

const identifier = (value, label) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) return '';
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(result)) throw workError(`${label}格式无效`, 400);
  return result;
};

// 所有参与者都以 Lagent 为主控：外部 Agent 只是协作方，不能被写成「替代主控」。
const agentIdsOf = value => normalizeManagedAgents(value);

const runsOf = value => {
  if (!Array.isArray(value)) return [];
  const runs = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const ticketId = identifier(item.ticketId, '工单 id');
    if (!ticketId) continue;
    const agentId = text(item.agentId, 'Agent', 60) || 'lagent';
    runs.push({
      ticketId,
      agentId,
      role: ROLES.has(item.role) ? item.role : 'answer'
    });
    if (runs.length >= MAX_RUNS_PER_TURN) break;
  }
  return runs;
};

const titleOf = (goal, turns) => {
  const source = String(goal || turns?.[0]?.prompt || '新对话').split('\n').find(line => line.trim()) || '新对话';
  return source.trim().slice(0, 60);
};

// 会话状态由里面的 run（ticket）聚合而来：有在跑的就是进行中，有等待确认的优先提示。
export function conversationStatus(statuses) {
  const list = statuses.filter(Boolean);
  if (!list.length) return 'waiting';
  if (list.some(status => status === 'working' || status === 'queued')) return 'working';
  if (list.some(status => status === 'awaiting_review')) return 'awaiting_review';
  if (list.some(status => status === 'waiting')) return 'waiting';
  if (list.every(status => status === 'completed')) return 'completed';
  if (list.some(status => status === 'failed' || status === 'blocked')) return 'failed';
  if (list.every(status => status === 'cancelled')) return 'cancelled';
  return 'completed';
}

export function createConversationService(db, { now = () => new Date().toISOString() } = {}) {
  const rows = () => db.list(KIND).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));

  const find = id => {
    const clean = identifier(id, '会话 id');
    if (!clean) throw workError('会话 id 无效', 400);
    const row = db.get(KIND, clean);
    if (!row) throw workError('会话不存在', 404);
    return row;
  };

  const turnIdsOf = row => Array.isArray(row.turns) ? row.turns : [];

  function ticketIdsOf(row) {
    const ids = [];
    for (const turn of turnIdsOf(row)) {
      for (const run of turn.runs || []) if (run.ticketId && !ids.includes(run.ticketId)) ids.push(run.ticketId);
      if (turn.synthesisTicketId && !ids.includes(turn.synthesisTicketId)) ids.push(turn.synthesisTicketId);
    }
    return ids;
  }

  function publicConversation(row) {
    return {
      id: row.id,
      title: row.title,
      goal: row.goal || '',
      host: row.host || 'lagent',
      projectId: row.projectId || null,
      participants: agentIdsOf(row.participants),
      turns: turnIdsOf(row).map(turn => ({
        id: turn.id,
        index: turn.index,
        prompt: turn.prompt,
        mode: turn.mode,
        agentIds: agentIdsOf(turn.agentIds),
        runs: Array.isArray(turn.runs) ? turn.runs : [],
        ...(turn.synthesisTicketId ? { synthesisTicketId: turn.synthesisTicketId } : {}),
        // 历史汇总可能记的是别的 Agent；投影时统一显示为主控，避免 UI 继续传播旧语义。
        ...(turn.synthesisTicketId ? { synthesisAgentId: LAGENT_EXECUTOR_ID } : {}),
        createdAt: turn.createdAt
      })),
      ticketIds: ticketIdsOf(row),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  function create(input = {}) {
    const requestedId = identifier(input.id, '会话 id');
    // 幂等优先：已有会话直接返回，不因为数量到上限而挡住重复上报。
    if (requestedId) {
      const existing = db.get(KIND, requestedId);
      if (existing) return publicConversation(existing);
    }
    if (rows().length >= MAX_CONVERSATIONS) throw workError(`最多保留 ${MAX_CONVERSATIONS} 个会话，请先删除不用的会话`, 429);
    const goal = text(input.goal, '会话目标', 4000);
    const agentIds = agentIdsOf(input.agentIds);
    const stamp = now();
    const row = {
      id: requestedId || randomUUID(),
      title: text(input.title, '会话标题', 200) || titleOf(goal, null),
      goal,
      host: 'lagent',
      ...(typeof input.projectId === 'string' && input.projectId.trim() ? { projectId: input.projectId.trim() } : {}),
      participants: agentIds,
      turns: [],
      createdAt: stamp,
      updatedAt: stamp
    };
    db.put(KIND, row);
    return publicConversation(row);
  }

  function addTurn(id, input = {}) {
    const row = find(id);
    const prompt = text(input.prompt, '消息', 4000);
    if (!prompt) throw workError('消息不能为空', 400);
    const runs = runsOf(input.runs);
    if (!runs.length) throw workError('这一轮至少要有一个 Agent 作答', 400);
    const turns = turnIdsOf(row);
    if (turns.length >= MAX_TURNS) throw workError(`单个会话最多 ${MAX_TURNS} 轮，请新建会话`, 429);
    const turn = {
      id: identifier(input.id, '轮次 id') || randomUUID(),
      index: turns.length,
      prompt,
      mode: MODES.has(input.mode) ? input.mode : 'auto',
      // 不论前端传什么，主控都要在轮次里：这样才能保证每一轮都有 Lagent 的分工与收口。
      agentIds: agentIdsOf([...(Array.isArray(input.agentIds) ? input.agentIds : []), ...runs.map(run => run.agentId)]),
      runs,
      createdAt: now()
    };
    const participants = agentIdsOf([...(Array.isArray(row.participants) ? row.participants : []), ...turn.agentIds]);
    const next = {
      ...row,
      title: row.title && row.title !== '新对话' ? row.title : titleOf(prompt, null),
      turns: [...turns, turn].slice(-MAX_TURNS),
      participants,
      updatedAt: now()
    };
    db.put(KIND, next);
    return { conversation: publicConversation(next), turn };
  }

  function setSynthesis(id, turnId, input = {}) {
    const row = find(id);
    const ticketId = identifier(input.ticketId, '工单 id');
    if (!ticketId) throw workError('缺少汇总工单', 400);
    // 汇总只能由 Lagent 做。旧前端可能传了别的 Agent，这里直接忽略，避免主控被替换。
    const agentId = LAGENT_EXECUTOR_ID;
    let changed = false;
    const turns = turnIdsOf(row).map(turn => {
      if (turn.id !== turnId) return turn;
      changed = true;
      return {
        ...turn,
        synthesisTicketId: ticketId,
        synthesisAgentId: agentId
      };
    });
    if (!changed) throw workError('轮次不存在', 404);
    const next = {
      ...row,
      turns,
      participants: agentIdsOf([...(row.participants || []), agentId]),
      updatedAt: now()
    };
    db.put(KIND, next);
    return publicConversation(next);
  }

  function rename(id, input = {}) {
    const row = find(id);
    const title = text(input.title, '会话标题', 200);
    if (!title) throw workError('会话标题不能为空', 400);
    const next = { ...row, title, updatedAt: now() };
    db.put(KIND, next);
    return publicConversation(next);
  }

  function remove(id) {
    const row = find(id);
    db.delete(KIND, row.id);
    return { id: row.id, ticketIds: ticketIdsOf(row) };
  }

  // 把已有工单归到会话里：工单只加字段，不改执行状态。
  function linkTicket(ticket, { conversationId, turnId, agentId, role } = {}) {
    if (!ticket || typeof ticket !== 'object') return ticket;
    const next = { ...ticket };
    const conv = identifier(conversationId, '会话 id');
    if (conv) next.conversationId = conv;
    const turn = identifier(turnId, '轮次 id');
    if (turn) next.turnId = turn;
    const agent = text(agentId, 'Agent', 60);
    if (agent) next.agentId = agent;
    if (ROLES.has(role)) next.role = role;
    return next;
  }

  return {
    create,
    addTurn,
    setSynthesis,
    rename,
    remove,
    linkTicket,
    get: id => publicConversation(find(id)),
    getRaw: id => find(id),
    list(limit = 60) {
      return rows().slice(0, Math.max(1, Math.min(MAX_CONVERSATIONS, Number(limit) || 60))).map(publicConversation);
    },
    ticketIdsOf,
    find
  };
}
