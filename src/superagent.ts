export type WorkTicketStatus = 'queued' | 'working' | 'awaiting_review' | 'blocked' | 'failed' | 'waiting' | 'completed' | 'cancelled';
export type WorkAction = 'approve' | 'reject' | 'stop' | 'retry' | 'resume' | 'skip' | 'handoff';
export interface WorkAttentionOption { id: string; label: string; action: WorkAction }
export interface WorkAttention { question: string; options: WorkAttentionOption[]; createdAt: string }
/** 审批前给用户看的动作投影：只描述「将要做什么」，不暴露原始 argv 与完整提示词。 */
export interface WorkPreview {
  kind?: string;
  action?: string;
  risk?: 'low' | 'medium' | 'high' | string;
  reversible?: boolean;
  tier?: string;
  cwd?: string;
  paths?: string[];
  hosts?: string[];
}
export interface WorkVerifySpec { command: string; cwd?: string; expect?: string; timeoutMs?: number }
/** 结构化任务契约：规划器、执行器、验收器共用。 */
export interface WorkTaskContract {
  objective?: string;
  inputs?: string[];
  constraints?: string[];
  acceptance?: string[];
  tools?: string[];
  budget?: { tokens?: number; wallMs?: number; calls?: number };
  deadlineMs?: number;
  report?: { summary?: string; evidence?: string[]; next?: string[] };
}
export interface WorkAcceptance {
  status?: 'passed' | 'failed' | string;
  command?: string;
  cwd?: string;
  expect?: string;
  exitCode?: number;
  signal?: string | null;
  output?: string;
  durationMs?: number;
  at?: string;
}
/** 证据链：执行验收优先，结构评审只能解释、不能覆盖验收失败。 */
export interface WorkReviewIssue {
  code: string;
  severity: 'blocking' | 'warning' | string;
  message: string;
  fix?: string;
  failureMode?: string;
  evidenceRefs?: string[];
}
export interface WorkReview {
  verdict: 'pass' | 'revise' | 'reject' | 'unreviewed' | string;
  issues: WorkReviewIssue[];
  rubricVersion?: string;
  failureModes?: string[];
  evidence?: {
    level: 'verified' | 'reviewed' | 'failed' | 'unreviewed' | string;
    execution?: 'passed' | 'failed' | 'unreviewed' | string;
    verification?: WorkAcceptance | null;
  };
}
/** 结构化交接简报：换 Agent 接手时只读这一块。 */
export interface WorkHandoff {
  summary?: string;
  artifacts?: string[];
  evidence?: string[];
  decisions?: string[];
  openQuestions?: string[];
  nextSteps?: string[];
  budgetUsed?: { tokens?: number; calls?: number; wallMs?: number };
}
export interface WorkTicket {
  id: string; title: string; status: WorkTicketStatus; stage: string; source: string;
  executor: string; summary: string; attention?: WorkAttention; createdAt: string; updatedAt: string;
  parentTicketId?: string | null; chainRootId?: string | null; handoffDepth?: number; handoffSummary?: string; handoffChildId?: string | null;
  planId?: string | null; planStep?: number | null; planTotal?: number | null; projectChatId?: string | null;
  /** 会话归属：一条工单是哪个会话、哪一轮里哪个 Agent 的一次 run。 */
  conversationId?: string | null; turnId?: string | null; agentId?: string | null; role?: 'answer' | 'synthesis' | 'step' | 'coordination' | 'verify' | string | null;
  preview?: WorkPreview | null; verify?: WorkVerifySpec | null; acceptance?: WorkAcceptance | null; review?: WorkReview | null; contract?: WorkTaskContract | null;
  handoff?: WorkHandoff | null;
  /** 详情接口在长时间无心跳时返回；列表投影不带。 */
  stalled?: boolean;
  /** P0.2：该工单当前挂着的审批 id，用于从工单深链到审批中心。 */
  approvalId?: string | null;
}
/** P0.2 审批：等待确认不再只存在于工单 attention，而是一条独立实体。 */
export interface WorkApproval {
  id: string;
  threadId: string;
  runId?: string;
  ticketId?: string;
  requestId?: string;
  kind: 'ticket' | 'run' | 'tool' | 'command' | 'write' | 'network' | 'secret' | 'access' | string;
  executor?: string;
  title: string;
  summary: string;
  options: ('allow_once' | 'allow_session' | 'allow_always' | 'deny' | string)[];
  risk: 'low' | 'medium' | 'high';
  scope?: { threadId?: string; tool?: string; path?: string; host?: string };
  fingerprint?: string;
  status: 'pending' | 'resolved' | 'expired' | 'cancelled';
  decision?: 'allow_once' | 'deny';
  decidedBy?: string;
  resolutionNote?: string;
  createdAt: string;
  expiresAt: number;
  resolvedAt?: string;
  /** 只有 detail 接口带原始输入；列表与 bootstrap 不带。 */
  input?: unknown;
}
/** P0.3：thread 时间线行。P0 先给读模型，UI 行组件按 kind 分派。 */
export interface WorkThreadTimelineRow {
  id: string;
  kind: 'text' | 'thinking' | 'tool' | 'command' | 'approval' | 'plan' | 'artifact' | 'subagent' | 'fold' | 'error' | string;
  at?: string | null;
  title?: string;
  text?: string;
  status?: string;
  ticketId?: string;
  runId?: string;
  seq?: number;
  eventType?: string;
  approvalId?: string;
  artifactId?: string;
}
export interface WorkThreadTicketSummary {
  id: string; title: string; status: string; executor?: string; summary: string;
  createdAt: string | null; updatedAt: string | null;
  conversationId?: string; turnId?: string; approvalId?: string;
}
export interface WorkThreadRunSummary {
  id: string; goal: string; status: string; chatId?: string; projectId?: string;
  currentStep?: number; totalSteps: number; doneSteps: number;
  createdAt: string | null; updatedAt: string | null;
}
export interface WorkThreadSummary {
  id: string; title: string; status: string; conversationId?: string; projectId?: string;
  ticketCount: number; runCount: number; pendingApprovals: number;
  cursor: { lastSeq: number; updatedAt: string | null };
}
export interface WorkThread {
  id: string; title: string; status: string; conversationId?: string; projectId?: string;
  runs: WorkThreadRunSummary[];
  tickets: WorkThreadTicketSummary[];
  /** 交接链路：本线程从哪条线程接手、又交给过哪些线程。 */
  lineage?: {
    parent: { threadId: string; ticketId: string; title: string; status?: string } | null;
    children: { threadId: string; ticketId: string; title: string; status: string; depth: number }[];
  };
  approvals: WorkApproval[];
  timeline: WorkThreadTimelineRow[];
  inspector: {
    pendingApprovals: WorkApproval[];
    running: WorkThreadRunSummary[];
    artifacts: { id: string; ticketId: string; kind: string; summary: string; createdAt: string | null }[];
    usage: { tokens: number; cost: number; calls: number; budget?: number };
  };
  cursor: { lastSeq: number; updatedAt: string | null };
}
/** 执行前检查点：任务开始前存档的工作区改动，可按单文件 / 工作区 / 会话回滚。 */
export interface WorkCheckpointFile {
  path: string;
  state: string;
  before: 'saved' | 'absent' | 'head' | 'unreadable' | string;
  size?: number;
  warning?: string;
  diff?: string;
}
export interface WorkCheckpoint {
  id: string;
  projectId?: string;
  projectPath: string;
  threadId?: string;
  ticketId?: string;
  createdAt: string;
  files: WorkCheckpointFile[];
  lastRestoredAt?: string;
  stats?: { files: number; bytes: number };
}
export interface WorkCheckpointPreview {
  scope: 'file' | 'workspace' | 'session';
  checkpointId?: string;
  threadId?: string;
  checkpointIds: string[];
  projectPath: string;
  files: WorkCheckpointFile[];
  token: string;
  confirmRequired: boolean;
}
export interface WorkCheckpointRestore {
  checkpointId: string;
  scope: string;
  restoredAt: string;
  files: { path: string; action: string; reason?: string }[];
  counts: Record<string, number>;
}
export interface WorkAgent { id: string; name: string; kind: 'model' | 'claude-code' | 'codex' | 'browser' | 'terminal' | 'window' | string; status: string; capabilities: string[] }
/** Agent 档案：能力、权限、成本、可靠性与最近使用，用于路由解释。 */
export interface WorkRosterEntry {
  id: string; name: string; kind: string;
  // agent：能被派进对话、自己完成目标的同事；tool：由 Agent 调用的受控能力。
  category: 'agent' | 'tool';
  health: 'available' | 'needs_setup' | 'unavailable' | string;
  capabilities: string[];
  permissions: { allowed: boolean; mode: string };
  costProfile: { calls: number; avgTokens: number; totalTokens: number; avgDurationMs: number; costEstimate: number };
  reliability: { finished: number; succeeded: number; failed: number; successRate: number | null; lastStatus: string | null };
  bestFor: string;
  lastUsedAt: string | null;
}
/** 项目/全局团队模板：角色、执行器、权限与默认协作模式。 */
export interface WorkTeamTemplateRole { role: string; executorId: string; permissions: 'read' | 'workspace' | 'full' }
export interface WorkTeamTemplate {
  id: string; name: string; roles: WorkTeamTemplateRole[];
  defaultMode: 'auto' | 'plan' | 'review' | 'multi';
  projectId?: string;
  createdAt: string; updatedAt: string;
}
export interface WorkTool { id: string; name: string; kind: string; status: string; permissions: string[] }
export interface WorkPolicy {
  mode: 'personal'; acceptMode: 'explicit' | 'observe' | 'auto';
  permission?: 'read' | 'workspace' | 'full';
  allowedExecutors?: string[]; requireApproval?: boolean;
  budgets?: { maxConcurrent: number; maxCallsPerTicket: number; maxRuntimeMs: number; maxTokensPerTicket: number };
  limits?: { browserHosts: string[]; githubRepos: string[]; acpWrites?: boolean; modelWrites?: boolean; extraRoots?: string[]; confirmDanger?: boolean };
}
export interface WorkProfileSettings { profileId?: string; model?: string; effort?: string; permission?: 'read' | 'workspace' | 'full' }
export interface WorkProfileLibrary { skills: string[]; mcpServers: string[]; instructions: string[] }
export interface WorkProfile {
  id: string; name: string; description: string; settings: WorkProfileSettings;
  policy: WorkPolicy | null; library: WorkProfileLibrary; createdAt: string; updatedAt: string;
}
export interface WorkProfileScope {
  profileId: string; profile: WorkProfile | null; settings: WorkProfileSettings;
  library: WorkProfileLibrary; appliedAt: string | null;
}
export interface WorkProfilesActive { global: WorkProfileScope | null; project: WorkProfileScope | null; effective: WorkProfileScope | null }
export interface WorkMcpToken {
  id: string; name: string; projectId: string | null; readOnly: boolean; tools: string[];
  budgetTokens: number; maxCalls: number; maxConcurrency: number; calls: number; usedTokens: number;
  expiresAt: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null;
}
export interface WorkInboxItem { ticketId: string; title: string; question: string; options: WorkAttentionOption[]; createdAt: string; kind?: string; accessMode?: string; accessPath?: string }
export interface WorkPlanStep { index: number; ticketId: string; executorId: string; title: string; status?: string; dependsOn?: number[]; scope?: string[]; projectChatId?: string | null; preview?: WorkPreview | null; verify?: WorkVerifySpec | null; acceptance?: WorkAcceptance | null; contract?: WorkTaskContract | null }
export interface WorkPlan {
  id: string; goal: string; status: 'active' | 'completed' | 'failed' | 'cancelled'; autoRun?: boolean;
  currentStep: number; totalSteps: number; steps: WorkPlanStep[]; createdAt: string; updatedAt: string;
  projectChatId?: string | null; projectId?: string | null;
}
export type WorkPlanSummary = Pick<WorkPlan, 'id' | 'goal' | 'status' | 'autoRun' | 'currentStep' | 'totalSteps' | 'updatedAt'>;
export interface WorkTaskAnalysisStep {
  index: number; title: string; executorId: string; scope: string[]; output: string; readOnly: boolean; dependsOn: number[]; needsApproval: boolean;
}
/** 派单前给用户挑的任务书版本：同一个目标，三种侧重。 */
export interface WorkPromptOption {
  id: string;
  label: string;
  focus: string;
  prompt: string;
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
  /** change / note 为普通记忆；reflection 为失败反思，只在 playbook 中前置注入。 */
  kind?: 'change' | 'note' | 'reflection' | string;
  lesson?: string; failureCode?: string; occurrences?: number; positive?: number; negative?: number;
  files: string[]; improvements: string[]; openQuestions: string[];
  scope?: string; tags?: string[]; confidence?: number;
  source: 'local' | 'model' | 'external' | string;
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
  // 团队协作产生的从属会话会指向上级对话；侧栏只列上级对话，右栏再展开各个 Agent。
  parentChatId?: string;
  /** 归属的 Lagent 会话；有它的时候打开会跳转会话线程，而不是单 Agent 对话。 */
  conversationId?: string;
  /** 会话内部执行用的对话：不出现在项目页与侧栏。 */
  hidden?: boolean;
  // 这条会话自己的权限档位；没有这个字段表示跟随设置里的全局档位。
  permission?: 'read' | 'workspace' | 'full';
  // 建会话时挑的协作 Agent：内置 Agent 拆解后分派给它们，最多 3 个。
  collaborators?: string[];
  ticketCount?: number; pendingCount?: number; lastTicketStatus?: string; lastTicketAt?: string;
  createdAt: string; updatedAt: string;
}
export interface WorkProject {
  id: string; name: string; path: string; gitBranch: string; entryCount: number;
  chatCount: number; chats: WorkProjectChat[]; lastActivity?: string; createdAt: string; updatedAt: string;
}
export type WorkProjectFileKind = 'dir' | 'markdown' | 'html' | 'pdf' | 'docx' | 'doc' | 'pptx' | 'ppt' | 'csv' | 'sheet' | 'legacy' | 'image' | 'code' | 'text' | 'unsupported';
export interface WorkProjectFileEntry {
  name: string; path: string; type: 'dir' | 'file'; size?: number; modifiedAt?: string;
  ext: string; kind: WorkProjectFileKind; previewable: boolean; locked?: boolean;
}
export interface WorkProjectFileList {
  root: string; path: string; parent: string | null; entries: WorkProjectFileEntry[]; truncated: boolean;
}
export interface WorkProjectFileSearch { query: string; entries: WorkProjectFileEntry[]; truncated: boolean }
export interface WorkProjectFileTable { headers: string[]; rows: string[][]; truncated?: boolean }
export interface WorkProjectFileSlide { index: number; title: string; text: string }
export interface WorkProjectFilePreview {
  path: string; name: string; ext: string; kind: Exclude<WorkProjectFileKind, 'dir'>;
  mime: string; size: number; modifiedAt: string;
  text?: string; html?: string; slides?: WorkProjectFileSlide[]; sheets?: ({ name: string } & WorkProjectFileTable)[];
  headers?: string[]; rows?: string[][]; truncated?: boolean; message?: string;
}
export interface WorkProjectSession {
  executorId: 'claude-code' | 'codex' | string; sessionId: string; title: string; updatedAt: string; bytes: number; imported: boolean;
}
export interface WorkProjectBrief {
  projectId: string; goal: string; summary: string;
  keyPoints: string[]; decisions: string[]; constraints: string[];
  openQuestions: string[]; nextSteps: string[]; verifyCommands: string[];
  sources: Record<string, string>; updatedAt: string;
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
export type WorkRunStatus = 'drafting' | 'awaiting_approval' | 'running' | 'verifying' | 'repairing' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'paused';
export interface WorkRunStep {
  index: number;
  role: string;
  need?: Record<string, boolean>;
  executorId: string | null;
  ticketId: string | null;
  status: string;
  summary?: string;
  error?: string;
}
export interface WorkRunBoardEntry { at: string; kind: string; text: string }
/** 一次「深度编排」：分析目标 → 拆解步骤 → 等批准 → 逐部分发 → 验证（可返工）→ 汇总。 */
export interface WorkRun {
  id: string;
  kind?: 'orchestrator' | 'plan';
  goal: string;
  projectId: string | null;
  chatId: string | null;
  templateId: string | null;
  templateLabel: string | null;
  /** 用户在对话里手选的模板 id；null 表示按目标关键词自动识别。 */
  templateChoice?: string | null;
  confidence: number;
  status: WorkRunStatus;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  rounds: number;
  maxRounds: number;
  steps: WorkRunStep[];
  board: WorkRunBoardEntry[];
  digest: string;
  error: string | null;
}
// 会话：用户可见的唯一对话容器。每个被选中的 Agent 只是会话里的一次 run。
export interface WorkConversationRun { ticketId: string; agentId: string; role: 'answer' | 'synthesis' | 'step' | 'coordination' | 'verify' | string }
export interface WorkConversationTurn {
  id: string; index: number; prompt: string; mode: 'auto' | 'review' | 'plan' | 'multi' | string;
  agentIds: string[]; runs: WorkConversationRun[];
  synthesisTicketId?: string; synthesisAgentId?: string; createdAt: string;
}
export interface WorkConversationSummary {
  id: string; title: string; goal: string; host: string; projectId: string | null;
  participants: string[]; ticketIds: string[]; turnCount: number;
  lastPrompt: string; lastMode: string; status: string; createdAt: string; updatedAt: string;
}
export interface WorkConversation extends WorkConversationSummary { turns: WorkConversationTurn[] }
export interface WorkBootstrap {
  capabilities: { work: boolean };
  /** 服务级外部执行器总开关（LAGENT_ALLOW_EXTERNAL_EXECUTORS）；false 时策略里的 CLI 勾选不生效。 */
  externalExecutors?: boolean;
  /** 执行器并发占用：工单显示「排队中」时用来解释是在等空位。 */
  queue?: { maxConcurrent: number; running: number; queued: number; full: boolean };
  tickets: WorkTicket[];
  attention: WorkInboxItem[];
  agents: WorkAgent[];
  tools: WorkTool[];
  policy: WorkPolicy;
  profiles?: WorkProfile[];
  activeProfile?: WorkProfilesActive;
  plans?: WorkPlanSummary[];
  conversations?: WorkConversationSummary[];
  projects?: WorkProject[];
  /** 未绑定工作文件夹时，Agent 读写文件所在的目录。 */
  workspace?: string | null;
  /** 内置主控的就绪状态：未配置模型时前端禁用发送，外部 Agent 不能绕过。 */
  lagent?: WorkLagentState;
  /** P0.2：统一审批收件箱；旧 attention 保留，两者指向同一事实。 */
  approvals?: WorkApproval[];
}
export interface WorkLagentState {
  ready: boolean;
  configured: boolean;
  available?: boolean;
  name?: string;
  executorId?: string;
  code?: string;
  reason?: string;
}
export interface WorkAssignment { id: string; ticketId: string; executor: string; status: string; startedAt?: string; endedAt?: string; sessionId?: string; error?: string; heartbeatAt?: string; stalled?: boolean }
export type WorkReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
export interface WorkReport { id: string; ticketId: string; assignmentId: string; kind: WorkReportKind; summary: string; artifacts?: Record<string, unknown>; createdAt: string }
// 报告中心：以报告为主表，按会话或工单聚合后的列表项。
export interface WorkReportItem {
  id: string;
  group: 'conversation' | 'ticket' | 'report';
  groupId: string;
  reportId: string;
  reportIds: string[];
  reportCount: number;
  title: string;
  kind: string;
  kindLabel: string;
  summary: string;
  createdAt: string;
  ticketId: string;
  ticketTitle: string;
  ticketStatus: string;
  conversationId: string;
  turnId: string;
  executorId: string;
  role: string;
  projectId: string;
  projectName: string;
}
export interface WorkReportList { group: 'conversation' | 'ticket' | 'report'; total: number; reportTotal?: number; cursor: string | null; items: WorkReportItem[] }
export interface WorkReportArtifact { name: string; kind: string; summary?: string }
export interface WorkReportDetail {
  report: { id: string; ticketId: string; assignmentId: string; kind: string; kindLabel: string; summary: string; createdAt: string; conversationId: string; turnId: string; executorId: string; role: string };
  ticket: { id: string; title: string; status: string; executorId: string; role: string; summary: string; conversationId: string; turnId: string; projectId: string; createdAt: string; updatedAt: string } | null;
  conversation: { id: string; title: string; goal: string; projectId: string; participants: string[]; createdAt: string } | null;
  project: { id: string; name: string } | null;
  artifacts: WorkReportArtifact[];
}
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
export interface WorkEffect {
  id: string;
  kind: string;
  key: string;
  ticketId: string;
  stepId?: string | null;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  nextAt?: number;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface WorkUsageRow {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
  durationMs: number;
  costEstimate: number;
}
export interface WorkUsageReport {
  range: { days: number | 'all'; from: string | null; to: string; timeZone: string };
  totals: WorkUsageRow;
  budget?: { maxTokensPerTicket: number; warningRatio: number; warnings: Array<{ ticketId: string; used: number; ratio: number }> } | null;
  byExecutor: Array<WorkUsageRow & { executorId: string }>;
  byProject?: Array<WorkUsageRow & { projectId: string }>;
  byDay: Array<WorkUsageRow & { date: string }>;
  byTicket: Array<WorkUsageRow & { ticketId: string; executorId: string; ratio?: number; warning?: boolean }>;
  history?: { count: number; scanned: { files: number; claudeFiles: number; codexFiles: number }; note: string };
  alerts?: { cacheHitRate: number; topProject: (WorkUsageRow & { projectId: string }) | null; topTicket: (WorkUsageRow & { ticketId: string }) | null; today: (WorkUsageRow & { date: string }) | null };
}
export interface WorkTicketDetail { ticket: WorkTicket; assignments: WorkAssignment[]; reports: WorkReport[]; team: WorkTeam | null; project?: { id: string; name: string; path: string; gitBranch: string } | null; projectChat?: { id: string; title: string; executorId: string } | null; activity?: { kind: string; text: string; detail?: string; at?: string; requestId?: string; decided?: 'allow' | 'deny' }[] }
export interface WorkTraceSpan {
  kind: 'assignment' | 'report' | 'usage' | 'event' | string;
  id: string;
  at: string;
  endedAt?: string | null;
  durationMs?: number | null;
  executor?: string;
  status?: string;
  reportKind?: string;
  summary?: string;
  executorId?: string;
  calls?: number;
  tokens?: number;
  cost?: number;
  eventType?: string;
}
export interface WorkTrace {
  ticket: WorkTicket;
  spans: WorkTraceSpan[];
  summary: { startedAt: string | null; endedAt: string | null; durationMs: number | null; assignments: number; reports: number; events: number; calls: number; tokens: number; cost: number };
}

// P1 能力：Library 同步、例行任务、团队房间、Key 池、MCP 客户端、IM 通知、实时观察。
export interface WorkLibraryTarget { id: string; path: string; label: string; mode: 'managed' | 'json'; optIn?: boolean }
export interface WorkLibraryPreviewRow { id: string; label: string; path: string; exists: boolean; changed: boolean; before: string; after: string; error?: string; redacted?: boolean }
export interface WorkLibraryPreview { projectId: string; stamp: string; targets: WorkLibraryPreviewRow[] }
export interface WorkLibrarySyncFile { target: string; path: string; changed: boolean; existed: boolean; backup?: string }
export interface WorkLibrarySync { id: string; projectId: string; createdAt: string; changed: number; changedFiles: string[]; files: WorkLibrarySyncFile[]; rolledBackAt?: string; rolledBackFiles?: string[] }
export type WorkRoutineKind = 'task' | 'daily-brief' | 'stall-followup';
export type WorkRoutineSchedule = { kind: 'interval'; intervalMs: number } | { kind: 'daily'; at: string } | { kind: 'manual' } | { kind: 'webhook' } | { kind: 'git' } | { kind: 'file'; path: string; debounceMs?: number };
export interface WorkRoutine {
  id: string; name: string; enabled: boolean; kind: WorkRoutineKind; projectId: string; projectChatId: string;
  executorId: string; schedule: WorkRoutineSchedule; promptTemplate: string; question: string;
  mode: 'suggest' | 'auto'; stallMs: number; nextAt: string | null; lastRunAt: string | null;
  lastTicketId: string | null; lastError: string; webhookConfigured: boolean; createdAt: string; updatedAt: string;
}
export interface WorkRoomStep { index: number; ticketId: string; executorId: string; title: string; status: string; dependsOn: number[]; attention: string; claimedBy: string }
export interface WorkRoomMessage { id: string; kind: 'chat' | 'note' | 'system' | 'status' | 'report' | 'attention' | string; agent: string; at: string; text: string }
export interface WorkRoomDecision { id: string; by: string; ticketId: string; decision: string; at: string }
export interface WorkRoomArtifact { ticketId: string; executorId: string; title: string; summary: string; at: string; files: string[] }
export interface WorkTeamRoom {
  id: string; projectId: string | null; projectName: string; planId: string | null; title: string; goal: string;
  lead: string; members: string[]; status: string; steps: WorkRoomStep[]; counts: Record<string, number>;
  messages: WorkRoomMessage[]; decisions: WorkRoomDecision[]; artifacts: WorkRoomArtifact[];
  claims: Record<string, string>; createdAt: string; updatedAt: string;
}
export interface ProviderPoolMember { credentialId: string; weight: number; dailyCalls: number; priority: number; costPer1k: number; keyHint?: string; coolingUntil?: string; failures?: number; lastError?: string; usedToday?: number }
export interface ProviderPool {
  id: string; name: string; provider: string; baseUrl: string; protocol: string;
  strategy: 'priority' | 'round-robin' | 'least-failed' | 'cheapest'; maxAttempts: number; cooldownMs: number;
  version: number; members: ProviderPoolMember[]; createdAt: string; updatedAt: string;
}
export interface WorkMcpServer { id: string; name: string; command: string; args: string[]; enabled: boolean; tools: string[]; envKeys: string[]; cwd: string }
export interface WorkImChannel { id: string; name: string; kind: 'slack' | 'teams' | 'feishu' | 'wecom' | 'dingtalk' | 'generic'; enabled: boolean; events: string[]; webhookHost: string; createdAt: string }
export interface WorkImConfig { kinds: WorkImChannel['kind'][]; baseUrl: string; channels: WorkImChannel[] }
export interface WorkLiveSession { id: string; handle: number; process: string; title: string; ticketId: string; status: 'live' | 'paused' | 'takeover' | 'error'; pausedReason: string; lastError: string; intervalMs: number; frames: number; seq: number; startedAt: string; lastFrameAt: string | null; width: number; height: number }
export interface WorkLiveFrame { id: string; seq: number; image: string; width: number; height: number; at: string; status: string }

// 技能与插件中心：技能写原生 .claude/skills，插件交给本机 Claude Code CLI。
export type WorkSkillScope = 'project' | 'global';
export interface WorkSkillSource { type: 'catalog' | 'github'; repo: string; path: string; ref: string; commit: string; catalogId?: string }
export interface WorkSkillFile { path: string; size: number; sha256: string }
export interface WorkSkill {
  id: string; name: string; description: string; scope: WorkSkillScope; projectId: string | null;
  source: WorkSkillSource; targetPath: string; files: WorkSkillFile[]; enabled: boolean; missing: boolean;
  installedAt: string; updatedAt: string;
}
export interface WorkSkillCatalogEntry {
  id: string; name: string; title: string; description: string; category: 'code' | 'docs' | 'data' | 'ops' | string;
  repo: string; path: string; ref: string; license: string; installedProject: boolean; installedGlobal: boolean;
}
export interface WorkSkillPreview {
  token?: string; candidates?: string[]; name?: string; description?: string; repo?: string; path?: string;
  ref?: string; commit?: string; catalog?: boolean; license?: string; files?: WorkSkillFile[]; digest?: string; bytes?: number;
}
export interface WorkPluginMarketplace { name?: string; source?: string; repo?: string; installLocation?: string; [key: string]: unknown }
export interface WorkPlugins {
  available: boolean; reason?: string; binary?: string;
  installed: Record<string, unknown>[]; catalog: Record<string, unknown>[]; marketplaces: WorkPluginMarketplace[];
}
