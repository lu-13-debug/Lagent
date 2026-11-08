import { randomUUID } from 'node:crypto';
import { CredentialVault, vaultError } from './credential-vault.js';
import { chat, validateSettings } from './gateway.js';
import { listModels } from './model-catalog.js';
import { modelCapabilities, validateEffort } from './model-protocol.js';
import { modelCallEntry } from './model-usage.js';
import { STAGE_DEFINITIONS, BUILTIN_SKILLS, defaultWorkflow, validateWorkflow, skillHash, skillContract } from './workflow-config.js';

const field = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw vaultError(`${label}须为${required ? '非空' : ''}文本，最多${max}字`);
  return value.trim();
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function parseWorkPlanReply(reply, executors, datasets = [], windows = []) {
  const raw = String(reply || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw vaultError('规划模型返回格式无效', 502);
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { throw vaultError('规划模型返回格式无效', 502); }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : null;
  if (!steps || steps.length < 2 || steps.length > 5) throw vaultError('规划模型必须返回 2–5 个步骤', 502);
  const allowed = new Set(executors);
  const datasetIds = new Set(datasets.map(item => item?.id).filter(id => typeof id === 'string'));
  return steps.map((step, index) => {
    const executorId = typeof step?.executorId === 'string' ? step.executorId.trim() : '';
    if (!allowed.has(executorId)) throw vaultError(`规划第 ${index + 1} 步使用了不可用执行器`, 502);
    const text = typeof step?.text === 'string' ? step.text.trim() : '';
    if (!text || text.length > 500) throw vaultError(`规划第 ${index + 1} 步说明无效`, 502);
    const reason = typeof step?.reason === 'string' ? step.reason.trim().slice(0, 300) : '';
    const datasetId = typeof step?.datasetId === 'string' ? step.datasetId.trim() : '';
    if (datasetId && !datasetIds.has(datasetId)) throw vaultError(`规划第 ${index + 1} 步引用了未知数据集`, 502);
    const windowHandle = Number(step?.executorInput?.handle);
    const windowTarget = executorId === 'window' ? windows.find(item => item.handle === windowHandle) : null;
    if (executorId === 'window' && !windowTarget) throw vaultError(`规划第 ${index + 1} 步引用了未知窗口`, 502);
    const rawDependsOn = Array.isArray(step?.dependsOn) ? step.dependsOn : [];
    const dependsOn = [...new Set(rawDependsOn)].filter(item => Number.isInteger(item) && item >= 0 && item < index);
    if (rawDependsOn.length !== dependsOn.length) throw vaultError(`规划第 ${index + 1} 步依赖无效`, 502);
    if (dependsOn.length > 3) throw vaultError(`规划第 ${index + 1} 步依赖过多`, 502);
    return { executorId, text, ...(reason ? { reason } : {}), ...(datasetId ? { datasetId } : {}), ...(windowTarget ? { executorInput: { handle: windowTarget.handle, process: windowTarget.process, submit: true } } : {}), ...(dependsOn.length ? { dependsOn } : {}) };
  });
}

const PLAN_SYSTEM_PROMPT = '你是 DataAgent 的任务规划器。把用户目标拆成 2–5 个步骤，只输出严格 JSON，不执行工具、不调用命令。步骤可以并行：没有 dependsOn 的步骤会同时进入待审批；dependsOn 只能引用更早步骤的编号（从 0 开始），最多 3 个，禁止环，后续步骤用依赖表达先后。executorId 只能从给定列表选择；每步 text 是给该执行器的一句可执行指令，最多 300 字；reason 可选，最多 100 字。analysis 步骤如指定 datasetId 必须来自 datasets；codex/claude-code 目标是只读的；id 以 -acp 结尾的步骤通过 ACP 协议驱动另一个只读 Agent，适合独立分析或交叉审查。窗口步骤必须使用 executorId=window，并在 executorInput 中给出 windows 列表里的 handle。不得输出密钥、凭据、URL 参数或原始数据。格式：{"steps":[{"executorId":"...","text":"...","reason":"...","dependsOn":[0]}]}';

export function registerModelHub(app, { store, ownerId = 'local', masterKey, assertModelSettings, fetchImpl = fetch }) {
  ownerId = String(ownerId);
  const vault = new CredentialVault({ store, ownerId, masterKey });
  const profileKey = `model-hub-profiles-v1:${ownerId}`, skillKey = `model-hub-skills-v1:${ownerId}`, workflowKey = `model-hub-workflow-v1:${ownerId}`;
  const storedProfiles = () => store.config(profileKey) || [];
  const privateSkills = () => store.config(skillKey) || [];
  const skills = () => [...BUILTIN_SKILLS, ...privateSkills()];
  const workflow = () => store.config(workflowKey) || defaultWorkflow();
  const profileById = id => {
    const profile = storedProfiles().find(profile => profile.id === id);
    if (!profile) throw vaultError('模型配置不存在', 404);
    return profile;
  };
  const settingsFor = (credential, model) => ({ provider: credential.provider, baseUrl: credential.baseUrl, protocol: credential.protocol, model });
  const assertSettings = settings => { try { assertModelSettings?.(settings); } catch (error) { throw vaultError(error.message, error.status || 400); } };
  const profiles = () => storedProfiles().map(profile => {
    let credential; try { credential = vault.get(profile.credentialId); } catch { /* 删除凭据保留配置名称，便于用户重新关联。 */ }
    return { ...profile, capabilities: credential ? modelCapabilities(settingsFor(credential, profile.model)) : { efforts: ['default'], tools: false, reason: '引用的凭据已删除，请重新关联。' }, ...(!credential ? { unavailable: true } : {}) };
  });
  const publicState = () => ({ credentials: vault.list(), profiles: profiles(), workflow: workflow(), skills: skills(), vault: vault.status() });
  const validateConfig = input => validateWorkflow(input, { profiles: profiles(), skills: skills(), previous: workflow() });
  const captureWorkflow = () => {
    const config = validateConfig(workflow());
    if (!config.defaultProfileId) throw vaultError('请先选择工作流默认模型');
    const stages = {};
    for (const [stageId] of STAGE_DEFINITIONS) {
      const stage = config.stages[stageId], skill = skills().find(skill => skill.id === stage.skillId);
      const frozenSkill = structuredClone(skill);
      if (stageId === 'pdf') {
        stages[stageId] = { ...stage, stageId, ownerId, engine: 'pdf', profileId: null, settings: null, skill: frozenSkill };
        continue;
      }
      const profile = profileById(stage.profileId ?? config.defaultProfileId), credential = vault.get(profile.credentialId);
      const settings = { ...settingsFor(credential, profile.model), effort: stage.effort };
      assertSettings(settings); validateEffort(settings);
      // 提前验证密钥可用，但只把ID与版本引用写入快照。
      vault.decrypt(credential.id, credential.version);
      stages[stageId] = { ...stage, stageId, ownerId, profileId: profile.id, profileVersion: profile.version, profileName: profile.name, credentialId: credential.id, credentialVersion: credential.version, settings, skill: frozenSkill };
      if (stage.subagents?.length) stages[stageId].subagents = stage.subagents.map(child => {
        const profile = profileById(child.profileId), secret = vault.get(profile.credentialId);
        const settings = { ...settingsFor(secret, profile.model), effort: child.effort ?? stage.effort };
        assertSettings(settings); validateEffort(settings); vault.decrypt(secret.id, secret.version);
        return {...child,effort:child.effort ?? stage.effort,skill:structuredClone(child.skillId ? skills().find(s=>s.id===child.skillId) : frozenSkill),ownerId,model:profile.model,profileName:profile.name,credentialId:secret.id,credentialVersion:secret.version,settings,maxTokens:child.maxTokens || stage.maxTokens,timeoutMs:child.timeoutMs || Math.min(stage.timeoutMs,300000)};
      });
      if (stageId === 'insights' && stage.review?.reviewerProfileIds.length) {
        stages[stageId].reviewers = stage.review.reviewerProfileIds.map(id => {
          const reviewer = profileById(id), secret = vault.get(reviewer.credentialId);
          const reviewerSettings = { ...settingsFor(secret, reviewer.model), effort: stage.effort };
          assertSettings(reviewerSettings); validateEffort(reviewerSettings); vault.decrypt(secret.id, secret.version);
          return { ownerId, profileId: reviewer.id, profileName: reviewer.name, model: reviewer.model, credentialId: secret.id, credentialVersion: secret.version, settings: reviewerSettings, maxTokens: stage.maxTokens, timeoutMs: stage.timeoutMs };
        });
      }
    }
    return freeze({ version: 1, ownerId, capturedAt: new Date().toISOString(), defaultProfileId: config.defaultProfileId, stages });
  };
  const suggestWorkPlan = async ({ goal, executors, agents, datasets, windows } = {}) => {
    const goalText = field(goal, '计划目标', 300);
    const allowed = [...new Set((Array.isArray(executors) ? executors : []).filter(id => typeof id === 'string' && id.trim() && id.length <= 60).map(id => id.trim()))].slice(0, 12);
    if (!allowed.length) throw vaultError('没有可用于规划的执行器');
    const agentList = (Array.isArray(agents) ? agents : []).filter(item => object(item) && allowed.includes(item.id)).slice(0, 12)
      .map(item => ({ id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 80) : item.id, kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : 'unknown', ...(Array.isArray(item.capabilities) ? { capabilities: item.capabilities.filter(entry => typeof entry === 'string').slice(0, 12).map(entry => entry.slice(0, 80)) } : {}) }));
    const plannerExecutors = agentList.length ? agentList : allowed.map(id => ({ id }));
    const windowList = (Array.isArray(windows) ? windows : []).slice(0, 20).map(item => ({ handle: Number(item?.handle), process: typeof item?.process === 'string' ? item.process.slice(0, 80) : '', title: typeof item?.title === 'string' ? item.title.slice(0, 160) : '' })).filter(item => Number.isSafeInteger(item.handle) && item.handle > 0);
    const datasetList = (Array.isArray(datasets) ? datasets : []).filter(item => object(item) && typeof item.id === 'string' && item.id.length <= 120).slice(0, 10)
      .map(item => ({ id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 120) : item.id }));
    const captured = captureWorkflow();
    const stage = captured.stages.plan;
    const modelContext = context(stage);
    let usage = null;
    const reply = await chat({
      settings: modelContext.settings,
      key: modelContext.key,
      maxTokens: 1600,
      timeoutMs: Math.min(modelContext.timeoutMs, 60000),
      messages: [{ role: 'system', content: PLAN_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify({ goal: goalText, executors: plannerExecutors, datasets: datasetList, windows: windowList }) }],
      fetchImpl: modelContext.fetchImpl,
      onUsage: value => { usage = value || null; }
    });
    const steps = parseWorkPlanReply(reply, allowed, datasetList, windowList);
    if (usage) {
      try {
        store.put('model-call', modelCallEntry({
          call: { provider: modelContext.settings.provider, model: modelContext.settings.model, protocol: modelContext.settings.protocol, effort: modelContext.settings.effort, usage },
          taskId: null, stage: { id: 'work-plan', name: '任务规划' }, kind: 'planner', now: new Date().toISOString()
        }));
      } catch { /* 用量账本失败不阻断规划。 */ }
    }
    return { steps, usage: usage || null, model: { provider: modelContext.settings.provider, model: modelContext.settings.model } };
  };
  const reviewerContext = (stage, index) => {
    if (!object(stage) || stage.stageId !== 'insights' || stage.ownerId !== ownerId) throw vaultError('评审快照无效或不属于当前账号', 403);
    const reviewer = Number.isInteger(index) && stage.reviewers?.[index];
    if (!object(reviewer) || reviewer.ownerId !== ownerId) throw vaultError('评审员快照无效或不属于当前账号', 403);
    return context({ ...reviewer, stageId: 'insights' });
  };
  const context = stage => {
    if (!object(stage) || stage.ownerId !== ownerId || !object(stage.settings) || !STAGE_DEFINITIONS.some(([id]) => id === stage.stageId && id !== 'pdf')) throw vaultError('阶段模型快照无效或不属于当前账号', 403);
    const credential = vault.get(stage.credentialId);
    if (credential.version !== stage.credentialVersion) throw vaultError('凭据版本已变更，请重新创建任务', 409);
    if (credential.baseUrl !== stage.settings.baseUrl || credential.protocol !== stage.settings.protocol) throw vaultError('凭据与阶段接口绑定不匹配', 409);
    assertSettings(stage.settings); validateEffort(stage.settings);
    return { settings: structuredClone(stage.settings), key: vault.decrypt(stage.credentialId, stage.credentialVersion), maxTokens: stage.maxTokens, timeoutMs: stage.timeoutMs, fetchImpl };
  };
  // Express 5处理async异常；统一输入错误为400，避免错误诊断暴露密钥。
  const route = handler => async (req, res) => {
    if (['POST', 'PUT'].includes(req.method) && req.body !== undefined && !object(req.body)) throw vaultError('请求内容须为对象');
    return handler(req, res);
  };
  app.get('/api/model-hub', (_req, res) => res.json(publicState()));
  app.post('/api/model-credentials', route((req, res) => {
    // 主机策略在保存之前执行，禁用主机不能获得可使用的持久凭据。
    let candidate; try { candidate = validateSettings({ ...(req.body || {}), model: 'credential-validation' }); } catch (error) { throw vaultError(error.message); }
    assertSettings(candidate); res.json({ credential: vault.create(req.body) });
  }));
  app.put('/api/model-credentials/:id', route((req, res) => {
    const previous = vault.get(req.params.id);
    let candidate; try { candidate = validateSettings({ ...previous, ...req.body, model: 'credential-validation' }); } catch (error) { throw vaultError(error.message); }
    assertSettings(candidate); res.json({ credential: vault.update(req.params.id, req.body) });
  }));
  app.delete('/api/model-credentials/:id', route((req, res) => { vault.delete(req.params.id); res.json({ ok: true }); }));
  const saveProfile = (input, previous) => {
    const name = field(input.name ?? previous?.name, '模型配置名称', 80);
    const credentialId = field(input.credentialId ?? previous?.credentialId, '凭据ID', 100);
    const credential = vault.get(credentialId);
    const model = field(input.model ?? previous?.model, '模型ID', 200);
    let checked; try { checked = validateSettings({ ...settingsFor(credential, model), provider: credential.provider }); } catch (error) { throw vaultError(error.message); }
    assertSettings(checked);
    const profile = { id: previous?.id ?? randomUUID(), name, credentialId, model: checked.model, version: (previous?.version || 0) + 1 };
    store.config(profileKey, [...storedProfiles().filter(item => item.id !== profile.id), profile]);
    return profiles().find(item => item.id === profile.id);
  };
  app.post('/api/model-profiles', route((req, res) => {
    if (storedProfiles().length >= 200) throw vaultError('每个账号最多保存200个模型配置', 429);
    res.json({ profile: saveProfile(req.body || {}) });
  }));
  app.put('/api/model-profiles/:id', route((req, res) => res.json({ profile: saveProfile(req.body || {}, profileById(req.params.id)) })));
  app.delete('/api/model-profiles/:id', route((req, res) => {
    profileById(req.params.id); const config = workflow();
    if (config.defaultProfileId === req.params.id) config.defaultProfileId = null;
    for (const stage of Object.values(config.stages)) if (stage.profileId === req.params.id) stage.profileId = null;
    store.config(profileKey, storedProfiles().filter(item => item.id !== req.params.id)); store.config(workflowKey, config); res.json({ ok: true });
  }));
  app.post('/api/model-profiles/:id/test', route(async (req, res) => {
    const profile = profileById(req.params.id), credential = vault.get(profile.credentialId), settings = settingsFor(credential, profile.model);
    assertSettings(settings);
    await chat({ settings, key: vault.decrypt(credential.id), maxTokens: 1024, timeoutMs: 30000, connectionTest: true, messages: [{ role: 'user', content: 'Reply with OK.' }], fetchImpl });
    res.json({ ok: true, message: '连接成功，所选模型已返回有效响应。' });
  }));
  app.post('/api/model-credentials/:id/models', route(async (req, res) => {
    const credential = vault.get(req.params.id), settings = settingsFor(credential, 'catalog');
    assertSettings(settings); res.json(await listModels({ settings, key: vault.decrypt(credential.id), fetchImpl }));
  }));
  app.put('/api/workflow-config', route((req, res) => {
    const config = validateConfig(req.body); store.config(workflowKey, config); res.json({ workflow: config });
  }));
  const saveSkill = (input, previous) => {
    if (previous?.builtin) throw vaultError('内置Skill不可修改，请复制为个人Skill');
    const name = field(input.name ?? previous?.name, 'Skill名称', 80);
    const description = field(input.description ?? previous?.description ?? '', 'Skill说明', 500, false);
    const stageId = input.stageId ?? previous?.stageId;
    if (!STAGE_DEFINITIONS.some(([id]) => id === stageId)) throw vaultError('Skill适用阶段无效');
    const content = input.content ?? previous?.content;
    if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > 64 * 1024 || content.includes('\u0000')) throw vaultError('Skill须为非空Markdown文本，最多64KB');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw vaultError('Skill启用状态无效');
    const skill = { id: previous?.id ?? `private-${randomUUID()}`, name, description, stageId, content, category: 'private', version: (previous?.version || 0) + 1, builtin: false, enabled: input.enabled ?? previous?.enabled ?? true, hash: skillHash(content), ...skillContract(stageId) };
    store.config(skillKey, [...privateSkills().filter(item => item.id !== skill.id), skill]); return skill;
  };
  app.post('/api/workflow-skills', route((req, res) => {
    if (privateSkills().length >= 100) throw vaultError('每个账号最多保存100个个人Skill', 429);
    res.json({ skill: saveSkill(req.body || {}) });
  }));
  app.put('/api/workflow-skills/:id', route((req, res) => {
    const previous = skills().find(skill => skill.id === req.params.id);
    if (!previous) throw vaultError('Skill不存在', 404);
    res.json({ skill: saveSkill(req.body || {}, previous) });
  }));
  app.delete('/api/workflow-skills/:id', route((req, res) => {
    const previous = skills().find(skill => skill.id === req.params.id);
    if (!previous) throw vaultError('Skill不存在', 404);
    if (previous.builtin) throw vaultError('内置Skill不可删除');
    const config = workflow();
    for (const [stageId, stage] of Object.entries(config.stages)) if (stage.skillId === previous.id) stage.skillId = STAGE_DEFINITIONS.find(([id]) => id === stageId)[3];
    store.config(skillKey, privateSkills().filter(skill => skill.id !== previous.id)); store.config(workflowKey, config); res.json({ ok: true });
  }));
  return { publicState, captureWorkflow, context, suggestWorkPlan, reviewerContext, subagentContext: (stage,index) => { if(stage.ownerId !== ownerId || !['insights','report'].includes(stage.stageId) || !Number.isInteger(index) || !stage.subagents?.[index]) throw vaultError('子智能体快照无效',403); return context({...stage.subagents[index],stageId:stage.stageId}); } };
}
