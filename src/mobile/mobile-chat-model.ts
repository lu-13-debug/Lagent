import type {
  MobileActivityStep, MobileChatSettings, MobileConversationSummary, MobileEfforts, MobileReport,
  MobileThinkingStep, MobileTicketState, MobileTurn
} from './types';

export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
const effortSet = new Set<string>(EFFORTS);
export const isEffort = (value: unknown): value is Effort => typeof value === 'string' && effortSet.has(value);

export type ThinkingGroup = {
  agentId: string;
  name: string;
  ticketId: string;
  status: string;
  steps: MobileThinkingStep[];
};

export function groupConversations<T extends { updatedAt: string }>(items: T[], now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const groups: { label: string; items: T[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] }
  ];
  for (const item of [...items].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))) {
    const stamp = Date.parse(item.updatedAt);
    const index = !Number.isFinite(stamp) || stamp < startOfYesterday ? 2 : stamp < startOfToday ? 1 : 0;
    groups[index].items.push(item);
  }
  return groups.filter(group => group.items.length > 0);
}

const stepKey = (step: MobileActivityStep) => `${step.at || ''}|${step.kind}|${step.text || ''}`;

export function mergeActivity(existing: MobileThinkingStep[], incoming: MobileThinkingStep[], limit = 200): MobileThinkingStep[] {
  const seen = new Set(existing.map(stepKey));
  const result = [...existing];
  for (const step of incoming) {
    if ((step.kind as string) === 'result') continue;
    const key = stepKey(step);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(step);
  }
  return result.slice(-limit);
}

export function sanitizeSettings(value: { profileId?: unknown; effort?: unknown; permission?: unknown; model?: unknown } | null | undefined): MobileChatSettings | null {
  if (!value || typeof value !== 'object') return null;
  const result: MobileChatSettings = {};
  if (typeof value.profileId === 'string' && /^[A-Za-z0-9._:-]{1,100}$/.test(value.profileId.trim())) result.profileId = value.profileId.trim();
  if (isEffort(value.effort)) result.effort = value.effort;
  return Object.keys(result).length ? result : null;
}

export function sanitizeEfforts(agentIds: string[], efforts: MobileEfforts | null | undefined): MobileEfforts | undefined {
  if (!efforts) return undefined;
  const allowed = new Set(agentIds);
  const result: MobileEfforts = {};
  for (const [key, value] of Object.entries(efforts)) if (allowed.has(key) && isEffort(value)) result[key] = value;
  return Object.keys(result).length ? result : undefined;
}

export function setEffort(efforts: MobileEfforts, agentId: string, effort: string): MobileEfforts {
  return { ...efforts, [agentId]: isEffort(effort) ? effort : 'default' };
}

export function removeEffort(efforts: MobileEfforts, agentId: string): MobileEfforts {
  const { [agentId]: _removed, ...rest } = efforts;
  return rest;
}

export function visibleTurns(turns: MobileTurn[], { limit = 30, before = null }: { limit?: number; before?: number | null } = {}) {
  const list = [...turns].sort((left, right) => left.index - right.index);
  const visible = before === null ? list.slice(-limit) : list.filter(turn => turn.index < before).slice(-limit);
  const hasMore = visible.length > 0 && list.some(turn => turn.index < visible[0].index);
  return { turns: visible, hasMore, nextBefore: hasMore ? visible[0].index : null };
}

export function lagentEfforts(profile?: { efforts?: string[] } | null): string[] {
  const supported = new Set((Array.isArray(profile?.efforts) ? profile.efforts : []).filter(isEffort));
  return ['default', ...EFFORTS.filter(effort => effort !== 'default' && supported.has(effort))];
}

export function collaboratorEfforts(): string[] {
  return [...EFFORTS];
}

export function conversationTitle(conversation: MobileConversationSummary): string {
  return conversation.title?.trim() || conversation.lastPrompt?.trim().slice(0, 60) || '新对话';
}

export function ticketIdsOfTurn(turn: MobileTurn): string[] {
  const ids = turn.runs.map(run => run.ticketId).filter(Boolean);
  if (turn.synthesisTicketId && !ids.includes(turn.synthesisTicketId)) ids.push(turn.synthesisTicketId);
  return ids;
}

// 思考块按 Agent 分组：详情里的 activity 与服务端实时步骤合并去重。
export function thinkingGroups(
  turn: MobileTurn,
  tickets: Record<string, MobileTicketState | undefined>,
  live: Record<string, MobileThinkingStep[]>,
  names: Record<string, string> = {}
): ThinkingGroup[] {
  return turn.runs.map(run => {
    const state = tickets[run.ticketId];
    const base = (state?.activity || []).map(step => ({ ...step, ticketId: run.ticketId }));
    const fresh = (live[run.ticketId] || []).map(step => ({ ...step, ticketId: run.ticketId }));
    return {
      agentId: run.agentId,
      name: names[run.agentId] || run.agentId,
      ticketId: run.ticketId,
      status: state?.ticket.status || 'queued',
      steps: mergeActivity(base, fresh)
    };
  });
}

// 助手结论：优先合成工单，其次最后一个 run；报告按写入倒序，最新一份在前。
export function assistantReport(turn: MobileTurn, tickets: Record<string, { reports: MobileReport[] } | undefined>): MobileReport | null {
  const ids = turn.synthesisTicketId
    ? [turn.synthesisTicketId, ...turn.runs.map(run => run.ticketId)]
    : [...turn.runs].reverse().map(run => run.ticketId);
  for (const id of ids) {
    const report = (tickets[id]?.reports || [])[0];
    if (report?.text || report?.summary) return report;
  }
  return null;
}
