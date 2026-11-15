import { randomUUID } from 'node:crypto';
import { analyzeDomain } from './domain-analytics.js';
import { DOMAIN_PROFILES, getProfile } from './domain-profiles.js';
import { enhanceReport } from './gateway.js';
import { isModelErrorCode } from './task-errors.js';
import { runMultiWorkflow } from './multi-workflow.js';
import { buildApprovalSnapshot, sameApprovalSnapshot } from './approval-snapshot.js';

const DEFINITIONS = [
  ['quality', '数据质量检查', '检查表结构、日期、订单与金额口径', 'data-quality'],
  ['plan', '制定分析计划', '根据分析目标和追加背景确认指标范围', 'analysis-plan'],
  ['activity', '活跃与新增分析', '按已结束自然日统计活跃与注册用户', 'game-activity'],
  ['retention', '用户留存分析', '计算成熟注册 cohort 的 D1 / D7 回访留存', 'game-retention'],
  ['monetization', '商业化分析', '核对成功订单、收入与活跃付费率', 'game-monetization'],
  ['channel', '渠道质量分析', '比较各渠道新增、成熟留存、收入与付费结构', 'game-channel'],
  ['seasonality', '周内规律分析', '按自然日聚合周一至周日的活跃、新增与收入规律', 'game-weekday'],
  ['insights', '洞察与建议', '从聚合指标提取证据与观察结论', 'game-insights'],
  ['report', '生成分析报告', '整合指标、目标、协作背景和方法说明', 'report-writer'],
  ['verify', '结果核验', '复核数据覆盖范围、空值与指标边界', 'result-verifier'],
];
export const SKILLS = DEFINITIONS.map(([id, name, description, skillId]) => ({ id: skillId, name, description, category: id === 'quality' || id === 'verify' ? '质量保障' : '运营分析', version: '1.0.0', enabled: true }));
function stepsFor(domain) {
  if (!domain || domain === 'game') return DEFINITIONS.map(([id, name, description, skillId]) => ({ id, name, description, skillId, status: 'pending' }));
  const profile = getProfile(domain);
  return DEFINITIONS.map(([id, name, description, skillId]) => ({
    id,
    name: profile.stepLabels?.[id] || name,
    description: profile.stepDescriptions?.[id] || description,
    skillId,
    status: 'pending',
  }));
}
// 领域开放状态以 domain-profiles.js 为准；只有完成数据规范、指标口径和测试后才启用。
export const DOMAINS = [
  { id: 'game', name: '游戏运营', description: '活跃、留存、渠道和商业化分析', enabled: true },
  { id: 'commerce', name: '电商经营', description: '订单、复购、客单价与渠道经营分析', enabled: false },
  { id: 'saas', name: 'SaaS 增长', description: '激活、留存、订阅续费与流失分析', enabled: false },
  { id: 'content', name: '内容与社区', description: '内容消费、互动、创作者留存与广告/打赏收入分析', enabled: false },
  { id: 'education', name: '在线教育', description: '报名、学习活跃、完课、续费与渠道转化分析', enabled: false },
  { id: 'local', name: '本地生活', description: '到店、核销、复购、门店与渠道经营分析', enabled: false },
  { id: 'social', name: '社交娱乐', description: '注册、活跃、互动、匹配效率与付费转化分析', enabled: false },
  { id: 'streaming', name: '直播与短视频', description: '观看、互动、打赏、广告变现与主播/创作者分析', enabled: false },
  { id: 'travel', name: '旅游住宿', description: '预订、入住、取消、复购与渠道分析', enabled: false },
  { id: 'subscription', name: '会员订阅', description: '试用、激活、续费、流失与订阅收入分析', enabled: false },
  { id: 'enterprise', name: 'B2B 企业服务', description: '线索、商机、签约、续约与增购分析', enabled: false },
  { id: 'adtech', name: '广告与营销', description: '投放、曝光、点击、转化、ROI 与渠道归因分析', enabled: false },
  { id: 'mobility', name: '出行与物流', description: '下单、履约、取消、复购与运力/渠道分析', enabled: false },
].map(domain => ({ ...domain, enabled: DOMAIN_PROFILES[domain.id]?.enabled ?? false }));
export const PROJECT = { id: 'project-game', name: '星河远征', domain: 'game', description: '多 Agent 指挥台 · 本地单用户项目' };
export const makeEvent = (type, title, detail, stepId) => ({ id: randomUUID(), type, title, detail, ...(stepId ? { stepId } : {}), createdAt: new Date().toISOString() });
export const makeMessage = (role, content) => ({ id: randomUUID(), role, content, createdAt: new Date().toISOString() });
export function createTask(input, dataset, model = '') {
  const now = new Date().toISOString();
  const domain = input.domain || dataset.domain || 'game';
  return {
    id: randomUUID(), title: input.title, goal: input.goal, mode: input.mode, domain, datasetId: dataset.id, datasetName: dataset.name,
    status: 'running', currentStep: 0, progress: 0, createdAt: now, updatedAt: now, useAI: input.useAI, model: input.useAI ? model : '本地确定性分析', cost: 20,
    steps: stepsFor(domain),
    events: [makeEvent('info', '任务已创建', '已冻结 20 试用额度；完成后结算，失败或取消释放。')],
    messages: [makeMessage('system', input.useAI ? '计算在本地完成，仅向配置的模型服务发送聚合指标和业务背景。' : '本任务使用本地确定性分析，不会发起模型调用。')],
    skippedSteps: [],
    _approved: [],
  };
}
export function publicTask(task) {
  const result = Object.fromEntries(Object.entries(task).filter(([field]) => !field.startsWith('_') && field !== 'approvalSnapshot'));
  const snapshot = buildApprovalSnapshot(task);
  if (snapshot) result.approvalSnapshot = snapshot;
  return result;
}

