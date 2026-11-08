import { useCallback, useRef, useState } from 'react';
import { Check, CircleHelp, Database, FileSpreadsheet, Gamepad2, GitBranch, KeyRound, MessageSquare, Plus, ShieldCheck, Sparkles, UploadCloud, WandSparkles, X, Zap } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth-context';
import type { Dataset, Domain, Mode, Settings, Skill, Task, Wallet } from '../types';
import { Checked, downloadText, Modal, number, Spinner } from './ui';
import { analysisAccess, ANALYSIS_COST } from '../product-state';

export { NewAnalysis } from './NewAnalysis';
export { SettingsModal } from './ModelSettings';
export { DataPreview } from './DataPreview';
export function DomainModal({ domains, selected, select, close }: { domains: Domain[]; selected: string; select: (id: string) => void; close: () => void }) {
  const current = domains.find(domain => domain.id === selected);
  return <Modal title="选择分析领域" subtitle="领域决定可识别的数据表、指标口径与报告模板；只影响新上传的数据和新任务。" close={close}><div className="modal-body domain-options">{domains.map(d => <button type="button" className={`domain-option ${d.id === selected ? 'selected' : ''}`} key={d.id} disabled={!d.enabled} onClick={() => { select(d.id); close(); }}><span className="domain-icon">{d.id === 'game' ? <Gamepad2 size={22} /> : <Database size={22} />}</span><div><strong>{d.name}</strong><p>{d.description}</p></div><span className={d.id === selected ? 'green-tag' : d.enabled ? 'tiny-tag' : 'tiny-tag'}>{d.id === selected ? '当前领域' : d.enabled ? '可切换' : '暂未开放'}</span></button>)}<p className="field-help">上传数据后会在数据检查中显示识别到的表、字段和指标可用性；不属于当前领域的表不会被强行套用口径。</p></div><div className="modal-footer"><span className="subtle-label">{current ? `当前：${current.name}` : '未选择领域'}</span><button className="button primary" onClick={close}>关闭</button></div></Modal>;
}
export function SkillModal({ skill, close }: { skill: Skill; close: () => void }) { return <Modal title={skill.name} subtitle={`${skill.category} · v${skill.version}`} close={close}><div className="modal-body"><div className="skill-detail-icon"><GitBranch size={28} /></div><p className="skill-description">{skill.description}</p><div className="skill-detail-row"><span>能力状态</span><strong className="green-text">已启用</strong></div><div className="skill-detail-row"><span>执行方式</span><strong>{skill.id.includes('report') || skill.id.includes('insight') ? '计算结果 + 可选 AI 解读' : '确定性数据计算'}</strong></div><div className="skill-detail-row"><span>适用工作流</span><strong>运营分析诊断</strong></div><div className="settings-notice"><ShieldCheck size={18} /><p>工作流会根据可用数据调用该能力。每个阶段保留执行记录和结果摘要，缺少必要数据时明确跳过。</p></div></div><div className="modal-footer"><span className="subtle-label">{skill.id}</span><button className="button primary" onClick={close}>了解了</button></div></Modal>; }
export { HelpModal } from './HelpModal';
