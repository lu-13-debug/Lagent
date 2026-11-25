import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import { mobileApi } from './mobile-api';
import { isAgentKind } from './display';
import type { MobileAgent, MobileBootstrap, MobileTicket } from './types';

// 工具直连：只保留受控终端 / 浏览器 / GitHub，不再提供「让某个 Agent 干活」的入口。
export function MobileCommand({ token, bootstrap, loading, error, allowed, agents, onSent }: {
  token: string; bootstrap: MobileBootstrap | null; loading: boolean; error: string; allowed: string[]; agents: MobileAgent[];
  onSent: (ticket: MobileTicket) => void;
}) {
  const available = useMemo(() => agents.filter(agent => allowed.includes(agent.id) && !isAgentKind(agent.kind)), [agents, allowed]);
  const [text, setText] = useState('');
  const [executorId, setExecutorId] = useState('');
  const [program, setProgram] = useState('git');
  const [args, setArgs] = useState('status --short');
  const [url, setUrl] = useState('');
  const [githubAction, setGithubAction] = useState('repo');
  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [number, setNumber] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!available.length) { setExecutorId(''); return; }
    if (!available.some(agent => agent.id === executorId)) setExecutorId(available[0].id);
  }, [available, executorId]);

  const current = available.find(agent => agent.id === executorId);
  const canSend = Boolean(text.trim() && executorId && current?.status === 'available' && !busy);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSend) return;
    let executorInput: Record<string, unknown> | undefined;
    if (executorId === 'terminal') executorInput = { program, args: args.trim().split(/\s+/).filter(Boolean) };
    else if (executorId === 'browser') {
      if (!/^https?:\/\//i.test(url.trim())) { setMessage('请填写 http/https 页面地址。'); return; }
      executorInput = { url: url.trim() };
    } else if (executorId === 'github') {
      if (!owner.trim() || !repo.trim()) { setMessage('请填写 GitHub owner 和 repo。'); return; }
      executorInput = { action: githubAction, owner: owner.trim(), repo: repo.trim(), ...(number.trim() ? { number: Number(number) } : {}), ...(githubAction === 'file' ? { path: path.trim() } : {}) };
    }
    setBusy(true); setMessage('');
    try {
      const response = await mobileApi.command(token, {
        text: text.trim(), clientRequestId: `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, executorId, executorInput
      });
      setText(''); onSent(response.ticket);
    } catch (cause) { setMessage((cause as Error).message); }
    finally { setBusy(false); }
  };

  if (loading && !bootstrap) return <p className="mob-loading"><RefreshCw size={16} className="mob-spin" />正在载入工具…</p>;
  if (error && !bootstrap) return <section className="mob-empty"><AlertTriangle size={22} /><h2>无法载入工具</h2><p>{error}</p></section>;

  return <section className="mob-page">
    <p className="mob-eyebrow">工具直连</p>
    <h1>直接调用工具</h1>
    <p className="mob-lead">日常任务请回到「对话」，这里只用来执行一次具体的终端、浏览器或 GitHub 操作。</p>
    <form className="mob-composer" onSubmit={submit}>
      <textarea value={text} onChange={event => setText(event.target.value)} rows={4} placeholder="例如：查看仓库 CI 状态" aria-label="指令" />
      <div className="mob-field-row">
        <label>工具<select value={executorId} onChange={event => setExecutorId(event.target.value)}>{available.length
          ? available.map(agent => <option key={agent.id} value={agent.id} disabled={agent.status !== 'available'}>{agent.name}{agent.status !== 'available' ? '（不可用）' : ''}</option>)
          : <option value="">无可用工具</option>}</select></label>
      </div>
      {executorId === 'terminal' && <div className="mob-field-row">
        <label>程序<select value={program} onChange={event => setProgram(event.target.value)}><option value="git">git</option><option value="npm">npm</option><option value="ls">ls</option><option value="pwd">pwd</option></select></label>
        <label>参数<input value={args} onChange={event => setArgs(event.target.value)} placeholder="status --short" /></label>
      </div>}
      {executorId === 'browser' && <label className="mob-wide">页面地址<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/page" /></label>}
      {executorId === 'github' && <div className="mob-field-row">
        <label>动作<select value={githubAction} onChange={event => setGithubAction(event.target.value)}><option value="repo">仓库</option><option value="issues">Issues</option><option value="pulls">Pull Requests</option><option value="checks">CI Checks</option><option value="file">文件</option></select></label>
        <label>owner<input value={owner} onChange={event => setOwner(event.target.value)} placeholder="acme" /></label>
        <label>repo<input value={repo} onChange={event => setRepo(event.target.value)} placeholder="lagent" /></label>
        {['issues', 'pulls', 'checks'].includes(githubAction) && <label>编号<input inputMode="numeric" value={number} onChange={event => setNumber(event.target.value)} /></label>}
        {githubAction === 'file' && <label>文件路径<input value={path} onChange={event => setPath(event.target.value)} placeholder="docs/readme.md" /></label>}
      </div>}
      {message && <p className="mob-error" role="alert">{message}</p>}
      <button type="submit" className="mob-primary" disabled={!canSend}>{busy ? <RefreshCw size={16} className="mob-spin" /> : <Send size={16} />}{busy ? '提交中' : '发送指令'}</button>
    </form>
    <p className="mob-note"><ShieldCheck size={13} />只会执行你明确授权或规则允许的操作；危险动作会先请求确认。</p>
  </section>;
}
