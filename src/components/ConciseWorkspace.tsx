import { useState } from 'react';
import { ArrowRight, ArrowUp, FileText, Upload, Activity, Sparkles } from 'lucide-react';
import type { Dataset, Task } from '../types';
import { prepareGoal, recentTasks, taskStatusHint } from '../concise-workspace';
import { isPresetSample } from '../onboarding';
import '../concise-workspace.css';

export interface ConciseWorkspaceProps {
  task?: Task;
  dataset?: Dataset;
  tasks: Task[];
  onNew: (goal?: string) => void;
  onShowData: (dataset: Dataset) => void;
  onSelectTask: (task: Task) => void;
  onOpenData: () => void;
  onOpenDetails: () => void;
  onFullReport: () => void;
  defaultModelName?: string;
  onOpenSettings: () => void;
  onOpenReports: () => void;
}

const statusNames = { running: '运行中', awaiting_approval: '待确认', completed: '已完成', failed: '失败', cancelled: '已取消' };

export function ConciseWorkspace({ task, dataset, tasks, onNew, onShowData, onSelectTask, onOpenData, onOpenDetails, onFullReport, defaultModelName, onOpenSettings, onOpenReports }: ConciseWorkspaceProps) {
  const [goal, setGoal] = useState('');
  const recent = recentTasks(tasks, 6);
  const sample = task?.sourceProvenance?.demo || dataset?.source === 'demo' || Boolean(task && isPresetSample(task));
  return <div className="concise-workspace">
    <section className="concise-start" aria-labelledby="concise-heading">
      <h1 id="concise-heading">今天想从数据中了解什么？</h1>
      <p className="concise-intro">说说你的分析目标，选择数据后再确认执行。</p>
      <form className="concise-composer" onSubmit={event => { event.preventDefault(); onNew(prepareGoal(goal)); }}>
        <textarea aria-label="分析目标" id="concise-goal" value={goal} onChange={event => setGoal(event.target.value)} rows={3} placeholder="例如：分析最近一周的收入变化，找出值得关注的渠道" />
        <div className="concise-composer-actions">
          <button type="button" className="concise-tool" onClick={onOpenData}><span><Upload size={15} aria-hidden="true" />选择数据</span></button>
          <button type="button" className="concise-tool concise-model" aria-label={`默认模型：${defaultModelName || '模型设置'}`} onClick={onOpenSettings}><span><Sparkles size={14} aria-hidden="true" />{defaultModelName || '模型设置'}</span></button>
          <button type="submit" className="concise-send" aria-label="开始分析"><span><ArrowUp size={19} aria-hidden="true" /></span></button>
        </div>
      </form>
      <p className="concise-cost">此处仅打开分析向导；执行前可确认数据、模型与费用。</p>
      <div className="concise-intents" role="group" aria-label="快捷分析意图">{['收入与付费', '留存与活跃', '渠道质量', '异常与口径'].map(intent => <button type="button" key={intent} aria-pressed={goal === intent} onClick={() => setGoal(intent)}><span>{intent}</span></button>)}</div>
    </section>
    {task && <section className="concise-current" aria-labelledby="concise-current-title">
      <div className="concise-section-heading"><h2 id="concise-current-title">当前分析</h2><span className="concise-status"><i aria-hidden="true" />{statusNames[task.status]}</span></div>
      <h3>{task.title}</h3>
      <p className={task.status === 'failed' ? 'concise-error' : ''} role="status"><Activity size={16} aria-hidden="true" />{taskStatusHint(task)}</p>
      {sample && <p className="concise-notice">示例数据 · 结果仅用于演示，不代表你的业务表现。</p>}
      {task.report && <p className="concise-notice">分析结果尚需人工审查，请核对数据质量、证据和分析口径后使用。</p>}
      <div className="concise-task-meta"><span>{task.datasetName}</span><span>{isPresetSample(task) ? '预置示例 · 不扣费' : `任务额度：${task.cost}`}</span>{dataset && <span>{dataset.rowCount.toLocaleString()} 行数据</span>}</div>
      <div className="concise-current-actions">
        <button type="button" className="concise-button" onClick={onOpenDetails}>{task.status === 'awaiting_approval' ? '审查并确认' : '查看执行详情'}</button>
        {dataset && <button type="button" className="concise-button" onClick={() => onShowData(dataset)}>查看源数据</button>}
        {task.report && <button type="button" className="concise-button concise-primary" onClick={onFullReport}><FileText size={16} aria-hidden="true" />完整报告</button>}
      </div>
    </section>}
    <section className="concise-recent" aria-labelledby="concise-recent-title">
      <div className="concise-section-heading"><h2 id="concise-recent-title">最近分析</h2><button type="button" className="concise-all" onClick={onOpenReports}>全部<ArrowRight size={13} aria-hidden="true" /></button></div>
      {recent.length ? <ul>{recent.map(item => <li key={item.id}><button type="button" onClick={() => onSelectTask(item)} aria-current={item.id === task?.id ? 'true' : undefined}>
        <span className="concise-recent-copy"><strong>{item.title}</strong><span>{item.datasetName}{item.sourceProvenance?.demo || isPresetSample(item) ? ' · 示例数据' : ''}</span></span>
        <span className="concise-recent-state"><span><i aria-hidden="true" />{statusNames[item.status]}</span><time dateTime={item.updatedAt}>{item.updatedAt.slice(0, 10)}</time></span>
        <ArrowRight size={16} aria-hidden="true" />
      </button></li>)}</ul> : <p className="concise-empty">还没有分析记录。上传数据或使用向导中的示例数据，开始第一次分析。</p>}
    </section>
  </div>;
}
