// Mock provider fixture shared by API and browser integration tests.
// Keep the single-model response path in each caller separate.
import { STAGE_FIELDS } from './stage-contracts.js';
export function stageReply(body, overrides = {}) {
 const stageId = /阶段：([a-z]+)/.exec(body.messages?.[0]?.content || '')?.[1];
 const fields = STAGE_FIELDS[stageId]?.fields;
 if (!fields) throw new Error(`mock收到未知阶段：${stageId}`);
 const payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
 const result = { summary:'按真实聚合结果完成阶段分析。', operations:[], findings:[], recommendations:[], approved:true, issues:[] };
 for (const [key,type] of Object.entries(fields)) result[key] = type === 'array' ? [] : type === 'object' ? {} : type === 'boolean' ? true : 'mock';
 if (stageId === 'quality') result.profile = { coverage: payload.facts?.coverage || {} };
 if (stageId === 'plan') {
  result.questions = [{id:'goal',question:[...(payload.goal || '核对聚合证据')].slice(0,300).join(''),stageIds:['activity'],metricIds:[],priority:'should',status:'planned'}];
  result.steps = [{id:'check-evidence',stageId:'activity',purpose:'按聚合证据分析，核对覆盖与口径',dependsOn:[],expectedOutput:'可核验的聚合指标与限制',optional:false}];
 }
 if (['activity','retention','monetization','channel','seasonality'].includes(stageId)) result.metrics = (payload.facts?.facts || []).filter(fact => fact.metricId && fact.value !== null).map(fact => ({metricId:fact.metricId,value:fact.value,unit:fact.unit,denominator:fact.denominator,period:fact.period,datasetVersion:fact.datasetVersion,evidenceRefs:[fact.id]}));
 if (stageId === 'report') result.sections = [{title:'证据范围',text:'依据提供的聚合指标和覆盖信息核对。'}];
 if (stageId === 'verify') result.checks = ['核对合同、证据引用与覆盖范围'];
 return {...result,...overrides};
}
