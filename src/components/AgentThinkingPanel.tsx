import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ShieldCheck, Sparkles, Terminal, Wrench } from 'lucide-react';
import { STATUS_LABELS } from '../status';
import { ResultMarkdown } from './ResultMarkdown';

// 一轮对话里「谁在想什么」的呈现：主控先规划 → 分发 → 各路并行 → 完成后成结论。
// 数据全部由调用方传入，标签行按数组 map，多一个 Agent 就多一个 chip，布局不用改。
export type ThinkingStep = { kind: string; text: string; detail?: string; at?: string; requestId?: string; ticketId?: string; decided?: 'allow' | 'deny' };
export type ThinkingBrand = { bg: string; icon?: string; text?: string; mono?: boolean } | null | undefined;
export type ThinkingAgent = {
  id: string;
  name: string;
  brand?: ThinkingBrand;
  status: string;
  startedAt?: string;
  endedAt?: string;
  steps: ThinkingStep[];
  output?: string;
  note?: string;
};
export type ThinkingDispatchRow = { id: string; name: string; brand?: ThinkingBrand; status: string; startedAt?: string; endedAt?: string; detail?: string };
export type ThinkingOrchestrator = {
  name: string;
  role: string;
  startedAt?: string;
  endedAt?: string;
  steps: ThinkingStep[];
  dispatch: ThinkingDispatchRow[];
  summary?: string;
};

const DONE = ['completed', 'failed', 'blocked', 'cancelled'];

const seconds = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
};

const elapsedOf = (startedAt?: string, endedAt?: string) => {
  const start = startedAt ? Date.parse(startedAt) : 0;
  if (!start) return '';
  const end = endedAt ? Date.parse(endedAt) : Date.now();
  return seconds(end - start);
};

