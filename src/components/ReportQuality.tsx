import type { Task } from '../types';
export function ReportQuality({ task, id }: { task: Task; id?: string }) {
  const critic = task.artifacts?.verify?.critic || task.artifacts?.report?.critic;
  const delegations=Object.values(task.artifacts||{}).filter(a=>!a.scopeInvalidated).flatMap(a=>a.delegations||[]);
  const panel = task.artifacts?.insights?.scopeInvalidated ? undefined : task.artifacts?.insights?.panel;
  const hasReview = panel?.reviewers.some(item => item.status === 'completed');
  const failedReviews = panel?.reviewers.filter(item => item.status === 'failed').length || 0;
  const labels: Record<string, string> = { 'data-quality': '数据质量', narrative: '语义审查', visual: '视觉审查' };
  const status: Record<string, string> = { pass: '通过', issue: '有问题', unreviewed: '未审查', disabled: '已禁用' };
  return <section className="report-section" id={id} tabIndex={id ? -1 : undefined} aria-label="来源与审查记录"><h3>来源与审查记录</h3>
    <p>{task.sourceProvenance ? `${task.sourceProvenance.demo ? '演示数据' : '上传数据'} · ${task.sourceProvenance.rowCount} 行 · 来源已登记` : '历史报告未登记完整来源链'}</p>
    <p>生成报告不代表已完成全部审查。</p>
    {delegations.length>0&&<div aria-label="子智能体"><h4>子智能体</h4><p>参与 {delegations.length} 次 · 成功 {delegations.filter(d=>d.status==='completed').length} · 失败 {delegations.filter(d=>d.status==='failed').length} · Token {delegations.reduce((n,d)=>n+d.tokens,0)}</p></div>}
    {critic && <div aria-label="评审状态"><h4>评审状态</h4><p>{({pass:'通过',revise:'需修订',reject:'未通过',unreviewed:'未审查'} as const)[critic.verdict] || '未审查'} · 阻断 {critic.issues.filter(i=>i.severity==='blocking').length} 项 · 警告 {critic.issues.filter(i=>i.severity==='warning').length} 项</p></div>}
    {panel?.enabled && <div className="report-panel" aria-label="多模型评审"><h4>多模型评审</h4>{hasReview ? <><p>参与模型 {panel.participants} 个 · 共识 {panel.agreements.length} 条{panel.degraded ? ' · 部分评审不可用，已降级继续' : ''}</p><p>分歧表示尚需核对，不代表结论已获验证。</p><ul>{[...panel.disagreements.judgeOnly,...panel.disagreements.reviewerOnly].map((item,index)=><li key={index}>{item.title}</li>)}</ul></> : <p>评审不可用，已按单模型完成</p>}{failedReviews > 0 && <p>失败评审员：{failedReviews} 位</p>}</div>}
    <ul>{(task.qualityReceipts || task.report?.qualityReceipts)?.checks.map(check => <li key={check.id}>{labels[check.id] || '专项审查'}：{status[check.status] || '未审查'}。{check.reasons.join('；')}</li>)}</ul>
  </section>;
}
