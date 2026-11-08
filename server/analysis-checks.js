export function analysisChecks(report, contract = {}) {
 const rows = (report.daily || []).filter(row => Number.isFinite(row.dau));
 const unavailable = { status: 'not_applicable', reason: '有效日样本不足' };
 if (rows.length < 2) return { comparison: unavailable, anomaly: unavailable, robustness: unavailable };
 const values = rows.map(row => row.dau), mean = values.reduce((a,b)=>a+b,0)/values.length;
 const sorted = [...values].sort((a,b)=>a-b), median = sorted[Math.floor(sorted.length/2)];
 const sd = Math.sqrt(values.reduce((sum,v)=>sum+(v-mean)**2,0)/values.length);
 return { comparison: !contract.comparisonSpec ? { status:'not_applicable', reason:'缺少已确认的可比时间或分组' } : { status:'not_applicable', reason:'暂不支持指定期间或分组的聚合比较，需明确执行方案后分析；未计算首末日替代值' },
 anomaly: rows.length < 7 ? unavailable : { status:'completed', method:'3-sigma', dates:rows.filter(row=>sd>0&&Math.abs(row.dau-mean)>3*sd).map(row=>row.date) },
 robustness: rows.length < 7 ? unavailable : { status:'completed', method:'mean-median', mean, median, interpretation:'均值与中位数对照，仅检验异常值敏感性' } };
}
export function validateCharts(report) {
 for(const chart of report.charts || []) {
  const source = report[chart.source || 'daily'];
  if(!Array.isArray(source) || !Array.isArray(chart.data) || !chart.x || !chart.y) throw new Error('图表缺少可验证来源或坐标');
  for(const row of chart.data) if(!source.some(item=>item[chart.x]===row[chart.x]&&item[chart.y]===row[chart.y])) throw new Error('图表取数与聚合证据不一致');
 }
 return true;
}
