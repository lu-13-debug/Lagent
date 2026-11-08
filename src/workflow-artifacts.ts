type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const labels: Record<string, string> = { DataProfile: '数据概况', AnalysisContract: '分析范围与口径', AnalysisPlan: '分析计划', TransformReceipt: '数据处理记录', AnalysisResult: '分析结果', FigurePlan: '绘图计划', FigureReceipt: '图表记录', FindingsLedger: '发现与证据', ReportDocument: '报告正文', ReviewReceipt: '核验记录', ExportReceipt: '导出记录' };
export function artifactSummary(value: unknown): string[] {
  const artifact = object(value), deliverable = object(artifact.deliverable), validation = object(artifact.validation);
  const lines: string[] = [];
  if (artifact.scopeInvalidated) lines.push('分析范围已变化，此产物不再供下游引用');
  if (artifact.reused) lines.push('已复用输入与版本一致的结果');
  const kind = String(deliverable.kind || deliverable.type || '');
  if (labels[kind]) lines.push(`已保存${labels[kind]}`);
  const status = validation.status;
  if (status === 'verified' || status === 'validated' || status === 'passed' || validation.valid === true) lines.push('阶段产物已校验');
  else if (status === 'legacy') lines.push('旧格式结果，仅作兼容读取');
  else if (status === 'failed' || validation.valid === false) lines.push('阶段产物未通过校验');
  const revisions = artifact.revisions;
  if (Array.isArray(revisions) && revisions.length) lines.push(`已进行 ${revisions.length} 轮定向修订`);
  const coverage = object(deliverable.coverage || artifact.coverage);
  for (const [name, entry] of Object.entries(coverage)) {
    const row = object(entry), total = row.totalRows ?? row.total, provided = row.providedRows ?? row.provided;
    if (typeof total === 'number' && typeof provided === 'number') lines.push(`${({ daily: '每日数据', channels: '渠道数据', retention: '留存数据' } as Record<string, string>)[name] || '聚合数据'}：提供 ${provided} / ${total} 行${provided < total ? '，已声明取样范围' : ''}`);
  }
  const panel = object(artifact.panel);
  if (panel.enabled && !artifact.scopeInvalidated) {
    const disagreements = object(panel.disagreements);
    const count = (v:unknown) => Array.isArray(v) ? v.length : 0;
    lines.push(`多模型评审：参与模型 ${Number(panel.participants) || 0}；共识 ${count(panel.agreements)}；分歧 ${count(disagreements.judgeOnly)+count(disagreements.reviewerOnly)}`);
    const failed = Array.isArray(panel.reviewers) ? panel.reviewers.filter(v=>object(v).status==='failed').length : 0;
    if (failed) lines.push(`失败评审员 ${failed}，已降级继续`);
    else if (panel.degraded) lines.push('多模型评审已降级继续');
  }
  return lines;
}

