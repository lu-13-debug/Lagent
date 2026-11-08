import { createContext, useContext, forwardRef, Children, isValidElement, cloneElement } from 'react';
import type { ReactNode, Ref, SVGProps, ReactElement } from 'react';
import type { Report } from '../types';
import { number } from './ui';
import { cumulativeSeries, paymentSeries } from '../operation-chart-data';
import { CHART_NAMES, cleanTitle, cleanNote, resolveSeriesColors, sortChannels } from '../operation-chart-settings';
import type { ChartId, ChartSettings } from '../operation-chart-settings';
type RetentionMetric = 'd1' | 'd7';
const W = 960;
const WEEKDAYS = ['周一','周二','周三','周四','周五','周六','周日'];
const GRANULARITY_LABEL = {day:'按日',week:'按周',month:'按月'};
type InnerProps = {report:Report;start:string;end:string};
type VisualProps = InnerProps & {id:ChartId;settings:ChartSettings;theme:'light'|'dark';svgRef?:Ref<SVGSVGElement>};
const VisualContext = createContext<VisualProps | null>(null);
const Empty = ({children}:{children:ReactNode}) => <p className="op-empty">{children}</p>;
function closeArea(path:string,baseline:number) {
 const points = [...path.matchAll(/[ML]([\d.-]+),([\d.-]+)/g)];
 return points.length ? `${path} L${points.at(-1)![1]},${baseline} L${points[0][1]},${baseline} Z` : '';
}
const ChartSvg = forwardRef<SVGSVGElement, SVGProps<SVGSVGElement>>(function ChartSvg(props, ref) {
 const {id,settings,theme,report} = useContext(VisualContext)!;
 const presentation = settings.charts[id]; const colors=resolveSeriesColors(presentation.palette,theme);
 const title=cleanTitle(presentation.title,CHART_NAMES[id]); const note=cleanNote(presentation.note);
 const legends = id==='retention' ? settings.retentionMetrics.map(m=>({name:m.toUpperCase(),series:m==='d1'?'primary':'tertiary',dash:m==='d7'})) : id==='payment' ? [{name:settings.paymentGranularity==='day'?'付费人数':'付费人次',series:'secondary',dash:false},{name:'活跃付费率',series:'tertiary',dash:true}].filter((_,i)=>settings.paymentShow==='both'||settings.paymentShow===(i===0?'payers':'rate')) : [];
 const availableLegends = id==='payment' ? legends.filter(l => paymentSeries(report.daily,settings.paymentGranularity).some(row => l.series==='secondary' ? row.payers!=null : row.rate!=null)) : legends;
 const legend = presentation.showLegend && availableLegends.length>1;
 const topLegend=legend && presentation.legendPosition==='top';
 const nodeText=(node:ReactNode):string=>Children.toArray(node).map(n=>isValidElement(n)?nodeText((n.props as {children?:ReactNode}).children):String(n)).join('');
 const originalChildren=Children.toArray(props.children);
 const subtitleElement=originalChildren[2] as ReactElement<{children:ReactNode}>;
 const subtitle=[...nodeText(subtitleElement?.props.children)];
 const subtitleLines=Array.from({length:Math.ceil(subtitle.length/70)},(_,i)=>subtitle.slice(i*70,(i+1)*70).join(''));
 const subtitleExtra=Math.max(0,subtitleLines.length-1)*17;
 const shift=(note?20:0)+(topLegend?28:0)+subtitleExtra;
 const view=String(props.viewBox).split(' ').map(Number); const height=view[3]+shift+(legend&&!topLegend?28:0);
 const transformNode=(node:ReactNode):ReactNode=> {
  if(!isValidElement(node)) return node;
  const el=node as ReactElement<Record<string,unknown>>; const p=el.props;
  if(el.type==='text' && p.fill==='#33443a' && !presentation.showLabels)return null;
  const map:Record<string,'primary'|'secondary'|'tertiary'>={'#1f7a52':'primary','#3f6f9e':'secondary','#a8802f':'tertiary','rgba(31,122,82,0.12)':'primary','rgba(168,128,47,0.14)':'tertiary'};
  const series=map[String(p.stroke)]||map[String(p.fill)];
  const extra:Record<string,unknown>={};
  if(series){extra['data-series']=series;extra.style={...(p.style as object),...(map[String(p.fill)]?{fill:colors[series]}:{}),...(map[String(p.stroke)]?{stroke:colors[series]}:{})}; if(String(p.fill).startsWith('rgba'))extra.fillOpacity=.12;}
  if(el.type==='text' && p.fill==='#33443a')extra['data-value-label']='';
  return cloneElement(el,extra,p.children?Children.map(p.children as ReactNode,transformNode):p.children as ReactNode);
 };
 const children=Children.toArray(props.children); const head=children.slice(1,3); const plot=children.slice(3);
 return <svg {...props} ref={ref} data-palette={presentation.palette} viewBox={`0 0 ${view[2]} ${height}`} aria-label={`${title} · ${props['aria-label']} · ${id==='channel'?settings.channelType==='bar'?'柱状':'横向条形':id==='retention'?settings.retentionType==='area'?'面积':'折线':id==='cumulative'?settings.cumulativeType==='area'?'面积':'折线':''}`}>
 <rect width={view[2]} height={height} fill="#ffffff" />
 {head.map((n,i)=>isValidElement(n)?cloneElement(n as ReactElement<{children:ReactNode}>,{},i===0?title:subtitleLines.map((line,index)=><tspan key={index} x="18" y={50+index*17}>{line}</tspan>)):n)}
 {note&&<text x="18" y={70+subtitleExtra} fill="#59685f" fontSize="12">观察背景：{note}</text>}
 <g transform={`translate(0 ${shift})`}>{Children.map(plot,transformNode)}</g>
 {legend&&<g className="op-svg-legend" transform={`translate(18 ${topLegend?(note?94:74)+subtitleExtra:height-8})`}>{availableLegends.map((l,i)=><g key={l.name} transform={`translate(${i*240} 0)`}><line x1="0" x2="24" y1="-4" y2="-4" strokeWidth={l.series==='secondary'?8:3} strokeDasharray={l.dash?'6 4':undefined} data-series={l.series} style={{stroke:colors[l.series as keyof typeof colors]}} /><text x="32" y="0" fill="#59685f" fontSize="12">{l.name}{l.dash?'（虚线）':l.series==='secondary'?'（柱）':'（实线）'}</text></g>)}</g>}
 </svg>;
});
export function OperationChartVisual(props:VisualProps) {
 const Component={channel:ChannelChart,weekday:WeekdayChart,retention:RetentionChart,payment:PaymentChart,cumulative:CumulativeChart}[props.id];
 return <VisualContext.Provider value={props}><Component report={props.report} start={props.start} end={props.end}/></VisualContext.Provider>;
}
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const maxOf = (values: (number | null | undefined)[]) => Math.max(1, ...values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
const text = (value: number | null | undefined, digits = 0) => value == null ? '—' : number(value, digits);
const short = (value: string, length = 14) => [...value].length > length ? `${[...value].slice(0, length).join('')}…` : value;

function weekdayRows(report: Report) {
  if (report.weekday?.length) return WEEKDAYS.map((label,index) => report.weekday!.find(row => row.index === index) || {index,label,days:0,dau:null,newUsers:null,revenue:null});
  return WEEKDAYS.map((label, index) => {
    const rows = report.daily.filter(day => (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7 === index);
    const average = (key: 'dau' | 'newUsers' | 'revenue') => {
      const values = rows.map(row => row[key]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
    };
    return { index, label, days: rows.filter(row => row.dau != null || row.newUsers != null || row.revenue != null).length, dau: average('dau'), newUsers: average('newUsers'), revenue: average('revenue') };
  });
}

function lineSegments(values: (number | null)[], x: (index: number) => number, y: (value: number) => number) {
  const paths: string[] = []; let path = '';
  values.forEach((value, index) => {
    if (value == null || !Number.isFinite(value)) { if (path) paths.push(path); path = ''; return; }
    path += `${path ? ' L' : 'M'}${x(index).toFixed(2)},${y(value).toFixed(2)}`;
  });
  if (path) paths.push(path);
  return paths;
}

function ChannelChart({ report, start, end }: InnerProps) {
  const { settings, svgRef } = useContext(VisualContext)!;
  const metric = settings.channelMetric; const topN = settings.channelTopN;

  const rows = sortChannels(report.channels, metric, settings.channelSort)
    .map(channel => ({ ...channel, value: metric === 'users' ? channel.users : metric === 'd1' ? channel.d1 : channel.revenue }))
    .slice(0, topN);
  const available = rows.filter(row => row.value != null);
  const label = metric === 'users' ? (report.labels?.channelUsers || '新增玩家') : metric === 'd1' ? '次日留存' : `${report.labels?.channelRevenue || '支付收入'}（${report.currency}）`;
  if (!rows.length) return <Empty>当前范围没有注册渠道数据，补齐注册表和渠道字段后重新分析。</Empty>;
  const max = maxOf(available.map(row => row.value));
  const left = 158, width = W - left - 96, top = 78, rowHeight = 32, height = top + rows.length * rowHeight + 34;
  if(settings.channelType === 'bar') return <div className="op-chart-scroll"><ChartSvg ref={svgRef} viewBox="0 0 960 380" role="img" aria-label={`渠道${label}柱状对比`}>
    <rect width="960" height="380" fill="#ffffff"/><text x="18" y="28" fill="#233d30">渠道表现</text><text x="18" y="50" fill="#59685f" fontSize="12">{start} 至 {end} · {label} · {settings.channelSort === 'name' ? '按名称' : settings.channelSort === 'asc' ? '值升序' : '值降序'} · 前 {topN} 个渠道；无覆盖或不可计算显示 —</text>
    {rows.map((row,index)=>{const step=860/rows.length; const x=64+index*step; const h=row.value==null?0:row.value/max*220;return <g key={row.name}><line x1="58" x2="928" y1="306" y2="306" stroke="#d9e2dc"/>{row.value!=null&&<rect x={x} y={306-h} width={Math.max(2,step-12)} height={h} fill={metric==='users'?'#1f7a52':metric==='d1'?'#3f6f9e':'#a8802f'}/>}<text x={x} y="326" fontSize="11" fill="#4c5b52">{short(row.name,6)}</text><text x={x} y={300-h} fontSize="11" fill="#33443a">{text(row.value,metric==='users'?0:1)}{metric==='d1'&&row.value!=null?'%':''}</text></g>})}
    <text x="18" y="366" fill="#59685f" fontSize="11">渠道按完整注册表归因；收入只统计成功订单。DATAAGENT</text>
  </ChartSvg></div>;
  return <>
    <div className="op-chart-scroll"><ChartSvg ref={svgRef} viewBox={`0 0 ${W} ${height}`} role="img" aria-label={`渠道${label}对比，前 ${rows.length} 个渠道`} fontFamily="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
      <rect width={W} height={height} fill="#ffffff" />
      <text x="18" y="28" fill="#233d30" fontSize="17" fontWeight="600">渠道{label}对比</text>
      <text x="18" y="50" fill="#59685f" fontSize="12">{start} 至 {end} · {label} · {settings.channelSort === 'name' ? '按名称' : settings.channelSort === 'asc' ? '按值升序' : '按值降序'}，最多显示 {topN} 个渠道；— 表示覆盖不足或不可计算</text>
      {rows.map((row, index) => {
        const y = top + index * rowHeight;
        const barWidth = row.value == null ? 0 : Math.max(2, row.value / max * width);
        return <g key={row.name}>
          <text x={left - 12} y={y + 15} textAnchor="end" fill="#4c5b52" fontSize="12">{short(row.name)}</text>
          <rect x={left} y={y + 3} width={width} height="16" rx="4" fill="#f0f4f1" />
          {row.value != null && <rect x={left} y={y + 3} width={barWidth} height="16" rx="4" fill={metric === 'users' ? '#1f7a52' : metric === 'd1' ? '#3f6f9e' : '#a8802f'} />}
          <text x={left + Math.max(barWidth, 0) + 8} y={y + 16} fill="#33443a" fontSize="12">{text(row.value, metric === 'd1' ? 1 : metric === 'revenue' ? 2 : 0)}{metric === 'd1' && row.value != null ? '%' : ''}</text>
        </g>;
      })}
      <text x="18" y={height - 10} fill="#59685f" fontSize="11">渠道按完整注册表归因；收入只统计成功订单。DATAAGENT</text>
    </ChartSvg></div>
    {available.length < rows.length && <p className="op-help">部分渠道没有覆盖或有数据，显示为 —，不能按零解释。</p>}
  </>;
}

function WeekdayChart({ report, start, end }: InnerProps) {
  const { settings, svgRef } = useContext(VisualContext)!;
  const metric = settings.weekdayMetric; const type = settings.weekdayType;

  const rows = weekdayRows(report);
  const available = rows.filter(row => row[metric] != null);
  const label = metric === 'dau' ? '平均活跃' : metric === 'newUsers' ? '平均新增' : `平均收入（${report.currency}）`;
  if (!available.length) return <Empty>当前范围没有可按星期汇总的数据，请检查活跃、注册或支付覆盖。</Empty>;
  const max = maxOf(rows.map(row => row[metric]));
  const color = metric === 'dau' ? '#1f7a52' : metric === 'newUsers' ? '#3f6f9e' : '#a8802f';
  const left = 58, top = 82, plotWidth = W - left - 32, plotHeight = 214, barWidth = 62, gap = (plotWidth - barWidth * 7) / 6;
  const x = (index: number) => left + index * (barWidth + gap) + barWidth / 2;
  const y = (value: number) => top + plotHeight - Math.max(0, value) * plotHeight / max;
  return <>
    <div className="op-chart-scroll"><ChartSvg ref={svgRef} viewBox={`0 0 ${W} 360`} role="img" aria-label={`周一至周日${label}${type === 'line' ? '折线' : '柱状'}规律`} fontFamily="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
      <rect width={W} height="360" fill="#ffffff" />
      <text x="18" y="28" fill="#233d30" fontSize="17" fontWeight="600">周内{label}规律</text>
      <text x="18" y="50" fill="#59685f" fontSize="12">{start} 至 {end} · {label} · 同一星期先按日计算再取平均；无覆盖日期不参与平均{type === 'line' ? '；相邻星期相连仅用于观察节奏' : ''}</text>
      {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={left} x2={left + plotWidth} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} stroke="#e2e7e4" strokeDasharray="3 4" /><text x={left - 10} y={top + plotHeight * ratio + 4} textAnchor="end" fill="#59685f" fontSize="11">{text(max * (1 - ratio), metric === 'revenue' ? 2 : 0)}</text></g>)}
      {type === 'bar' ? rows.map((row, index) => {
        const value = row[metric];
        const barHeight = value == null ? 0 : Math.max(2, value / max * plotHeight);
        return <g key={row.label}>
          <rect x={x(index) - barWidth / 2} y={top} width={barWidth} height={plotHeight} fill="#f7f9f7" rx="4" />
          {value != null && <rect x={x(index) - barWidth / 2} y={top + plotHeight - barHeight} width={barWidth} height={barHeight} rx="4" fill={color} />}
          <text x={x(index)} y={top + plotHeight - barHeight - 7} textAnchor="middle" fill="#33443a" fontSize="11">{text(value, metric === 'revenue' ? 2 : 0)}</text>
        </g>;
      }) : <>
        {lineSegments(rows.map(row => row[metric]), x, y).map((path, index) => <path key={`line-${index}`} d={path} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" />)}
        {rows.map((row, index) => row[metric] == null ? null : <g key={row.label}><circle cx={x(index)} cy={y(row[metric]!)} r="4" fill="#ffffff" stroke={color} strokeWidth="2.2" /><text x={x(index)} y={y(row[metric]!) - 10} textAnchor="middle" fill="#33443a" fontSize="11">{text(row[metric], metric === 'revenue' ? 2 : 0)}</text></g>)}
      </>}
      {rows.map((row, index) => <g key={`label-${row.label}`}><text x={x(index)} y={top + plotHeight + 22} textAnchor="middle" fill="#4c5b52" fontSize="12">{row.label}</text><text x={x(index)} y={top + plotHeight + 38} textAnchor="middle" fill="#8a968f" fontSize="10">{row.days} 天</text></g>)}
      <text x="18" y="350" fill="#59685f" fontSize="11">周内规律只描述范围内容量节奏，不证明活动、版本或推送造成差异。DATAAGENT</text>
    </ChartSvg></div>
  </>;
}

function RetentionChart({ report, start, end }: InnerProps) {
  const { settings, svgRef } = useContext(VisualContext)!;

  const selected = settings.retentionMetrics;
  const raw = report.retention;
  const bucketSize = Math.ceil(raw.length / 60);
  const rows = bucketSize > 1 ? Array.from({ length: Math.ceil(raw.length / bucketSize) }, (_, index) => {
    const slice = raw.slice(index * bucketSize, (index + 1) * bucketSize);
    const users = slice.reduce((sum, row) => sum + row.users, 0);
    const weighted = (key: RetentionMetric) => {
      const mature = slice.filter(row => row[key] != null);
      const total = mature.reduce((sum, row) => sum + row.users, 0);
      return total ? round(mature.reduce((sum, row) => sum + row.users * row[key]!, 0) / total) : null;
    };
    return { date: slice[0].date, users, d1: weighted('d1'), d7: weighted('d7') };
  }) : raw;
  const values = rows.flatMap(row => selected.map(metric => row[metric])).filter((value): value is number => value != null);
  if (!rows.length || !values.length) return <Empty>当前范围没有成熟留存 cohort，或缺少注册与活跃覆盖，暂无法绘制留存曲线。</Empty>;
  const max = Math.max(10, Math.ceil(maxOf(values) / 10) * 10);
  const left = 58, top = 80, plotWidth = W - left - 34, plotHeight = 212;
  const x = (index: number) => left + (rows.length > 1 ? index * plotWidth / (rows.length - 1) : plotWidth / 2);
  const y = (value: number) => top + plotHeight - Math.max(0, value) * plotHeight / max;
  const ticks = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  const colors: Record<RetentionMetric, string> = { d1: '#1f7a52', d7: '#a8802f' };
  return <>
    <div className="op-chart-scroll"><ChartSvg ref={svgRef} viewBox={`0 0 ${W} 360`} role="img" aria-label={`按注册日期分组的 ${selected.map(metric => metric.toUpperCase()).join(' 与 ')} 留存曲线`} fontFamily="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
      <rect width={W} height="360" fill="#ffffff" />
      <text x="18" y="28" fill="#233d30" fontSize="17" fontWeight="600">注册 cohort 留存曲线</text>
      <text x="18" y="50" fill="#59685f" fontSize="12">{start} 至 {end} · 仅绘制 {selected.map(metric => metric.toUpperCase()).join(' / ')} 观察期成熟的 cohort；{bucketSize > 1 ? `每 ${bucketSize} 个注册日按人数加权合并；` : ''}断线表示该日不可计算</text>
      {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={left} x2={left + plotWidth} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} stroke="#e2e7e4" strokeDasharray="3 4" /><text x={left - 10} y={top + plotHeight * ratio + 4} textAnchor="end" fill="#59685f" fontSize="11">{number(max * (1 - ratio), 0)}%</text></g>)}
      {settings.retentionType === 'area' && selected.map(metric => lineSegments(rows.map(row => row[metric]), x, y).map((path,index)=><path key={`area-${metric}-${index}`} d={closeArea(path,top+plotHeight)} fill={colors[metric]} fillOpacity={.12}/>))}
      {selected.map(metric => rows.map((row,index)=>row[metric]==null?null:<g key={`point-${metric}-${index}`}><circle cx={x(index)} cy={y(row[metric]!)} r={metric==='d1'?3:2} fill={colors[metric]}/>{settings.charts.retention.showLabels && index % Math.max(1,Math.ceil(rows.length/10)) === 0 && <text data-value-label='' x={x(index)} y={y(row[metric]!)-(metric==='d1'?10:-18)} fontSize='10' fill='#33443a'>{text(row[metric],1)}%</text>}</g>))}
      {selected.map(metric => lineSegments(rows.map(row => row[metric]), x, y).map((path, index) => <path key={`${metric}-${index}`} d={path} fill="none" stroke={colors[metric]} strokeWidth={metric === 'd1' ? '2.4' : '2.2'} strokeDasharray={metric === 'd7' ? '7 4' : undefined} strokeLinecap="round" />))}
      {ticks.map(index => <text key={index} x={x(index)} y={top + plotHeight + 22} textAnchor={index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'} fill="#4c5b52" fontSize="11">{rows[index].date}</text>)}
      <text x="18" y="350" fill="#59685f" fontSize="11">留存按注册人数加权；目标日必须落在活跃覆盖内且已成熟。DATAAGENT</text>
    </ChartSvg></div>
  </>;
}

function PaymentChart({ report, start, end }: InnerProps) {
  const { settings, svgRef } = useContext(VisualContext)!;

  const granularity = settings.paymentGranularity; const show = settings.paymentShow;
  const rows = paymentSeries(report.daily, granularity);
  const payersVisible = show !== 'rate';
  const rateVisible = show !== 'payers';
  const hasPayers = payersVisible && rows.some(row => row.payers != null);
  const hasRate = rateVisible && rows.some(row => row.rate != null);
  if (!hasPayers && !hasRate) return <Empty>{payersVisible && rateVisible ? '当前范围没有支付覆盖，付费人数与付费率无法绘制。' : payersVisible ? '当前范围没有支付覆盖，付费人数无法绘制。' : '当前范围没有活跃与支付交集，付费率无法绘制。'}</Empty>;
  const maxPayers = maxOf(rows.map(row => row.payers));
  const rateMax = Math.max(5, Math.ceil(maxOf(rows.map(row => row.rate)) / 5) * 5);
  const dualAxis = hasPayers && hasRate;
  const left = 58, top = 82, plotWidth = W - left - (dualAxis ? 52 : 34), plotHeight = 206;
  const barWidth = Math.max(1, plotWidth / Math.max(1, rows.length) - 1);
  const x = (index: number) => left + (rows.length > 1 ? index * plotWidth / (rows.length - 1) : plotWidth / 2);
  const yPayers = (value: number) => top + plotHeight - Math.max(0, Math.min(maxPayers, value)) * plotHeight / maxPayers;
  const yRate = (value: number) => top + plotHeight - Math.max(0, Math.min(rateMax, value)) * plotHeight / rateMax;
  const payersLabel = granularity === 'day' ? '付费人数' : '付费人次';
  const seriesDescription = [
    hasPayers ? `柱为${payersLabel}${granularity === 'day' ? '' : '合计'}` : '',
    hasRate ? '线为付费人数 / 活跃人数，无覆盖时断开' : '',
  ].filter(Boolean).join('；');
  const title = show === 'rate' ? '活跃付费率' : show === 'payers' ? `${GRANULARITY_LABEL[granularity]}${payersLabel}` : '付费人数与活跃付费率';
  return <>
    <div className="op-chart-scroll"><ChartSvg ref={svgRef} viewBox={`0 0 ${W} 360`} role="img" aria-label={`${GRANULARITY_LABEL[granularity]}${title}`} fontFamily="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
      <rect width={W} height="360" fill="#ffffff" />
      <text x="18" y="28" fill="#233d30" fontSize="17" fontWeight="600">{title}</text>
      <text x="18" y="50" fill="#59685f" fontSize="12">{start} 至 {end} · {GRANULARITY_LABEL[granularity]}汇总；{seriesDescription}</text>
      <line x1={left} x2={left + plotWidth} y1={top + plotHeight} y2={top + plotHeight} stroke="#d9e2dc" />
      {dualAxis && <line x1={left + plotWidth + 26} x2={left + plotWidth + 26} y1={top} y2={top + plotHeight} stroke="#efe7d6" />}
      {[0, 0.5, 1].map(ratio => <g key={`axis-${ratio}`}><text x={left - 10} y={top + plotHeight * ratio + 4} textAnchor="end" fill="#59685f" fontSize="11">{hasPayers ? text(maxPayers * (1 - ratio), 0) : `${number(rateMax * (1 - ratio), 0)}%`}</text>{dualAxis && <text x={left + plotWidth + 34} y={top + plotHeight * ratio + 4} fill="#8a7440" fontSize="11">{number(rateMax * (1 - ratio), 0)}%</text>}</g>)}
      {hasPayers && rows.map((row, index) => row.payers == null ? null : <rect key={`payer-${row.label}`} x={x(index) - barWidth / 2} y={top + plotHeight - Math.max(2, row.payers / maxPayers * plotHeight)} width={barWidth} height={Math.max(2, row.payers / maxPayers * plotHeight)} fill="#3f6f9e" rx="1" />)}
      {hasRate && lineSegments(rows.map(row => row.rate), x, yRate).map((path, index) => <path key={index} d={path} fill="none" stroke="#a8802f" strokeDasharray="6 4" strokeWidth="2.2" strokeLinecap="round" />)}
      {rows.map((row,index)=>index % Math.max(1,Math.ceil(rows.length/10)) ? null : <g key={`values-${index}`}>{hasPayers&&row.payers!=null&&<text x={x(index)} y={yPayers(row.payers)-8} textAnchor="middle" fill="#33443a" fontSize="10">{text(row.payers)}</text>}{hasRate&&row.rate!=null&&<text x={x(index)} y={yRate(row.rate)+16} textAnchor="middle" fill="#33443a" fontSize="10">{text(row.rate,1)}%</text>}</g>)}
      <text x={left} y={top + plotHeight + 22} fill="#4c5b52" fontSize="11">{rows[0]?.label}</text><text x={left + plotWidth} y={top + plotHeight + 22} textAnchor="end" fill="#4c5b52" fontSize="11">{rows.at(-1)?.label}</text>
      <text x="18" y="350" fill="#59685f" fontSize="11">付费率为该周期活跃与支付用户交集 / 活跃人数；收入不跨币种合计。DATAAGENT</text>
    </ChartSvg></div>
  </>;
}

function CumulativeChart({ report, start, end }: InnerProps) {
  const { settings, svgRef } = useContext(VisualContext)!;

  const metric = settings.cumulativeMetric; const type = settings.cumulativeType; const granularity = settings.cumulativeGranularity;
  const series = cumulativeSeries(report.daily, granularity, metric);
  const hasValue = report.daily.some(day => day[metric] != null);
  const label = metric === 'newUsers' ? `累计新增${report.labels?.newEntity || '玩家'}` : `累计${report.labels?.revenueName || '支付收入'}（${report.currency}）`;
  if (!hasValue) return <Empty>当前范围没有可累计的{metric === 'newUsers' ? '新增' : '支付'}数据。</Empty>;
  const totals = series.map(point => point.coverage ? point.value : null);
  const max = maxOf(totals);
  const left = 66, top = 80, plotWidth = W - left - 36, plotHeight = 206;
  const x = (index: number) => left + (series.length > 1 ? index * plotWidth / (series.length - 1) : plotWidth / 2);
  const y = (value: number) => top + plotHeight - value * plotHeight / max;
  const paths = lineSegments(totals, x, y);
  const line = paths.join(' ');
  const area = type === 'area' ? paths.map(path => closeArea(path, top + plotHeight)).join(' ') : '';
  return <>
    <div className="op-chart-scroll"><ChartSvg ref={svgRef} viewBox={`0 0 ${W} 350`} role="img" aria-label={`${label}${GRANULARITY_LABEL[granularity]}趋势`} fontFamily="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">
      <rect width={W} height="350" fill="#ffffff" />
      <text x="18" y="28" fill="#233d30" fontSize="17" fontWeight="600">{label}</text>
      <text x="18" y="50" fill="#59685f" fontSize="12">{start} 至 {end} · {label} · {GRANULARITY_LABEL[granularity]}累加，仅累加有覆盖日期；断供日期不按零补齐</text>
      {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={left} x2={left + plotWidth} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} stroke="#e2e7e4" strokeDasharray="3 4" /><text x={left - 10} y={top + plotHeight * ratio + 4} textAnchor="end" fill="#59685f" fontSize="11">{max * (1 - ratio) >= 10000 ? `${number(max * (1 - ratio) / 10000, 1)}万` : text(max * (1 - ratio), metric === 'revenue' ? 2 : 0)}</text></g>)}
      {area && <path d={area} fill={metric === 'newUsers' ? 'rgba(31,122,82,0.12)' : 'rgba(168,128,47,0.14)'} />}
      {line && <path d={line} fill="none" stroke={metric === 'newUsers' ? '#1f7a52' : '#a8802f'} strokeWidth="2.6" strokeLinecap="round" />}
      {series.map((row,index)=>!row.coverage||index % Math.max(1,Math.ceil(series.length/10))?null:<g key={`value-${index}`}><circle cx={x(index)} cy={y(row.value)} r="3" fill={metric==='newUsers'?'#1f7a52':'#a8802f'}/><text x={x(index)} y={y(row.value)-10} textAnchor="middle" fill="#33443a" fontSize="10">{text(row.value,metric==='revenue'?2:0)}</text></g>)}
      <text x={left} y={top + plotHeight + 22} fill="#4c5b52" fontSize="11">{series[0]?.label}</text><text x={left + plotWidth} y={top + plotHeight + 22} textAnchor="end" fill="#4c5b52" fontSize="11">{series.at(-1)?.label}</text>
      <text x="18" y="340" fill="#59685f" fontSize="11">累计值为范围内逐日累加，不能替代完整生命周期 LTV。DATAAGENT</text>
    </ChartSvg></div>
  </>;
}



