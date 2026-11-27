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