const optionalNames = { retention: '用户留存分析', monetization: '商业化分析', channel: '渠道质量分析', seasonality: '周内规律分析', insights: '洞察与建议' };
export function maskSkippedReport(report, task) {
  const skipped = task.skippedSteps || [];
  if (!skipped.length) return report;
  const profile = getProfile(task.domain || report.domain);
  const names = { ...optionalNames, ...(profile.stepLabels || {}) };
  const note = `由用户选择跳过：${skipped.map(id => names[id]).filter(Boolean).join('、')}；相关结果不参与报告或模型分析，空值表示未执行此分支。`;
  const paymentMetrics = Object.entries(profile.metricDependencies).filter(([, deps]) => deps.some(dep => dep.split('.')[0] === 'payments')).map(([id]) => id);
  if (skipped.includes('retention')) {
    report.metrics = report.metrics.map(metric => ['d1_retention', 'd7_retention'].includes(metric.id) ? { ...metric, value: null, change: null, note: '用户已跳过留存分析；显示无数据。' } : metric);
    report.retention = []; report.channels = report.channels.map(channel => ({ ...channel, d1: null }));
    const mentions = value => /留存|D1|D7|retention|cohort/i.test(value);
    report.findings = report.findings.filter(finding => !mentions(`${finding.title} ${finding.detail} ${finding.evidence}`));
    report.recommendations = report.recommendations.filter(value => !mentions(value));
  }
  if (skipped.includes('monetization')) {
    report.metrics = report.metrics.map(metric => paymentMetrics.includes(metric.id) ? { ...metric, value: null, change: null, note: '用户已跳过商业化分析；显示无数据。' } : metric);
    report.daily = report.daily.map(day => ({ ...day, revenue: null, payers: null, orders: null, spend: null, impressions: null, clicks: null, conversions: null }));
    report.channels = report.channels.map(channel => ({ ...channel, revenue: null, payers: null, payRate: null, arppu: null }));
    report.weekday = (report.weekday || []).map(day => ({ ...day, revenue: null }));
    report.payerSummary = null;
    const mentions = value => new RegExp(`商业化|收入|支付|付费|GMV|订单|退款|ARPP|revenue|payer|ROAS|CVR|CPA`, 'i').test(value);
    report.findings = report.findings.filter(finding => !mentions(`${finding.title} ${finding.detail} ${finding.evidence}`));
    report.recommendations = report.recommendations.filter(value => !mentions(value));
  }
  if (skipped.includes('channel')) {
    report.channels = [];
    const mentions = value => /渠道|channel/i.test(value);
    report.findings = report.findings.filter(finding => !mentions(`${finding.title} ${finding.detail} ${finding.evidence}`));
    report.recommendations = report.recommendations.filter(value => !mentions(value));
  }
  if (skipped.includes('seasonality')) {
    report.weekday = [];
    const mentions = value => /周内|星期|weekday/i.test(value);
    report.findings = report.findings.filter(finding => !mentions(`${finding.title} ${finding.detail} ${finding.evidence}`));
    report.recommendations = report.recommendations.filter(value => !mentions(value));
  }
  if (skipped.includes('insights')) { report.findings = []; report.recommendations = []; }
  const qualityOnly = skipped.includes('monetization') && report.metrics.every(metric => metric.value === null);
  const qualityOnlyNote = '全部可计算运营分支已跳过，仅保留质量检查。';
  if (qualityOnly) { report.findings = []; report.recommendations = []; report.retention = []; report.channels = []; report.weekday = []; report.payerSummary = null; }
  // Provider prose cannot reintroduce unsupported results from a skipped branch.
  report.summary = `${task.datasetName.includes('演示') ? '本报告使用示例数据，不代表真实业务。' : ''}围绕“${task.goal}”分析 ${report.period} 的 ${report.quality.rows} 行记录。${qualityOnly ? qualityOnlyNote : ''}${note}`;
  report.methodology = [...report.methodology.filter(value => !value.startsWith('由用户选择跳过：') && value !== qualityOnlyNote), note, ...(qualityOnly ? [qualityOnlyNote] : [])];
  return report;
}
export function analyzeForTask(dataset, task) {
  const options = { title: task.title, goal: task.goal, messages: task.messages, domain: task.domain || dataset.domain };
  let report = analyzeDomain(dataset, options);
  if (task.skippedSteps?.includes('monetization')) {
    const original = report;
    // Exclude payment records before computation, while retaining the original quality audit,
    // currency and complete-day union. The task still describes the uploaded dataset honestly.
    // A legitimate payments-only dataset has no operational rows after this exclusion.
    // Audit its original records, then mask every payment result instead of analyzing an empty input.
    if (original.daily.some(day => day.dau !== null || day.newUsers !== null)) report = analyzeDomain({ ...dataset, records: { ...dataset.records, payments: [] } }, options);
    report.quality = original.quality; report.currency = original.currency; report.period = original.period;
    report.daily = original.daily.map(day => ({ ...day, revenue: null, payers: null, orders: null, spend: null, impressions: null, clicks: null, conversions: null }));
    report.metrics = report.metrics.map(metric => ({ ...metric, unit: original.metrics.find(item => item.id === metric.id)?.unit ?? metric.unit }));
  }
  return maskSkippedReport(report, task);
}

