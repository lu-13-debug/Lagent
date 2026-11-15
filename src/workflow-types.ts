export type ModelProtocol = 'chat-completions' | 'anthropic' | 'responses';
export interface ModelCredential {
  id: string; name: string; provider: string; baseUrl: string; protocol: ModelProtocol;
  hasKey: boolean; keyHint: string; version: number;
}
export interface CredentialInput { name: string; provider: string; baseUrl: string; protocol: ModelProtocol; apiKey?: string }
export interface HubModelProfile {
  id: string; name: string; credentialId?: string; poolId?: string; model: string; unavailable?: boolean;
  capabilities: { efforts: string[]; tools: boolean; reason?: string };
}
export type ModelProfileInput = Pick<HubModelProfile, 'name' | 'model'> & { credentialId?: string; poolId?: string };
export interface ProviderPoolMember {
  credentialId: string; weight: number; dailyCalls: number; priority: number; costPer1k: number;
  keyHint?: string; coolingUntil?: string; failures?: number; lastError?: string; usedToday?: number;
}
export interface ProviderPool {
  id: string; name: string; provider: string; baseUrl: string; protocol: string;
  strategy: 'priority' | 'round-robin' | 'least-failed' | 'cheapest'; maxAttempts: number; cooldownMs: number;
  version: number; members: ProviderPoolMember[]; createdAt: string; updatedAt: string;
}
export interface WorkflowStageConfig { profileId: string | null; skillId: string; effort: string; maxTokens: number; timeoutMs: number; team?:{enabled:boolean}; subagents?: {id:string;profileId:string;name:string;role:string;skillId?:string;effort?:string;maxTokens?:number;timeoutMs?:number}[]; review?: { reviewerProfileIds: string[] } }
export interface WorkflowConfig { version: 1; defaultProfileId: string | null; stages: Record<string, WorkflowStageConfig> }
export interface WorkflowSkill {
  id: string; name: string; description: string; category: string; version: number;
  enabled: boolean; stageId: string; content: string; builtin: boolean;
}
export type WorkflowSkillInput = Pick<WorkflowSkill, 'name' | 'description' | 'category' | 'enabled' | 'stageId' | 'content'>;
export interface ModelHubState {
  credentials: ModelCredential[]; profiles: HubModelProfile[]; pools: ProviderPool[]; workflow: WorkflowConfig; skills: WorkflowSkill[];
  vault: { enabled: boolean; available: boolean; reason: string | null; keyVersion: number };
}
export interface HubModelCatalog { models: { id: string; name?: string }[]; baseUrl: string; partial: boolean }

