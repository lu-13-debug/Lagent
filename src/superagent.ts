export type WorkTicketStatus = 'queued' | 'working' | 'awaiting_review' | 'blocked' | 'failed' | 'waiting' | 'completed' | 'cancelled';
export type WorkAction = 'approve' | 'reject' | 'stop' | 'retry' | 'resume' | 'handoff';
export interface WorkAttentionOption { id: string; label: string; action: WorkAction }
export interface WorkAttention { question: string; options: WorkAttentionOption[]; createdAt: string }
export interface WorkTicket {
  id: string; title: string; status: WorkTicketStatus; stage: string; source: string;
  executor: string; summary: string; datasetId?: string | null; attention?: WorkAttention; createdAt: string; updatedAt: string;
  parentTicketId?: string | null; chainRootId?: string | null; handoffDepth?: number; handoffSummary?: string; handoffChildId?: string | null;
  planId?: string | null; planStep?: number | null; planTotal?: number | null; projectChatId?: string | null;
}
export interface WorkDataset { id: string; name: string; rowCount: number; source: string }
export interface WorkAgent { id: string; name: string; kind: 'analysis' | 'claude-code' | 'codex' | 'browser' | 'terminal' | string; status: string; capabilities: string[] }
export interface WorkTool { id: string; name: string; kind: string; status: string; permissions: string[] }
export interface WorkPolicy {
  mode: 'personal'; acceptMode: 'explicit' | 'observe' | 'auto';
  allowedExecutors?: string[]; requireApproval?: boolean;
  budgets?: { maxConcurrent: number; maxCallsPerTicket: number; maxRuntimeMs: number; maxTokensPerTicket: number };
  limits?: { browserHosts: string[]; githubRepos: string[]; acpWrites?: boolean };
}
export interface WorkInboxItem { ticketId: string; title: string; question: string; options: WorkAttentionOption[]; createdAt: string }
export interface WorkPlanStep { index: number; ticketId: string; executorId: string; title: string; status?: string; dependsOn?: number[]; scope?: string[]; projectChatId?: string | null }
export interface WorkPlan {
  id: string; goal: string; status: 'active' | 'completed' | 'failed' | 'cancelled'; autoRun?: boolean;
  currentStep: number; totalSteps: number; steps: WorkPlanStep[]; createdAt: string; updatedAt: string;
  projectChatId?: string | null; projectId?: string | null;
}
export type WorkPlanSummary = Pick<WorkPlan, 'id' | 'goal' | 'status' | 'autoRun' | 'currentStep' | 'totalSteps' | 'updatedAt'>;
export interface WorkTaskAnalysisStep {
  index: number; title: string; executorId: string; scope: string[]; output: string; readOnly: boolean; dependsOn: number[]; needsApproval: boolean;
}
export interface WorkTaskAnalysis {
  goal: string;
  category: string;
  categoryLabel: string;
  project: { name?: string; path?: string; gitBranch?: string } | null;
  needs: { id: string; label: string; reason: string }[];
  understanding: string[];
  conflicts: { between: number[]; reason: string; resolution: string }[];
  steps: WorkTaskAnalysisStep[];
  /** 这次拆分是模型想的还是本地规则算的。 */
  source?: 'model' | 'local' | string;
  modelAvailable?: boolean;
  model?: { provider?: string; model?: string } | null;
  thoughts?: string[];
  toolCalls?: { name: string; query: string; ok: boolean; summary: string }[];
  modelError?: string;
}

export interface WorkProjectMemoryEntry {
  id: string; projectId: string; ticketId: string | null; projectChatId: string | null;
  executorId: string | null; title: string; status: string | null; summary: string;
  files: string[]; improvements: string[]; openQuestions: string[];
  source: 'local' | 'model' | string;
  model: { provider?: string; model?: string } | null;
  createdAt: string; updatedAt: string;
}