export function validateReport(report) {
  if (!report || !report.daily.length) throw new Error('报告核验失败：没有已结束自然日数据');
  for (const metric of report.metrics) {
    if (metric.value !== null && !Number.isFinite(metric.value)) throw new Error('报告核验失败：出现非有限数值');
    if (metric.unit === '%' && metric.value !== null && (metric.value < 0 || metric.value > 100)) throw new Error('报告核验失败：比例超出 0–100%');
  }
}

export class Workflow {
  constructor(store, options = {}) {
    this.store = store; this.running = new Set(); this.controllers = new Map(); this.closed = false;
    this.modelHub = options.hub; this.fetchImpl = options.fetchImpl; this.runTool = options.runTool; this.createPdf = options.createPdf;
    // Credentials and the selected endpoint are captured per task only in memory.
    this.modelSnapshots = new Map(); this.lockedModelContexts = new Set();
    for (const task of store.list('task')) if (['running', 'awaiting_approval'].includes(task.status)) {
      task.status = 'failed'; task.error = '服务已重启，先前任务中断，冻结额度已释放。'; task.updatedAt = new Date().toISOString();
      // 旧记录可能缺 steps 或 currentStep 越界；这里只做善后，不能让整个服务起不来。
      const steps = Array.isArray(task.steps) ? task.steps : [];
      const step = steps[task.currentStep];
      if (step && step.status !== 'completed') step.status = 'failed';
      if (!Array.isArray(task.events)) task.events = [];
      task.events.push(makeEvent('error', '任务因服务重启中断', task.error, step?.id)); store.finish(task, false);
    }
  }
  captureModel(id, options) { this.modelSnapshots.set(id, { ...options, settings: Object.freeze({ ...options.settings }) }); }
  isModelContextLocked(id) { return this.lockedModelContexts.has(id); }
  clearModel(id) { this.modelSnapshots.delete(id); this.lockedModelContexts.delete(id); }
  schedule(id) { setImmediate(() => { if (!this.closed) void this.run(id); }); }
  async run(id) {
    if (this.running.has(id) || this.closed) return;
    this.running.add(id);
    const controller = new AbortController(); this.controllers.set(id, controller);
    let analysis;
    try {
      let task = this.store.get('task', id);
      if (task?.status !== 'running') return;
      const dataset = this.store.get('dataset', task.datasetId);
      if (!dataset) throw new Error('任务数据集已不存在');
      if (task.workflowSnapshot) { await runMultiWorkflow(this, task, dataset, controller.signal); return; }
      const profile = getProfile(task.domain || dataset.domain);
      const tableLabels = profile.tableLabels;
      for (let index = task.currentStep; index < task.steps.length; index++) {
        await new Promise(resolve => setImmediate(resolve));
        if (this.closed) return;
        task = this.store.get('task', id);
        if (task.status !== 'running') return;
        const step = task.steps[index];
        if (task.skippedSteps?.includes(step.id)) {
          step.status = 'skipped'; step.summary = '由用户选择跳过；相关结果不会纳入报告或模型输入。';
          task.progress = Math.round((index + 1) * 100 / task.steps.length); task.updatedAt = new Date().toISOString();
          this.store.put('task', task); continue;
        }
        if (step.status === 'completed') continue;
        task.currentStep = index;
        const required = { activity: [['activity', '活跃']], retention: [['users', '注册'], ['activity', '活跃']], monetization: [['payments', '支付']], channel: [['users', '注册']] }[step.id];
        const missing = required?.filter(([type]) => !dataset.records?.[type]?.length).map(([type]) => tableLabels[type] || type) || [];
        if (missing.length) {
          step.status = 'skipped'; step.summary = `缺少${missing.join('、')}，已跳过此分析；其他可用数据分支继续，相关指标显示无数据。`;
          task.progress = Math.round((index + 1) * 100 / task.steps.length); task.updatedAt = new Date().toISOString();
          task.events.push(makeEvent('info', `${step.name}已跳过`, step.summary, step.id)); this.store.put('task', task); continue;
        }
        if (task.mode === 'collaborative' && ['plan', 'report'].includes(step.id) && !task._approved.includes(step.id)) {
          step.status = 'awaiting_approval'; task.status = 'awaiting_approval'; task.updatedAt = new Date().toISOString();
          const detail = step.id === 'plan' ? `拟围绕“${task.goal}”分析数据质量、${profile.labels.trendTitle || '趋势'}、留存和${profile.revenueName}。请补充业务背景并确认计划。` : '已完成指标分析。请确认生成报告；你此前追加的业务背景将纳入报告。';
          task.events.push(makeEvent('approval', step.id === 'plan' ? '等待确认分析计划' : '等待确认生成报告', detail, step.id));
          task.messages.push(makeMessage('assistant', detail)); this.store.put('task', task); return;
        }
        step.status = 'running'; task.updatedAt = new Date().toISOString();
        task.events.push(makeEvent('start', step.name, step.description, step.id)); this.store.put('task', task);
        // Yield at real node transitions; no simulated progress or fabricated model thoughts.
        await new Promise(resolve => setImmediate(resolve));
        if (this.closed || this.store.get('task', id).status !== 'running') return;
        if (!analysis || ['quality', 'activity', 'retention', 'monetization', 'channel', 'seasonality', 'insights', 'report'].includes(step.id)) {
          analysis = analyzeForTask(dataset, this.store.get('task', id));
        }
        let summary;
        switch (step.id) {
          case 'quality': summary = `检查 ${analysis.quality.rows} 行记录，发现 ${analysis.quality.issues.length} 项质量提示。`; break;
          case 'plan': summary = `目标：${task.goal}；仅分析实际可用的数据表，缺表指标显示无数据。`; break;
          case 'activity': summary = `已计算 ${analysis.daily.filter(day => day.dau !== null).length} 个完整覆盖自然日的活跃；${dataset.records.users?.length ? `新增以${tableLabels.users}为准。` : `缺少${tableLabels.users}，新增无数据。`}`; break;
          case 'retention': summary = `已计算 ${analysis.retention.length} 个${profile.entity} cohort；未成熟窗口保留无数据。`; break;
          case 'monetization': summary = `已核对成功记录去重与整数分金额；${dataset.records.activity?.length ? `已按最后完整覆盖日核对${profile.payerEntity}交集与人均收入，覆盖不足时显示无数据。` : `缺少${tableLabels.activity}，活跃付费率与人均收入无数据。`}`; break;
          case 'channel': summary = `已比较 ${analysis.channels.length} 个${profile.labels.channelColumn || '渠道'}分组的新增、成熟次日留存与${profile.revenueName}结构。`; break;
          case 'seasonality': summary = `已归纳 ${(analysis.weekday || []).filter(day => day.dau !== null).length} 个星期的平均活跃、新增与收入。`; break;
          case 'insights': summary = `已生成 ${analysis.findings.length} 条带证据的本地观察。`; break;
          case 'report': {
            task = this.store.get('task', id);
            if (task.useAI) {
              const model = this.modelSnapshots.get(id);
              if (!model?.key) throw new Error('本次任务的模型配置快照不可用，任务已停止，额度将释放。');
              this.lockedModelContexts.add(id);
              analysis = maskSkippedReport(await enhanceReport(analysis, task, { ...model, signal: controller.signal }), task);
            }
            summary = task.useAI ? '模型已基于聚合指标与业务背景生成报告；原始用户数据未发送。' : '已整合本地分析、业务目标、追加背景与方法说明。';
            break;
          }
          case 'verify':
            if (!task.useAI) analysis = analyzeForTask(dataset, this.store.get('task', id));
            validateReport(analysis); summary = '报告数值、比例范围、完整日与空值口径核验通过。'; break;
        }
        if (this.closed) return;
        task = this.store.get('task', id);
        if (task.status !== 'running') return;
        task.steps[index].status = 'completed'; task.steps[index].summary = summary;
        task.progress = Math.round((index + 1) * 100 / task.steps.length); task.updatedAt = new Date().toISOString();
        task.events.push(makeEvent('complete', `${step.name}完成`, summary, step.id));
        if (step.id === 'report' || (step.id === 'verify' && !task.useAI)) task.report = analysis;
        if (index === task.steps.length - 1) {
          // A resumed runner rebuilds analysis, so retain the stored AI report for final validation.
          if (task.report) validateReport(task.report);
          task.status = 'completed'; task.messages.push(makeMessage('assistant', '分析报告已完成，20 试用额度已结算。'));
          this.store.finish(task, true);
        } else this.store.put('task', task);
      }
    } catch (error) {
      if (this.closed) return;
      const task = this.store.get('task', id);
      if (!task || ['cancelled', 'completed', 'failed'].includes(task.status)) return;
      task.status = 'failed'; task.error = error.message || '分析失败，额度已释放'; task.updatedAt = new Date().toISOString();
      if (isModelErrorCode(error.code)) task.errorCode = error.code;
      task.steps[task.currentStep].status = 'failed'; task.events.push(makeEvent('error', '分析失败', task.error, task.steps[task.currentStep].id));
      this.store.finish(task, false);
    } finally {
      this.running.delete(id); this.controllers.delete(id);
      if (this.closed || ['completed', 'failed', 'cancelled'].includes(this.store.get('task', id)?.status)) this.clearModel(id);
    }
  }
  approve(task, message, expectedStepId, snapshot) {
    if (task.workflowSnapshot) {
      // Retried requests may arrive after the next approval gate is visible.
      // Match the original receipt before inspecting the current gate.
      if ((task._approvalReceipts || []).some(receipt => sameApprovalSnapshot(receipt, snapshot) && (expectedStepId === undefined || expectedStepId === receipt.stepId))) return task;
      const current = buildApprovalSnapshot(task);
      if (!sameApprovalSnapshot(current, snapshot) || (expectedStepId !== undefined && expectedStepId !== current?.stepId)) {
        throw Object.assign(new Error('待确认内容已更新或缺少版本，请刷新任务后重新核对并确认。'), { status: 409, code: 'APPROVAL_SNAPSHOT_CONFLICT' });
      }
    }
    if (task.status !== 'awaiting_approval') return task;
    const step = task.steps[task.currentStep];
    if (expectedStepId !== undefined && expectedStepId !== step.id) return task;
    if (!['plan', 'report'].includes(step.id)) throw new Error('当前节点不接受批准');
    // Bind the reviewed content before appending the optional new background.
    if (task.workflowSnapshot) task._approvalReceipts = [...(task._approvalReceipts || []), { ...snapshot }];
    if (message) task.messages.push(makeMessage('user', message));
    task._approved.push(step.id); step.status = 'pending'; task.status = 'running'; task.updatedAt = new Date().toISOString();
    task.events.push(makeEvent('approval', '已确认，继续分析', message || `已批准${step.name}`, step.id)); this.store.put('task', task); this.schedule(task.id); return task;
  }
  cancel(task) {
    if (!['running', 'awaiting_approval'].includes(task.status)) return task;
    task.status = 'cancelled'; task.updatedAt = new Date().toISOString();
    for (const step of task.steps) if (step.status !== 'completed') step.status = 'skipped';
    task.events.push(makeEvent('info', '任务已取消', '未完成任务的冻结额度已释放。'));
    this.controllers.get(task.id)?.abort(); this.clearModel(task.id); this.store.finish(task, false); return task;
  }
  skip(task, stepId) {
    if (!Object.hasOwn(optionalNames, stepId)) throw Object.assign(new Error('仅允许跳过 retention、monetization、channel、seasonality、insights 可选步骤'), { status: 400 });
    if (!['running', 'awaiting_approval'].includes(task.status)) throw Object.assign(new Error('任务已结束，请通过新恢复尝试选择跳过步骤'), { status: 409 });
    if (task.skippedSteps?.includes(stepId)) return task;
    const step = task.steps.find(item => item.id === stepId);
    if (!step || step.status !== 'pending') throw Object.assign(new Error('步骤已开始或完成，不能改写已执行结果；请创建新尝试'), { status: 409 });
    task.skippedSteps = [...(task.skippedSteps || []), stepId]; step.status = 'skipped';
    step.summary = '由用户选择跳过；相关结果不会纳入报告或模型输入。'; task.updatedAt = new Date().toISOString();
    task.events.push(makeEvent('info', `${step.name}已由用户跳过`, step.summary, step.id));
    this.store.put('task', task); return task;
  }
  close() { this.closed = true; for (const controller of this.controllers.values()) controller.abort(); this.modelSnapshots.clear(); this.lockedModelContexts.clear(); }
}

export function demoTask(dataset) {
  const task = createTask({ title: '近 28 天运营复盘', goal: '了解活跃、留存与收入趋势，识别值得进一步验证的渠道机会', mode: 'automatic', useAI: false }, dataset);
  task.status = 'completed'; task.currentStep = 7; task.progress = 100;
  task.steps.forEach(step => { step.status = 'completed'; step.summary = '基于示例数据真实计算并核验。'; });
  task.events = [makeEvent('info', '示例报告已生成', '使用确定性生成的演示数据完成本地真实计算；本条示例历史不扣费。')];
  task.messages = [makeMessage('assistant', '这是基于示例数据计算的演示报告，不代表真实业务。本条历史不消耗试用额度。')];
  task.report = analyzeDomain(dataset, { title: task.title, goal: task.goal, domain: dataset.domain || 'game' }); return task;
}
