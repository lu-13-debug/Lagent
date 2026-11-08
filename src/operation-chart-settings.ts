import type { Granularity } from './operation-chart-data';

export const CHART_IDS = ['channel', 'weekday', 'retention', 'payment', 'cumulative'] as const;
export type ChartId = typeof CHART_IDS[number];
export const CHART_NAMES: Record<ChartId, string> = { channel:'渠道表现', weekday:'周内规律', retention:'留存曲线', payment:'付费结构', cumulative:'累计增长' };
export type Palette = 'default' | 'warm' | 'cool';
export type Theme = 'light' | 'dark';
export type RetentionMetric = 'd1' | 'd7';
export interface ChartPresentation { title:string; note:string; showLabels:boolean; showLegend:boolean; legendPosition:'top'|'bottom'; palette:Palette }
export interface ChartSettings {
  version:2; hidden:ChartId[]; order:ChartId[];
  channelMetric:'users'|'d1'|'revenue'; channelType:'horizontal'|'bar'; channelTopN:5|10|20; channelSort:'desc'|'asc'|'name';
  weekdayMetric:'dau'|'newUsers'|'revenue'; weekdayType:'bar'|'line';
  retentionMetrics:RetentionMetric[]; retentionType:'line'|'area';
  paymentShow:'both'|'payers'|'rate'; paymentGranularity:Granularity;
  cumulativeMetric:'newUsers'|'revenue'; cumulativeType:'area'|'line'; cumulativeGranularity:Granularity;
  charts:Record<ChartId,ChartPresentation>;
}
const object = (value:unknown): Record<string,unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {};
const clean = (value:unknown, length:number) => typeof value === 'string' ? [...value.trim()].slice(0,length).join('') : '';
export const cleanTitle = (value:unknown, fallback:string) => clean(value,30) || fallback;
export const cleanNote = (value:unknown) => clean(value,40);
const oneOf = <T extends string | number>(value:unknown, values:readonly T[], fallback:T):T => values.includes(value as T) ? value as T : fallback;
const ids = (value:unknown):ChartId[] => Array.isArray(value) ? [...new Set(value.filter((id):id is ChartId => CHART_IDS.includes(id as ChartId)))] : [];
export function defaultSettings():ChartSettings {
  return { version:2, hidden:[], order:[...CHART_IDS], channelMetric:'users', channelType:'horizontal', channelTopN:10, channelSort:'desc', weekdayMetric:'dau', weekdayType:'bar', retentionMetrics:['d1','d7'], retentionType:'line', paymentShow:'both', paymentGranularity:'day', cumulativeMetric:'newUsers', cumulativeType:'area', cumulativeGranularity:'day', charts:Object.fromEntries(CHART_IDS.map(id=>[id,{title:'',note:'',showLabels:true,showLegend:true,legendPosition:'top',palette:'default'}])) as Record<ChartId,ChartPresentation> };
}
export function normalizeSettings(value:unknown):ChartSettings {
  const v=object(value), base=defaultSettings(), order=ids(v.order);
  const metrics = Array.isArray(v.retentionMetrics) ? [...new Set(v.retentionMetrics.filter((m):m is RetentionMetric => m==='d1'||m==='d7'))] : [];
  const granularity=oneOf(v.granularity,['day','week','month'],'day');
  return { ...base, hidden:ids(v.hidden), order:[...order,...CHART_IDS.filter(id=>!order.includes(id))],
    channelMetric:oneOf(v.channelMetric,['users','d1','revenue'],'users'), channelType:oneOf(v.channelType,['horizontal','bar'],'horizontal'), channelTopN:oneOf(v.channelTopN,[5,10,20],10), channelSort:oneOf(v.channelSort,['desc','asc','name'],'desc'),
    weekdayMetric:oneOf(v.weekdayMetric,['dau','newUsers','revenue'],'dau'), weekdayType:oneOf(v.weekdayType,['bar','line'],'bar'),
    retentionMetrics:metrics.length?metrics:base.retentionMetrics, retentionType:oneOf(v.retentionType,['line','area'],'line'),
    paymentShow:oneOf(v.paymentShow,['both','payers','rate'],'both'), paymentGranularity:oneOf(v.paymentGranularity,['day','week','month'],granularity),
    cumulativeMetric:oneOf(v.cumulativeMetric,['newUsers','revenue'],'newUsers'), cumulativeType:oneOf(v.cumulativeType,['area','line'],'area'), cumulativeGranularity:oneOf(v.cumulativeGranularity,['day','week','month'],granularity),
    charts:Object.fromEntries(CHART_IDS.map(id=>{
      const p=object(object(v.charts)[id]);
      return [id,{ title:cleanTitle(p.title,''), note:cleanNote(p.note), showLabels:typeof p.showLabels==='boolean'?p.showLabels:true, showLegend:typeof p.showLegend==='boolean'?p.showLegend:true, legendPosition:oneOf(p.legendPosition,['top','bottom'],'top'), palette:oneOf(p.palette,['default','warm','cool'],'default') }];
    })) as Record<ChartId,ChartPresentation>,
  };
}
export function readSettings(storage:Pick<Storage,'getItem'>,key:string):ChartSettings { try { return normalizeSettings(JSON.parse(storage.getItem(key)||'null')); } catch { return defaultSettings(); } }
export function writeSettings(storage:Pick<Storage,'setItem'>,key:string,settings:ChartSettings):void { try { storage.setItem(key,JSON.stringify(normalizeSettings(settings))); } catch { /* 本机存储不可用时只保留会话设置。 */ } }
export function moveChart(order:ChartId[],id:ChartId,direction:-1|1):ChartId[] { const next=[...order], i=next.indexOf(id), target=i+direction; if(i>=0 && target>=0 && target<next.length) [next[i],next[target]]=[next[target],next[i]]; return next; }
export function toggleRetention(metrics:RetentionMetric[],metric:RetentionMetric):RetentionMetric[] { return metrics.includes(metric) ? metrics.length>1?metrics.filter(m=>m!==metric):[...metrics] : [...metrics,metric]; }
export function sortChannels<T extends {channel?:string;name?:string;users:number|null;d1:number|null;revenue:number|null}>(rows:T[],metric:'users'|'d1'|'revenue',sort:'asc'|'desc'|'name'):T[] {
  return [...rows].sort((a,b)=>{
    const name=(a.channel??a.name??'').localeCompare(b.channel??b.name??'','zh-CN');
    if(sort==='name') return name;
    const av=a[metric],bv=b[metric];
    if(av==null) return bv==null?name:1;
    if(bv==null) return -1;
    return (sort==='asc'?av-bv:bv-av)||name;
  });
}
const PALETTES:Record<Palette,Record<Theme,{primary:string;secondary:string;tertiary:string}>> = {
  default:{light:{primary:'#1f7a52',secondary:'#3f6f9e',tertiary:'#967020'},dark:{primary:'#76c89b',secondary:'#8ab8e0',tertiary:'#e4bf73'}},
  warm:{light:{primary:'#ad4935',secondary:'#8c5a30',tertiary:'#99526b'},dark:{primary:'#f4a08a',secondary:'#dfb080',tertiary:'#e8a3c2'}},
  cool:{light:{primary:'#246c91',secondary:'#5265a8',tertiary:'#287b7a'},dark:{primary:'#8bc9eb',secondary:'#b0b9f0',tertiary:'#80ceca'}},
};
export function resolveSeriesColors(palette:Palette,theme:Theme) { return {...PALETTES[oneOf(palette,['default','warm','cool'],'default')][theme==='dark'?'dark':'light']}; }
