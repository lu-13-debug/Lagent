import { z } from 'zod';

// 统一 API 契约：请求体/查询参数的形状与取值范围先由 zod 把关，
// 业务规则（例如「2–5 个步骤」「执行器必须可用」）仍留给各自服务，
// 这样错误信息不会因为换了校验层就变样，旧客户端也不会被意外的严格模式挡掉。
const identifier = z.string().trim().min(1).max(200);
const shortText = max => z.string().trim().max(max);
const list = max => z.array(z.string().trim().min(1).max(500)).max(max);

export const RunStartBody = z.object({
  goal: z.string().trim().min(1).max(4000),
  projectId: identifier.nullish(),
  chatId: identifier.nullish(),
  templateId: z.string().trim().max(80).nullish()
});

export const RunApproveBody = z.object({
  decision: z.enum(['approve', 'reject']).optional()
});

// 决议取值交由审批服务判定：例如 allow_session 需要返回固定的 409 GRANT_NOT_ENABLED，
// 这里只校验形状，避免把业务语义复制到校验层。
export const ApprovalDecisionBody = z.object({
  decision: z.string().trim().min(1).max(40),
  by: z.enum(['desktop', 'im']).optional()
});

export const IsolateBody = z.object({
  mode: z.enum(['direct', 'worktree'])
});

export const CheckpointRestoreBody = z.object({
  checkpointId: identifier.optional(),
  threadId: identifier.optional(),
  scope: z.enum(['file', 'workspace', 'session']).optional(),
  path: z.string().max(2000).optional(),
  paths: z.array(z.string().max(2000)).max(500).optional(),
  token: z.string().trim().max(200).optional(),
  confirm: z.boolean().optional()
});

export const WorkflowSaveBody = z.object({
  id: identifier.optional(),
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().max(4000).optional().default(''),
  projectId: identifier.nullish(),
  projectChatId: identifier.nullish(),
  steps: z.array(z.object({
    executorId: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(2000),
    dependsOn: z.array(z.number().int().min(0).max(20)).max(5).optional()
  })).min(1).max(10)
});

export const WorkflowRunBody = z.object({
  autoRun: z.boolean().optional().default(false),
  clientRequestId: z.string().trim().max(120).optional()
});

export const EvalCreateBody = z.object({
  name: z.string().trim().max(80).optional(),
  ticketIds: z.array(identifier).max(200).optional(),
  limit: z.number().int().min(1).max(200).optional()
});

export const AgentBundleBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: shortText(400).optional().default(''),
  executorId: z.string().trim().min(1).max(60),
  permission: z.enum(['read', 'workspace', 'full']).optional().default('workspace'),
  effort: z.string().trim().max(20).optional(),
  instructions: list(20).optional().default([]),
  skills: list(20).optional().default([])
});

export const MarketQuery = z.object({
  source: z.enum(['local', 'remote', 'all']).optional().default('all')
});

export const RemotePublishBody = AgentBundleBody;

export const ToolRegistryBody = z.object({
  enabled: z.boolean().optional(),
  risk: z.enum(['low', 'medium', 'high']).optional()
});

export const ThreadQuery = z.object({
  after_seq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional()
});

export const CheckpointQuery = z.object({
  projectId: identifier.optional(),
  threadId: identifier.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

/**
 * 解析失败时抛出带 400 状态的错误；路由捕获后会按既有约定返回 { error }。
 * 错误信息里带字段路径，前端能直接指出是哪一项不合法。
 */
export function parseBody(schema, value, label = '请求参数') {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path?.length ? `${issue.path.join('.')}：` : '';
  const error = new Error(`${label}不合法：${where}${issue?.message || '格式错误'}`);
  error.status = 400;
  error.code = 'INVALID_ARGUMENT';
  error.issues = result.error.issues;
  throw error;
}

/** 查询参数同样走 zod，只是失败时回落到默认值，避免旧链接因为多一个参数就打不开。 */
export function parseQuery(schema, value, fallback = {}) {
  const result = schema.safeParse(value ?? {});
  return result.success ? result.data : fallback;
}
