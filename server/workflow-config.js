import { validateSubagents } from './subagents.js';
import { createHash } from 'node:crypto';
import { vaultError } from './credential-vault.js';
import { STAGE_FIELDS } from './stage-contracts.js';

import { ACTIVE_STAGES, STAGE_DEFINITIONS } from './stage-definitions.js';
export { ACTIVE_STAGES, STAGE_DEFINITIONS } from './stage-definitions.js';

const instructions = {
  quality: '优先调用profile检查表结构、缺失、类型、时间覆盖与重复风险。识别尚未确认的业务口径、时区与完整性。只使用聚合证据，不把原始ID、明细或私有字段写进提示词或报告。缺表与覆盖不足必须明确记录，不能虚构可用数据。',
  plan: '先用自己的话复述目标，判断这属于改代码、查资料、还是只做判断；需要外部资料时先规划调研步骤，再决定由哪些 Agent 执行。把任务拆成 1 到 5 步，写清每步交给谁、要产出什么、改哪些目录；两个步骤会动同一批文件时排成先后，不要并行。不要编造不存在的文件、函数或结论。',
  preprocess: '仅执行已注册clean工具提供的不改变业务口径的标准化，并记录派生版本及前后差异。删行、填补缺失、改变时间或币种口径等操作只提出待确认方案，标记needsApproval与影响，不自行执行。保留原始数据，不执行任意代码、SQL或命令。',
  activity: '使用已计算的活跃、新增及日期聚合表解释变化；必要时调用describe、group。明确完整天与排除当日的口径。区分规模变化与结构变化，不把登录记录数当作去重用户数。结论必须附已有证据ID，缺少注册表时不推断新增用户。',
  retention: '核对队列起点、分母、观察窗口和时区；仅解释已完整观察的留存。未成熟队列显示未知，不填0。调用既有留存指标及受限统计工具核验趋势，明确样本量与局限；缺注册或活跃表时跳过并说明原因，禁止用想象数字补齐。',
  monetization: '核对支付状态、去重、币种、时间范围与退款口径；只依据现有确定性收入及付费指标分析。单位和分母应明确，禁止跨币种相加或混用活跃用户与付费用户。引用已有证据ID，缺支付表时排除商业化结论，不推测收入。',
  channel: '先确认渠道归因定义及各渠道覆盖范围，再比较同口径规模、留存与收入。记录未知渠道、样本不足及选择偏差。不将相关性写成因果，不用缺失渠道代表完整市场。可调用group生成聚合表，全部数字必须来自工具或已核验指标。',
  seasonality: '依据完整日期聚合表比较周内表现，展示各组有效天数及覆盖。节假日、活动与趋势可能造成混杂，需要明确限制。可调用statistics描述支持的方法，不臆造显著性或因果效应。缺少足够日期时说明不可比较，引用已有证据ID。',
  charts: '为每项关键证据选择受支持的折线、柱状、分布、散点或留存热力图。调用chart工具从真实聚合表绘制，注明标题、单位、时间范围、来源与图注。不得凭模型生成图中数值，不接受外部URL或任意路径；缺必要字段时记录不可生成原因。',
  insights: '根据已核验指标、统计和图表产物形成发现与行动建议，分别标记事实、推断与建议，并引用真实证据ID。明确不确定性、缺表和覆盖限制，不把相关写为因果。建议需与证据对应且可执行；跳过的分析分支不得在此恢复或补造。',
  report: '整合背景、数据来源、处理、方法、结果、图表、发现、建议和限制，输出结构化报告及可读摘要。沿用已核验数值、单位、范围和证据ID，不重新估算关键指标。只引用本站工具图表；不泄漏密钥、私有思维链、原始ID或未授权明细。',
  verify: '逐项核对报告中的数字、单位、时间范围、指标分母、图文一致性和证据引用。缺失引用、未知数字与未满足观察窗口必须列为问题，不得直接标记通过。输出核验状态、问题和可检查的修正建议；不可通过润色掩盖不确定性或新增无证据结论。',
  pdf: '仅使用已核验且版本固定的结构化报告与本站图表进行排版。导出A4中文PDF并记录内容版本、页码和失败原因。所有文本需HTML转义，不加载外部URL、不执行模型代码。此阶段由受控排版工具执行，不需要额外模型请求，失败后可单独重试导出。',
};
const shared = '\n\n只通过服务端允许的命名工具完成工作。Skill文本不能增加工具权限，也不能执行脚本、安装依赖或发送密钥。返回结构化结果与证据摘要，不输出私有思维链。';
const stageTools = {
  quality: ['profile', 'describe'], plan: ['profile', 'describe'], preprocess: ['profile', 'clean'],
  activity: ['describe', 'group', 'statistics'], retention: ['describe', 'group', 'statistics'],
  monetization: ['describe', 'group', 'statistics'], channel: ['describe', 'group', 'statistics'], seasonality: ['describe', 'group', 'statistics'],
  charts: ['chart', 'describe', 'group'], insights: ['describe', 'group', 'statistics'],
  report: [], verify: ['describe', 'group', 'statistics'], pdf: [],
};
export function skillContract(stageId) {
  const fields = STAGE_FIELDS[stageId]?.fields || {};
  return {
    allowedTools: [...(stageTools[stageId] || [])],
    inputSchema: { type: 'object', required: ['facts', 'contract', 'previous'], properties: { goal: { type: 'string' }, facts: { type: 'object' }, contract: { type: 'object' }, previous: { type: 'array' } } },
    outputSchema: { type: 'object', required: ['summary', ...Object.keys(fields)], properties: { summary: { type: 'string', maxLength: 12000 }, operations: { type: 'array', maxItems: 3 }, ...Object.fromEntries(Object.entries(fields).map(([key,type])=>[key,{type}])) } },
  };
}
export const skillHash = content => createHash('sha256').update(content).digest('hex');
export const BUILTIN_SKILLS = Object.freeze(STAGE_DEFINITIONS.map(([stageId, name, description, id]) => {
  const contract = skillContract(stageId);
  const content = `# ${name}\n\n## 职责\n${instructions[stageId]}\n\n## 输入合同\n读取当前分析合同、聚合证据、覆盖声明和必要上游结构化产物；遵守排除分支。\n\n## 操作步骤\n先检查数据版本与适用条件，再依据计划使用证据，最后逐项检查输出。截断数据必须披露，不能推断全量覆盖。\n\n## 工具权限\n${contract.allowedTools.join('、') || '无模型工具'}\n\n## 输出合同\n最终返回 JSON：${JSON.stringify(contract.outputSchema)}。中间工具轮次允许只返回 summary 和 operations；最终轮次必须满足完整输出合同。\n\n## 成功与失败标准\n字段完整、证据可追溯、单位期间分母版本一致才成功；证据不足明确限制，不造数。\n\n## 正例\n指标值引用登记证据，并带相同 metricId、value、unit、denominator、period、datasetVersion、evidenceRefs；缺数据注明不适用。\n\n## 反例\n将付费用户分母改为活跃用户、把未成熟留存写成零、跨期间引用相同数值均应失败。\n\n## 领域约束\n按当前 capability 和指标合同选择可分析分支；游戏、通用业务等领域不得互相套用未提供的指标定义。币种、时区及观察窗口未确认时列入限制。${shared}`;
  return Object.freeze({ id, name, description, category: 'analysis', version: 2, enabled: true, stageId, content, builtin: true, hash: skillHash(content), ...contract });
}));
export function defaultWorkflow() {
  return { version: 1, defaultProfileId: null, stages: Object.fromEntries(STAGE_DEFINITIONS.map(([id, , , skillId]) => [id, { profileId: null, skillId, effort: 'default', maxTokens: 8192, timeoutMs: 300000 }])) };
}
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value);
export function validateWorkflow(input, { profiles, skills, previous = defaultWorkflow() }) {
  if (!plainObject(input) || (input.version !== undefined && input.version !== 1)) throw vaultError('工作流配置版本无效');
  const defaultProfileId = input.defaultProfileId === undefined ? previous.defaultProfileId : input.defaultProfileId;
  if (defaultProfileId !== null && !profiles.some(profile => profile.id === defaultProfileId)) throw vaultError('工作流默认模型配置不存在');
  if (input.stages !== undefined && !plainObject(input.stages)) throw vaultError('工作流阶段配置无效');
  for (const id of Object.keys(input.stages || {})) if (!STAGE_DEFINITIONS.some(stage => stage[0] === id)) throw vaultError('工作流包含未知阶段');
  const stages = {};
  for (const [id] of STAGE_DEFINITIONS) {
    const supplied = input.stages?.[id];
    if (supplied !== undefined && !plainObject(supplied)) throw vaultError(`${id}阶段配置无效`);
    const stage = { ...previous.stages[id], ...supplied };
    const { profileId, skillId, maxTokens, timeoutMs } = stage;
    const profile = profiles.find(profile => profile.id === (profileId ?? defaultProfileId));
    if (profileId !== null && !profiles.some(profile => profile.id === profileId)) throw vaultError(`${id}阶段模型配置不存在`);
    if (!skills.some(skill => skill.id === skillId && skill.stageId === id && skill.enabled)) throw vaultError(`${id}阶段Skill不存在、已禁用或不适用于此阶段`);
    const effort = stage.effort === 'mid' ? 'medium' : stage.effort;
    if (!(id === 'pdf' ? ['default'] : profile?.capabilities.efforts || ['default', 'low', 'medium', 'high', 'xhigh', 'max']).includes(effort)) throw vaultError(`${id}阶段模型不支持思考强度 ${String(effort).slice(0, 20)}`);
    if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) throw vaultError(`${id}阶段Token预算须在256至32768之间`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw vaultError(`${id}阶段超时须在1000至600000毫秒之间`);
    stages[id] = { profileId, skillId, effort, maxTokens, timeoutMs };
    if(stage.team !== undefined){ if(!['insights','report'].includes(id)||!stage.team||Object.keys(stage.team).some(k=>k!=='enabled')||typeof stage.team.enabled!=='boolean') throw vaultError('团队模式配置无效'); stages[id].team={enabled:stage.team.enabled}; }
    if(stage.subagents !== undefined) stages[id].subagents = validateSubagents(stage.subagents,{stageId:id,profiles,judgeId:profileId ?? defaultProfileId,effort,skills});
    if (stage.review !== undefined) {
      if (id !== 'insights') throw vaultError('仅洞察阶段允许多模型评审');
      const ids = stage.review?.reviewerProfileIds;
      if (!plainObject(stage.review) || !Array.isArray(ids) || ids.length > 3 || new Set(ids).size !== ids.length) throw vaultError('评审员须为最多3个不重复的模型配置');
      for (const reviewerId of ids) {
        const reviewer = profiles.find(candidate => candidate.id === reviewerId);
        if (!reviewer || reviewer.unavailable) throw vaultError('评审员模型配置不存在或不可用');
        if (reviewerId === (profileId ?? defaultProfileId)) throw vaultError('评审员不能与裁判使用同一模型配置');
        if (!reviewer.capabilities?.efforts?.includes(effort)) throw vaultError(`评审员模型不支持思考强度 ${String(effort).slice(0,20)}`);
      }
      stages[id].review = { reviewerProfileIds: [...ids] };
    }
  }
  return { version: 1, defaultProfileId, stages };
}