export interface WorkProjectMemory { digest: string; entries: WorkProjectMemoryEntry[] }
export interface WorkProjectChat {
  id: string; projectId: string; executorId: 'claude-code' | 'codex' | 'window' | string; title: string;
  sessionId: string; writable: boolean; source: 'manual' | 'imported' | string;
  lastTicketId?: string; lastSummary?: string; window?: { handle: number; process: string; title: string };
  // 占位标题标记：第一条消息到达后由后端改成消息摘要。
  autoTitle?: boolean;
  ticketCount?: number; pendingCount?: number; lastTicketStatus?: string; lastTicketAt?: string;
  createdAt: string; updatedAt: string;
}
export interface WorkProject {
  id: string; name: string; path: string; gitBranch: string; entryCount: number;
  chatCount: number; chats: WorkProjectChat[]; lastActivity?: string; createdAt: string; updatedAt: string;
}
export interface WorkProjectSession {
  executorId: 'claude-code' | 'codex' | string; sessionId: string; title: string; updatedAt: string; bytes: number; imported: boolean;
}
export interface WorkProjectBrief {
  projectId: string; goal: string; summary: string;
  keyPoints: string[]; decisions: string[]; constraints: string[]; updatedAt: string;
}
export interface WorkProjectChange {
  id: string; projectId: string; projectChatId: string; ticketId: string; executorId: string;
  title: string; summary: string; files: string[]; sessionId: string; status: string;
  source: 'auto' | 'manual'; createdAt: string; updatedAt?: string;
}
export interface WorkTeamworkPart {
  id: string; name: string; file: string; global?: string; executorId: string; chatId: string; ticketId: string;
  status: string; summary?: string; fileExists?: boolean; fileSize?: number;
}
export interface WorkTeamwork {
  id: string; projectId: string; goal: string; status: 'running' | 'assembled' | 'blocked' | string;
  parts: WorkTeamworkPart[]; outputPath: string | null; bytes: number; assembledAt: string | null;
  problems: { part?: string; message: string }[]; allSettled?: boolean; projectName?: string; projectPath?: string;
  createdAt: string; updatedAt: string;
}
export interface WorkBootstrap {
  capabilities: { work: boolean };
  tickets: WorkTicket[];
  attention: WorkInboxItem[];
  datasets: WorkDataset[];
  agents: WorkAgent[];
  tools: WorkTool[];
  policy: WorkPolicy;
  plans?: WorkPlanSummary[];
  projects?: WorkProject[];
  /** 未绑定工作文件夹时，Agent 读写文件所在的目录。 */
  workspace?: string | null;
}
export interface WorkAssignment { id: string; ticketId: string; executor: string; status: string; startedAt?: string; endedAt?: string; sessionId?: string; error?: string }
export type WorkReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
export interface WorkReport { id: string; ticketId: string; assignmentId: string; kind: WorkReportKind; summary: string; artifacts?: Record<string, unknown>; createdAt: string }
export interface WorkTeamProposal { id: string; kind: 'chart' | 'clean'; status: 'proposed' | 'needsApproval' | 'accepted' | 'rejected'; summary: string }
export interface WorkTeamNode {
  id: string; parentId: string | null; depth: number; name: string; status: string;
  dependsOn: string[]; retries: number; proposals: WorkTeamProposal[];
}
export interface WorkTeamEvent { type: string; nodeId?: string; status?: string; seq: number; createdAt: string; proposal?: WorkTeamProposal }
export interface WorkTeam {
  limits: { maxDepth: number; maxNodes: number; maxConcurrent: number; maxCalls: number; maxTokens: number; timeoutMs: number; maxSubtasks: number };
  usage: { calls: number; totalTokens: number; reservedTokens: number };
  cancelled: boolean; revision: number; updatedAt: string | null; events: WorkTeamEvent[]; nodes: WorkTeamNode[];
}
export interface WorkTicketDetail { ticket: WorkTicket; assignments: WorkAssignment[]; reports: WorkReport[]; team: WorkTeam | null; project?: { id: string; name: string; path: string; gitBranch: string } | null; projectChat?: { id: string; title: string; executorId: string } | null }
