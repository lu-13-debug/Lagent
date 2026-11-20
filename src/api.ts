import type { ModelUsageReport, Bootstrap, PublicReport, ShareItem, Dataset, ExploreInput, Exploration, Mode, ModelCatalog, ReportMetadata, Runtime, Settings, Task, TaskSnapshot, TaskResponse, Transaction, User, Wallet } from './types';
import type { WorkAction, WorkAcceptance, WorkBootstrap, WorkConversation, WorkConversationSummary, WorkImChannel, WorkImConfig, WorkLibraryPreview, WorkLibrarySync, WorkLiveFrame, WorkLiveSession, WorkMcpServer, WorkMcpToken, WorkPlan, WorkPlanStep, WorkPlugins, WorkPolicy, WorkProfile, WorkProfilesActive, WorkProject, WorkProjectBrief, WorkProjectChange, WorkProjectChat, WorkProjectFileList, WorkProjectFilePreview, WorkProjectFileSearch, WorkProjectMemory, WorkProjectSession, WorkPromptOption, WorkReportDetail, WorkReportList, WorkReview, WorkRoomMessage, WorkRosterEntry, WorkRoutine, WorkRun, WorkSkill, WorkSkillCatalogEntry, WorkSkillPreview, WorkSkillScope, WorkTaskAnalysis, WorkTaskContract, WorkTeam, WorkTeamRoom, WorkTeamTemplate, WorkTicket, WorkTicketDetail, WorkTrace, WorkUsageReport, WorkVerifySpec } from './superagent';
import { uploadFiles } from './upload.ts';
import type { UploadOptions } from './upload';

const sessionExpiredListeners = new Set<() => void>();
let sessionBoundary = 0;
export function onSessionExpired(listener: () => void) { sessionExpiredListeners.add(listener); return () => { sessionExpiredListeners.delete(listener); }; }
export function resetSessionBoundary() { sessionBoundary++; }

