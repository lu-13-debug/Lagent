import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileText, FolderGit2, RefreshCw, Search } from 'lucide-react';
import { api } from '../api';
import type { WorkProject, WorkReportDetail, WorkReportItem, WorkTicket } from '../superagent';
import { STATUS_LABELS } from '../status';

interface ReportCenterProps {
  projects: WorkProject[];
  tickets: WorkTicket[];
  notify: (text: string, error?: boolean) => void;
  onOpenConversation: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onRefresh: () => void;
  tab?: 'reports' | 'tickets';
  onTabChange?: (tab: 'reports' | 'tickets') => void;
}

const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
const KIND_OPTIONS = [
  { value: '', label: '全部结论' },
  { value: 'ready', label: '完成' },
  { value: 'completed', label: '完成（历史）' },
  { value: 'failed', label: '失败' },
  { value: 'blocked', label: '受阻' },
  { value: 'dropped', label: '已停止' },
  { value: 'progress', label: '进展' }
];
const TICKET_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'attention', label: '待我处理' },
  { value: 'running', label: '执行中' },
  { value: 'failed', label: '失败' },
  { value: 'done', label: '已完成' }
];
const ROLE_LABELS: Record<string, string> = { coordination: '分工', synthesis: '汇总', answer: '作答', step: '步骤', host: '主控' };
const TICKET_GROUPS: Record<string, string[]> = {
  attention: ['awaiting_review', 'queued', 'waiting'],
  running: ['working'],
  failed: ['failed', 'blocked', 'cancelled', 'interrupted'],
  done: ['completed', 'skipped']
};

