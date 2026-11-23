export interface InsightPanel { enabled: boolean; degraded: boolean; participants: number; summary: string; reviewers: {lens: string; lensName: string; model: string; status: string; summary?: string; tokens?: number; error?: string}[]; agreements: {title: string; evidenceRefs?: string[]; support?: number; consensus?: string}[]; disagreements: {judgeOnly: {title:string}[]; reviewerOnly: {title:string}[]} }
export type Mode = 'collaborative' | 'automatic';
export type View = 'workspace' | 'datasets' | 'reports' | 'skills' | 'wallet' | 'memory';
export type TaskStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
export interface User { id: string; username: string; displayName: string; createdAt: string; phoneMasked?: string; phoneVerified?: boolean }
export interface Runtime { mode: 'local' | 'cloud'; authRequired: boolean; serviceName: 'Lagent'; version: string; registrationOpen?: boolean; modelHosts?: string[]; phoneRequired?: boolean; smsConfigured?: boolean; capabilities?: { superagent?: boolean; agentTrace?: boolean; memory?: boolean; modelUsage?: boolean; taskEvents?: boolean; taskSummaries?: boolean; taskRecovery?: boolean; taskSkip?: boolean; idempotentTasks?: boolean; walletVersion?: boolean; reportExplore?: boolean; reportMetadata?: boolean; reportContinuation?: boolean; reportSharing?: boolean; modelHub?: boolean; reportPdf?: boolean } }
export interface Wallet { balance: number; frozen: number; spent: number }
export interface WalletState { wallet: Wallet; walletVersion?: number }
export interface TaskResponse extends WalletState { task: Task }
export interface Settings { provider: string; baseUrl: string; model: string; hasKey: boolean; workflowEnabled?: boolean; sessionHasKey?: boolean }
export interface ModelOption { id: string; name: string }
export interface ModelCatalog { models: ModelOption[]; baseUrl: string; partial: boolean }
export interface Project { id: string; name: string; domain: string; description: string }
export interface Domain { id: string; name: string; description: string; enabled: boolean }
export interface Skill { id: string; name: string; description: string; category: string; version: string; enabled: boolean }
export interface DataIssue {
  code: string; severity: 'error' | 'warning' | 'info'; problem: string; metrics: string[]; fix: string;
  location?: { table?: string; column?: string; rows?: number[] };
}
export interface Timezone { name: string; offsetMinutes: number; source: 'user' | 'default' | 'detected'; assumed: boolean; declaredAt?: string }
export interface MetricCapability { label: string; status: 'computed' | 'unavailable'; missing: string[]; unlocks: string[] }
export interface Capability {
  metrics: Record<string, MetricCapability>;
  missingTables: { table: string; label: string; unlocks: string[] }[];
  computed: string[];
  unavailable: string[];
}
export interface DatasetInspection {
  unrecognizedColumns?: { source: string; table: string; column: string; label?: string; status: 'identified_unused'; reason: string }[];
  version: 1;
  mappings: { table: string; source: string; field: string; sourceColumn: string | null; origin: 'automatic' | 'generated'; required: boolean }[];
  coverage: { table: string; start: string | null; end: string | null; validRows: number }[];
  missingTables: string[]; capability?: Capability; issues: DataIssue[]; quality: { score: number | null; rule: string };
  timezone?: Timezone; analyzable: boolean; rawRows: number; validRows: number;
}
export interface Completeness { declared: 'full' | 'partial' | 'unknown'; source: 'user' | 'default'; shardNote?: string; declaredAt: string }
export interface Dataset {
  domain?: string;
  completeness?: Completeness;
  timezone?: Timezone;
  id: string; name: string; source: 'demo' | 'upload'; createdAt: string; rowCount: number; tableCount: number;
  tables: { name: string; type: string; columns: string[]; rowCount: number; preview: Record<string, unknown>[] }[];
  warnings: string[]; dateRange: { start: string; end: string }; channelCount: number;
  capability?: Capability;
  inspection?: DatasetInspection;
}
export interface Step {
  id: string; name: string; description: string; skillId: string;
  status: 'pending' | 'running' | 'completed' | 'awaiting_approval' | 'skipped' | 'failed'; summary?: string;
}
export interface TaskEvent { id: string; type: 'start' | 'complete' | 'info' | 'approval' | 'error'; title: string; detail: string; stepId?: string; createdAt: string }
export interface Message { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string }
export interface Metric { id: string; label: string; value: number | null; unit: string; change: number | null; note: string }
export interface ReportLabels {
  eyebrow?: string; summaryTitle?: string; trendTitle?: string; retentionTitle?: string; retentionDescription?: string;
  cohortColumn?: string; cohortUsers?: string; d1?: string; d7?: string; channelTitle?: string; channelColumn?: string;
  channelUsers?: string; channelRevenue?: string; channelD1?: string; payerTitle?: string;
  entity?: string; newEntity?: string; activeEntity?: string; payerEntity?: string; revenueName?: string;
}
export interface Report {
  domain?: string;
  labels?: ReportLabels;
  extras?: { topStore?: { name: string; revenue: number } | null; topProduct?: { name: string; revenue: number } | null; stages?: { name: string; count: number }[]; totalImpressions?: number; totalClicks?: number; totalConversions?: number; totalSpend?: number };
  dataCompleteness?: Completeness & { affectedDates: string[]; hiddenComparisons: string[]; message: string; comparisonMessage: string };
  timezone?: Timezone;
  capability?: Capability;
  title: string; period: string; generatedAt: string; currency: string; summary: string;
  facts?: { id: string; text: string }[];
  findings: { title: string; detail: string; severity: 'positive' | 'warning' | 'neutral'; evidence: string; kind?: 'fact' | 'inference' | 'recommendation'; evidenceRefs?: string[]; unverified?: boolean }[];
  recommendations: string[]; metrics: Metric[];
  daily: { date: string; dau: number | null; newUsers: number | null; revenue: number | null; payers: number | null }[];
  retention: { date: string; users: number; d1: number | null; d7: number | null }[];
  channels: { name: string; users: number | null; revenue: number | null; d1: number | null; payers?: number | null; payRate?: number | null; arppu?: number | null }[];
  weekday?: { index: number; label: string; days: number; dau: number | null; newUsers: number | null; revenue: number | null }[];
  payerSummary?: { payers: number; repeatPayers: number; repeatRate: number | null; topPayerShare: number | null; averageOrders: number | null; averageRevenue: number | null } | null;
  quality: { rows: number; issues: string[]; score: number }; methodology: string[]; source: 'local' | 'ai';
  aiUsage?: { protocol: 'anthropic' | 'chat-completions' | 'responses'; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cacheReadInputTokens: number | null; cacheCreationInputTokens: number | null; reasoningTokens: number | null };
  charts?: { id: string; title: string; kind: string; mimeType: string; svg: string; caption?: string; source?: string; unit?: string }[];
  pdf?: { ready: boolean; bytes: number; generatedAt?: string };
  qualityReceipts?: { contentHash: string; ruleVersion: string; checks: { id: string; status: string; reasons: string[] }[] };
}
export interface Task {
  id: string; title: string; goal: string; mode: Mode; domain: string; datasetId: string; datasetName: string;
  status: TaskStatus; currentStep: number; progress: number; createdAt: string; updatedAt: string;
  useAI: boolean; model: string; cost: number; steps: Step[]; events: TaskEvent[]; messages: Message[]; report?: Report; error?: string;
  sourceTaskId?: string; sourceKind?: 'continuation'; clientRequestId?: string; skippedSteps?: string[]; errorCode?: string; metadata?: ReportMetadata;
  workflowSnapshot?: { version: number; stages: Record<string, unknown> };
  analysisContract?: { version: number; [field: string]: unknown };
  derivedDatasetId?: string;
  approvalSnapshot?: { version: number; stepId: string; hash: string };
  sourceProvenance?: { demo: boolean; rowCount: number; hash: string };
  qualityReceipts?: Report['qualityReceipts'];
  artifacts?: Record<string, { critic?: {verdict:'pass'|'revise'|'reject'|'unreviewed';rubricVersion:string;issues:{code:string;severity:'blocking'|'warning'|'info';message:string;fix:string;evidenceRefs:string[]}[]}; trace?: {round?:number;actions?:{tool:string;status:string;durationMs:number;resultBytes:number}[];usage?:{calls:number;totalTokens:number};stopReason?:string}; retrieval?:{ids:string[];count:number;omitted:number}; team?:{nodes:{id:string;parentId:string|null;depth:number;name:string;status:string}[];usage:{calls:number;totalTokens:number;reservedTokens:number};cancelled:boolean}; delegations?:{id:string;subagentId:string;name:string;model:string;status:string;tokens:number}[]; scopeInvalidated?: boolean; panel?: InsightPanel; panelTokens?: number; summary: string; model?: string; effort?: string; skillId?: string; skillVersion?: string | number; verified?: boolean; calls?: { model: string; effort: string; usage?: { totalTokens?: number | null } | null }[]; tools?: { name: string }[] }>;
}
export interface ReportMetadata { favorite: boolean; pinned: boolean; tags: string[]; revision: number }
export interface ExploreInput { start: string; end: string; channels?: string[]; comparePrevious?: boolean }
export interface ExploreScope {
  start: string; end: string; channels: string[]; timeZone: string; statisticsVersion: string; generatedAt: string;
  coverage: Record<'users' | 'activity' | 'payments', { start: string; end: string } | null>;
  sample: { sourceRows: number; selectedRows: number; selectedRowsByTable: Record<'users' | 'activity' | 'payments', number>; registeredUsers: number | null; payingUsers: number | null };
  skippedSteps: string[];
}
export interface ExploreMetricComparison { id: string; comparable: boolean; reason: string | null; current: number | null; previous: number | null; absoluteChange: number | null; percentChange: number | null }
export interface Exploration {
  report: Report; scope: ExploreScope; previous?: Report; previousScope?: ExploreScope;
  comparison: { requested: boolean; comparable: boolean; reasons: string[]; previousRange?: { start: string; end: string }; metrics: ExploreMetricComparison[] };
}
export type TaskSummary = Pick<Task, 'id' | 'title' | 'mode' | 'domain' | 'datasetId' | 'datasetName' | 'status' | 'currentStep' | 'progress' | 'createdAt' | 'updatedAt' | 'useAI' | 'model' | 'cost' | 'sourceTaskId' | 'sourceKind' | 'skippedSteps' | 'errorCode'> & { steps: Pick<Step, 'id' | 'name' | 'status'>[] };
export interface TaskSnapshot extends WalletState { summaries: TaskSummary[] }
export interface Transaction { id: string; type: 'grant' | 'freeze' | 'settle' | 'release'; amount: number; taskId?: string; description: string; createdAt: string }
export interface Bootstrap extends WalletState { project: Project; tasks: Task[]; datasets: Dataset[]; skills: Skill[]; domains: Domain[]; settings: Settings }