// 当前产品只使用「任务规划」一个阶段；旧数据分析流水线的 12 个阶段已归档，
// 不再出现在设置界面，历史 Skill 只能在「归档模板」里查看与删除。
export const WORKFLOW_STAGES: { id: string; name: string; description: string; tool?: boolean }[] = [
  { id: 'plan', name: '任务规划', description: '理解目标、决定步骤与分工' },
];
export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const EFFORT_LABELS: Record<string, string> = { default: '模型默认', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' };
export function normalizeEffort(value?: string): string { return value === 'mid' ? 'medium' : value || 'default'; }
export function effortOptions(profile?: HubModelProfile | null) {
  const supported = new Set(['default', ...(profile?.capabilities?.efforts || []).map(normalizeEffort)]);
  return EFFORTS.map(value => ({ value, label: EFFORT_LABELS[value], supported: supported.has(value) }));
}
export function completeWorkflow(value?: Partial<WorkflowConfig> | null, skills: Pick<WorkflowSkill, 'id' | 'stageId' | 'enabled' | 'builtin'>[] = []): WorkflowConfig {
  return {
    version: 1, defaultProfileId: value?.defaultProfileId || null,
    stages: Object.fromEntries(WORKFLOW_STAGES.map(stage => {
      const saved = value?.stages?.[stage.id];
      const skill = skills.find(item => item.stageId === stage.id && item.enabled && item.builtin) || skills.find(item => item.stageId === stage.id && item.enabled);
      // 归档阶段的团队模式 / 多模型评审 / 子智能体配置不再保留，避免旧配置阻断保存。
      return [stage.id, { profileId: saved?.profileId || null, skillId: saved?.skillId || skill?.id || '', effort: normalizeEffort(saved?.effort), maxTokens: saved?.maxTokens ?? 8192, timeoutMs: saved?.timeoutMs ?? 300000 }];
    })),
  };
}
export function validateWorkflow(value: WorkflowConfig, profiles: HubModelProfile[], skills: Pick<WorkflowSkill, 'id' | 'stageId' | 'enabled'>[]): string[] {
  const errors: string[] = [];
  if (value.defaultProfileId && !profiles.some(item => item.id === value.defaultProfileId)) errors.push('工作流默认模型已不存在，请重新选择。');
  for (const stage of WORKFLOW_STAGES) {
    const config = value.stages[stage.id];
    if (!config) { errors.push(`${stage.name}：缺少配置。`); continue; }
    if (!Number.isInteger(config.maxTokens) || config.maxTokens < 256 || config.maxTokens > 32768) errors.push(`${stage.name}：输出 Token 预算应为 256–32768 的整数。`);
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000) errors.push(`${stage.name}：超时应为 1–600 秒的整数。`);
    if (!skills.some(item => item.id === config.skillId && item.enabled && item.stageId === stage.id)) errors.push(`${stage.name}：请选择此阶段可用的 Skill。`);
    if(config.subagents && (!['insights','report'].includes(stage.id) || config.subagents.length>3 || new Set(config.subagents.map(s=>s.id)).size!==config.subagents.length || config.subagents.some(s=>!s.id.trim()||!s.name.trim()||s.name.length>100||!s.role.trim()||s.role.length>300||!profiles.some(p=>p.id===s.profileId&&!p.unavailable)||s.profileId===(config.profileId??value.defaultProfileId))))errors.push('子智能体配置无效');
    if (config.review !== undefined) {
      const ids = config.review?.reviewerProfileIds;
      if (stage.id !== 'insights') errors.push(`${stage.name}：多模型评审仅允许洞察阶段。`);
      if (!Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length) errors.push(`${stage.name}：评审员最多3位且不能重复。`);
      else for (const reviewerId of ids) {
        const reviewer = profiles.find(item => item.id === reviewerId);
        if (!reviewer || reviewer.unavailable || reviewerId === (config.profileId ?? value.defaultProfileId)) errors.push(`${stage.name}：评审员须存在且不能与裁判相同。`);
        else if (!effortOptions(reviewer).some(option => option.value === normalizeEffort(config.effort) && option.supported)) errors.push(`${stage.name}：评审员模型不支持所选思考强度。`);
      }
    }
    if (stage.tool) continue;
    const id = config.profileId || value.defaultProfileId;
    const profile = profiles.find(item => item.id === id);
    if (id && !profile) errors.push(`${stage.name}：模型配置已不存在，请重新选择。`);
    const effort = normalizeEffort(config.effort);
    const allowed = profile ? effortOptions(profile).some(option => option.value === effort && option.supported) : EFFORTS.some(value => value === effort);
    if (!allowed) errors.push(`${stage.name}：当前模型不支持所选思考强度，请明确选择可用档位。`);
  }
  return errors;
}
export function credentialPayload(input: CredentialInput, saved?: ModelCredential): CredentialInput {
  const apiKey = input.apiKey?.trim();
  if (!input.name.trim() || !input.provider.trim()) throw new Error('请填写凭据名称和供应商。');
  let url: URL;
  try { url = new URL(input.baseUrl.trim()); } catch { throw new Error('请填写有效的 API 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('API 地址需要 HTTPS；本机地址支持 HTTP，地址中不能包含账号或查询参数。');
  if (!apiKey && (!saved?.hasKey || saved.baseUrl.replace(/\/+$/, '') !== input.baseUrl.trim().replace(/\/+$/, '') || saved.protocol !== input.protocol)) throw new Error(saved ? '更换 API 地址或协议后，请重新输入对应的 API Key。' : '请输入 API Key。');
  return { name: input.name.trim(), provider: input.provider.trim(), baseUrl: input.baseUrl.trim().replace(/\/+$/, ''), protocol: input.protocol, ...(apiKey ? { apiKey } : {}) };
}
export function validateSkillFile(file: { name: string; size: number }): string | null {
  if (!/\.(md|markdown)$/i.test(file.name)) return '请选择 Markdown 文件（.md 或 .markdown）。';
  return file.size > 64 * 1024 ? 'Skill 文件不能超过 64KB。' : null;
}