export async function request<T>(path: string, options: RequestInit = {}, authentication = false, format: 'json' | 'text' | 'blob' = 'json', timeoutMs?: number): Promise<T> {
  const boundary = sessionBoundary;
  const headers = options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers };
  const timeout = AbortSignal.timeout(timeoutMs ?? (format === 'blob' ? 90000 : 30000));
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const connectionFailure = () => {
    if (!signal.aborted) return new Error('无法连接服务端，请检查网络和服务地址后重试。');
    if (signal.reason?.name !== 'TimeoutError') return new Error(options.method && options.method !== 'GET' ? '请求已停止，已有服务端任务不会因此取消。' : '请求已停止，请重试。');
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
  catch { if (signal.aborted) throw connectionFailure(); throw new Error('服务端返回格式异常，请重新载入；若问题持续，请联系管理员。'); }
}
export const api = {
  workBootstrap: (signal?: AbortSignal) => request<WorkBootstrap>('/work/bootstrap', { signal }),
  workCommand: (text: string, clientRequestId?: string, datasetId?: string, executorId?: string, executorInput?: unknown, extra?: { verify?: WorkVerifySpec; contract?: WorkTaskContract; settings?: { profileId?: string; model?: string; effort?: string; permission?: 'read' | 'workspace' | 'full' } }) => request<{ ticket: WorkTicket }>('/work/command', { method: 'POST', body: JSON.stringify({ text, ...(clientRequestId ? { clientRequestId } : {}), ...(datasetId ? { datasetId } : {}), ...(executorId ? { executorId } : {}), ...(executorInput !== undefined ? { executorInput } : {}), ...(extra?.verify ? { verify: extra.verify } : {}), ...(extra?.contract ? { contract: extra.contract } : {}), ...(extra?.settings ? { settings: extra.settings } : {}) }) }),
  workTicket: (id: string) => request<WorkTicketDetail>(`/work/tickets/${encodeURIComponent(id)}`),
  // 会话：对话只由 Lagent 创建，选中的 Agent 在会话内各是一条 run。
  workConversations: (limit = 60) => request<{ conversations: WorkConversationSummary[] }>(`/work/conversations?limit=${limit}`),
  workConversation: (id: string) => request<{ conversation: WorkConversation; tickets: WorkTicket[] }>(`/work/conversations/${encodeURIComponent(id)}`),
  workCreateConversation: (input: { title?: string; goal?: string; projectId?: string; agentIds?: string[] }) => request<{ conversation: WorkConversationSummary }>('/work/conversations', { method: 'POST', body: JSON.stringify(input) }),
  workRenameConversation: (id: string, title: string) => request<{ conversation: WorkConversationSummary }>(`/work/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  workDeleteConversation: (id: string) => request<{ id: string; ticketIds: string[] }>(`/work/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workConversationMessage: (id: string, input: { text: string; mode?: 'auto' | 'review' | 'plan'; agentIds?: string[]; settings?: { profileId?: string; model?: string; effort?: string; permission?: 'read' | 'workspace' | 'full' }; executorInputs?: Record<string, unknown>; datasetId?: string; clientRequestId?: string; autoRun?: boolean }) => request<{ conversation: WorkConversationSummary; turn: unknown; tickets?: WorkTicket[]; plan?: WorkPlan }>(`/work/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
  workConversationSynthesize: (id: string, turnId: string, agentId: string) => request<{ conversation: WorkConversationSummary; ticket: WorkTicket }>(`/work/conversations/${encodeURIComponent(id)}/turns/${encodeURIComponent(turnId)}/synthesize`, { method: 'POST', body: JSON.stringify({ agentId }) }),
  // 报告中心：列表按会话/工单聚合，详情与导出共用同一份结论提取。
  workReports: (options: { group?: 'conversation' | 'ticket' | 'report'; projectId?: string; conversationId?: string; ticketId?: string; executorId?: string; kind?: string; q?: string; limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    return request<WorkReportList>(`/work/reports${params.toString() ? `?${params.toString()}` : ''}`);
  },
  workReport: (id: string) => request<WorkReportDetail>(`/work/reports/${encodeURIComponent(id)}`),
  workReportMarkdown: (id: string) => request<string>(`/work/reports/${encodeURIComponent(id)}/markdown`, {}, false, 'text'),
  workMaterializeChat: (id: string) => request<{ chat: WorkProjectChat; conversation: WorkConversationSummary; created: boolean }>(`/work/chats/${encodeURIComponent(id)}/materialize`, { method: 'POST', body: '{}' }),
  workImportConversations: (groups: unknown[]) => request<{ imported: number; conversations: WorkConversationSummary[] }>('/work/conversations/import', { method: 'POST', body: JSON.stringify({ groups }) }),
  workTicketTrace: (id: string) => request<WorkTrace>(`/work/tickets/${encodeURIComponent(id)}/trace`),
  workVerifyTicket: (id: string) => request<{ ticket: WorkTicket; acceptance: WorkAcceptance; review?: WorkReview }>(`/work/tickets/${encodeURIComponent(id)}/verify`, { method: 'POST', body: '{}' }),
  workProjects: () => request<{ projects: WorkProject[] }>('/work/projects'),
  workImportProject: (path: string, name?: string) => request<{ project: WorkProject; created: boolean }>('/work/projects', { method: 'POST', body: JSON.stringify({ path, ...(name ? { name } : {}) }) }),
  workDirectory: (path?: string) => request<{ path: string; parent: string | null; roots: string[]; entries: { name: string; path: string; isDir: boolean }[]; truncated: boolean }>(`/work/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  workProjectBrief: (id: string) => request<{ brief: WorkProjectBrief }>(`/work/projects/${encodeURIComponent(id)}/brief`),
  workSaveProjectBrief: (id: string, input: Partial<Omit<WorkProjectBrief, 'projectId' | 'updatedAt'>>) => request<{ brief: WorkProjectBrief }>(`/work/projects/${encodeURIComponent(id)}/brief`, { method: 'PUT', body: JSON.stringify(input) }),
  workProjectBriefMarkdown: (id: string) => request<{ project: WorkProject; brief: WorkProjectBrief; changes: WorkProjectChange[]; markdown: string }>(`/work/projects/${encodeURIComponent(id)}/brief.md`),
  workProjectChanges: (id: string) => request<{ changes: WorkProjectChange[] }>(`/work/projects/${encodeURIComponent(id)}/changes`),
  workRecordProjectChange: (id: string, input: { title?: string; summary?: string; files?: string[]; executorId?: string; ticketId?: string }) => request<{ change: WorkProjectChange }>(`/work/projects/${encodeURIComponent(id)}/changes`, { method: 'POST', body: JSON.stringify(input) }),
  workDeleteProjectChange: (projectId: string, changeId: string) => request<{ id: string }>(`/work/projects/${encodeURIComponent(projectId)}/changes/${encodeURIComponent(changeId)}`, { method: 'DELETE' }),
  workProjectMemory: (id: string, options?: { query?: string; scope?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.query) params.set('query', options.query);
    if (options?.scope) params.set('scope', options.scope);
    if (options?.limit) params.set('limit', String(options.limit));
    return request<WorkProjectMemory>(`/work/projects/${encodeURIComponent(id)}/memory${params.toString() ? `?${params.toString()}` : ''}`);
  },
  workDeleteProjectMemory: (projectId: string, memoryId: string) => request<{ ok: boolean }>(`/work/projects/${encodeURIComponent(projectId)}/memory/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  workDeleteProject: (id: string) => request<{ id: string }>(`/work/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workRenameProject: (id: string, name: string) => request<{ project: WorkProject }>(`/work/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  workProjectSessions: (id: string, executor?: string) => request<{ sessions: WorkProjectSession[] }>(`/work/projects/${encodeURIComponent(id)}/sessions${executor ? `?executor=${encodeURIComponent(executor)}` : ''}`),
  // 项目文件：列表/搜索用相对路径，预览只返回内容；PDF、图片、HTML 直接加载原始文件接口。
  workProjectFiles: (id: string, path = '') => request<WorkProjectFileList>(`/work/projects/${encodeURIComponent(id)}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  workProjectFileSearch: (id: string, query: string) => request<WorkProjectFileSearch>(`/work/projects/${encodeURIComponent(id)}/files/search?q=${encodeURIComponent(query)}`),
  workProjectFilePreview: (id: string, path: string) => request<WorkProjectFilePreview>(`/work/projects/${encodeURIComponent(id)}/file/preview?path=${encodeURIComponent(path)}`),
  workProjectFileUrl: (id: string, path: string, download = false) => `/api/work/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`,
  workImportProjectSession: (id: string, executorId: string, sessionId: string) => request<{ chat: WorkProjectChat; created: boolean }>(`/work/projects/${encodeURIComponent(id)}/sessions`, { method: 'POST', body: JSON.stringify({ executorId, sessionId }) }),
  workCreateProjectChat: (projectId: string, input: { executorId: string; title?: string; writable?: boolean; handle?: number; process?: string; windowTitle?: string; collaborators?: string[] }) => request<{ chat: WorkProjectChat; project: WorkProject }>(`/work/projects/${encodeURIComponent(projectId)}/chats`, { method: 'POST', body: JSON.stringify(input) }),
  workDeleteProjectChat: (id: string) => request<{ id: string }>(`/work/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workRenameProjectChat: (id: string, title: string) => request<{ chat: WorkProjectChat }>(`/work/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  // 每条会话自己的权限档位；传空字符串表示回到「跟随设置」。
  workChatPermission: (id: string, permission: '' | 'read' | 'workspace' | 'full') => request<{ chat: WorkProjectChat }>(`/work/chats/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ permission }) }),
  workProjectChatMessage: (id: string, text: string, clientRequestId?: string, options?: { profileId?: string; model?: string; effort?: string; executorId?: string; executorIds?: string[] }) => request<{ ticket: WorkTicket; tickets?: WorkTicket[]; conversationId?: string }>(`/work/chats/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ text, ...(clientRequestId ? { clientRequestId } : {}), ...(options?.executorIds?.length ? { executorIds: options.executorIds } : options?.executorId ? { executorId: options.executorId } : {}), ...(options?.profileId ? { profileId: options.profileId } : {}), ...(options?.model ? { model: options.model } : {}), ...(options?.effort ? { effort: options.effort } : {}) }) }),
  workAction: (id: string, action: WorkAction, input?: Record<string, unknown>) => request<{ ticket: WorkTicket }>(`/work/tickets/${encodeURIComponent(id)}/actions`, { method: 'POST', body: JSON.stringify({ action, ...(input ? { input } : {}) }) }),
  workPermissionDecision: (id: string, requestId: string, decision: 'allow' | 'deny') => request<{ ticket: WorkTicket }>(`/work/tickets/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  workDeleteTicket: (id: string) => request<{ id: string; removed: number; ids: string[]; planRemoved: boolean }>(`/work/tickets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 编排器：一次运行 = 分析 → 拆解 → 批准 → 分发 → 验证（可返工）→ 汇总
  workRuns: (limit = 20, includePlans = false) => request<{ runs: WorkRun[] }>(`/work/runs?limit=${limit}${includePlans ? '&include=plans' : ''}`),
  workResumeRun: (id: string) => request<{ run: WorkRun }>(`/work/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' }),
  workRun: (id: string) => request<{ run: WorkRun }>(`/work/runs/${encodeURIComponent(id)}`),
  workUsage: (options?: { projectId?: string; executorId?: string; from?: string; to?: string; days?: number | 'all'; includeHistory?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.executorId) params.set('executorId', options.executorId);
    if (options?.from) params.set('from', options.from);
    if (options?.to) params.set('to', options.to);
    if (options?.includeHistory) params.set('includeHistory', '1');
    params.set('days', String(options?.days ?? 30));
    return request<WorkUsageReport>(`/work/usage?${params.toString()}`);
  },
  workUsageCsv: (options?: { projectId?: string; executorId?: string; from?: string; to?: string; includeHistory?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.projectId) params.set('projectId', options.projectId);
    if (options?.executorId) params.set('executorId', options.executorId);
    if (options?.from) params.set('from', options.from);
    if (options?.to) params.set('to', options.to);
    if (options?.includeHistory) params.set('includeHistory', '1');
    return request<Blob>(`/work/usage.csv?${params.toString()}`, {}, false, 'blob');
  },
  workSaveProfile: (input: { name: string; description?: string; settings?: unknown; policy?: WorkPolicy; library?: unknown }) => request<{ profile: WorkProfile }>('/work/profiles', { method: 'POST', body: JSON.stringify(input) }),
  workDeleteProfile: (id: string) => request<{ id: string }>(`/work/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workApplyProfile: (id: string, projectId?: string) => request<{ profile: WorkProfile; scope: string; projectId: string | null; policy: WorkPolicy; active: WorkProfilesActive }>(`/work/profiles/${encodeURIComponent(id)}/apply`, { method: 'POST', body: JSON.stringify(projectId ? { projectId } : {}) }),
  workResetProfile: (projectId?: string) => request<{ scope: string; projectId: string | null; policy: WorkPolicy; active: WorkProfilesActive }>('/work/profiles/reset', { method: 'POST', body: JSON.stringify(projectId ? { projectId } : {}) }),
  workBackupExport: (passphrase: string, includeCredentials = true) => request<Blob>('/work/backup/export', { method: 'POST', body: JSON.stringify({ passphrase, includeCredentials }) }, false, 'blob'),
  // 口令经 URL 编码后放进请求头，允许中文/空格等非 ASCII 字符。
  workBackupRestore: (file: Blob, passphrase: string) => request<{ ok: boolean; restoredAt: string }>('/work/backup/restore', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'x-backup-passphrase': encodeURIComponent(passphrase) } }, false),
  workBackupStatus: () => request<{ backups: Array<{ kind: string; result: string; bytes?: number; at: string }> }>('/work/backup/status'),
  workDiagnostics: () => request<{ diagnostics: Record<string, unknown> }>('/work/diagnostics'),
  workMcpTokens: () => request<{ tokens: WorkMcpToken[] }>('/mcp/tokens'),
  // Library 同步：预览 → 应用（自动备份）→ 回滚。
  workLibraryPreview: (projectId: string, options?: { targets?: string[]; mcpUrl?: string }) => {
    const params = new URLSearchParams();
    if (options?.targets?.length) params.set('targets', options.targets.join(','));
    if (options?.mcpUrl) params.set('mcpUrl', options.mcpUrl);
    return request<WorkLibraryPreview>(`/work/projects/${encodeURIComponent(projectId)}/library/preview${params.toString() ? `?${params.toString()}` : ''}`);
  },
  workLibraryApply: (projectId: string, options?: { targets?: string[]; mcpUrl?: string; mcpToken?: string }) => request<{ sync: WorkLibrarySync }>(`/work/projects/${encodeURIComponent(projectId)}/library/apply`, { method: 'POST', body: JSON.stringify(options || {}) }),
  workLibrarySyncs: (projectId: string) => request<{ syncs: WorkLibrarySync[] }>(`/work/projects/${encodeURIComponent(projectId)}/library/syncs`),
  workLibraryRollback: (projectId: string, syncId: string) => request<{ sync: WorkLibrarySync; restored: string[] }>(`/work/projects/${encodeURIComponent(projectId)}/library/rollback`, { method: 'POST', body: JSON.stringify({ syncId }) }),
  // 技能与插件中心。
  workSkills: () => request<{ skills: WorkSkill[]; catalog: WorkSkillCatalogEntry[] }>('/work/skills'),
  // 预览要克隆 GitHub 仓库，30 秒容易超时；安装/更新同理。
  workSkillPreview: (input: { catalogId?: string; source?: unknown; url?: string; repo?: string; path?: string; ref?: string }) => request<WorkSkillPreview>('/work/skills/preview', { method: 'POST', body: JSON.stringify(input) }, false, 'json', 180000),
  workSkillInstall: (input: { token: string; name?: string; scope: WorkSkillScope; projectId?: string; commit?: string; digest?: string; confirmed?: boolean; onConflict?: 'overwrite' | 'rename' }) => request<{ skill: WorkSkill; backup: string }>('/work/skills/install', { method: 'POST', body: JSON.stringify(input) }, false, 'json', 120000),
  workSkillUpdate: (id: string) => request<{ skill: WorkSkill; backup: string }>(`/work/skills/${encodeURIComponent(id)}/update`, { method: 'POST', body: '{}' }, false, 'json', 180000),
  workSkillEnable: (id: string) => request<{ skill: WorkSkill }>(`/work/skills/${encodeURIComponent(id)}/enable`, { method: 'POST', body: '{}' }),
  workSkillDisable: (id: string) => request<{ skill: WorkSkill }>(`/work/skills/${encodeURIComponent(id)}/disable`, { method: 'POST', body: '{}' }),
  workSkillRemove: (id: string) => request<{ id: string; removed: boolean; backup: string }>(`/work/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workPlugins: (refresh = false) => request<WorkPlugins>(`/work/plugins${refresh ? '?refresh=1' : ''}`),
  workPluginDetails: (name: string) => request<{ name: string; text: string }>('/work/plugins/preview', { method: 'POST', body: JSON.stringify({ name }) }),
  workPluginAddMarketplace: (source: string, scope: 'user' | 'project' | 'local' = 'user') => request<{ marketplace: unknown; raw: string }>('/work/plugins/marketplaces', { method: 'POST', body: JSON.stringify({ source, scope }) }),
  workPluginRemoveMarketplace: (name: string) => request<{ ok: boolean; name: string }>(`/work/plugins/marketplaces/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  workPluginInstall: (name: string, options?: { marketplace?: string; scope?: 'user' | 'project' | 'local'; acceptCommand?: string }) => request<{ plugin: unknown; raw: string }>('/work/plugins/install', { method: 'POST', body: JSON.stringify({ name, ...(options?.marketplace ? { marketplace: options.marketplace } : {}), ...(options?.scope ? { scope: options.scope } : {}), ...(options?.acceptCommand ? { acceptCommand: options.acceptCommand } : {}) }) }, false, 'json', 180000),
  workPluginEnable: (name: string, scope?: 'user' | 'project' | 'local') => request<{ plugin: unknown }>(`/work/plugins/${encodeURIComponent(name)}/enable`, { method: 'POST', body: JSON.stringify({ ...(scope ? { scope } : {}) }) }),
  workPluginDisable: (name: string, scope?: 'user' | 'project' | 'local') => request<{ plugin: unknown }>(`/work/plugins/${encodeURIComponent(name)}/disable`, { method: 'POST', body: JSON.stringify({ ...(scope ? { scope } : {}) }) }),
  workPluginUpdate: (name: string) => request<{ plugin: unknown }>(`/work/plugins/${encodeURIComponent(name)}/update`, { method: 'POST', body: '{}' }),
  workPluginUninstall: (name: string) => request<{ ok: boolean; plugin: unknown }>(`/work/plugins/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  // 例行任务：默认只生成待批准工单。
  workRoutines: () => request<{ routines: WorkRoutine[]; kinds: string[] }>('/work/routines'),
  workSaveRoutine: (input: Partial<WorkRoutine> & { projectId: string; executorId: string; name: string; kind: string }) => request<{ routine: WorkRoutine; webhookToken?: string }>('/work/routines', { method: 'POST', body: JSON.stringify(input) }),
  workUpdateRoutine: (id: string, input: Partial<WorkRoutine> & { rotateWebhook?: boolean }) => request<{ routine: WorkRoutine; webhookToken?: string }>(`/work/routines/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  workDeleteRoutine: (id: string) => request<{ ok: boolean; id: string }>(`/work/routines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workRunRoutine: (id: string) => request<{ text: string; tickets: WorkTicket[]; autoApproved?: boolean }>(`/work/routines/${encodeURIComponent(id)}/run`, { method: 'POST', body: '{}' }),
  workTeamRooms: (projectId: string) => request<{ rooms: WorkTeamRoom[] }>(`/work/projects/${encodeURIComponent(projectId)}/rooms`),
  workCreateTeamRoom: (projectId: string, input: { planId?: string; title?: string; goal?: string; members?: string[]; lead?: string }) => request<{ room: WorkTeamRoom }>(`/work/projects/${encodeURIComponent(projectId)}/rooms`, { method: 'POST', body: JSON.stringify(input) }),
  workTeamRoom: (id: string) => request<{ room: WorkTeamRoom }>(`/work/rooms/${encodeURIComponent(id)}`),
  workDeleteTeamRoom: (id: string) => request<{ ok: boolean; id: string }>(`/work/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workPostTeamRoomMessage: (id: string, input: { text: string; agent?: string; kind?: string }) => request<{ room: WorkTeamRoom; message: WorkRoomMessage }>(`/work/rooms/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify(input) }),
  workClaimTeamRoomTicket: (id: string, input: { ticketId: string; member: string }) => request<{ room: WorkTeamRoom }>(`/work/rooms/${encodeURIComponent(id)}/claims`, { method: 'POST', body: JSON.stringify(input) }),
  workMcpServers: () => request<{ servers: WorkMcpServer[]; projectConfig: boolean }>('/work/mcp/servers'),
  addWorkMcpServer: (input: { name: string; command: string; args?: string[]; env?: Record<string, string>; tools?: string[]; enabled?: boolean }) => request<{ server: WorkMcpServer }>('/work/mcp/servers', { method: 'POST', body: JSON.stringify(input) }),
  removeWorkMcpServer: (id: string) => request<{ ok: boolean; id: string }>(`/work/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testWorkMcpServer: (input: { name: string; command: string; args?: string[]; env?: Record<string, string> }) => request<{ ok: boolean; tools?: number; schemas?: string[]; servers?: { id: string; ok: boolean; error?: string; tools?: number }[]; message?: string; error?: string }>('/work/mcp/test', { method: 'POST', body: JSON.stringify(input) }),
  workImConfig: () => request<WorkImConfig>('/work/im/config'),
  saveWorkImChannel: (input: { id?: string; name: string; kind: WorkImChannel['kind']; webhookUrl?: string; events?: string[]; enabled?: boolean; baseUrl?: string }) => request<{ channel: WorkImChannel }>(input.id ? `/work/im/channels/${encodeURIComponent(input.id)}` : '/work/im/channels', { method: input.id ? 'PATCH' : 'POST', body: JSON.stringify(input) }),
  deleteWorkImChannel: (id: string) => request<{ ok: boolean; id: string }>(`/work/im/channels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testWorkImChannel: (id: string) => request<{ ok: boolean; status: number }>(`/work/im/channels/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' }),
  startWorkLive: (input: { handle: number; process?: string; title?: string; ticketId?: string }) => request<{ session: WorkLiveSession }>('/work/live', { method: 'POST', body: JSON.stringify(input) }),
  workLiveSession: (id: string) => request<{ session: WorkLiveSession }>(`/work/live/${encodeURIComponent(id)}`),
  workLiveFrame: (id: string) => request<{ frame: WorkLiveFrame }>(`/work/live/${encodeURIComponent(id)}/frame`),
  pauseWorkLive: (id: string, reason?: string) => request<{ session: WorkLiveSession }>(`/work/live/${encodeURIComponent(id)}/pause`, { method: 'POST', body: JSON.stringify({ reason }) }),
  resumeWorkLive: (id: string) => request<{ session: WorkLiveSession }>(`/work/live/${encodeURIComponent(id)}/resume`, { method: 'POST', body: '{}' }),
  takeoverWorkLive: (id: string) => request<{ session: WorkLiveSession }>(`/work/live/${encodeURIComponent(id)}/takeover`, { method: 'POST', body: '{}' }),
  stopWorkLive: (id: string) => request<{ ok: boolean; id: string }>(`/work/live/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' }),
  workCreateMcpToken: (input: { name: string; projectId?: string; readOnly?: boolean; tools?: string[]; budgetTokens?: number; maxCalls?: number; maxConcurrency?: number; ttlDays?: number }) => request<{ endpoint: string; token: string; record: WorkMcpToken }>('/mcp/tokens', { method: 'POST', body: JSON.stringify(input) }),
  workRevokeMcpToken: (id: string) => request<{ token: WorkMcpToken }>(`/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workReviewTeam: (id: string, nodeId: string, decision: 'accept' | 'reject') => request<{ team: WorkTeam }>(`/work/tickets/${encodeURIComponent(id)}/team/${encodeURIComponent(nodeId)}/review`, { method: 'POST', body: JSON.stringify({ decision }) }),
  workDecideProposal: (id: string, nodeId: string, proposalId: string, decision: 'accept' | 'reject') => request<{ team: WorkTeam }>(`/work/tickets/${encodeURIComponent(id)}/team/${encodeURIComponent(nodeId)}/proposals/${encodeURIComponent(proposalId)}`, { method: 'POST', body: JSON.stringify({ decision }) }),
  workAgentRoster: () => request<{ agents: WorkRosterEntry[] }>('/work/agents/roster'),
  workTeamTemplates: (projectId?: string) => request<{ templates: WorkTeamTemplate[] }>(`/work/team-templates${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  workSaveTeamTemplate: (input: Omit<Partial<WorkTeamTemplate>, 'createdAt' | 'updatedAt'> & { name: string; roles: WorkTeamTemplate['roles'] }) => request<{ template: WorkTeamTemplate }>('/work/team-templates', { method: 'POST', body: JSON.stringify(input) }),
  workDeleteTeamTemplate: (id: string) => request<{ id: string }>(`/work/team-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  workPolicy: () => request<{ policy: WorkPolicy }>('/work/policy'),
  workWindows: () => request<{ windows: { id: string; handle: number; pid: number; process: string; title: string }[] }>('/work/windows'),
  workProviders: (refresh = false) => request<{ providers: { id: string; name: string; kind?: string; command: string | null; installed: boolean; version: string | null; status: string; message: string; auth: { loggedIn: boolean | null; method: string | null; message: string } }[] }>(`/work/providers${refresh ? '?refresh=1' : ''}`),
  mcpToken: () => request<{ endpoint: string; token: string; deviceId: string; expiresAt: string }>('/mcp/token', { method: 'POST', body: '{}' }),  readWorkWindow: (id: string) => request<{ text: string }>(`/work/windows/${encodeURIComponent(id)}/text`),
  sendWorkWindow: (id: string, text: string, submit: boolean) => request<{ ok: boolean; process: string; submitted: boolean }>(`/work/windows/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ text, submit }) }),
  createWorkPlan: (goal: string, steps: { executorId: string; text: string; executorInput?: unknown; datasetId?: string; dependsOn?: number[] }[], clientRequestId?: string, autoRun = false, projectChatId?: string) => request<{ plan: WorkPlan }>('/work/plans', { method: 'POST', body: JSON.stringify({ goal, steps, autoRun, ...(clientRequestId ? { clientRequestId } : {}), ...(projectChatId ? { projectChatId } : {}) }) }),
  suggestWorkPlan: (goal: string, executors: string[], projectChatId?: string) => request<{ steps: { executorId: string; text: string; datasetId?: string; reason?: string; dependsOn?: number[]; executorInput?: { handle?: number; process?: string; title?: string }; verify?: WorkVerifySpec; contract?: WorkTaskContract }[] }>('/work/plans/suggest', { method: 'POST', body: JSON.stringify({ goal, executors, ...(projectChatId ? { projectChatId } : {}) }) }),
  workPlan: (id: string) => request<{ plan: WorkPlan; tickets?: WorkTicket[] }>(`/work/plans/${encodeURIComponent(id)}`),
  workPlanSheet: (id: string) => request<{ plan: WorkPlan; rows: { index: number; title: string; executorId: string; executorName: string; status: string; ticketId: string; summary: string; verify?: WorkVerifySpec | null; acceptance?: WorkAcceptance | null; files: string[]; tokens: number; cost: number }[]; brief: WorkProjectBrief | null; markdown: string }>(`/work/plans/${encodeURIComponent(id)}/sheet`),
  // 团体协作：内置模型 Agent 先理解拆解，再分派给所选外部 Agent，最后由它收拢结果。
  workSuggestPrompts: (input: { goal: string; agentIds?: string[]; projectId?: string; projectChatId?: string }) => request<{ prompts: WorkPromptOption[]; source: 'model' | 'local'; model?: { provider: string; model: string }; modelError?: string }>('/work/prompts', { method: 'POST', body: JSON.stringify(input) }),
  workCollaborate: (goal: string, agentIds: string[], options?: { projectId?: string; projectChatId?: string; profileId?: string; models?: Record<string, string>; autoRun?: boolean }) => request<{ plan: WorkPlan; steps: WorkPlanStep[]; analysis?: WorkTaskAnalysis | null; mainChatId?: string | null; conversationId?: string | null }>('/work/collaborate', { method: 'POST', body: JSON.stringify({ goal, agentIds, ...(options?.projectChatId ? { projectChatId: options.projectChatId } : {}), ...(!options?.projectChatId && options?.projectId ? { projectId: options.projectId } : {}), ...(options?.profileId ? { profileId: options.profileId } : {}), ...(options?.models && Object.keys(options.models).length ? { models: options.models } : {}), ...(options?.autoRun ? { autoRun: true } : {}) }) }),
  modelHub: () => request<{ profiles: { id: string; name: string; model: string; capabilities?: { efforts: string[]; tools?: boolean } }[]; workflow: { defaultProfileId: string | null } }>('/model-hub'),
  cancelWorkPlan: (id: string) => request<{ plan: WorkPlan }>(`/work/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  mobilePair: () => request<{ code: string; expiresAt: string }>('/mobile/pair', { method: 'POST', body: '{}' }),
  mobileDevices: () => request<{ devices: { id: string; name: string; createdAt: string; expiresAt: string }[] }>('/mobile/devices'),
  revokeMobileDevice: (id: string) => request<{ ok: boolean }>(`/mobile/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateWorkPolicy: (policy: WorkPolicy) => request<{ policy: WorkPolicy }>('/work/policy', { method: 'PUT', body: JSON.stringify(policy) }),
  modelUsage: (days: number | 'all') => request<ModelUsageReport>("/model-usage?days=" + days),
  readShare: (token: string) => request<{ report: PublicReport }>('/public/shares/read', { method: 'POST', body: JSON.stringify({ token }), referrerPolicy: 'no-referrer', cache: 'no-store' }, true),
  visitShare: (token: string, visitorToken: string) => request<{ ok: boolean }>('/public/shares/visit', { method: 'POST', body: JSON.stringify({ token, visitorToken }), referrerPolicy: 'no-referrer', cache: 'no-store' }, true),
  shares: (id: string) => request<{shares: ShareItem[]}>(`/tasks/${encodeURIComponent(id)}/shares`, {}, true),
  createShare: (id: string, input: {expiresInDays: 1 | 7 | 30; hideRevenue: boolean}) => request<{share: ShareItem; token: string}>(`/tasks/${encodeURIComponent(id)}/shares`, {method:'POST', body:JSON.stringify(input)}, true),
  revokeShare: (id: string) => request<{ok:boolean}>(`/shares/${encodeURIComponent(id)}`, {method:'DELETE'}, true),
  runtime: () => request<Runtime>('/runtime', {}, true),
  session: () => request<{ user: User | null }>('/auth/session', {}, true),
  me: () => request<{ user: User; phoneRequired: boolean }>('/auth/me', {}, true),
  register: (input: { username?: string; displayName?: string; password?: string; phone?: string; code?: string; rememberDevice?: boolean; shareToken?: string; visitorToken?: string }) => request<{ user: User }>('/auth/register', { method: 'POST', body: JSON.stringify(input) }, true),
  login: (input: { username?: string; password?: string; phone?: string; code?: string; rememberDevice?: boolean }) => request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify(input) }, true),
  sendSms: (input: { phone?: string; username?: string; purpose: 'register' | 'login' | 'bind' | 'change' | 'reset'; captchaToken?: string }) => request<{ ok: boolean; message: string; expiresIn: number; retryAfter: number; devCode?: string }>('/auth/sms/send', { method: 'POST', body: JSON.stringify(input) }, true),
  bindPhone: (input: { phone: string; code: string }) => request<{ user: User; phoneRequired: boolean }>('/auth/phone/bind', { method: 'POST', body: JSON.stringify(input) }, true),
  changePhone: (input: { oldCode: string; newPhone: string; newCode: string }) => request<{ user: User }>('/auth/phone/change', { method: 'POST', body: JSON.stringify(input) }, true),
  revokeDevices: (input: { code?: string } = {}) => request<{ ok: boolean; sessions: number; devices: number }>('/auth/devices/revoke-all', { method: 'POST', body: JSON.stringify(input) }, true),
  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST', body: '{}' }, true),
  changePassword: (input: { currentPassword: string; newPassword: string; code?: string }) => request<{ ok: boolean }>('/auth/change-password', { method: 'POST', body: JSON.stringify(input) }, true),
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
  getSettings: () => request<{ settings: Settings }>('/settings'),
  testSettings: () => request<{ ok: boolean; message: string }>('/settings/test', { method: 'POST', body: '{}' }),
  models: (input: { baseUrl: string; apiKey?: string }, signal?: AbortSignal) => request<ModelCatalog>('/settings/models', { method: 'POST', body: JSON.stringify(input), signal }),
};
