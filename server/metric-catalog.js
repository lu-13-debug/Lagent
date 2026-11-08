import { getProfile } from './domain-profiles.js';
export const METRIC_DEFINITION_VERSION = '2026-11-02.1';
const definitions = {
 dau: { tables:['activity'], definition:'头条活跃覆盖自然日内按 user_id 去重人数' },
 new_users: { tables:['users'], definition:'注册覆盖期间注册人数' },
 d1_retention: { tables:['users','activity'], definition:'仅 D1 目标日有活跃覆盖的成熟注册 cohort，按注册人数加权' },
 d7_retention: { tables:['users','activity'], definition:'仅 D7 目标日有活跃覆盖的成熟注册 cohort，按注册人数加权' },
 revenue: { tables:['payments'], definition:'支付覆盖期间成功订单金额，按订单去重、整数分累计' },
 arppu: { tables:['payments'], definition:'支付覆盖期间成功支付收入 / 同期去重付费人数' },
 pay_rate: { tables:['activity','payments'], definition:'头条活跃日活跃与成功支付用户交集人数 / 同日活跃人数' },
 arpdau: { tables:['activity','payments'], definition:'头条活跃日成功支付收入 / 同日活跃人数' },
};
export function getMetricCatalog(domain = 'game') {
 const profile = getProfile(domain);
 return profile.metricOrder.map(id => ({id, label:profile.metricLabels[id] || id, domain, definitionVersion:METRIC_DEFINITION_VERSION, definitionStatus:domain==='game' && definitions[id]?'confirmed':'unconfirmed', definition:domain==='game' ? definitions[id]?.definition || null : null, source:{tables:domain==='game'?definitions[id]?.tables || []:[],status:'unconfirmed'}}));
}
export function attachMetricMetadata(metrics, context = {}) {
 const {domain='game', coverage={}, start=null,end=null,headlineEnd=null,payerCount=null,activeCount=null,activePayerCount=null,retention=[]}=context;
 const intersect = table => coverage[table] ? {start: start && start>coverage[table].start?start:coverage[table].start,end:end && end<coverage[table].end?end:coverage[table].end} : {start:null,end:null};
 for(const metric of metrics){
  const def = domain==='game'?definitions[metric.id]:null;
  const dailyMetric=['dau','pay_rate','arpdau'].includes(metric.id);
  const available=Boolean(def && def.tables.every(t=>coverage[t] && (!dailyMetric || (headlineEnd && coverage[t].start<=headlineEnd && coverage[t].end>=headlineEnd))));
  let period={start:null,end:null}, denominator={value:null,unit:null,definition:'未确认'}, numerator;
  if(def){
   if(['dau','pay_rate','arpdau'].includes(metric.id)) period={start:headlineEnd,end:headlineEnd};
   else if(['revenue','arppu'].includes(metric.id)) period=intersect('payments');
   else period=intersect('users');
   if(metric.id==='arppu') denominator={value:available?payerCount:null,unit:'人',definition:'期间成功支付去重人数'};
   if(['pay_rate','arpdau'].includes(metric.id)) denominator={value:available && metric.value!==null?activeCount:null,unit:'人',definition:'同日去重活跃人数'};
   if(metric.id==='pay_rate') numerator={value:available && metric.value!==null?activePayerCount:null,unit:'人',definition:'同日活跃且成功支付交集人数'};
   if(['d1_retention','d7_retention'].includes(metric.id)){
    const key=metric.id==='d1_retention'?'d1':'d7'; const mature=retention.filter(c=>c[key]!==null);
    denominator={value:available?mature.reduce((n,c)=>n+c.users,0):null,unit:'人',definition:`${key.toUpperCase()} 已成熟且目标日有活跃覆盖的注册人数`};
    period={start:mature[0]?.date || null,end:mature.at(-1)?.date || null,kind:'mature_registration_cohorts',lagDays:key==='d1'?1:7};
   }
  }
  if(period.start && period.end && period.start>period.end) period={start:null,end:null};
  Object.assign(metric,{period,denominator,...(numerator?{numerator}:{}),source:{tables:def?.tables || [],status:!def?'unconfirmed':available?'available':'unavailable'},definitionVersion:METRIC_DEFINITION_VERSION,definitionStatus:def?'confirmed':'unconfirmed',definition:def?.definition || null});
 }
 return metrics;
}

