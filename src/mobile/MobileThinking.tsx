import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Loader2, ShieldCheck } from 'lucide-react';
import type { ThinkingGroup } from './mobile-chat-model';
import type { MobileThinkingStep } from './types';

const stepText = (step: MobileThinkingStep) => step.text || step.detail || '';

function PermissionStep({ step, busy, onDecide }: { step: MobileThinkingStep; busy: boolean; onDecide: (requestId: string, decision: 'allow' | 'deny') => void }) {
  if (step.decided === true) return <div className="mob-step is-permission"><Check size={13} /><span>{stepText(step) || '已确认'}</span></div>;
  if (!step.requestId) return <div className="mob-step is-permission"><ShieldCheck size={13} /><span>{stepText(step)}</span></div>;
  return <div className="mob-step is-permission">
    <ShieldCheck size={13} />
    <span>{stepText(step) || '需要确认才能继续'}</span>
    <div className="mob-step-actions">
      <button type="button" className="mob-tiny" disabled={busy} onClick={() => onDecide(step.requestId!, 'allow')}>允许一次</button>
      <button type="button" className="mob-tiny ghost" disabled={busy} onClick={() => onDecide(step.requestId!, 'deny')}>拒绝</button>
    </div>
  </div>;
}

// 一轮一个思考块；多 Agent 时按 Agent 分 tab，运行中默认展开。
export function MobileThinking({ groups, running, open, onToggle, busy, onDecide }: {
  groups: ThinkingGroup[]; running: boolean; open: boolean; onToggle: () => void;
  busy: boolean; onDecide: (ticketId: string, requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const [tab, setTab] = useState(0);
  const list = groups.filter(group => group.steps.length > 0 || group.status === 'working' || group.status === 'queued');
  if (!list.length) return null;
  const activeIndex = Math.min(tab, list.length - 1);
  const active = list[activeIndex];
  const total = list.reduce((sum, group) => sum + group.steps.length, 0);
  const label = running ? `正在思考 · ${total} 步` : `已思考 · ${total} 步`;
  return <section className={`mob-think ${open ? 'is-open' : ''}`}>
    <button type="button" className="mob-think-head" onClick={onToggle} aria-expanded={open}>
      {running ? <Loader2 size={14} className="mob-spin" /> : <Check size={14} />}
      <span>{label}</span>
      <ChevronDown size={15} className={open ? 'rotate' : ''} />
    </button>
    {open && <>
      {list.length > 1 && <div className="mob-think-tabs" role="tablist">
        {list.map((group, index) => <button type="button" role="tab" key={group.ticketId} aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} onClick={() => setTab(index)}>{group.name}</button>)}
      </div>}
      <div className="mob-think-body">
        {active.steps.length === 0 && <p className="mob-hint">{active.status === 'failed' ? '这一步没有留下过程记录。' : '正在等待执行…'}</p>}
        {active.steps.map((step, index) => step.kind === 'permission'
          ? <PermissionStep key={`${step.at || ''}-${index}`} step={step} busy={busy} onDecide={(requestId, decision) => onDecide(active.ticketId, requestId, decision)} />
          : <div key={`${step.at || ''}-${index}`} className={`mob-step is-${step.kind}`}>
            {step.kind === 'error' ? <AlertTriangle size={13} /> : <span className="mob-step-dot" />}
            <span>{stepText(step)}</span>
          </div>)}
      </div>
    </>}
  </section>;
}
