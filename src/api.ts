import type { ModelUsageReport, Bootstrap, PublicReport, ShareItem, Dataset, ExploreInput, Exploration, Mode, ModelCatalog, ReportMetadata, Runtime, Settings, Task, TaskSnapshot, TaskResponse, Transaction, User, Wallet } from './types';
import type { WorkAction, WorkBootstrap, WorkPlan, WorkPolicy, WorkProject, WorkProjectBrief, WorkProjectChange, WorkProjectChat, WorkProjectSession, WorkTaskAnalysis, WorkTeam, WorkTeamwork, WorkTicket, WorkTicketDetail } from './superagent';
import { uploadFiles } from './upload.ts';
import type { UploadOptions } from './upload';

const sessionExpiredListeners = new Set<() => void>();
let sessionBoundary = 0;
export function onSessionExpired(listener: () => void) { sessionExpiredListeners.add(listener); return () => { sessionExpiredListeners.delete(listener); }; }
export function resetSessionBoundary() { sessionBoundary++; }

async function request<T>(path: string, options: RequestInit = {}, authentication = false, format: 'json' | 'text' | 'blob' = 'json'): Promise<T> {
  const boundary = sessionBoundary;
  const headers = options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers };
  const timeout = AbortSignal.timeout(format === 'blob' ? 90000 : 30000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const connectionFailure = () => {
    if (!signal.aborted) return new Error('无法连接分析服务，请检查网络和服务地址后重试。');
    if (signal.reason?.name !== 'TimeoutError') return new Error('请求已停止，已有服务端任务不会因此取消。');
    return new Error(options.method && options.method !== 'GET' ? '请求超时，服务端可能已处理；请先查看任务状态，再决定是否重试。' : '请求超时，请检查网络和服务地址后重试。');
  };
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, signal, headers, credentials: 'same-origin' }); }
  catch { throw connectionFailure(); }
  if (!response.ok) {
    if (response.status === 401 && !authentication && boundary === sessionBoundary) sessionExpiredListeners.forEach(listener => listener());
    const body = await response.json().catch(() => null);
    throw Object.assign(new Error(body?.error || `请求失败（${response.status}），请重试。`), { code: typeof body?.code === 'string' ? body.code : undefined, status: response.status });
  }
  try { return await (format === 'text' ? response.text() : format === 'blob' ? response.blob() : response.json()) as T; }
  catch { if (signal.aborted) throw connectionFailure(); throw new Error('分析服务返回格式异常，请重新载入；若问题持续，请联系管理员。'); }
}
export const api = {
  workBootstrap: (signal?: AbortSignal) => request<WorkBootstrap>('/work/bootstrap', { signal }),
  workCommand: (text: string, clientRequestId?: string, datasetId?: string, executorId?: string, executorInput?: unknown) => request<{ ticket: WorkTicket }>('/work/command', { method: 'POST', body: JSON.stringify({ text, ...(clientRequestId ? { clientRequestId } : {}), ...(datasetId ? { datasetId } : {}), ...(executorId ? { executorId } : {}), ...(executorInput !== undefined ? { executorInput } : {}) }) }),
  workTicket: (id: string) => request<WorkTicketDetail>(`/work/tickets/${encodeURIComponent(id)}`),
  workProjects: () => request<{ projects: WorkProject[] }>('/work/projects'),
  workImportProject: (path: string, name?: string) => request<{ project: WorkProject; created: boolean }>('/work/projects', { method: 'POST', body: JSON.stringify({ path, ...(name ? { name } : {}) }) }),
  workProject: (id: string) => request<{ project: WorkProject }>(`/work/projects/${encodeURIComponent(id)}`),
  workDirectory: (path?: string) => request<{ path: string; parent: string | null; roots: string[]; entries: { name: string; path: string; isDir: boolean }[]; truncated: boolean }>(`/work/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  workProjectBrief: (id: string) => request<{ brief: WorkProjectBrief }>(`/work/projects/${encodeURIComponent(id)}/brief`),
  workSaveProjectBrief: (id: string, input: Partial<Omit<WorkProjectBrief, 'projectId' | 'updatedAt'>>) => request<{ brief: WorkProjectBrief }>(`/work/projects/${encodeURIComponent(id)}/brief`, { method: 'PUT', body: JSON.stringify(input) }),
  workProjectBriefMarkdown: (id: string) => request<{ project: WorkProject; brief: WorkProjectBrief; changes: WorkProjectChange[]; markdown: string }>(`/work/projects/${encodeURIComponent(id)}/brief.md`),
  workProjectChanges: (id: string) => request<{ changes: WorkProjectChange[] }>(`/work/projects/${encodeURIComponent(id)}/changes`),
  workRecordProjectChange: (id: string, input: { title?: string; summary?: string; files?: string[]; executorId?: string; ticketId?: string }) => request<{ change: WorkProjectChange }>(`/work/projects/${encodeURIComponent(id)}/changes`, { method: 'POST', body: JSON.stringify(input) }),
  workDeleteProjectChange: (projectId: string, changeId: string) => request<{ id: string }>(`/work/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}`, { method: 'DELETE' }),
  workDeleteProject: (id: string) => request<{ id: string }>(`/work/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workRenameProject: (id: string, name: string) => request<{ project: WorkProject }>(`/work/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  workProjectSessions: (id: string, executor?: string) => request<{ sessions: WorkProjectSession[] }>(`/work/projects/${encodeURIComponent(id)}/sessions${executor ? `?executor=${encodeURIComponent(executor)}` : ''}`),
  workImportProjectSession: (id: string, executorId: string, sessionId: string) => request<{ chat: WorkProjectChat; created: boolean }>(`/work/projects/${encodeURIComponent(id)}/sessions`, { method: 'POST', body: JSON.stringify({ executorId, sessionId }) }),
  workCreateProjectChat: (projectId: string, input: { executorId: string; title?: string; writable?: boolean; handle?: number; process?: string; windowTitle?: string }) => request<{ chat: WorkProjectChat; project: WorkProject }>(`/work/projects/${encodeURIComponent(projectId)}/chats`, { method: 'POST', body: JSON.stringify(input) }),
  workDeleteProjectChat: (id: string) => request<{ id: string }>(`/work/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workRenameProjectChat: (id: string, title: string) => request<{ chat: WorkProjectChat }>(`/work/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  workProjectChatMessage: (id: string, text: string, clientRequestId?: string) => request<{ ticket: WorkTicket }>(`/work/chats/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(clientRequestId ? { clientRequestId } : {}) }) }),
  workProjectChatTickets: (id: string) => request<{ tickets: WorkTicket[] }>(`/work/chats/${encodeURIComponent(id)}/tickets`),
  workProjectTeamworks: (projectId: string) => request<{ teamworks: WorkTeamwork[] }>(`/work/projects/${encodeURIComponent(projectId)}/teamworks`),
  workStartTeamwork: (projectId: string, goal: string, executorIds: string[]) => request<{ teamwork: WorkTeamwork; tickets: WorkTicket[] }>(`/work/projects/${encodeURIComponent(projectId)}/teamwork`, { method: 'POST', body: JSON.stringify({ goal, executorIds }) }),
  workAssembleTeamwork: (id: string) => request<{ ok: boolean; relativePath?: string; outputPath?: string; bytes?: number; problems: { part?: string; message: string }[]; teamwork: WorkTeamwork }>(`/work/teamworks/${encodeURIComponent(id)}/assemble`, { method: 'POST' }),
  workRetryTeamworkPart: (id: string, partId: string) => request<{ teamwork: WorkTeamwork; ticket: WorkTicket }>(`/work/teamworks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ partId }) }),
  workProjectDispatch: (projectId: string, text: string, executorIds: string[], window?: { handle: number; process?: string; title?: string }) => request<{ project: WorkProject; tickets: WorkTicket[] }>(`/work/projects/${encodeURIComponent(projectId)}/dispatch`, { method: 'POST', body: JSON.stringify({ text, executorIds, ...(window ? { window } : {}) }) }),
  workAction: (id: string, action: WorkAction, input?: Record<string, unknown>) => request<{ ticket: WorkTicket }>(`/work/tickets/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action, ...(input ? { input } : {}) }) }),
  workReviewTeam: (id: string, nodeId: string, decision: 'accept' | 'reject') => request<{ team: WorkTeam }>(`/work/tickets/${encodeURIComponent(id)}/team/${encodeURIComponent(nodeId)}/review`, { method: 'POST', body: JSON.stringify({ decision }) }),
  workDecideProposal: (id: string, nodeId: string, proposalId: string, decision: 'accept' | 'reject') => request<{ team: WorkTeam }>(`/work/tickets/${encodeURIComponent(id)}/team/${encodeURIComponent(nodeId)}/proposals/${encodeURIComponent(proposalId)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  workPolicy: () => request<{ policy: WorkPolicy }>('/work/policy'),
  workWindows: () => request<{ windows: { id: string; handle: number; pid: number; process: string; title: string }[] }>('/work/windows'),
  workProviders: (refresh = false) => request<{ providers: { id: string; name: string; kind?: string; command: string | null; installed: boolean; version: string | null; status: string; message: string; auth: { loggedIn: boolean | null; method: string | null; message: string } }[] }>(`/work/providers${refresh ? '?refresh=1' : ''}`),
  mcpToken: () => request<{ endpoint: string; token: string; deviceId: string; expiresAt: string }>('/mcp/token', { method: 'POST', body: '{}' }),  readWorkWindow: (id: string) => request<{ text: string }>(`/work/windows/${encodeURIComponent(id)}/text`),
  sendWorkWindow: (id: string, text: string, submit: boolean) => request<{ ok: boolean; process: string; submitted: boolean }>(`/work/windows/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ text, submit }) }),
  createWorkPlan: (goal: string, steps: { executorId: string; text: string; executorInput?: unknown; datasetId?: string; dependsOn?: number[] }[], clientRequestId?: string, autoRun = false, projectChatId?: string) => request<{ plan: WorkPlan }>('/work/plans', { method: 'POST', body: JSON.stringify({ goal, steps, autoRun, ...(clientRequestId ? { clientRequestId } : {}), ...(projectChatId ? { projectChatId } : {}) }) }),
  suggestWorkPlan: (goal: string, executors: string[], projectChatId?: string) => request<{ steps: { executorId: string; text: string; datasetId?: string; reason?: string; dependsOn?: number[]; executorInput?: { handle?: number; process?: string; title?: string } }[] }>('/work/plans/suggest', { method: 'POST', body: JSON.stringify({ goal, executors, ...(projectChatId ? { projectChatId } : {}) }) }),
  workPlan: (id: string) => request<{ plan: WorkPlan; tickets?: WorkTicket[] }>(`/work/plans/${encodeURIComponent(id)}`),
  workCommander: (goal: string, executors: string[], options?: { projectChatId?: string; projectId?: string; autoRun?: boolean }) => request<{ plan: WorkPlan; steps: { executorId: string; text: string; dependsOn?: number[] }[]; analysis?: WorkTaskAnalysis | null }>('/work/commander', { method: 'POST', body: JSON.stringify({ goal, executors, ...(options?.projectChatId ? { projectChatId: options.projectChatId } : {}), ...(!options?.projectChatId && options?.projectId ? { projectId: options.projectId } : {}), ...(options?.autoRun ? { autoRun: true } : {}) }) }),
  workAnalyze: (goal: string, executors: string[], options?: { projectId?: string }) => request<WorkTaskAnalysis>('/work/analyze', { method: 'POST', body: JSON.stringify({ goal, executors, ...(options?.projectId ? { projectId: options.projectId } : {}) }) }),  workCommanderReport: (id: string) => request<{ plan: { id: string; goal: string; status: string }; rows: { index: number; title: string; executorId: string; executorName: string; status: string; ticketId: string; summary: string }[]; completed: number; total: number; markdown: string }>(`/work/commander/${encodeURIComponent(id)}/report`),
  cancelWorkPlan: (id: string) => request<{ plan: WorkPlan }>(`/work/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  mobilePair: () => request<{ code: string; expiresAt: string }>('/mobile/pair', { method: 'POST', body: '{}' }),
  mobileDevices: () => request<{ devices: { id: string; name: string; createdAt: string; expiresAt: string }[] }>('/mobile/devices'),
  revokeMobileDevice: (id: string) => request<{ ok: boolean }>(`/mobile/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateWorkPolicy: (policy: WorkPolicy) => request<{ policy: WorkPolicy }>('/work/policy', { method: 'PUT', body: JSON.stringify(policy) }),
  modelUsage: (days: number | 'all') => request<ModelUsageReport>("/model-usage?days=" + days),
  reportPdf: (id: string) => request<Blob>(`/tasks/${encodeURIComponent(id)}/report.pdf`, {}, false, 'blob'),
  readShare: (token: string) => request<{ report: PublicReport }>('/public/shares/read', { method: 'POST', body: JSON.stringify({ token }), referrerPolicy: 'no-referrer', cache: 'no-store' }, true),
  visitShare: (token: string, visitorToken: string) => request<{ ok: boolean }>('/public/shares/visit', { method: 'POST', body: JSON.stringify({ token, visitorToken }), referrerPolicy: 'no-referrer', cache: 'no-store' }, true),
  shares: (id: string) => request<{shares: ShareItem[]}>(`/tasks/${encodeURIComponent(id)}/shares`, {}, true),
  createShare: (id: string, input: {expiresInDays: 1 | 7 | 30; hideRevenue: boolean}) => request<{share: ShareItem; token: string}>(`/tasks/${encodeURIComponent(id)}/shares`, {method:'POST', body:JSON.stringify(input)}, true),
  revokeShare: (id: string) => request<{ok:boolean}>(`/shares/${encodeURIComponent(id)}`, {method:'DELETE'}, true),
  runtime: () => request<Runtime>('/runtime', {}, true),
  session: () => request<{ user: User | null }>('/auth/session', {}, true),
  register: (input: { username: string; displayName: string; password: string; shareToken?: string; visitorToken?: string }) => request<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }, true),
  login: (input: { username: string; password: string }) => request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }, true),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }, true),
  changePassword: (input: { currentPassword: string; newPassword: string }) => request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify(input) }, true),
  bootstrap: (signal?: AbortSignal) => request<Bootstrap>('/bootstrap', { signal }),
  health: (signal?: AbortSignal) => request<{ ok: boolean }>('/health', { signal }),
  demo: () => request<{ dataset: Dataset }>('/datasets/demo', { method: 'POST', body: '{}' }),
  upload: (files: File[], options: UploadOptions = {}) => { const boundary = sessionBoundary; return uploadFiles(files, { ...options, onUnauthorized: () => { if (boundary === sessionBoundary) sessionExpiredListeners.forEach(listener => listener()); } }); },
  declareCompleteness: (id: string, input: { declared: 'full' | 'partial' | 'unknown'; shardNote?: string }) => request<{ dataset: Dataset }>(`/datasets/${encodeURIComponent(id)}/completeness`, { method: 'PUT', body: JSON.stringify(input) }),
  declareTimezone: (id: string, timezone: string) => request<{ dataset: Dataset; note: string }>(`/datasets/${encodeURIComponent(id)}/timezone`, { method: 'PUT', body: JSON.stringify({ timezone }) }),
  removeDataset: (id: string) => request<{ ok: boolean }>(`/datasets/${id}`, { method: 'DELETE' }),
  create: (input: { title: string; goal: string; mode: Mode; datasetId: string; domain: string; useAI: boolean; clientRequestId?: string; sourceTaskId?: string; inheritContext?: boolean }) => request<TaskResponse>('/tasks', { method: 'POST', body: JSON.stringify(input) }),
  reportMetadata: (id: string, input: Partial<Pick<ReportMetadata, 'favorite' | 'pinned' | 'tags'>>) => request<{ task: Task }>(`/tasks/${encodeURIComponent(id)}/metadata`, { method: 'PUT', body: JSON.stringify(input) }),
  explore: (id: string, input: ExploreInput, signal?: AbortSignal) => request<Exploration>(`/tasks/${encodeURIComponent(id)}/explore`, { method: 'POST', body: JSON.stringify(input), signal }),
  task: (id: string, signal?: AbortSignal) => request<TaskResponse>(`/tasks/${encodeURIComponent(id)}`, { signal }),
  taskSummaries: (signal?: AbortSignal) => request<TaskSnapshot>('/tasks/summary', { signal }),
  retry: (id: string, input: { strategy: 'restart' | 'resume'; useAI: boolean; mode?: Mode; skipSteps?: string[]; clientRequestId?: string }) => request<TaskResponse>(`/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify(input) }),
  skip: (id: string, stepId: string) => request<TaskResponse>(`/tasks/${encodeURIComponent(id)}/skip`, { method: 'POST', body: JSON.stringify({ stepId }) }),
  report: (id: string) => request<string>(`/tasks/${encodeURIComponent(id)}/report.md`, {}, false, 'text'),
  approve: (id: string, message?: string, stepId?: string, approvalSnapshot?: Task['approvalSnapshot']) => request<TaskResponse>(`/tasks/${id}/approve`, { method: 'POST', body: JSON.stringify({ message, stepId, approvalSnapshot }) }),
  message: (id: string, message: string) => request<{ task: Task }>(`/tasks/${id}/message`, { method: 'POST', body: JSON.stringify({ message }) }),
  cancel: (id: string) => request<TaskResponse>(`/tasks/${id}/cancel`, { method: 'POST', body: '{}' }),
  wallet: () => request<{ wallet: Wallet; walletVersion?: number; transactions: Transaction[] }>('/wallet'),
  settings: (input: Partial<Settings> & { apiKey?: string; clearKey?: boolean }) => request<{ settings: Settings }>('/settings', { method: 'PUT', body: JSON.stringify(input) }),
  testSettings: () => request<{ ok: boolean; message: string }>('/settings/test', { method: 'POST', body: '{}' }),
  models: (input: { baseUrl: string; apiKey?: string }, signal?: AbortSignal) => request<ModelCatalog>('/settings/models', { method: 'POST', body: JSON.stringify(input), signal }),
};
