export type MobileDevice = { deviceId: string; deviceToken: string; expiresAt: string; name?: string };
export type MobileOption = { id?: string; label?: string; action?: string };
export type MobileAttention = { question?: string; createdAt?: string; options?: MobileOption[] };
export type MobileTicket = {
  id: string; title?: string; summary?: string; status: string; stage?: string; source?: string;
  executor?: string; createdAt?: string; updatedAt?: string; attention?: MobileAttention;
  parentTicketId?: string | null; handoffDepth?: number; handoffSummary?: string; handoffChildId?: string | null;
  planId?: string | null; planStep?: number | null; planTotal?: number | null;
};
export type MobileReport = { id: string; ticketId?: string; assignmentId?: string; kind?: string; summary?: string; text?: string; truncated?: boolean; createdAt?: string };
export type MobileActivityStep = { kind: 'thought' | 'tool' | 'observation' | 'error' | 'permission'; text?: string; detail?: string; at?: string; requestId?: string; decided?: boolean };
export type MobileThinkingStep = MobileActivityStep & { ticketId?: string };
export type MobileTeamNode = { id: string; parentId?: string | null; depth?: number; status?: string; proposals?: { id: string; kind: string; status: string }[] };
export type MobileDetail = {
  ticket: MobileTicket;
  assignments: { id: string; executor?: string; status?: string }[];
  reports: MobileReport[];
  activity?: MobileActivityStep[];
  project?: MobileProject;
  team?: { nodes: MobileTeamNode[]; cancelled?: boolean };
};
export type MobileFile = { name: string; path: string; ext?: string; kind: string; size?: number; modifiedAt?: string; previewable?: boolean };
export type MobileFileTable = { name?: string; headers: string[]; rows: string[][]; truncated?: boolean };
export type MobileFilePreview = {
  path: string; name: string; kind: string; ext?: string; mime?: string; size?: number;
  text?: string; html?: string; truncated?: boolean; message?: string;
  headers?: string[]; rows?: string[][];
  slides?: { index: number; title: string; text: string }[];
  sheets?: MobileFileTable[];
};
export type MobileFileLink = { url: string; name: string; mime?: string; size?: number; expiresAt?: string };
export type MobileAgent = { id: string; name: string; kind?: string; status?: string; capabilities?: string[] };
export type MobileProject = { id: string; name: string; path?: string; gitBranch?: string };
export type MobileNotification = { id: string; ticketId?: string; title: string; status: string; summary: string; createdAt: string; unread: boolean };
export type MobileConversationStatus = 'waiting' | 'working' | 'awaiting_review' | 'completed' | 'failed' | 'cancelled';
export type MobileConversationSummary = {
  id: string; title: string; goal: string; projectId: string | null; participants: string[];
  status: MobileConversationStatus; turnCount: number; lastPrompt?: string;
  lastMode?: 'auto' | 'multi' | 'plan' | 'review'; createdAt: string; updatedAt: string;
};
export type MobileTurn = {
  id: string; index: number; prompt: string; mode: string; agentIds: string[];
  runs: { ticketId: string; agentId: string; role: string }[];
  synthesisTicketId?: string; createdAt: string;
};
export type MobileConversation = MobileConversationSummary & { turns: MobileTurn[]; hasMore: boolean; nextBefore: number | null };
export type MobileLagent = { name: string; executorId: string; ready: boolean; configured: boolean; reason?: string };
export type MobileBootstrap = {
  tickets: MobileTicket[];
  attention: { ticketId: string; title?: string; question?: string; createdAt?: string; options?: MobileOption[] }[];
  agents: MobileAgent[];
  projects?: MobileProject[];
  conversations?: MobileConversationSummary[];
  lagent?: MobileLagent | null;
  policy?: { allowedExecutors?: string[] };
  notifications?: { unread?: number };
  plans?: { id: string; goal: string; status: string; currentStep: number; totalSteps: number; updatedAt?: string }[];
};
export type MobileModelProfile = { id: string; name: string; model: string; available: boolean; efforts: string[] };
export type MobileChatSettings = { profileId?: string; effort?: string };
export type MobileEfforts = Record<string, string>;
export type MobileEvent = { type: string; ticketId: string | null; payload: { status?: string; reportId?: string; activity?: MobileActivityStep[] } };
export type MobileTicketState = { ticket: MobileTicket; activity: MobileThinkingStep[]; reports: MobileReport[] };
