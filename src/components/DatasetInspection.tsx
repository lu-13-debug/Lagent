import completenessCopy from '../completeness-copy.json';
import { api } from '../api';
import { useState } from 'react';
import { Copy, Info } from 'lucide-react';
import type { Capability, DataIssue, Dataset } from '../types';
import { datasetSummary, missingTableImpacts, tableLabels, metricLabel } from '../data-inspection';
import { number } from './ui';
import { AnalysisScope } from './AnalysisScope';

const offsetLabel = (minutes: number) => `UTC${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
const zoneLabel = (name: string, minutes: number) => name === offsetLabel(minutes) ? name : `${name}（${offsetLabel(minutes)}）`;

export function QualityIssues({ issues, capability }: { issues: DataIssue[]; capability?: Capability }) {
  const [copyStatus, setCopyStatus] = useState(''); const [manual, setManual] = useState('');
  const labels = capability ? Object.fromEntries(Object.entries(capability.metrics).map(([id, metric]) => [id, metric.label])) : {};
  const label = (id: string) => labels[id] || metricLabel(id);
  async function copy(issue: DataIssue) {
    const text = `问题：${issue.problem}\n影响指标：${issue.metrics.map(label).join('、') || '数据可用性'}\n建议修复：${issue.fix}\n定位：${issue.location?.table || '数据集'} / ${issue.location?.column || '未记录列'} / ${issue.location?.rows?.length ? '源文件第 ' + issue.location.rows.join('、') + ' 行' : '未记录行号'}`;
    try { await navigator.clipboard.writeText(text); setCopyStatus('问题与修复建议已复制'); setManual(''); }
    catch { setManual(text); setCopyStatus('自动复制不可用，请选择以下文本复制'); }
  }
  return <section className="quality-issues" aria-label="可行动的数据质量提示"><h3>数据质量与修复建议</h3>{issues.length ? issues.map((issue, index) => <article className={`quality-issue issue-${issue.severity}`} key={`${issue.code}-${index}`}><div className="inspection-heading"><strong>{issue.problem}</strong><button className="text-button" onClick={() => void copy(issue)}><Copy size={13} />复制问题</button></div><dl><div><dt>影响指标</dt><dd>{issue.metrics.map(label).join('、') || '数据可用性'}</dd></div><div><dt>建议修复</dt><dd>{issue.fix}</dd></div><div><dt>定位</dt><dd>{issue.location?.table || '数据集'}{issue.location?.column ? ` / ${issue.location.column}` : ''}{issue.location?.rows?.length ? ` / 源文件第 ${issue.location.rows.join('、')} 行` : ' / 未记录具体行号'}</dd></div></dl></article>) : <p>当前没有已记录的结构化质量问题。</p>}<span className="sr-only" role="status">{copyStatus}</span>{manual && <label className="field">手动复制问题<textarea readOnly value={manual} onFocus={event => event.currentTarget.select()} rows={5} /></label>}</section>;
}
export function DatasetInspection({ dataset, showMappings = true }: { dataset: Dataset; showMappings?: boolean }) {
  const [saved, setSaved] = useState<{ id: string; value: NonNullable<Dataset['completeness']> }>();
  const current = saved?.id === dataset.id ? saved.value : dataset.completeness;
  const [savedTz, setSavedTz] = useState<{ id: string; value: Dataset }>();
  const live = savedTz?.id === dataset.id ? savedTz.value : dataset;
  const timezone = live.timezone;
  const tzName = timezone?.name || 'Asia/Shanghai';
  const [tzChoice, setTzChoice] = useState<string>();
  const chosenTz = tzChoice ?? tzName;
  const [tzBusy, setTzBusy] = useState(false); const [tzError, setTzError] = useState('');
  async function declareTimezone() {
    setTzBusy(true); setTzError('');
    try { const response = await api.declareTimezone(dataset.id, chosenTz); setSavedTz({ id: dataset.id, value: response.dataset }); }
    catch (e) { setTzError(e instanceof Error ? e.message : '时区保存失败'); } finally { setTzBusy(false); }
  }
  const declared = current?.declared || 'unknown';
  const [choiceState, setChoiceState] = useState<{ id: string; value: 'full' | 'partial' | 'unknown' }>();
  const choice = choiceState?.id === dataset.id ? choiceState.value : declared;
  const setChoice = (value: 'full' | 'partial' | 'unknown') => setChoiceState({ id: dataset.id, value });
  const [shardNote, setShardNote] = useState<string | undefined>(); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function declare(value: 'full' | 'partial' | 'unknown') {
    setBusy(true); setError('');
    try { const response = await api.declareCompleteness(dataset.id, { declared: value, shardNote: shardNote ?? current?.shardNote }); setSaved({ id: dataset.id, value: response.dataset.completeness! }); }
    catch (e) { setError(e instanceof Error ? e.message : '声明保存失败'); } finally { setBusy(false); }
  }
  const summary = datasetSummary(live); const metadata = live.inspection;
  const impacts = missingTableImpacts(dataset.tables.map(table => table.type));
  return <div className="dataset-inspection">
    <div className="inspection-heading"><strong>数据完整性 <span className="tiny-tag">{completenessCopy.labels[declared]}</span></strong><select aria-label="声明数据完整性" value={choice} onChange={e => setChoice(e.target.value as typeof choice)} disabled={busy}><option value="unknown">未声明</option><option value="full">全量</option><option value="partial">分片</option></select><button className="text-button" disabled={busy || choice === 'unknown'} onClick={() => void declare(choice)}>保存声明</button>{declared === 'unknown' && <button className="text-button" disabled={busy} onClick={() => void declare('full')}>声明为全量</button>}</div>
    <p className="field-help">{completenessCopy[declared]}修改声明后需重新分析，已有报告保留生成时的声明。</p>
    {(declared === 'partial' || choice === 'partial') && <label className="field">分片说明<input value={shardNote ?? current?.shardNote ?? ''} maxLength={1000} placeholder="例如：共68个分片，本次上传1个" onChange={e => setShardNote(e.target.value)} /><button className="text-button" disabled={busy} onClick={() => void declare('partial')}>保存分片说明</button></label>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="inspection-heading"><strong>数据时区 <span className="tiny-tag">{timezone?.assumed === false ? '已确认' : '未确认'}</span></strong><select aria-label="确认数据时区" value={chosenTz} onChange={e => setTzChoice(e.target.value)} disabled={tzBusy}>{[...new Set([tzName, 'Asia/Shanghai', 'UTC', 'UTC+09:00', 'UTC-05:00'])].map(name => <option key={name} value={name}>{name}</option>)}</select><button className="text-button" disabled={tzBusy} onClick={() => void declareTimezone()}>{timezone?.assumed === false ? '更新时区' : '确认时区'}</button></div>
    <p className="field-help">{timezone ? `${zoneLabel(tzName, timezone.offsetMinutes)}${timezone.assumed ? '尚未确认，当前按此解释无时区时间' : '已由用户确认'}${timezone.source === 'detected' ? '；时区由数据中的偏移推断' : ''}。带时区时间按自身偏移换算；修改时区后需重新分析。` : '历史数据未记录时区，按 Asia/Shanghai 解释，请确认后再分析。'}</p>
    {tzError && <p className="form-error" role="alert">{tzError}</p>}
    <div className="coverage-summary"><div><span>数据时间范围</span><strong>{dataset.dateRange?.start?.slice(0, 10) || '未记录'} 至 {dataset.dateRange?.end?.slice(0, 10) || '未记录'}</strong></div><div><span>原始 / 有效行数</span><strong>{number(summary.rawRows)} / {summary.validRows == null ? '未记录' : number(summary.validRows)}</strong></div><div><span>全量规则质量分</span><strong>{summary.score == null ? '未记录' : `${summary.score} / 100`}</strong></div></div>
    <p className="field-help">实际指标使用已结束自然日，并按上述完整性声明处理边界日期。原始行数与去重后的有效行数可能不同。</p>
    {metadata?.coverage.length ? <details className="inspection-details"><summary>查看各表覆盖范围与评分规则</summary><ul>{metadata.coverage.map((table, index) => <li key={table.table + index}>{tableLabels[table.table] || table.table}：{table.start?.slice(0, 10) || '无'} 至 {table.end?.slice(0, 10) || '无'} · {number(table.validRows)} 条有效记录</li>)}</ul><p>{metadata.quality.rule}</p></details> : null}
    {impacts.length > 0 && <aside className="data-impact" role="note"><Info size={17} /><div><strong>部分指标不可计算，其他数据分支仍可分析</strong>{impacts.map(impact => <p key={impact}>{impact}</p>)}</div></aside>}
    <AnalysisScope capability={metadata?.capability ?? live.capability} title="分析可完成度" />
    {!summary.analyzable && <p className="form-error" role="alert">当前数据不可分析，请先按质量提示修复后重新上传。不会创建任务或冻结额度。</p>}
    {showMappings && <section className="mapping-section"><div className="inspection-heading"><h3>字段识别结果</h3><span className="tiny-tag">自动识别 · 只读确认</span></div>{metadata?.mappings.length ? <div className="table-scroll"><table className="data-table mapping-table"><thead><tr><th>表 / 来源</th><th>标准字段 ← 源列名</th><th>识别方式</th></tr></thead><tbody>{metadata.mappings.map((mapping, index) => <tr key={index}><td>{mapping.table}<small>{mapping.source}</small></td><td><strong>{mapping.field}</strong> ← {mapping.sourceColumn ?? '源文件未提供'}</td><td>{mapping.origin === 'generated' ? '系统生成' : '自动识别'}{mapping.required ? ' · 必填' : ' · 可选'}</td></tr>)}</tbody></table></div> : <p className="legacy-metadata">历史数据未保存源列映射，不能反推识别结果。重新上传后可查看真实映射。</p>}</section>}
    {showMappings && Boolean(metadata?.unrecognizedColumns?.length) && <section className="mapping-section"><h3>额外字段</h3><p>已识别，当前不参与计算</p><div className="table-scroll"><table className="data-table"><thead><tr><th>来源文件</th><th>表</th><th>原列名</th><th>状态和原因</th></tr></thead><tbody>{metadata?.unrecognizedColumns?.map((column, index) => <tr key={index}><td>{column.source}</td><td>{column.table}</td><td>{column.column}{column.label && column.label !== column.column ? `（${column.label}）` : ''}</td><td>已识别，当前不参与计算：{column.reason}</td></tr>)}</tbody></table></div></section>}
    {metadata ? <QualityIssues issues={metadata.issues} capability={metadata.capability ?? live.capability} /> : <><p className="legacy-metadata">历史数据未记录全量质量分与问题定位。以下仅展示已有提示。</p>{live.warnings.map((warning, index) => <p className="field-help" key={index}>{warning}</p>)}</>}
  </div>;
}
