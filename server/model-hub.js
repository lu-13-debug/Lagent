import { randomUUID } from 'node:crypto';
import { CredentialVault, vaultError } from './credential-vault.js';
import { createProviderPool } from './provider-pool.js';
import { chat, validateSettings } from './gateway.js';
import { listModels } from './model-catalog.js';
import { modelCapabilities, validateEffort } from './model-protocol.js';
import { modelCallEntry } from './model-usage.js';
import { STAGE_DEFINITIONS, BUILTIN_SKILLS, defaultWorkflow, validateWorkflow, skillHash, skillContract } from './workflow-config.js';
import { normalizeVerify } from './work/verify.js';

const field = (value, label, max, required = true) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw vaultError(`${label}须为${required ? '非空' : ''}文本，最多${max}字`);
  return value.trim();
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// 思考强度与前端 EFFORTS 同一套取值；'mid' 是旧别名的兼容写法。
const normalizeEffort = value => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'default';
  return raw === 'mid' ? 'medium' : raw;
};
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

export function parseWorkPlanReply(reply, executors, windows = []) {
  const raw = String(reply || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw vaultError('规划模型返回格式无效', 502);
  let parsed;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { throw vaultError('规划模型返回格式无效', 502); }
  const steps = Array.isArray(parsed?.steps) ? parsed.steps : null;
  if (!steps || steps.length < 2 || steps.length > 5) throw vaultError('规划模型必须返回 2–5 个步骤', 502);
  const allowed = new Set(executors);
  return steps.map((step, index) => {
    const executorId = typeof step?.executorId === 'string' ? step.executorId.trim() : '';
    if (!allowed.has(executorId)) throw vaultError(`规划第 ${index + 1} 步使用了不可用执行器`, 502);
    const text = typeof step?.text === 'string' ? step.text.trim() : '';
    if (!text || text.length > 500) throw vaultError(`规划第 ${index + 1} 步说明无效`, 502);
    const reason = typeof step?.reason === 'string' ? step.reason.trim().slice(0, 300) : '';
    const windowHandle = Number(step?.executorInput?.handle);
    const windowTarget = executorId === 'window' ? windows.find(item => item.handle === windowHandle) : null;
    if (executorId === 'window' && !windowTarget) throw vaultError(`规划第 ${index + 1} 步引用了未知窗口`, 502);
    const rawDependsOn = Array.isArray(step?.dependsOn) ? step.dependsOn : [];
    const dependsOn = [...new Set(rawDependsOn)].filter(item => Number.isInteger(item) && item >= 0 && item < index);
    if (rawDependsOn.length !== dependsOn.length) throw vaultError(`规划第 ${index + 1} 步依赖无效`, 502);
    if (dependsOn.length > 3) throw vaultError(`规划第 ${index + 1} 步依赖过多`, 502);
    const scope = Array.isArray(step?.scope)
      ? step.scope.filter(item => typeof item === 'string' && item.trim() && item.trim().length <= 120).slice(0, 6).map(item => item.trim())
      : [];
    let verify;
    if (step?.verify !== undefined) {
      if (!step.verify || typeof step.verify !== 'object' || Array.isArray(step.verify)) throw vaultError(`规划第 ${index + 1} 步的 verify 无效`, 502);
      try {
        const normalized = normalizeVerify(step.verify);
        verify = { command: normalized.command, cwd: normalized.cwd, expect: normalized.expect, timeoutMs: normalized.timeoutMs };
      } catch (error) {
        throw vaultError(`规划第 ${index + 1} 步的验收命令无效：${error.message}`, 502);
      }
    }
    return { executorId, text, ...(reason ? { reason } : {}), ...(windowTarget ? { executorInput: { handle: windowTarget.handle, process: windowTarget.process, submit: true } } : {}), ...(scope.length ? { scope } : {}), ...(dependsOn.length ? { dependsOn } : {}), ...(verify ? { verify } : {}) };
  });
}

const PLAN_SYSTEM_PROMPT = '你是 Lagent 的任务规划器。把用户目标拆成 2–5 个步骤，只输出严格 JSON，不执行工具、不调用命令。步骤可以并行：没有 dependsOn 的步骤会同时进入待审批；dependsOn 只能引用更早步骤的编号（从 0 开始），最多 3 个，禁止环，后续步骤用依赖表达先后。executorId 只能从给定列表选择；每步 text 是给该执行器的一句可执行指令，最多 300 字；reason 可选，最多 100 字。claude-code、codex、model 都可以读写项目文件；要只读分析必须在 text 里明确写「只读、不修改文件」，要改文件时用 scope 标出允许改动的目录。id 以 -acp 结尾的步骤通过 ACP 协议驱动另一个只读 Agent，适合独立分析或交叉审查。窗口步骤必须使用 executorId=window，并在 executorInput 中给出 windows 列表里的 handle。不得输出密钥、凭据、URL 参数或原始数据。实现/验证类步骤可选带 verify：{"command":"npm test","expect":"exit=0"}；命令只能用 npm test / npm run test|build|lint|typecheck|check|coverage / pytest / python -m pytest / go test / cargo test / dotnet test / node --test / git diff --check，不要写 shell 管道、重定向或变量。格式：{"steps":[{"executorId":"...","text":"...","reason":"...","scope":["src/**"],"dependsOn":[0],"verify":{"command":"npm test","expect":"exit=0"}}]}';

export function registerModelHub(app, { store, ownerId = 'local', masterKey, assertModelSettings, fetchImpl = fetch }) {
  ownerId = String(ownerId);
  const vault = new CredentialVault({ store, ownerId, masterKey });
  const pool = createProviderPool({ store, vault, ownerId, fetchImpl });
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
  // 配置档可以绑定单条凭据，也可以绑定 Key 池；池对外只暴露凭据 ID 与 Key 尾号。
  const bindingFor = profile => {
    if (profile?.poolId) {
      const row = pool.get(profile.poolId);
      return { provider: row.provider, baseUrl: row.baseUrl, protocol: row.protocol, poolId: row.id, pool: row };
    }
    const credential = vault.get(profile.credentialId);
    return { provider: credential.provider, baseUrl: credential.baseUrl, protocol: credential.protocol, credentialId: credential.id, credential };
  };
  const settingsForBinding = (binding, model) => ({ provider: binding.provider, baseUrl: binding.baseUrl, protocol: binding.protocol, model });
  const assertSettings = settings => { try { assertModelSettings?.(settings); } catch (error) { throw vaultError(error.message, error.status || 400); } };
  const profiles = () => storedProfiles().map(profile => {
    let binding; try { binding = bindingFor(profile); } catch { /* 删除凭据/池后保留配置名称，便于用户重新关联。 */ }
    return { ...profile, capabilities: binding ? modelCapabilities(settingsForBinding(binding, profile.model)) : { efforts: ['default'], tools: false, reason: '引用的凭据或 Key 池已删除，请重新关联。' }, ...(!binding ? { unavailable: true } : {}) };
  });
  const publicState = () => ({ credentials: vault.list(), profiles: profiles(), pools: pool.list(), workflow: workflow(), skills: skills(), vault: vault.status() });
  const validateConfig = input => validateWorkflow(input, { profiles: profiles(), skills: skills(), previous: workflow() });
  // 把配置档绑定冻结成快照：单凭据记录 ID+版本，Key 池记录池版本与每个成员的凭据版本。
  const captureBinding = binding => {
    if (binding.poolId) {
      const row = pool.get(binding.poolId);
      const members = row.members.map(member => {
        const credential = vault.get(member.credentialId);
        vault.decrypt(credential.id, credential.version);
        return { credentialId: credential.id, credentialVersion: credential.version };
      });
      return { poolId: row.id, poolVersion: row.version, poolMembers: members };
    }
    const credential = vault.get(binding.credentialId);
    vault.decrypt(credential.id, credential.version);
    return { credentialId: credential.id, credentialVersion: credential.version };
  };
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
      const profile = profileById(stage.profileId ?? config.defaultProfileId), binding = bindingFor(profile);
      const settings = { ...settingsForBinding(binding, profile.model), effort: stage.effort };
      assertSettings(settings); validateEffort(settings);
      // 提前验证密钥可用，但只把 ID/版本引用写入快照。
      const captured = captureBinding(binding);
      stages[stageId] = { ...stage, stageId, ownerId, profileId: profile.id, profileVersion: profile.version, profileName: profile.name, ...captured, settings, skill: frozenSkill };
      if (stage.subagents?.length) stages[stageId].subagents = stage.subagents.map(child => {
        const profile = profileById(child.profileId), binding = bindingFor(profile);
        const settings = { ...settingsForBinding(binding, profile.model), effort: child.effort ?? stage.effort };
        assertSettings(settings); validateEffort(settings);
        const captured = captureBinding(binding);
        return {...child,effort:child.effort ?? stage.effort,skill:structuredClone(child.skillId ? skills().find(s=>s.id===child.skillId) : frozenSkill),ownerId,model:profile.model,profileName:profile.name,...captured,settings,maxTokens:child.maxTokens || stage.maxTokens,timeoutMs:child.timeoutMs || Math.min(stage.timeoutMs,300000)};
      });
      if (stageId === 'insights' && stage.review?.reviewerProfileIds.length) {
        stages[stageId].reviewers = stage.review.reviewerProfileIds.map(id => {
          const reviewer = profileById(id), binding = bindingFor(reviewer);
          const reviewerSettings = { ...settingsForBinding(binding, reviewer.model), effort: stage.effort };
          assertSettings(reviewerSettings); validateEffort(reviewerSettings);
          const captured = captureBinding(binding);
          return { ownerId, profileId: reviewer.id, profileName: reviewer.name, model: reviewer.model, ...captured, settings: reviewerSettings, maxTokens: stage.maxTokens, timeoutMs: stage.timeoutMs };
        });
      }
    }
    return freeze({ version: 1, ownerId, capturedAt: new Date().toISOString(), defaultProfileId: config.defaultProfileId, stages });
  };
  const suggestWorkPlan = async ({ goal, executors, agents, windows, project } = {}) => {
    // 与引擎的 4000 字上限保持一致，避免长目标被模型规划器静默拒绝后才回退本机 Agent。
    const goalText = field(goal, '计划目标', 4000);
    const allowed = [...new Set((Array.isArray(executors) ? executors : []).filter(id => typeof id === 'string' && id.trim() && id.length <= 60).map(id => id.trim()))].slice(0, 12);
    if (!allowed.length) throw vaultError('没有可用于规划的执行器');
    const agentList = (Array.isArray(agents) ? agents : []).filter(item => object(item) && allowed.includes(item.id)).slice(0, 12)
      .map(item => ({ id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 80) : item.id, kind: typeof item.kind === 'string' ? item.kind.slice(0, 40) : 'unknown', ...(Array.isArray(item.capabilities) ? { capabilities: item.capabilities.filter(entry => typeof entry === 'string').slice(0, 12).map(entry => entry.slice(0, 80)) } : {}) }));
    const plannerExecutors = agentList.length ? agentList : allowed.map(id => ({ id }));
    const windowList = (Array.isArray(windows) ? windows : []).slice(0, 20).map(item => ({ handle: Number(item?.handle), process: typeof item?.process === 'string' ? item.process.slice(0, 80) : '', title: typeof item?.title === 'string' ? item.title.slice(0, 160) : '' })).filter(item => Number.isSafeInteger(item.handle) && item.handle > 0);
    const captured = captureWorkflow();
    const stage = captured.stages.plan;
    const modelContext = context(stage);
    let usage = null;
    const reply = await chat({
      settings: modelContext.settings,
      key: modelContext.key,
      pool: modelContext.pool,
      poolId: modelContext.poolId,
      maxTokens: 1600,
      timeoutMs: Math.min(modelContext.timeoutMs, 60000),
      messages: [{ role: 'system', content: PLAN_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify({ goal: goalText, executors: plannerExecutors, windows: windowList, project: project && typeof project === 'object' ? { name: typeof project.name === 'string' ? project.name.slice(0, 80) : '', path: typeof project.path === 'string' ? project.path.slice(0, 300) : '', gitBranch: typeof project.gitBranch === 'string' ? project.gitBranch.slice(0, 80) : '', memory: typeof project.memory === 'string' ? project.memory.slice(0, 1600) : '' } : null }) }],
      fetchImpl: modelContext.fetchImpl,
      onUsage: value => { usage = value || null; }
    });
    const steps = parseWorkPlanReply(reply, allowed, windowList);
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
    if (stage.poolId) {
      const row = pool.get(stage.poolId);
      if ((row.version || 1) !== (stage.poolVersion || 1)) throw vaultError('Key 池已变更，请重新创建任务', 409);
      const keys = [];
      for (const member of stage.poolMembers || []) {
        const credential = vault.get(member.credentialId);
        if (credential.version !== member.credentialVersion) throw vaultError('Key 池中的凭据已变更，请重新创建任务', 409);
        if (credential.baseUrl !== stage.settings.baseUrl || credential.protocol !== stage.settings.protocol) throw vaultError('凭据与阶段接口绑定不匹配', 409);
        keys.push(vault.decrypt(credential.id, credential.version));
      }
      if (!keys.length) throw vaultError('Key 池快照为空，请重新创建任务', 409);
      assertSettings(stage.settings); validateEffort(stage.settings);
      return {
        settings: structuredClone(stage.settings),
        // key 仅用于日志脱敏的兼容字段；真正请求由 pool 逐 Key 选择。
        key: keys[0],
        pool,
        poolId: row.id,
        redact: value => keys.reduce((text, key) => text.split(key).join('[已隐藏凭据]'), String(value ?? '')),
        maxTokens: stage.maxTokens,
        timeoutMs: stage.timeoutMs,
        fetchImpl
      };
    }
    const credential = vault.get(stage.credentialId);
    if (credential.version !== stage.credentialVersion) throw vaultError('凭据版本已变更，请重新创建任务', 409);
    if (credential.baseUrl !== stage.settings.baseUrl || credential.protocol !== stage.settings.protocol) throw vaultError('凭据与阶段接口绑定不匹配', 409);
    assertSettings(stage.settings); validateEffort(stage.settings);
    return { settings: structuredClone(stage.settings), key: vault.decrypt(stage.credentialId, stage.credentialVersion), maxTokens: stage.maxTokens, timeoutMs: stage.timeoutMs, fetchImpl };
  };
  // 会话级模型：允许内置模型 Agent 用指定的模型配置，而不是全局默认模型。
  // 思考强度也随会话走：不支持该档位的模型会当场报错，而不是静默降级成默认档。
  const contextForProfile = (profileId, effort = 'default') => {
    const profile = profileById(field(profileId, '模型配置ID', 100));
    const binding = bindingFor(profile);
    const config = workflow();
    const stage = config.stages.plan || {};
    const settings = { ...settingsForBinding(binding, profile.model), effort: normalizeEffort(effort) };
    assertSettings(settings);
    // 未在能力表里确认过的档位也允许尝试：执行器在供应商明确拒绝时会退回默认档重试，
    // 并在结果里标注「已按默认档执行」，所以这里只拦明显非法的取值。
    if (!['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(settings.effort)) {
      throw vaultError('思考强度取值无效');
    }
    if (binding.poolId) {
      return {
        settings,
        pool,
        poolId: binding.poolId,
        maxTokens: Number.isSafeInteger(stage.maxTokens) ? stage.maxTokens : 8192,
        timeoutMs: Number.isSafeInteger(stage.timeoutMs) ? Math.min(stage.timeoutMs, 300000) : 300000,
        fetchImpl,
        profileId: profile.id,
        profileName: profile.name
      };
    }
    return {
      settings,
      key: vault.decrypt(binding.credentialId),
      maxTokens: Number.isSafeInteger(stage.maxTokens) ? stage.maxTokens : 8192,
      timeoutMs: Number.isSafeInteger(stage.timeoutMs) ? Math.min(stage.timeoutMs, 300000) : 300000,
      fetchImpl,
      profileId: profile.id,
      profileName: profile.name
    };
  };
  // Express 5处理async异常；统一输入错误为400，避免错误诊断暴露密钥。
  const route = handler => async (req, res) => {
    if (['POST', 'PUT'].includes(req.method) && req.body !== undefined && !object(req.body)) throw vaultError('请求内容须为对象');
    return handler(req, res);
  };
  app.get('/api/model-hub', (_req, res) => res.json(publicState()));
  // Key 池管理：成员只引用已有凭据；池的接口地址/协议必须与所有成员一致。
  app.get('/api/provider-pools', (_req, res) => res.json({ pools: pool.list() }));
  app.post('/api/provider-pools', route((req, res) => res.json({ pool: pool.save({ ...(req.body || {}) }) })));
  app.put('/api/provider-pools/:id', route((req, res) => res.json({ pool: pool.save({ ...(req.body || {}), id: req.params.id }) })));
  app.delete('/api/provider-pools/:id', route((req, res) => res.json(pool.remove(req.params.id))));
  app.get('/api/provider-pools/:id/explain', route((req, res) => res.json({ routing: pool.explain(req.params.id) })));
  app.post('/api/provider-pools/:id/test', route(async (req, res) => {
    const row = pool.get(req.params.id);
    const profile = storedProfiles().find(item => item.poolId === row.id);
    if (!profile) throw vaultError('请先为该 Key 池创建模型配置', 400);
    const checked = validateSettings({ provider: row.provider, baseUrl: row.baseUrl, protocol: row.protocol, model: profile.model });
    assertSettings(checked);
    await chat({ settings: { ...checked }, pool, poolId: row.id, maxTokens: 1024, timeoutMs: 30000, connectionTest: true, messages: [{ role: 'user', content: 'Reply with OK.' }], fetchImpl });
    res.json({ ok: true, message: 'Key 池连接成功；如首个 Key 失败，已自动切换到下一个。' });
  }));
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
    const poolId = typeof input.poolId === 'string' ? input.poolId.trim() : (input.poolId === null ? '' : (previous?.poolId || ''));
    let credentialId = '';
    let binding;
    if (poolId) {
      const row = pool.get(poolId);
      binding = { provider: row.provider, baseUrl: row.baseUrl, protocol: row.protocol, poolId: row.id };
    } else {
      credentialId = field(input.credentialId ?? previous?.credentialId, '凭据ID', 100);
      const credential = vault.get(credentialId);
      binding = { provider: credential.provider, baseUrl: credential.baseUrl, protocol: credential.protocol, credentialId };
    }
    const model = field(input.model ?? previous?.model, '模型ID', 200);
    let checked; try { checked = validateSettings({ ...settingsForBinding(binding, model), provider: binding.provider }); } catch (error) { throw vaultError(error.message); }
    assertSettings(checked);
    const profile = { id: previous?.id ?? randomUUID(), name, ...(poolId ? { poolId } : { credentialId }), model: checked.model, version: (previous?.version || 0) + 1 };
    store.config(profileKey, [...storedProfiles().filter(item => item.id !== profile.id), profile]);
    // 第一个模型配置自动成为默认模型：否则用户得再进「规划设置」手动选一次，
    // 而这正是内置模型 Agent 一直显示「未就绪」的常见原因。
    const config = workflow();
    if (!config.defaultProfileId) { config.defaultProfileId = profile.id; store.config(workflowKey, config); }
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
    for (const stage of Object.values(config.stages)) {
      if (stage.profileId === req.params.id) stage.profileId = null;
      // 子智能体与评审员也引用模型配置；不清理会让后续 captureWorkflow 校验失败，
      // 该账号的所有 AI 任务都无法再创建。
      if (Array.isArray(stage.subagents)) {
        stage.subagents = stage.subagents.filter(item => item.profileId !== req.params.id);
        if (!stage.subagents.length) delete stage.subagents;
      }
      if (stage.review?.reviewerProfileIds) {
        const ids = stage.review.reviewerProfileIds.filter(id => id !== req.params.id);
        if (ids.length) stage.review = { reviewerProfileIds: ids };
        else delete stage.review;
      }
    }
    store.config(profileKey, storedProfiles().filter(item => item.id !== req.params.id));
    // 删掉默认配置后补一个，避免整个工作流突然「没有默认模型」。
    if (!config.defaultProfileId) { const rest = storedProfiles(); if (rest.length) config.defaultProfileId = rest[0].id; }
    store.config(workflowKey, config); res.json({ ok: true });
  }));
  app.post('/api/model-profiles/:id/test', route(async (req, res) => {
    const profile = profileById(req.params.id), binding = bindingFor(profile), settings = settingsForBinding(binding, profile.model);
    assertSettings(settings);
    await chat({
      settings,
      key: binding.poolId ? undefined : vault.decrypt(binding.credentialId),
      pool: binding.poolId ? pool : undefined,
      poolId: binding.poolId,
      maxTokens: 1024,
      timeoutMs: 30000,
      connectionTest: true,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      fetchImpl
    });
    res.json({ ok: true, message: binding.poolId ? '连接成功；Key 池已按策略选择可用 Key。' : '连接成功，所选模型已返回有效响应。' });
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
    for (const [stageId, stage] of Object.entries(config.stages)) {
      if (stage.skillId === previous.id) stage.skillId = STAGE_DEFINITIONS.find(([id]) => id === stageId)[3];
      // 子智能体也能绑定独立 Skill；删掉 Skill 后同样要解除引用，否则校验失败。
      if (Array.isArray(stage.subagents)) {
        for (const item of stage.subagents) if (item.skillId === previous.id) delete item.skillId;
      }
    }
    store.config(skillKey, privateSkills().filter(skill => skill.id !== previous.id)); store.config(workflowKey, config); res.json({ ok: true });
  }));
  return { publicState, captureWorkflow, context, contextForProfile, suggestWorkPlan, reviewerContext, subagentContext: (stage,index) => { if(stage.ownerId !== ownerId || !['insights','report'].includes(stage.stageId) || !Number.isInteger(index) || !stage.subagents?.[index]) throw vaultError('子智能体快照无效',403); return context({...stage.subagents[index],stageId:stage.stageId}); } };
}