export function ReportCenter({ projects, tickets, notify, onOpenConversation, onOpenTicket, onRefresh, tab = 'reports', onTabChange }: ReportCenterProps) {
  const [ticketFilter, setTicketFilter] = useState('all');
  const [ticketQuery, setTicketQuery] = useState('');
  const [group, setGroup] = useState<'conversation' | 'ticket'>('conversation');
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [items, setItems] = useState<WorkReportItem[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<WorkReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const listRequest = useRef(0);
  const detailRequest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const openDetail = useCallback(async (reportId: string) => {
    if (!reportId) return;
    const request = ++detailRequest.current;
    setSelectedId(reportId);
    setDetailLoading(true);
    setError('');
    try {
      const next = await api.workReport(reportId);
      if (request === detailRequest.current) setDetail(next);
    } catch (cause) {
      if (request === detailRequest.current) {
        setDetail(null);
        setError((cause as Error).message);
      }
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  const load = useCallback(async (nextCursor: string | null = null) => {
    const request = ++listRequest.current;
    setLoading(true);
    setError('');
    try {
      const result = await api.workReports({ group, projectId, kind, q: debounced, limit: 30, cursor: nextCursor });
      if (request !== listRequest.current) return;
      setItems(previous => nextCursor ? [...previous, ...result.items] : result.items);
      setTotal(result.total);
      setCursor(result.cursor);
      if (!nextCursor) {
        setDetail(null);
        const first = result.items[0];
        if (first) void openDetail(first.reportId);
        else setSelectedId('');
      }
    } catch (cause) {
      if (request === listRequest.current) {
        setItems([]);
        setError((cause as Error).message);
      }
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [group, projectId, kind, debounced, openDetail]);

  useEffect(() => { void load(); }, [load]);

  const projectOptions = useMemo(() => projects.filter(project => project.id), [projects]);
  const visibleTickets = useMemo(() => {
    const statuses = TICKET_GROUPS[ticketFilter];
    const keyword = ticketQuery.trim().toLowerCase();
    return tickets
      .filter(ticket => ticketFilter === 'all' || Boolean(statuses?.includes(ticket.status)))
      .filter(ticket => !keyword || ticket.title.toLowerCase().includes(keyword) || (ticket.executor || '').toLowerCase().includes(keyword))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }, [tickets, ticketFilter, ticketQuery]);
  const attentionCount = useMemo(() => tickets.filter(ticket => TICKET_GROUPS.attention.includes(ticket.status)).length, [tickets]);

  const exportMarkdown = async () => {
    if (!detail) return;
    try {
      const markdown = await api.workReportMarkdown(detail.report.id);
      const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `lagent-report-${detail.report.id.slice(0, 8)}.md`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify('报告已导出为 Markdown。');
    } catch (cause) { notify((cause as Error).message, true); }
  };

  return <section className="sa-page sa-report-page">
    <header className="sa-page-head">
      <div><p className="sa-eyebrow">结果与记录</p><h1>报告</h1><p>结论与执行记录的统一入口：看结论、产物和导出，也在这里找待审批、执行中与失败的工单。</p></div>
      <button type="button" className="sa-button" onClick={() => tab === 'tickets' ? onRefresh() : void load()}><RefreshCw size={14} />刷新</button>
    </header>
    <div className="sa-report-tabs" role="tablist" aria-label="报告与执行记录">
      <button type="button" role="tab" aria-selected={tab === 'reports'} className={tab === 'reports' ? 'on' : ''} onClick={() => onTabChange?.('reports')}>结论</button>
      <button type="button" role="tab" aria-selected={tab === 'tickets'} className={tab === 'tickets' ? 'on' : ''} onClick={() => onTabChange?.('tickets')}>执行工单{attentionCount > 0 ? <em>{attentionCount}</em> : null}</button>
    </div>
    {tab === 'tickets' ? <div className="sa-report-exec">
      <div className="sa-report-toolbar">
        <div className="sa-report-group" role="group" aria-label="按工单状态筛选">
          {TICKET_FILTERS.map(option => <button key={option.value} type="button" className={ticketFilter === option.value ? 'on' : ''} aria-pressed={ticketFilter === option.value} onClick={() => setTicketFilter(option.value)}>{option.label}</button>)}
        </div>
        <label className="sa-report-search">
          <Search size={14} />
          <input value={ticketQuery} onChange={event => setTicketQuery(event.target.value)} placeholder="搜索工单标题或执行者" aria-label="搜索工单" />
        </label>
      </div>
      <div className="sa-recent-list" aria-label="工单列表">
        {visibleTickets.map(ticket => <button type="button" key={ticket.id} className="sa-recent-item" onClick={() => onOpenTicket(ticket.id)}>
          <span className="sa-recent-dot" aria-hidden="true" data-status={ticket.status} />
          <span className="sa-recent-title">{ticket.title}</span>
          <span className="sa-recent-agents">{ticket.agentId || ticket.executor}{ticket.conversationId ? ' · 会话内' : ''}{ticket.role ? ` · ${ROLE_LABELS[ticket.role] || ticket.role}` : ''}</span>
          <span className={`sa-report-kind kind-${ticket.status}`}>{STATUS_LABELS[ticket.status] || ticket.status}</span>
          <span className="sa-recent-time">{time(ticket.createdAt)}</span>
        </button>)}
        {!visibleTickets.length && <p className="sa-empty">{tickets.length ? '没有符合筛选条件的工单。' : '还没有工单。在指挥台描述一个目标即可。'}</p>}
      </div>
      {tickets.length > 0 && <p className="sa-inline-note">共 {tickets.length} 条工单{visibleTickets.length !== tickets.length ? `，当前显示 ${visibleTickets.length} 条` : ''}。</p>}
    </div> : <>
    <div className="sa-report-toolbar">
      <div className="sa-report-group" role="group" aria-label="报告分组">
        <button type="button" className={group === 'conversation' ? 'on' : ''} aria-pressed={group === 'conversation'} onClick={() => setGroup('conversation')}>按会话</button>
        <button type="button" className={group === 'ticket' ? 'on' : ''} aria-pressed={group === 'ticket'} onClick={() => setGroup('ticket')}>按工单</button>
      </div>
      <label className="sa-report-search">
        <Search size={14} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索结论、工单或项目" aria-label="搜索报告" />
      </label>
      <label className="sa-report-filter"><FolderGit2 size={13} />
        <select value={projectId} onChange={event => setProjectId(event.target.value)} aria-label="按项目筛选">
          <option value="">全部项目</option>
          {projectOptions.map(project => <option key={project.id} value={project.id}>{project.name || project.path}</option>)}
        </select>
      </label>
      <label className="sa-report-filter">
        <select value={kind} onChange={event => setKind(event.target.value)} aria-label="按报告类型筛选">
          {KIND_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
    {error && <p className="sa-inline-note sa-stalled-note" role="alert">{error}</p>}
    <div className="sa-report-layout">
      <div className="sa-report-list" aria-label="报告列表">
        {items.map(item => <button type="button" key={item.id} className={`sa-report-item ${item.reportId === selectedId ? 'is-active' : ''}`} aria-pressed={item.reportId === selectedId} onClick={() => void openDetail(item.reportId)}>
          <span className="sa-report-item-head"><strong>{item.title}</strong><span className={`sa-report-kind kind-${item.kind}`}>{item.kindLabel}</span></span>
          <span className="sa-report-item-summary">{item.summary || '（没有结论正文）'}</span>
          <span className="sa-report-item-meta">{item.projectName || '未绑定项目'} · {item.executorId || '未知执行者'}{item.reportCount > 1 ? ` · ${item.reportCount} 份结论` : ''} · {time(item.createdAt)}</span>
        </button>)}
        {!items.length && !loading && <p className="sa-empty">还没有符合条件的报告。Agent 完成任务后，结论会出现在这里。</p>}
        {loading && <p className="sa-empty"><RefreshCw size={14} className="sa-spin" />正在加载报告…</p>}
        {cursor && <button type="button" className="sa-button sa-report-more" disabled={loading} onClick={() => void load(cursor)}>加载更多</button>}
      </div>
      <article className="sa-report-preview" aria-live="polite">
        {detailLoading && !detail ? <p className="sa-empty"><RefreshCw size={14} className="sa-spin" />正在打开报告…</p> : detail ? <>
          <header className="sa-report-preview-head">
            <div><span className="sa-report-kind">{detail.report.kindLabel}</span><h2>{detail.ticket?.title || detail.report.summary.slice(0, 40) || '报告'}</h2></div>
            <div className="sa-report-actions">
              {detail.conversation && <button type="button" className="sa-link" onClick={() => onOpenConversation(detail.conversation!.id)}>打开会话</button>}
              {detail.ticket && <button type="button" className="sa-link" onClick={() => onOpenTicket(detail.ticket!.id)}>查看工单</button>}
              <button type="button" className="sa-button" onClick={() => void exportMarkdown()}><Download size={14} />导出 Markdown</button>
            </div>
          </header>
          <p className="sa-report-meta">
            {detail.project?.name || '未绑定项目'} · {detail.report.executorId || '未知执行者'}{detail.report.role ? ` · ${detail.report.role}` : ''} · {time(detail.report.createdAt)}
          </p>
          <div className="sa-report-body">{detail.report.summary || '（没有结论正文）'}</div>
          {detail.artifacts.length > 0 && <section className="sa-report-artifacts">
            <h3>产物</h3>
            <ul>{detail.artifacts.map(artifact => <li key={artifact.name}><FileText size={13} /><span><strong>{artifact.name}</strong>{artifact.summary ? <em>{artifact.summary}</em> : null}</span></li>)}</ul>
          </section>}
        </> : <p className="sa-empty">选择左侧一份报告查看结论与产物。</p>}
      </article>
    </div>
    {total > 0 && <p className="sa-inline-note">共 {total} 组报告{items.length < total ? `，已显示 ${items.length} 组` : ''}。</p>}
    </>}
  </section>;
}
