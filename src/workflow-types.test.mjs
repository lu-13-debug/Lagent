import test from 'node:test';
import assert from 'node:assert/strict';

const workflow = await import('./workflow-types.ts').catch(() => ({}));
const profile = { id: 'p1', name: '分析模型', credentialId: 'c1', model: 'known-model', capabilities: { efforts: ['default', 'low', 'medium', 'high'], tools: true } };
const stages = ['quality', 'plan', 'preprocess', 'activity', 'retention', 'monetization', 'channel', 'seasonality', 'charts', 'insights', 'report', 'verify', 'pdf'];
const skills = stages.map(stageId => ({ id: 'skill-' + stageId, name: stageId, stageId, enabled: true, builtin: true }));

test('工作流只补齐任务规划阶段，保留预算与模型覆盖', () => {
  assert.equal(typeof workflow.completeWorkflow, 'function');
  const value = workflow.completeWorkflow({ version: 1, defaultProfileId: 'p1', stages: { plan: { profileId: 'p2', skillId: 'mine', effort: 'mid', maxTokens: 1234, timeoutMs: 60000 } } }, skills);
  assert.deepEqual(Object.keys(value.stages), ['plan']);
  assert.deepEqual(value.stages.plan, { profileId: 'p2', skillId: 'mine', effort: 'medium', maxTokens: 1234, timeoutMs: 60000 });
  const blank = workflow.completeWorkflow(null, skills);
  assert.equal(blank.stages.plan.skillId, 'skill-plan');
  assert.equal(blank.stages.plan.profileId, null);
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

test('只保留任务规划阶段，并校验继承模型、思考强度与预算', () => {
  assert.equal(typeof workflow.validateWorkflow, 'function');
  assert.deepEqual(workflow.WORKFLOW_STAGES.map(stage => stage.id), ['plan']);
  const value = workflow.completeWorkflow({ version: 1, defaultProfileId: 'p1', stages: {} }, skills);
  assert.deepEqual(Object.keys(value.stages), ['plan']);
  assert.deepEqual(workflow.validateWorkflow(value, [profile], skills), []);
  value.stages.plan.effort = 'max';
  value.stages.plan.maxTokens = 255;
  value.stages.plan.timeoutMs = 600001;
  value.stages.plan.skillId = 'skill-quality';
  const errors = workflow.validateWorkflow(value, [profile], skills).join(' ');
  assert.match(errors, /任务规划.*强度/);
  assert.match(errors, /任务规划.*Token/);
  assert.match(errors, /任务规划.*超时/);
  assert.match(errors, /任务规划.*Skill/);
});

test('未开启工作流仍校验预算和Skill，但允许未分配模型', () => {
  const value = workflow.completeWorkflow(null, skills);
  assert.deepEqual(workflow.validateWorkflow(value, [], skills), []);
  value.stages.plan.maxTokens = NaN;
  assert.match(workflow.validateWorkflow(value, [], skills).join(' '), /Token/);
});

test('关闭工作流保留继承阶段的强度偏好，重新启用时再检查模型能力', () => {
  const value = workflow.completeWorkflow(null, skills);
  value.stages.plan.effort = 'max';
  assert.deepEqual(workflow.validateWorkflow(value, [], skills), []);
  value.defaultProfileId = 'p1';
  assert.match(workflow.validateWorkflow(value, [profile], skills).join(' '), /任务规划.*强度/);
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

test('任务规划阶段不接受多模型评审配置', () => {
 const profiles=[profile,{...profile,id:'p2'}];
 const config=workflow.completeWorkflow({defaultProfileId:'p1'},skills);
 const staged={...config,stages:{...config.stages,plan:{...config.stages.plan,review:{reviewerProfileIds:['p2']}}}};
 assert.match(workflow.validateWorkflow(staged,profiles,skills).join('；'),/任务规划.*评审/);
});