const clock = (value?: string) => {
  const stamp = value ? Date.parse(value) : 0;
  if (!stamp) return '';
  const date = new Date(stamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
};

// 分发卡右侧：开始 → 结束 · 耗时；还在跑就写「进行中」，还没开始就写「等待开始」。
const spanOf = (row: ThinkingDispatchRow) => {
  const from = clock(row.startedAt);
  if (!from) return DONE.includes(row.status) ? '' : '等待开始';
  const to = clock(row.endedAt);
  const cost = elapsedOf(row.startedAt, row.endedAt);
  if (to) return `${from} → ${to}${cost ? ` · ${cost}` : ''}`;
  return DONE.includes(row.status) ? from : `${from} → 进行中`;
};

export function BrandGlyph({ brand, size = 22 }: { brand?: ThinkingBrand; size?: number }) {
  if (!brand) return <span className="sa-tp-glyph" style={{ width: size, height: size }} aria-hidden="true" />;
  return (
    <span className="sa-tp-glyph" style={{ width: size, height: size, background: brand.bg }} aria-hidden="true">
      {brand.icon ? <img src={`/brands/${brand.icon}`} alt="" /> : <i className="sa-tp-glyph-text">{brand.text || '?'}</i>}
    </span>
  );
}

function StatusGlyph({ status }: { status: string }) {
  if (DONE.includes(status)) return <span className="sa-tp-tick" aria-hidden="true"><Check size={13} strokeWidth={2.6} /></span>;
  if (status === 'working' || status === 'running' || status === 'verifying') return <span className="sa-tp-ring" aria-hidden="true" />;
  return <span className="sa-tp-dot" aria-hidden="true" />;
}

const flatten = (value: string) => value.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();

// 最后一条 note 通常就是结论本身：结论块里已经原样显示，正文里再留一条就重复了。
const tailDuplicates = (agent: ThinkingAgent) => {
  const last = agent.steps.at(-1);
  if (!last || !agent.output) return false;
  return flatten(last.text) === flatten(agent.output);
};

function Steps({ steps, pending, onPermission }: { steps: ThinkingStep[]; pending: string; onPermission?: (ticketId: string, requestId: string, decision: 'allow' | 'deny') => void }) {  if (!steps.length) return <p className="sa-tp-pending">{pending}</p>;
  return <div className="sa-tp-steps">{steps.map((step, index) => {
    if (step.kind === 'thought') return <p className="sa-tp-thought" key={`${index}-${step.at || ''}`}>{step.text}</p>;
    if (step.kind === 'error') return <p className="sa-tp-error" key={`${index}-${step.at || ''}`}><AlertTriangle size={12} />{step.text}</p>;
    if (step.kind === 'permission') {
      const decided = step.decided === 'allow' || step.decided === 'deny' ? step.decided : null;
      const canDecide = Boolean(step.requestId && step.ticketId && onPermission);
      const decide = (decision: 'allow' | 'deny') => {
        if (step.requestId && step.ticketId && onPermission) onPermission(step.ticketId, step.requestId, decision);
      };
      return <div className={`sa-tp-permission${decided ? ' is-decided' : ''}`} key={`${index}-${step.at || ''}`}>
        <ShieldCheck size={13} />
        <div className="sa-tp-permission-main">
          <p>{step.text}</p>
          {step.detail ? <span>{step.detail}</span> : null}
        </div>
        {decided
          ? <span className={`sa-tp-permission-state is-${decided}`}>{decided === 'allow' ? '已允许' : '已拒绝'}</span>
          : <span className="sa-tp-permission-actions">
            <button type="button" className="sa-tp-permission-allow" disabled={!canDecide} onClick={() => decide('allow')}>允许一次</button>
            <button type="button" className="sa-tp-permission-deny" disabled={!canDecide} onClick={() => decide('deny')}>拒绝</button>
          </span>}
      </div>;
    }
    if (step.kind === 'tool' || step.kind === 'observation') {
      const Icon = step.kind === 'tool' ? Wrench : Terminal;
      return <div className="sa-tp-tool" key={`${index}-${step.at || ''}`}>
        <Icon size={11} />
        <code>{step.text}</code>
        {step.detail ? <span className="sa-tp-tool-detail">{step.detail}</span> : null}
      </div>;
    }
    return <p className="sa-tp-note" key={`${index}-${step.at || ''}`}>{step.text}</p>;
  })}</div>;
}

export function AgentThinkingPanel({ orchestrator, agents, defaultOpen = true, dispatchNote = '并行执行 · 互不共享上下文', onPermission }: {
  orchestrator?: ThinkingOrchestrator | null;
  agents: ThinkingAgent[];
  defaultOpen?: boolean;
  dispatchNote?: string;
  onPermission?: (ticketId: string, requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // 主控规划默认压成一行，把正文留给正在思考的 Agent；点箭头再展开分发细节。
  const [orcheOpen, setOrcheOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const anyPending = agents.some(agent => !DONE.includes(agent.status));
  // 只有还在跑时才需要刷新耗时；每秒一次足够，标签页在后台时停掉。
  useEffect(() => {
    if (!anyPending) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) timer = setInterval(() => setTick(value => value + 1), 1000); };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const sync = () => { if (document.visibilityState === 'hidden') stop(); else start(); };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => { stop(); document.removeEventListener('visibilitychange', sync); };
  }, [anyPending]);

  const doneCount = agents.filter(agent => agent.status === 'completed').length;
  // 排队中的算「没结束」；失败、取消、阻断已经结束，不能再显示成「进行中」。
  const pendingCount = agents.filter(agent => !DONE.includes(agent.status)).length;
  // 没手动点过标签时，跟随第一个正在思考的那一路，让正文始终有东西在动。
  const activeId = picked && agents.some(agent => agent.id === picked)
    ? picked
    : (agents.find(agent => !DONE.includes(agent.status) && agent.status !== 'waiting' && agent.status !== 'queued')?.id ?? agents[0]?.id);
  const active = agents.find(agent => agent.id === activeId) || agents[0] || null;
  const shown = active && tailDuplicates(active) ? active.steps.slice(0, -1) : active?.steps || [];
  const meta = orchestrator && agents.every(agent => agent.status === 'waiting' || agent.status === 'queued')
    ? `${orchestrator.name} 正在规划`
    : agents.length === 0
      ? '等待开始'
      : doneCount === agents.length
        ? `${agents.length} 个 Agent 已完成`
        : pendingCount === 0
          ? `${agents.length} 个 Agent 已结束 · ${doneCount} 个完成`
          : `${pendingCount} 路进行中 · ${doneCount}/${agents.length} 已完成`;

  return <section className={`sa-tp${open ? '' : ' is-closed'}`}>
    <header className="sa-tp-head">
      <span className="sa-tp-title">思考过程</span>
      <span className="sa-tp-meta">{meta}</span>
      {orchestrator ? <span className="sa-tp-timer">{elapsedOf(orchestrator.startedAt, orchestrator.endedAt)}</span> : <span className="sa-tp-timer" />}
      <button type="button" className="sa-tp-icon" aria-expanded={open} aria-label={open ? '收起思考过程' : '展开思考过程'} onClick={() => setOpen(value => !value)}>
        <ChevronDown size={15} />
      </button>
    </header>
    {open && <>
      {orchestrator && <div className={`sa-tp-orch${orcheOpen ? '' : ' is-collapsed'}`}>
        <div className="sa-tp-orch-head">
          <BrandGlyph brand={{ bg: '#4a3aff', text: 'L' }} />
          <StatusGlyph status={orchestrator.endedAt ? 'completed' : 'working'} />
          <strong>{orchestrator.name}</strong>
          <span className="sa-tp-role">{orchestrator.role}</span>
          {orchestrator.dispatch.length > 0 && <span className="sa-tp-orch-count">已分发 {orchestrator.dispatch.length} 路</span>}
          <span className="sa-tp-timer">{elapsedOf(orchestrator.startedAt, orchestrator.endedAt)}</span>
          <button type="button" className="sa-tp-icon" aria-expanded={orcheOpen} aria-label={orcheOpen ? '收起规划' : '展开规划'} onClick={() => setOrcheOpen(value => !value)}>
            <ChevronDown size={15} />
          </button>
        </div>
        <div className="sa-tp-orch-body">
          <Steps steps={orchestrator.steps} pending={`${orchestrator.name} 正在读取上下文…`} onPermission={onPermission} />
          {orchestrator.dispatch.length > 0 && <div className="sa-tp-dispatch">
            <div className="sa-tp-dispatch-head">
              <Sparkles size={12} />
              <span>任务已分发 {orchestrator.dispatch.length} 路 · {dispatchNote}</span>
            </div>
            <div className="sa-tp-dispatch-rows">
              {orchestrator.dispatch.map(row => <div className="sa-tp-dispatch-row" key={row.id}>
                <BrandGlyph brand={row.brand} size={16} />
                <span className="sa-tp-dispatch-name">{row.name}</span>
                <span className="sa-tp-dispatch-detail">{row.detail ? `${row.detail} · ` : ''}{spanOf(row)}</span>
                <StatusGlyph status={row.status} />
              </div>)}
            </div>
          </div>}
          {orchestrator.summary ? <p className="sa-tp-thought">{orchestrator.summary}</p> : null}
        </div>
      </div>}
      {agents.length > 0 && <div className="sa-tp-tabs" role="tablist" aria-label="切换 Agent 的思考过程">
        {agents.map(agent => <button
          key={agent.id}
          type="button"
          role="tab"
          aria-selected={agent.id === activeId}
          title={`${agent.name} · ${STATUS_LABELS[agent.status] || agent.status}`}
          className={`sa-tp-chip${agent.id === activeId ? ' is-on' : ''}`}
          onClick={() => setPicked(agent.id)}
        >
          <BrandGlyph brand={agent.brand} size={24} />
          <StatusGlyph status={agent.status} />
          <span className="sa-tp-chip-name">{agent.name}</span>
          {DONE.includes(agent.status) && <span className="sa-tp-chip-time">{elapsedOf(agent.startedAt, agent.endedAt)}</span>}
        </button>)}
      </div>}
      {active && <div className="sa-tp-body" role="tabpanel" aria-label={`${active.name} 的思考过程`}>
        {shown.length > 0
          ? <Steps steps={shown} pending="" onPermission={onPermission} />
          : !active.output
            ? <p className="sa-tp-pending">{DONE.includes(active.status) ? '这一步没有留下过程记录。' : active.status === 'awaiting_review' ? '等待你确认后开始执行。' : active.status === 'waiting' || active.status === 'queued' ? '排队中，等待开始…' : 'Agent 正在思考…'}</p>
            : null}
        {active.output ? <div className="sa-tp-output">
          <div className="sa-tp-output-head"><Check size={12} />结论</div>
          {/* ACP 的正文是逐片拼的，片与片之间带着换行，直接 pre-wrap 会变成一行一个词 */}
          <p>{flatten(active.output)}</p>
        </div> : null}
      </div>}
    </>}
  </section>;
}

// 各 Agent 的结论清单：一行一个，动作按钮留在行尾，Agent 再多也只是多几行。
export function AgentConclusionList({ rows, onOpen, onApprove }: {
  rows: { id: string; name: string; brand?: ThinkingBrand; status: string; text: string; ticketId: string }[];
  onOpen: (ticketId: string) => void;
  onApprove: (ticketId: string) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!rows.length) return null;
  const done = rows.filter(row => row.status === 'completed').length;
  return <div className="sa-tp-res">
    <div className="sa-tp-res-head"><strong>各 Agent 结论</strong><span>{done}/{rows.length} 已返回{done === rows.length ? '，可在上方回看思考过程' : '，其余仍在思考'}</span></div>
    {rows.map(row => {
      const text = row.text.trim() || '—';
      // 短结论直接展开；长结论先收成几行，需要时再读全文。
      const open = expanded[row.id] ?? text.length < 420;
      return <article className={`sa-tp-res-row${row.status === 'completed' ? ' is-done' : ''}`} key={row.id}>
        <header className="sa-tp-res-top">
          <BrandGlyph brand={row.brand} size={18} />
          <span className="sa-tp-res-name">{row.name}</span>
          <StatusGlyph status={row.status} />
          <span className="sa-tp-res-actions">
            {row.status === 'awaiting_review' && <button type="button" className="sa-tp-link" onClick={() => onApprove(row.ticketId)}>确认执行</button>}
            <button type="button" className="sa-tp-link" onClick={() => onOpen(row.ticketId)}>详情</button>
          </span>
        </header>
        <div className={`sa-tp-res-body${open ? ' is-open' : ''}`}>
          <ResultMarkdown text={text} />
        </div>
        {text.length >= 420 && <button type="button" className="sa-tp-res-toggle" aria-expanded={open} onClick={() => setExpanded(previous => ({ ...previous, [row.id]: !open }))}>
          {open ? '收起结论' : '展开全文'}
        </button>}
      </article>;
    })}
  </div>;
}
