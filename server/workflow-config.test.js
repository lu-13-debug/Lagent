import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('./workflow-config.js').catch(() => ({}));
test('team字段白名单、阶段边界及关闭时单层配置兼容',()=>{
 const options={profiles:[{id:'judge',capabilities:{efforts:['default']}},{id:'reader',capabilities:{efforts:['default']}}],skills:module.BUILTIN_SKILLS};const row={id:'r',profileId:'reader',name:'核查',role:'核对'};
 for(const [stage,team] of [['activity',{enabled:true}],['insights',{enabled:true,extra:1}],['report',{enabled:'yes'}]])assert.throws(()=>module.validateWorkflow({defaultProfileId:'judge',stages:{[stage]:{team}}},options));
 for(const enabled of [true,false]){const result=module.validateWorkflow({defaultProfileId:'judge',stages:{insights:{team:{enabled},subagents:[row]}}},options);assert.equal(result.stages.insights.team.enabled,enabled);assert.deepEqual(result.stages.insights.subagents,[row]);}
 assert.equal(Object.hasOwn(module.validateWorkflow({defaultProfileId:'judge'},options).stages.insights,'team'),false);
});
test('评审模型沿用裁判强度且无评审字段时旧配置保持不变', () => {
  const profiles = [{id:'judge',capabilities:{efforts:['default','high']}},{id:'reviewer',capabilities:{efforts:['default']}}];
  const options={profiles,skills:module.BUILTIN_SKILLS};
  const config=module.validateWorkflow({defaultProfileId:'judge'},options);
  assert.equal(Object.hasOwn(config.stages.insights,'review'),false);
  assert.throws(()=>module.validateWorkflow({defaultProfileId:'judge',stages:{insights:{effort:'high',review:{reviewerProfileIds:['reviewer']}}}},options),/评审员.*不支持/);
  assert.deepEqual(module.validateWorkflow({defaultProfileId:'judge',stages:{insights:{review:{reviewerProfileIds:[]}}}},options).stages.insights.review,{reviewerProfileIds:[]});
});
test('产品侧只启用任务规划阶段，归档阶段定义仍保留', () => {
  assert.deepEqual(module.ACTIVE_STAGES, ['plan']);
  assert.equal(module.STAGE_DEFINITIONS.length, 13);
});
test('固定13阶段均有实际内置Skill和版本，PDF是工具节点', () => {
  assert.equal(typeof module.defaultWorkflow, 'function', '必须提供工作流配置');
  assert.deepEqual(module.STAGE_DEFINITIONS.map(stage => stage[0]), ['quality','plan','preprocess','activity','retention','monetization','channel','seasonality','charts','insights','report','verify','pdf']);
  const workflow = module.defaultWorkflow();
  for (const [stageId, , , skillId] of module.STAGE_DEFINITIONS) {
    assert.equal(workflow.stages[stageId].skillId, skillId);
    assert.ok(module.BUILTIN_SKILLS.some(skill => skill.id === skillId && skill.stageId === stageId && skill.content.length > 100 && skill.version === 2));
  }
});
test('强度按模型能力二次校验，mid归一化但不静默降档', () => {
  assert.equal(typeof module.validateWorkflow, 'function', '必须校验阶段配置');
  const profiles = [{ id: 'p', capabilities: { efforts: ['default','low','medium','high'], tools: true } }];
  const options = { profiles, skills: module.BUILTIN_SKILLS };
  const input = { defaultProfileId: 'p', stages: { plan: { effort: 'mid' } } };
  const config = module.validateWorkflow(input, options);
  assert.equal(config.stages.plan.effort, 'medium');
  assert.throws(() => module.validateWorkflow({ ...input, stages: { plan: { effort: 'max' } } }, options), /不支持/);
  assert.throws(() => module.validateWorkflow({ defaultProfileId: 'missing' }, options), /模型配置/);
  assert.throws(() => module.validateWorkflow({ stages: { extra: {} } }, options), /阶段/);
  assert.throws(() => module.validateWorkflow({ stages: { plan: { skillId: 'skill-quality' } } }, options), /Skill|阶段/);
  assert.throws(() => module.validateWorkflow({ stages: { plan: { maxTokens: 1 } } }, options), /预算|Token/);
});
test('关闭工作流保留未使用的强度，重新启用时按模型能力重新核验', () => {
  const profiles = [{ id: 'p', capabilities: { efforts: ['default', 'high'] } }, { id: 'q', capabilities: { efforts: ['default'] } }];
  const options = { profiles, skills: module.BUILTIN_SKILLS };
  const active = module.validateWorkflow({ defaultProfileId: 'p', stages: { plan: { effort: 'high' } } }, options);
  const disabled = module.validateWorkflow({ defaultProfileId: null }, { ...options, previous: active });
  assert.equal(disabled.defaultProfileId, null); assert.equal(disabled.stages.plan.effort, 'high');
  assert.throws(() => module.validateWorkflow({ defaultProfileId: 'q' }, { ...options, previous: disabled }), /不支持/);
  assert.throws(() => module.validateWorkflow({ stages: { plan: { effort: 'ultra' } } }, options), /不支持/);
});
test('Skill合同提供固定工具权限和输入输出schema，私人正文不能扩权', () => {
  const skill = module.BUILTIN_SKILLS.find(skill => skill.stageId === 'quality');
  assert.ok(Array.isArray(skill.allowedTools)); assert.ok(skill.allowedTools.includes('profile')); assert.equal(skill.allowedTools.includes('shell'), false);
  assert.equal(skill.inputSchema.type, 'object'); assert.ok(skill.outputSchema.required.includes('summary'));
});
test('v2阶段schema独立且内置更新不修改旧Skill对象',()=>{
 const legacy={...module.BUILTIN_SKILLS[0],version:1,content:'私人旧正文',hash:'frozen'};
 const before=structuredClone(legacy);
 module.validateWorkflow({}, {profiles:[],skills:[legacy,...module.BUILTIN_SKILLS.slice(1)]});
 assert.deepEqual(legacy,before);
 assert.ok(module.skillContract('plan').outputSchema.required.includes('evidenceRequirements'));
 assert.ok(module.skillContract('charts').outputSchema.required.includes('figures'));
 assert.ok(module.skillContract('verify').outputSchema.required.includes('checks'));
});
