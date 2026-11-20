import { createTeamRuntime, safeTeamEvent } from './team-runtime.js';
import { projectSubagentResult } from './subagents.js';
import { critiquePlan, critiqueResult } from './critic.js';
import { buildRetrievalCorpus, retrieveDocuments, retrievalQuery } from './retrieval.js';
import { buildAnalysisContract, buildEvidence, buildStageDeliverable, buildContextProjection } from './stage-contracts.js';
import { artifactFingerprint, deriveDataset } from './artifact-lifecycle.js';
import { analysisChecks, validateCharts } from './analysis-checks.js';
import { analyzeForTask, maskSkippedReport, validateReport, makeEvent, makeMessage } from './workflow.js';
import { applyStageNarrative, assertReportVerified, runStageAgent } from './stage-agent.js';
import { reportContentHash } from './report-version.js';
import { buildQualityReceipts } from './quality-receipts.js';
import { modelCallEntry } from './model-usage.js';
import { validatePlan, planForStage } from './plan.js';
import { PANEL_LENSES, panelInstruction, panelPrevious, runInsightPanel, summarizePanel } from './insight-panel.js';

export function configureMultiTask(task, snapshot) {
  task.workflowSnapshot = structuredClone(snapshot);
  task.model = '分阶段模型工作流'; task.artifacts = {};
  task._multiReportScope = scopeKey(task);
  const extra = (id, name, description, skillId) => ({ id, name, description, skillId, status: 'pending' });
  task.steps = task.steps.flatMap(step => [step,
    ...(step.id === 'plan' ? [extra('preprocess', '数据处理', '核对规范化结果与处理影响，保留原始数据', 'data-preprocess')] : []),
    ...(step.id === 'seasonality' ? [extra('charts', '图表设计与绘制', '从真实聚合结果绘制图表', 'chart-designer')] : []),
  ]);
  task.steps.push(extra('pdf', 'PDF 排版与输出', '生成含图表的可下载 PDF 文件', 'pdf-export'));
  for (const step of task.steps) if (snapshot.stages[step.id]?.skill?.id) step.skillId = snapshot.stages[step.id].skill.id;
  task.currentStep = 0; task.progress = 0;
}

function attachCharts(report, output) {
  const charts = output?.charts || (output?.chart ? [output.chart] : output?.mimeType && output?.svg ? [output] : []);
  return charts.length ? { ...report, charts: [...(report.charts || []), ...charts].slice(-12) } : report;
}

function reportFacts(report) {
  report.facts = [
    ...(report.metrics || []).map(metric => ({ id: `metric:${metric.id}`, text: `${metric.label}：${metric.value == null ? '无数据' : metric.value} ${metric.unit}；${metric.note || ''}` })),
    ...(report.quality.issues || []).slice(0, 50).map((value, index) => ({ id: `quality:issue:${index}`, text: value })),
    { id: 'quality:summary', text: `记录 ${report.quality.rows} 行，质量评分 ${report.quality.score}` },
    { id: 'period', text: `统计期间：${report.period}；时区：${report.timezone?.name || '未确认'}` },
  ];
  return report;
}

const scopeKey = task => JSON.stringify([...(task.skippedSteps || [])].sort());
const TEAM_EVENT_LIMIT = 100;