export interface ShareItem { id: string; expiresAt: string; hideRevenue: boolean; revoked: boolean; views: number; registrations: number }
export interface PublicReport { source: 'ai' | 'local'; hideRevenue: boolean; timeZone?: string | null; timeZoneAssumed?: boolean | null; currency?: string | null; period: { start: string; end: string } | null; sample: boolean | null; sampleNotice: string; dailyTruncated: boolean; retentionTruncated: boolean; metrics: { id: string; label: string; value: number | null; unit: string; coverage: {start:string; end:string} | null; method: string | null }[]; daily: {date:string; dau:number|null; newUsers:number|null; revenue?:number|null; payers?:number|null}[]; retention: {date:string; users:number; d1:number|null; d7:number|null}[]; methodology: string[] }
export interface UsageCounts { inputMissing?:number;outputMissing?:number; calls:number; withUsage:number; missingUsage:number; inputTokens:number|null; outputTokens:number|null; totalTokens:number|null }
export interface ModelUsageReport {range:{days:number|'all';from:string|null;to:string;timeZone:string};totals:UsageCounts&{tasks:number};byModel:(UsageCounts&{provider:string;model:string;protocol:string;tasks:number;cacheReadInputTokens?:number|null;cacheCreationInputTokens?:number|null})[];byStage:(UsageCounts&{stageId:string;stageName:string})[];byDay:(UsageCounts&{date:string})[];byTask:(UsageCounts&{taskId:string})[];review:{calls:number;withUsage:number;missingUsage:number;tokens:number|null};unledgeredTasks:number}
