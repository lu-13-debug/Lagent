import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = await import('./workflow-types.ts').catch(() => ({}));
const profile = { id: 'p1', name: '分析模型', credentialId: 'c1', model: 'known-model', capabilities: { efforts: ['default', 'low', 'medium', 'high'], tools: true } };
const stages = ['quality', 'plan', 'preprocess', 'activity', 'retention', 'monetization', 'channel', 'seasonality', 'charts', 'insights', 'report', 'verify', 'pdf'];
const skills = stages.map(stageId => ({ id: 'skill-' + stageId, name: stageId, stageId, enabled: true, builtin: true }));

test('工作流补齐13阶段、保留预算与阶段覆盖，PDF标记工具节点', () => {
  assert.equal(typeof workflow.completeWorkflow, 'function');
  const value = workflow.completeWorkflow({ version: 1, defaultProfileId: 'p1', stages: { plan: { profileId: 'p2', skillId: 'mine', effort: 'mid', maxTokens: 1234, timeoutMs: 60000 } } }, skills);
  assert.deepEqual(Object.keys(value.stages), stages);
  assert.deepEqual(value.stages.plan, { profileId: 'p2', skillId: 'mine', effort: 'medium', maxTokens: 1234, timeoutMs: 60000 });
  assert.equal(value.stages.quality.skillId, 'skill-quality');
  assert.equal(value.stages.quality.profileId, null);
  assert.equal(workflow.WORKFLOW_STAGES.at(-1).tool, true);
});

test('mid只映射medium，未知档位不会静默降级', () => {
  assert.equal(typeof workflow.normalizeEffort, 'function');
  assert.equal(workflow.normalizeEffort('mid'), 'medium');
  assert.equal(workflow.normalizeEffort('max'), 'max');
  assert.equal(workflow.normalizeEffort('unsupported'), 'unsupported');
});

test('可选强度取模型能力，未知模型只开放默认，明确显示不支持档位', () => {
  assert.equal(typeof workflow.effortOptions, 'function');
  const known = workflow.effortOptions(profile);
  assert.deepEqual(known.filter(item => item.supported).map(item => item.value), ['default', 'low', 'medium', 'high']);
  assert.equal(known.find(item => item.value === 'max').supported, false);
  assert.deepEqual(workflow.effortOptions(null).filter(item => item.supported).map(item => item.value), ['default']);
});

test('校验继承模型、显式覆盖、Skill阶段和预算，不对PDF要求模型', () => {
  assert.equal(typeof workflow.validateWorkflow, 'function');
  const value = workflow.completeWorkflow({ version: 1, defaultProfileId: 'p1', stages: {} }, skills);
  assert.deepEqual(workflow.validateWorkflow(value, [profile], skills), []);
  value.stages.report.effort = 'max';
  value.stages.plan.maxTokens = 255;
  value.stages.activity.timeoutMs = 600001;
  value.stages.charts.skillId = 'skill-plan';
  const errors = workflow.validateWorkflow(value, [profile], skills).join(' ');
  assert.match(errors, /报告撰写.*强度/);
  assert.match(errors, /分析计划.*Token/);
  assert.match(errors, /活跃.*超时/);
  assert.match(errors, /图表.*Skill/);
});

test('未开启工作流仍校验预算和Skill，但允许未分配模型', () => {
  const value = workflow.completeWorkflow(null, skills);
  assert.deepEqual(workflow.validateWorkflow(value, [], skills), []);
  value.stages.report.maxTokens = NaN;
  assert.match(workflow.validateWorkflow(value, [], skills).join(' '), /Token/);
});

test('关闭工作流保留继承阶段的强度偏好，重新启用时再检查模型能力', () => {
  const value = workflow.completeWorkflow(null, skills);
  value.stages.report.effort = 'max';
  assert.deepEqual(workflow.validateWorkflow(value, [], skills), []);
  value.defaultProfileId = 'p1';
  assert.match(workflow.validateWorkflow(value, [profile], skills).join(' '), /报告撰写.*强度/);
});

test('凭据写入只含允许字段，地址或协议变更必须重填Key', () => {
  assert.equal(typeof workflow.credentialPayload, 'function');
  const saved = { id: 'c1', name: '个人凭据', provider: 'Custom', baseUrl: 'https://model.example/v1', protocol: 'chat-completions', hasKey: true, keyHint: 'test', version: 1 };
  assert.deepEqual(workflow.credentialPayload({ ...saved, apiKey: '' }, saved), { name: '个人凭据', provider: 'Custom', baseUrl: 'https://model.example/v1', protocol: 'chat-completions' });
  assert.throws(() => workflow.credentialPayload({ ...saved, baseUrl: 'https://other.example/v1', apiKey: '' }, saved), /重新输入/);
  assert.throws(() => workflow.credentialPayload({ ...saved, protocol: 'responses', apiKey: '' }, saved), /重新输入/);
  assert.throws(() => workflow.credentialPayload({ ...saved, apiKey: '' }), /Key/);
  assert.equal(workflow.credentialPayload({ ...saved, apiKey: 'fake-test-key' }).apiKey, 'fake-test-key');
});

test('私人Skill导入只接受64KB以内Markdown文本', () => {
  assert.equal(typeof workflow.validateSkillFile, 'function');
  assert.equal(workflow.validateSkillFile({ name: 'SKILL.md', size: 65536 }), null);
  assert.match(workflow.validateSkillFile({ name: 'skill.md', size: 65537 }), /64/);
  assert.match(workflow.validateSkillFile({ name: 'script.js', size: 10 }), /Markdown/);
});

test('洞察评审默认关闭并校验阶段、数量、引用和强度', () => {
 const profiles=[profile,{...profile,id:'p2'},{...profile,id:'p3',capabilities:{efforts:['default'],tools:false}}];
 const config=workflow.completeWorkflow({defaultProfileId:'p1'},skills);
 assert.deepEqual(config.stages.insights.review,{reviewerProfileIds:[]});
 const errors=(ids,stage='insights')=>workflow.validateWorkflow({...config,stages:{...config.stages,[stage]:{...config.stages[stage],review:{reviewerProfileIds:ids}}}},profiles,skills).join('；');
 assert.equal(errors(['p2']),'');
 for(const ids of [['p1'],['missing'],['p2','p2'],['p2','p3','p1','missing']]) assert.match(errors(ids),/评审/);
 assert.match(errors(['p2'],'activity'),/洞察/);
 config.stages.insights.effort='high';assert.match(errors(['p3']),/强度/);
 config.stages.insights.effort='default'; profiles[1].unavailable=true;assert.match(errors(['p2']),/评审/);
});