export async function runMultiWorkflow(workflow, initial, dataset, signal) {
  const { store } = workflow;
  const teamEnabled=Object.values(initial.workflowSnapshot?.stages||{}).some(s=>s.team?.enabled);
  let persistTeam=()=>{};
  const team=teamEnabled?createTeamRuntime({onEvent:event=>persistTeam(event)},signal):null;
  const mergeTeamDecisions=(snapshot,previous)=>{
    const oldNodes=new Map((previous?.team?.nodes||[]).map(node=>[node?.id,node]));
    for(const node of snapshot?.nodes||[]){
      const old=oldNodes.get(node?.id);if(!old)continue;
      if(old.status==='accepted')node.status='accepted';
      if(old.status==='pending'&&Number.isSafeInteger(old.retries)&&old.retries>(node.retries||0)){node.status='pending';node.retries=old.retries;}
      const decisions=new Map((old.proposals||[]).map(proposal=>[proposal?.id,proposal]));
      for(const proposal of node.proposals||[]){const decided=decisions.get(proposal?.id);if(decided&&['accepted','rejected'].includes(decided.status))proposal.status=decided.status;}
    }
    return snapshot;
  };
  function persistTeamState(event){
    if(!team)return;
    const latest=store.get('task',initial.id);if(!latest)return;
    latest.artifacts||={};const previous=latest.artifacts.team;
    const snapshot=mergeTeamDecisions(team.snapshot(),previous);
    if(JSON.stringify(snapshot)===JSON.stringify(previous?.team)&&!event)return;
    const safeEvent=event?safeTeamEvent(event):null;
    const events=[...(previous?.events||[]),...(safeEvent?[safeEvent]:[])].slice(-TEAM_EVENT_LIMIT);
    latest.artifacts.team={summary:'团队任务状态',team:snapshot,events,revision:(Number.isSafeInteger(previous?.revision)&&previous.revision>0?previous.revision:0)+1,updatedAt:new Date().toISOString()};
    store.put('task',latest);
  }
  persistTeam=persistTeamState;
  const reviewResult = (report, context) => { try { return (workflow.critiqueResult || critiqueResult)(report, context); } catch { return critiqueResult(undefined); } };
  const corpus = buildRetrievalCorpus({tasks: store.list('task'), memory: store.list('memory'), ownerId: initial.workflowSnapshot?.stages?.plan?.ownerId || 'local', dataset, domain: initial.domain || 'game', currentTaskId: initial.id});
  const retrievalCache = new Map();
  const runAgent = async options => {
    const startedScope = scopeKey(store.get('task', initial.id));
    try { return await runStageAgent(options); }
    catch (error) {
      if (error?.trace && error.name !== 'AbortError' && !signal.aborted && !workflow.closed) try {
        const latest = store.get('task', initial.id);
        if (latest?.status === 'running' && scopeKey(latest) === startedScope) {
          latest.artifacts ||= {};
          latest.artifacts[options.stage.id] = { ...latest.artifacts[options.stage.id], trace: structuredClone(error.trace) };
          store.put('task', latest);
        }
      } catch { /* 诊断记录不可覆盖原始阶段失败。 */ }
      throw error;
    }
  };
  const onCallFor = (stage, kind = 'stage', lens = null) => call => {
    try {
      store.put('model-call', modelCallEntry({ call, taskId: initial.id,
        stage: { id: stage.id, name: initial.steps.find(step => step.id === stage.id)?.name || stage.id },
        kind, lens, now: new Date().toISOString() }));
    } catch { /* 独立追加用量账本，写入失败不得影响任务。 */ }
  };
  if (initial.derivedDatasetId) dataset = store.get('derived-dataset', initial.derivedDatasetId) || dataset;
  else if (initial.artifacts?.preprocess?.reused && initial.artifacts.preprocess.deliverable?.operations) dataset = deriveDataset(dataset, initial.artifacts.preprocess.deliverable.operations).dataset;
  let report = initial.report || reportFacts(analyzeForTask(dataset, initial));
  let reportScope = initial._multiReportScope ?? scopeKey(initial);
  const refreshScope = task => {
    const nextScope = scopeKey(task);
    if (nextScope === reportScope) return;
    // Masking alone leaves stale evidence, AI prose and chart data. Recompute the
    // deterministic report and evidence from the newly authorized scope instead.
    report = reportFacts(analyzeForTask(dataset, task)); reportScope = nextScope; task._multiReportScope = nextScope;
    for (const artifact of Object.values(task.artifacts || {})) artifact.scopeInvalidated = true;
    if (task.report) task.report = report;
    store.put('task', task);
  };
  if (!report.facts) reportFacts(report);
  report.facts = buildEvidence(report, { dataset });
  for (let index = initial.currentStep; index < initial.steps.length; index++) {
    signal.throwIfAborted();
    let task = store.get('task', initial.id);
    if (task.status !== 'running' || workflow.closed) return;
    refreshScope(task);
    const step = task.steps[index];
    if (['completed', 'skipped'].includes(step.status)) continue;
    task.currentStep = index;
    const required = { activity: ['activity'], retention: ['users', 'activity'], monetization: ['payments'], channel: ['users'] }[step.id] || [];
    if (task.skippedSteps?.includes(step.id) || required.some(name => !dataset.records?.[name]?.length)) {
      step.status = 'skipped'; step.summary = '此分支缺少必要数据或已由用户跳过；不纳入后续结论。';
      task.skippedSteps = [...new Set([...(task.skippedSteps || []), step.id])];
      refreshScope(task); task.progress = Math.round((index + 1) * 100 / task.steps.length); task.updatedAt = new Date().toISOString(); store.put('task', task); continue;
    }
    if (task.mode === 'collaborative' && step.id === 'report' && !task._approved.includes(step.id)) {
      step.status = 'awaiting_approval'; task.status = 'awaiting_approval'; task.updatedAt = new Date().toISOString();
      const detail = `已完成数据和图表分析。${task.artifacts.plan?.scopeInvalidated ? '' : task.artifacts.plan?.summary || ''} 请确认继续生成报告。`;
      task.events.push(makeEvent('approval', `等待确认${step.name}`, detail, step.id)); task.messages.push(makeMessage('assistant', detail)); store.put('task', task); return;
    }
    // Approval resumes this same step. The stored plan is the concrete result
    // the user approved, so completing it must not make a second model request.
    if (step.id === 'plan' && task._approved.includes('plan') && task.artifacts.plan) {
      step.status = 'completed'; step.summary = task.artifacts.plan.summary;
      task.progress = Math.round((index + 1) * 100 / task.steps.length); task.updatedAt = new Date().toISOString();
      task.events.push(makeEvent('complete', `${step.name}完成`, step.summary, step.id)); store.put('task', task); continue;
    }
    step.status = 'running'; task.updatedAt = new Date().toISOString(); task.events.push(makeEvent('start', step.name, step.description, step.id)); store.put('task', task);
    if (step.id === 'pdf') {
      validateReport(report);
      assertReportVerified(report);
      task.report = report;
      task.report.pdf = await workflow.createPdf(task, signal);
      task.artifacts.pdf = { summary: '已生成可下载 PDF。', createdAt: new Date().toISOString(), engine: 'Chromium', status: 'completed', reused: false, validation: { status: task.artifacts.verify?.validation?.status === 'verified' ? 'verified' : 'legacy' }, fingerprint: artifactFingerprint({ stageId: 'pdf', dataset, contract: buildAnalysisContract(task, dataset, report), stage: { id: 'pdf' }, upstream: task.artifacts }) };
      step.summary = 'PDF 已生成，可直接下载。';
    } else {
      const captured = task.workflowSnapshot.stages[step.id];
      if (!captured) throw new Error(`工作流缺少 ${step.name} 配置，请重新保存阶段设置。`);
      const context = workflow.modelHub.context(captured);
      const stage = { ...captured, id: step.id };
      const toolRecords = [];
      const runTool = async (name, input, options) => {
        const latest = store.get('task', initial.id);
        signal.throwIfAborted();
        if (latest.status !== 'running' || workflow.closed) throw new DOMException('任务已停止', 'AbortError');
        refreshScope(latest);
        const skipped = latest.skippedSteps || [];
        const source = input.source || (input.kind === 'heatmap' ? 'retention' : 'daily');
        if (name === 'chart' && ((source === 'retention' && skipped.includes('retention')) || (source === 'channels' && skipped.includes('channel')) || (source === 'weekday' && skipped.includes('seasonality')))) throw new Error('图表对应分析分支已跳过，不能通过工具重新读取');
        if (skipped.includes('channel') && (input.by?.includes('channel') || input.x === 'channel')) throw new Error('渠道分析已跳过，不能通过工具重新分组');
        const scopedDataset = skipped.includes('monetization') ? { ...dataset, records: Object.fromEntries(Object.entries(dataset.records || {}).filter(([table]) => table !== 'payments')) } : dataset;
        const toolSignal = options?.signal && options.signal !== signal ? AbortSignal.any([signal, options.signal]) : signal;
        toolSignal.throwIfAborted();
        const output = await workflow.runTool(name, input, { ...options, dataset: scopedDataset, report, signal: toolSignal });
        toolSignal.throwIfAborted();
        report = attachCharts(report, output); return output;
      };
      if (['quality', 'preprocess'].includes(step.id)) {
        const output = await runTool('profile', {}, { dataset, report, signal });
        toolRecords.push({ name: 'profile', result: output });
      }
      task = store.get('task', initial.id);
      if (task.status !== 'running' || workflow.closed) return;
      refreshScope(task);
      const inputScope = reportScope;
      const contract = buildAnalysisContract(task, dataset, report);
      report.facts = buildEvidence(report, { dataset, contract });
      const checks = analysisChecks(report, contract);
      if (step.id === 'verify') checks.critic = reviewResult(report,{task,dataset,contract,facts:report.facts});
      const strict = Number(stage.skill.version) >= 2 && stage.skill.builtin !== false;
      if (step.id === 'verify') assertReportVerified(report);
      const upstream = Object.fromEntries(Object.entries(task.artifacts).filter(([, artifact]) => !artifact.scopeInvalidated));
      const previous = { ...upstream };
      const plan = step.id === 'plan' ? undefined : planForStage(previous.plan?.deliverable || previous.plan, step.id);
      if (previous.plan) previous.plan = { summary: '本阶段相关计划', deliverable: plan, planVersion: previous.plan.planVersion, validation: previous.plan.validation };
      let panel;
      let judgeStage = stage, judgePrevious = previous;
      if (step.id === 'insights' && captured.reviewers?.length) {
        panel = await runInsightPanel({ reviewers: captured.reviewers, runReviewer: async (reviewer, reviewerIndex) => {
          signal.throwIfAborted();
          const reviewerContext = workflow.modelHub.reviewerContext(captured, reviewerIndex);
          const reviewerStage = { ...stage, ...reviewer, id: 'insights', effort: stage.effort, allowedTools: [], skill: { ...stage.skill, allowedTools: [], content: panelInstruction(stage.skill.content, PANEL_LENSES[reviewerIndex]) } };
          return runStageAgent({ onCall: onCallFor(reviewerStage, 'reviewer', PANEL_LENSES[reviewerIndex].id), contract: undefined, checks, stage: reviewerStage, context: reviewerContext, resolveContext: () => workflow.modelHub.reviewerContext(captured, reviewerIndex), task: structuredClone(task), dataset, report: structuredClone(report), previous: structuredClone(previous), plan, signal, fetchImpl: workflow.fetchImpl || reviewerContext.fetchImpl, runTool: async () => { throw new Error('评审员不得调用工具'); } });
        } });
        signal.throwIfAborted();
        const latest = store.get('task', initial.id);
        if (latest.status !== 'running' || workflow.closed) return;
        if (!panel.allFailed) {
          judgePrevious = { ...previous, ...panelPrevious(panel, report.facts.map(f => f.id)) };
          judgeStage = { ...stage, skill: { ...stage.skill, content: `${stage.skill.content}\n裁判：合并去重评审建议，只保留合法 evidenceRefs 支持的结论，明确共识与分歧，不得新增无证据结论。` } };
        }
      }
      if (!retrievalCache.has(step.id)) retrievalCache.set(step.id, retrieveDocuments({corpus, query: retrievalQuery({task,stage,plan,report}), stageId: step.id}));
      const retrieval = retrievalCache.get(step.id);
            const teamRoot = captured.team?.enabled ? team.createNode(null,{name:step.name}) : null;
      const teamHooks = node => ({before:async tokens=>{const release=await team.acquire(node.id);try{team.reserveCall(node.id,tokens);return release;}catch(error){release();throw error;}},after:usage=>team.completeCall(node.id,usage)});
      const teamResults=new Map();
      const persistTeam=()=>{if(teamRoot)persistTeamState();};
      const runSubagent = async (input, childSignal, parentNode=teamRoot) => {
        const index=captured.subagents.findIndex(child=>child.id===input.subagentId), child=captured.subagents[index];
        let retryNode;
        if(parentNode&&input.decision){if(!teamResults.has(input.resultId)||teamResults.get(input.resultId).subagentId!==input.subagentId)throw Error('只能验收对应角色的已有结果');retryNode=team.review(parentNode.id,input.resultId,input.decision);persistTeam();if(input.decision==='accept')return {...teamResults.get(input.resultId),status:'accepted'};}
        const childNode=retryNode||(parentNode?team.createNode(parentNode.id,{name:child.name,dependsOn:input.dependsOn}):null);
        if(childNode&&!team.ready(childNode.id)){team.updateNode(childNode.id,'blocked');persistTeam();return {id:childNode.id,subagentId:child.id,status:'failed',summary:'依赖节点尚未完成',findings:[],recommendations:[],tokens:0,trace:{taskId:initial.id,stageId:step.id,kind:'subagent',calls:0,log:'model-call'},failure:{code:'DEPENDENCY_BLOCKED',reason:'依赖节点尚未完成'}};}
        persistTeam();
        const base={id:childNode?.id||crypto.randomUUID(),parentId:parentNode?.id,depth:childNode?.depth,subagentId:child.id,name:child.name,model:child.model};
        try {
          if(childNode)team.updateNode(childNode.id,'running');
          const childContext=workflow.modelHub.subagentContext(captured,index);
          const roleTools=childNode?(Array.isArray(child.allowedTools)?child.allowedTools:['profile','describe','group','statistics']):[];
          const proposals=[];
          const childRunTool=async(name,input,options)=>{
            if(!childNode)throw Error('只读子智能体不得调用工具');
            if(!roleTools.includes(name))throw Error('团队执行节点未授权该工具');
            if(name==='chart'){
              await workflow.runTool('chart',input,{...options,dataset:structuredClone(dataset),report:structuredClone(report),signal:options?.signal});
              const proposal={id:`proposal-chart-${crypto.randomUUID()}`,kind:'chart',status:'proposed',summary:`图表提案：${String(input?.title||input?.kind||'图表').slice(0,120)}`};
              proposals.push(proposal);return {proposal};
            }
            if(name==='clean'){
              await workflow.runTool('clean',input,{...options,dataset:structuredClone(dataset),report:structuredClone(report),signal:options?.signal});
              const proposal={id:`proposal-clean-${crypto.randomUUID()}`,kind:'clean',status:'needsApproval',summary:'数据处理提案，需确认后应用'};
              proposals.push(proposal);return {proposal};
            }
            return runTool(name,input,options);
          };
          const childStage={...stage,...child,id:step.id,subagents:undefined,allowedTools:roleTools,skill:{...(child.skill||stage.skill),allowedTools:roleTools,content:`${child.skill?.content || stage.skill.content}\n子问题：${child.role}\n问题：${input.question}\n关注：${input.focus||''}\n只能使用提供的证据，不得生成事实或直接修改报告；chart/clean 只能返回提案。`}};
          const output=await runStageAgent({stage:childStage,context:childContext,resolveContext:()=>workflow.modelHub.subagentContext(captured,index),task:structuredClone(task),dataset,report:structuredClone(report),contract:undefined,checks,plan:structuredClone(plan),retrieval:structuredClone(retrieval),previous:structuredClone(previous),...(childNode?{teamCall:teamHooks(childNode),subagents:childNode.depth<team.limits.maxDepth?captured.subagents:undefined,runSubagent:(request,signal)=>runSubagent(request,signal,childNode)}:{}),readOnly:!childNode,signal:childNode?AbortSignal.any([childSignal,team.signal]):childSignal,fetchImpl:workflow.fetchImpl||childContext.fetchImpl,onCall:onCallFor(childStage,'subagent'),runTool:childRunTool});
          if(childSignal.aborted)throw childSignal.reason;
          if(childNode&&proposals.length)team.recordProposals(childNode.id,proposals);
          if(childNode)team.updateNode(childNode.id,'completed');
          const safeProposals=proposals.map(({id,kind,status,summary})=>({id,kind,status,summary}));
          const delegation={...base,status:'completed',...projectSubagentResult(output,new Set(report.facts.map(f=>f.id)),{trace:{taskId:initial.id,stageId:step.id,calls:output.calls.length}}),proposals:safeProposals,tokens:output.calls.reduce((n,c)=>n+(c.usage?.totalTokens||0),0)};if(childNode)teamResults.set(childNode.id,delegation);persistTeam();return delegation;
        } catch(error) {const aborted=childSignal.aborted||error?.name==='AbortError';if(childNode)team.updateNode(childNode.id,aborted?'cancelled':'failed');persistTeam();if(parentNode?(signal.aborted||team.signal.aborted):aborted)throw error;return {...base,status:'failed',summary:'子智能体不可用',findings:[],recommendations:[],tokens:0,error:'子智能体执行失败，主阶段继续',trace:{taskId:initial.id,stageId:step.id,kind:'subagent',calls:0,log:'model-call'},failure:{code:'SUBAGENT_FAILED',reason:'子智能体执行失败，主阶段继续'}};}
      };
      const agentOptions = { ...(teamRoot?{teamCall:teamHooks(teamRoot),signal:AbortSignal.any([signal,team.signal])}:{}), ...(captured.subagents?.length ? {subagents:captured.subagents,runSubagent}:{}), retrieval, onCall: onCallFor(stage), contract: strict ? contract : undefined, checks, stage: judgeStage, context, resolveContext: () => workflow.modelHub.context(captured), task, dataset, report, previous: judgePrevious, plan, signal:teamRoot?AbortSignal.any([signal,team.signal]):signal, fetchImpl: workflow.fetchImpl || context.fetchImpl, runTool };
      let result = await runAgent(agentOptions);
      let planValidation;
      if (step.id === 'plan') {
        let repaired = false;
        const currentPlanScope = () => {
          signal.throwIfAborted();
          task = store.get('task', initial.id);
          return task.status === 'running' && !workflow.closed && inputScope === scopeKey(task);
        };
        const validate = async () => {
          for (;;) {
            if (!currentPlanScope()) return false;
            const fields = ['questions', 'steps', 'evidenceRequirements', 'confirmations'];
            const legacy = !strict && fields.every(key => result[key] === undefined);
            if (legacy) for (const key of fields) result[key] = [];
            try {
              planValidation = validatePlan({ ...result, planVersion: result.planVersion ?? 1 }, { task, dataset });
              if (legacy) planValidation.status = 'legacy';
              return true;
            } catch (error) {
              if (error.name === 'AbortError' || !error.planValidationErrors || repaired) throw error;
              repaired = true;
              const old = result;
              result = await runAgent({ ...agentOptions, revision: { planValidationErrors: error.planValidationErrors, instruction: '只修正计划结构与引用，不改变用户范围。' } });
              result.calls = [...old.calls, ...result.calls];
            }
          }
        };
        if (!await validate()) {
          if (task.status !== 'running' || workflow.closed) return;
          refreshScope(task); index--; continue;
        }
        const enteredReport = ['report', 'verify'].some(id => task.artifacts[id] || task.steps.some(item => item.id === id && !['pending', 'skipped'].includes(item.status)));
        if (planValidation.blocked.length && task.mode === 'automatic' && !enteredReport && !task._plannerReplans && currentPlanScope()) {
          const old = result;
          result = await runAgent({ ...agentOptions, revision: { replanBlocked: planValidation.blocked, instruction: '重规划一次：说明必需问题的数据阻塞；不改变用户排除范围，不发明数据。' } });
          result.calls = [...old.calls, ...result.calls];
          signal.throwIfAborted();
          task = store.get('task', initial.id);
          if (task.status !== 'running' || workflow.closed) return;
          task._plannerReplans = 1;
          for (const [id, artifact] of Object.entries(task.artifacts)) if (id !== 'quality' && id !== 'plan') artifact.scopeInvalidated = true;
          store.put('task', task);
          if (!await validate()) {
            if (task.status !== 'running' || workflow.closed) return;
            refreshScope(task); index--; continue;
          }
        }
        result.planVersion = (task.artifacts.plan?.planVersion || 0) + 1 + (task._plannerReplans || 0);
      }
      if (panel) {
        const refs = new Set(report.facts.map(f => f.id));
        const seen = new Set();
        if (!panel.allFailed) result.findings = (Array.isArray(result.findings) ? result.findings : []).filter(f => {
          if (!f || typeof f !== 'object' || Array.isArray(f) || !Array.isArray(f.evidenceRefs)) return false;
          const key = String(f.title || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
          if (seen.has(key) || !f.evidenceRefs?.length || !f.evidenceRefs.every(ref => refs.has(ref))) return false;
          seen.add(key); return true;
        });
        const summary = summarizePanel({ reviewers: panel.reviewers, judge: result, validRefs: new Set(report.facts.map(f => f.id)) });
        const tokens = panel.reviewers.reduce((sum, r) => sum + (r.result?.calls || []).reduce((n,c) => n + (c.usage?.totalTokens || 0), 0), 0);
        result.panelTokens = tokens;
        result.panel = { enabled: true, degraded: panel.degraded, participants: 1 + panel.reviewers.filter(r => r.status === 'completed').length, reviewers: panel.reviewers.map(({result: output,...r}) => ({ ...r, tokens: (output?.calls || []).reduce((n,c) => n + (c.usage?.totalTokens || 0), 0) })), agreements: summary.agreements, disagreements: { judgeOnly: summary.judgeOnly, reviewerOnly: summary.reviewerOnly }, summary: summary.summary };
      }
      const revisions = [];
      const repairTokenLimit = Math.min(65536, 12 * (stage.maxTokens || 4096));
      if (step.id === 'verify' && strict) {
        for (let attempt = 0; result.approved !== true || result.issues?.length || ['reject','unreviewed'].includes(checks.critic?.verdict); attempt++) {
          revisions.push({ attempt, review: structuredClone(result) });
          task.artifacts.verify = { ...result, revisions, validation: { status: 'failed' } }; store.put('task', task);
          if (attempt >= 2 || result.calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0) >= repairTokenLimit) throw Object.assign(new Error('结果核验在两轮定向修订后仍未通过。'), { code: 'INVALID_REPORT', modelFailure: true });
          const reportStage = { ...task.workflowSnapshot.stages.report, id: 'report' };
          const reportContext = workflow.modelHub.context(reportStage);
          const reportPlan = planForStage(task.artifacts.plan?.deliverable || task.artifacts.plan, 'report');
          const reportPrevious = { ...previous, ...(previous.plan ? { plan: { summary: '本阶段相关计划', deliverable: reportPlan } } : {}) };
          const revision = await runAgent({ onCall: onCallFor(reportStage), stage: reportStage, context: reportContext, task, dataset, report, contract, checks, previous: reportPrevious, plan: reportPlan, revision: { issues: [...(result.issues || []), ...(checks.critic?.issues || [])], attempt: attempt + 1, instruction: '只修正报告所列问题，禁止改变合同口径或执行工具。' }, signal, fetchImpl: workflow.fetchImpl || reportContext.fetchImpl, runTool: async () => { throw new Error('报告定向修订不允许执行工具'); } });
          const deliverable = buildStageDeliverable('report', revision, { task, dataset, report, contract, previous, numericTransforms: revision.numericTransforms });
          report = maskSkippedReport(applyStageNarrative(report, revision), task);
          revisions.at(-1).revision = revision;
          task.artifacts.report = { ...task.artifacts.report, ...revision, deliverable, revisions: [...(task.artifacts.report?.revisions || []), { attempt: attempt + 1, result: revision }], validation: { status: 'verified' } };
          store.put('task', task);
          checks.critic = reviewResult(report,{task,dataset,contract,facts:report.facts});
          const review = await runAgent({ onCall: onCallFor(stage), stage, context, task, dataset, report, contract, checks, plan, previous: { ...previous, report: task.artifacts.report }, signal, fetchImpl: workflow.fetchImpl || context.fetchImpl, runTool });
          result = { ...review, calls: [...result.calls, ...revision.calls, ...review.calls] };
          if (result.calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0) > repairTokenLimit) {
            task.artifacts.verify = { ...result, revisions, validation: { status: 'failed' }, repairBudget: { maxRounds: 2, maxTokens: repairTokenLimit, actualTokens: result.calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0) } }; store.put('task', task);
            throw Object.assign(new Error('定向修订达到Token预算上限。'), { code: 'INVALID_REPORT', modelFailure: true });
          }
        }
      }
      task = store.get('task', initial.id);
      if (task.status !== 'running' || workflow.closed) return;
      refreshScope(task);
      const scopeInvalidated = inputScope !== reportScope;
      if (step.id === 'charts' && !report.charts?.length) {
        const y = ['dau', 'newUsers', 'revenue'].find(field => report.daily.some(day => typeof day[field] === 'number' && Number.isFinite(day[field])));
        if (y) {
          const output = await runTool('chart', { kind: 'line', source: 'daily', x: 'date', y }, { dataset, report, signal }); toolRecords.push({ name: 'chart', result: output });
        } else result.summary += ' 没有可绘制的有效聚合数据，已跳过图表兜底。';
      }
      if (!scopeInvalidated && result.numericTransforms?.length) report.facts = buildEvidence(report, { dataset, contract, numericTransforms: result.numericTransforms });
      if (!scopeInvalidated && ['insights', 'report'].includes(step.id)) report = maskSkippedReport(applyStageNarrative(report, result), task);
      if (step.id === 'verify') { validateReport(report); assertReportVerified(report); if (strict) validateCharts(report); }
      task = store.get('task', initial.id);
      if (task.status !== 'running' || workflow.closed) return;
      let deliverable;
      const fingerprint = artifactFingerprint({ stageId: step.id, dataset, contract, stage, upstream });
      if (strict) deliverable = buildStageDeliverable(step.id, result, { task, dataset, report, contract, previous, numericTransforms: result.numericTransforms });
      if (step.id === 'plan' && !strict) deliverable = { ...result };
      if (step.id === 'preprocess' && strict) {
        const operations = result.transformOperations || [];
        const derived = deriveDataset(dataset, operations);
        if (operations.length) {
          store.put('derived-dataset', derived.dataset); dataset = derived.dataset;
          task.derivedDatasetId = dataset.id;
          report = reportFacts(analyzeForTask(dataset, task)); report.facts = buildEvidence(report, { dataset });
          deliverable.operations = operations; deliverable.receipts = [derived.receipt];
        }
      }
      task.artifacts[step.id] = { ...result, deliverable, fingerprint, status: 'completed', validation: { status: strict && !scopeInvalidated ? 'verified' : 'legacy' }, reused: false, checks, revisions, repairBudget: { maxRounds: 2, maxTokens: repairTokenLimit, actualTokens: result.calls.reduce((sum, call) => sum + (call.usage?.totalTokens || 0), 0) }, coverage: buildContextProjection(report).coverage, tools: [...toolRecords, ...result.tools], createdAt: new Date().toISOString(), skillId: stage.skill.id, skillVersion: stage.skill.version, model: context.settings.model, effort: stage.effort || 'default', ...(scopeInvalidated ? { scopeInvalidated: true } : {}) };
      if(teamRoot) {team.updateNode(teamRoot.id,'completed');const persisted=store.get('task',initial.id);if(persisted?.artifacts?.team)task.artifacts.team=persisted.artifacts.team;task.artifacts[step.id].team=persisted?.artifacts?.team?.team||team.snapshot();}
      task.artifacts[step.id].retrieval = {ids: retrieval.map(doc => doc.id), count: retrieval.length, omitted: Math.max(0, corpus.length - retrieval.length)};
      if (step.id === 'plan') { task.artifacts.plan.validation = planValidation; task.artifacts.plan.critic = critiquePlan(result,{task,dataset,report}); }
      if (['insights','report','verify'].includes(step.id)) task.artifacts[step.id].critic = reviewResult(report,{task,dataset,contract,facts:report.facts});
      if (['charts', 'insights', 'report', 'verify'].includes(step.id)) task.report = report;
      if (step.id === 'verify') {
        task.verifiedReportHash = reportContentHash(report);
        report.qualityReceipts = buildQualityReceipts(task, report);
      }
      step.summary = result.summary;
      if (step.id === 'plan' && task.mode === 'collaborative' && !task._approved.includes('plan')) {
        if (scopeInvalidated) {
          task.steps[index].status = 'pending'; store.put('task', task); index--; continue;
        }
        task.steps[index].status = 'awaiting_approval'; task.steps[index].summary = result.summary;
        task.status = 'awaiting_approval'; task.updatedAt = new Date().toISOString();
        const detail = `已完成实际分析计划：${result.summary} ${task.artifacts.plan.critic?.issues.map(i=>i.message).join('；') || ''} ${planValidation?.blocked?.map(item => item.reason).join('；') || ''} 请确认后继续执行。`;
        task.events.push(makeEvent('approval', '等待确认分析计划', detail, step.id)); task.messages.push(makeMessage('assistant', detail));
        store.put('task', task); return;
      }
    }
    // Reload cancellation state after asynchronous model/tool/PDF calls.
    const latest = store.get('task', task.id);
    if (latest.status !== 'running' || workflow.closed) return;
    const targetStep = task.steps[index]; targetStep.status = 'completed'; targetStep.summary = step.summary;
    task.progress = Math.round((index + 1) * 100 / task.steps.length); task.updatedAt = new Date().toISOString();
    task.events.push(makeEvent('complete', `${step.name}完成`, step.summary, step.id));
    if (index === task.steps.length - 1) {
      task.status = 'completed'; task.report = report; task.report.pdf = task.report.pdf || latest.report?.pdf;
      task.messages.push(makeMessage('assistant', '分阶段分析和 PDF 已完成，20 试用额度已结算。')); store.finish(task, true);
    } else store.put('task', task);
  }
}
