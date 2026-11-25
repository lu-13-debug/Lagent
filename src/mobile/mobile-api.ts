import type {
  MobileBootstrap, MobileChatSettings, MobileConversation, MobileConversationSummary, MobileDetail,
  MobileEfforts, MobileModelProfile, MobileTicket, MobileTurn
} from './types';

export class MobileApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function mobileRequest<T>(path: string, token: string, options: RequestInit = {}, timeoutMs = 30000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetch(`/api/mobile${path}`, {
    ...options,
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) },
    credentials: 'same-origin', cache: 'no-store'
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new MobileApiError(body?.error || `请求失败（${response.status}）`, response.status);
  return body as T;
}

export const mobileApi = {
  bootstrap: (token: string) => mobileRequest<MobileBootstrap>('/bootstrap', token),
  models: (token: string) => mobileRequest<{ profiles: MobileModelProfile[]; defaultProfileId: string | null }>('/models', token),
  conversations: (token: string, limit = 60) => mobileRequest<{ conversations: MobileConversationSummary[] }>(`/conversations?limit=${limit}`, token),
  conversation: (token: string, id: string, options: { limit?: number; before?: number | null } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 30) });
    if (options.before !== null && options.before !== undefined) query.set('before', String(options.before));
    return mobileRequest<{ conversation: MobileConversation; tickets: MobileTicket[] }>(`/conversations/${encodeURIComponent(id)}?${query}`, token);
  },
  createConversation: (token: string, input: { title?: string; goal?: string; projectId?: string; agentIds?: string[] }) =>
    mobileRequest<{ conversation: MobileConversationSummary }>('/conversations', token, { method: 'POST', body: JSON.stringify(input) }),
  renameConversation: (token: string, id: string, title: string) =>
    mobileRequest<{ conversation: MobileConversationSummary }>(`/conversations/${encodeURIComponent(id)}`, token, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteConversation: (token: string, id: string) =>
    mobileRequest<{ ok: boolean }>(`/conversations/${encodeURIComponent(id)}`, token, { method: 'DELETE' }),
  sendMessage: (token: string, id: string, input: {
    text: string; mode: 'auto' | 'multi'; agentIds?: string[];
    settings?: MobileChatSettings | null; efforts?: MobileEfforts; clientRequestId?: string;
  }) => mobileRequest<{ conversation: MobileConversationSummary; turn: MobileTurn; tickets: MobileTicket[] }>(
    `/conversations/${encodeURIComponent(id)}/messages`, token, { method: 'POST', body: JSON.stringify(input) }, 60000
  ),
  ticket: (token: string, id: string) => mobileRequest<MobileDetail>(`/tickets/${encodeURIComponent(id)}`, token),
  reportText: (token: string, id: string) => mobileRequest<{ text: string; truncated: boolean }>(`/reports/${encodeURIComponent(id)}/text`, token),
  permission: (token: string, ticketId: string, requestId: string, decision: 'allow' | 'deny') =>
    mobileRequest<{ ticket: MobileTicket }>(`/tickets/${encodeURIComponent(ticketId)}/permissions/${encodeURIComponent(requestId)}`, token, { method: 'POST', body: JSON.stringify({ decision }) }),
  command: (token: string, body: Record<string, unknown>) => mobileRequest<{ ticket: MobileTicket }>('/command', token, { method: 'POST', body: JSON.stringify(body) }),
  action: (token: string, ticketId: string, body: Record<string, unknown>) =>
    mobileRequest<{ ticket: MobileTicket }>(`/tickets/${encodeURIComponent(ticketId)}/actions`, token, { method: 'POST', body: JSON.stringify(body) })
};
