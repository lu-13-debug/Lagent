import { useEffect, useState } from 'react';
import { BookOpen, Check, Download, Package, Plug, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { WorkPluginMarketplace, WorkPlugins, WorkProject, WorkSkill, WorkSkillCatalogEntry, WorkSkillPreview, WorkSkillScope } from '../superagent';
import { Spinner } from './ui';

type Notify = (message: string, error?: boolean) => void;
type Tab = 'installed' | 'discover' | 'plugins' | 'sources';

const TABS: { id: Tab; label: string; icon: typeof Package }[] = [
  { id: 'installed', label: '已安装', icon: Check },
  { id: 'discover', label: '发现', icon: Download },
  { id: 'plugins', label: '插件市场', icon: Plug },
  { id: 'sources', label: '来源', icon: BookOpen },
];

const CATEGORY_NAMES: Record<string, string> = { code: '代码开发与审查', design: '设计与视觉', backend: '后端与架构', context: '上下文与交接', docs: '文档与协作', data: '数据与报表', ops: 'GitHub 与项目管理' };

async function attempt<T>(notify: Notify, action: () => Promise<T>): Promise<T | null> {
  try { return await action(); } catch (cause) { notify((cause as Error).message || '操作失败', true); return null; }
}

const pluginId = (plugin: Record<string, unknown>) => String(plugin.pluginId || plugin.id || plugin.name || '');
const pluginName = (plugin: Record<string, unknown>) => String(plugin.name || plugin.pluginId || plugin.id || '').split('@')[0];
const pluginMarketplace = (plugin: Record<string, unknown>) => String(plugin.marketplaceName || (String(plugin.pluginId || '').split('@')[1] || ''));
const pluginDescription = (plugin: Record<string, unknown>) => String(plugin.descriptionZh || plugin.description || '');

export function SkillsPanel({ projects, notify }: { projects: WorkProject[]; notify: Notify }) {
  const [tab, setTab] = useState<Tab>('installed');
  const [skills, setSkills] = useState<WorkSkill[]>([]);
  const [catalog, setCatalog] = useState<WorkSkillCatalogEntry[]>([]);
  const [plugins, setPlugins] = useState<WorkPlugins | null>(null);
  const [busy, setBusy] = useState('');

  const loadSkills = async () => {
    const result = await attempt(notify, () => api.workSkills());
    if (result) { setSkills(result.skills); setCatalog(result.catalog); }
  };
  const loadPlugins = async (refresh = false) => {
    const result = await attempt(notify, () => api.workPlugins(refresh));
    if (result) setPlugins(result);
  };
  useEffect(() => { void loadSkills(); void loadPlugins(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  return <section className="sa-page">
    <header className="sa-page-head"><div><p className="sa-eyebrow">能力扩展</p><h1>技能与插件</h1><p>把可复用的做法装进项目，让内置 Agent 和 CLI 在真实工作里直接用上。</p></div></header>
    <div className="sa-ops-tabs" role="tablist">{TABS.map(item => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'is-on' : ''} onClick={() => setTab(item.id)}><item.icon size={14} />{item.label}</button>)}</div>
    {tab === 'installed' && <InstalledSkills skills={skills} notify={notify} busy={busy} setBusy={setBusy} reload={loadSkills} />}
    {tab === 'discover' && <DiscoverSkills skills={skills} catalog={catalog} projects={projects} notify={notify} reload={loadSkills} />}
    {tab === 'plugins' && <PluginMarket plugins={plugins} notify={notify} busy={busy} setBusy={setBusy} reload={loadPlugins} />}
    {tab === 'sources' && <SourcesPanel plugins={plugins} notify={notify} reload={loadPlugins} />}
  </section>;
}

function InstalledSkills({ skills, notify, busy, setBusy, reload }: { skills: WorkSkill[]; notify: Notify; busy: string; setBusy: (value: string) => void; reload: () => Promise<void> }) {
  if (!skills.length) return <p className="sa-empty">还没有安装技能。去「发现」里选一个，或贴一个 GitHub 仓库地址。</p>;
  return <div className="sa-ops-list">
    {skills.map(skill => <div className="sa-ops-row" key={skill.id}>
      <div>
        <strong>{skill.name}{skill.missing ? ' · 文件缺失' : skill.enabled ? '' : ' · 已停用'}</strong>
        <span>{skill.description || '没有描述'} · {skill.scope === 'global' ? '全局' : '项目'} · {skill.source.repo} · {skill.source.commit.slice(0, 8)}</span>
        <code>{skill.targetPath}</code>
      </div>
      <div className="sa-ops-row-actions">
        <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workSkillEnable(skill.id); notify('技能已启用。'); await reload(); })} disabled={skill.enabled || skill.missing}>启用</button>
        <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workSkillDisable(skill.id); notify('技能已停用。'); await reload(); })} disabled={!skill.enabled}>停用</button>
        <button type="button" className="sa-link" disabled={busy === skill.id} onClick={() => void attempt(notify, async () => { setBusy(skill.id); await api.workSkillUpdate(skill.id); notify('技能已更新，旧版本已备份。'); await reload(); }).finally(() => setBusy(''))}>{busy === skill.id ? '更新中…' : '更新'}</button>
        <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { if (!confirm(`卸载 ${skill.name}？文件会先备份到项目 .lagent/skill-backups。`)) return; await api.workSkillRemove(skill.id); notify('技能已卸载。'); await reload(); })}><Trash2 size={12} />卸载</button>
      </div>
    </div>)}
  </div>;
}

function DiscoverSkills({ skills, catalog, projects, notify, reload }: { skills: WorkSkill[]; catalog: WorkSkillCatalogEntry[]; projects: WorkProject[]; notify: Notify; reload: () => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<WorkSkillPreview | null>(null);
  const [scope, setScope] = useState<WorkSkillScope>(projects.length ? 'project' : 'global');
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  // 项目列表可能在页面挂载之后才返回；补上默认项目，避免安装按钮一直禁用。
  useEffect(() => { if (!projectId && projects[0]) setProjectId(projects[0].id); }, [projects, projectId]);

  const startPreview = async (input: { catalogId?: string; url?: string; repo?: string; path?: string; ref?: string }) => {
    setBusy('preview'); setError(''); setConflict(false);
    try { setPreview(await api.workSkillPreview(input)); }
    catch (cause) { setError((cause as Error).message || '预览失败'); }
    finally { setBusy(''); }
  };
  const install = async (onConflict?: 'overwrite' | 'rename') => {
    if (!preview?.token) return;
    setBusy('install'); setError('');
    try {
      await api.workSkillInstall({ token: preview.token, name: preview.name, scope, projectId: scope === 'project' ? projectId : undefined, commit: preview.commit, digest: preview.digest, confirmed: preview.catalog ? true : confirmed, ...(onConflict ? { onConflict } : {}) });
      notify('技能已安装。');
      setPreview(null); setConflict(false); await reload();
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code === 'skill_exists') setConflict(true);
      else setError((cause as Error).message || '安装失败');
    } finally { setBusy(''); }
  };

  if (preview) return <div className="sa-ops-section">
    <div className="sa-section-head"><h3>{preview.name || '选择技能'}</h3><button type="button" className="sa-link" onClick={() => { setPreview(null); setError(''); }}><X size={12} />关闭</button></div>
    {preview.candidates?.length ? <>
      <p className="sa-inline-note">这个仓库里有多个技能，选一个安装：</p>
      <div className="sa-ops-actions">{preview.candidates.map(path => <button key={path} type="button" className="sa-button" onClick={() => void startPreview({ repo: preview.repo, path, ref: preview.ref })}>{path}</button>)}</div>
    </> : <>
      <dl className="sa-ops-facts">
        <div><dt>来源</dt><dd>{preview.repo} · {preview.path}</dd></div>
        <div><dt>版本</dt><dd>{preview.commit?.slice(0, 12)} · {preview.license || '未声明许可证'}</dd></div>
        <div><dt>内容</dt><dd>{preview.files?.length || 0} 个文件 · {Math.ceil((preview.bytes || 0) / 1024)} KB</dd></div>
      </dl>
      <p className="sa-inline-note">{preview.description || '没有描述'}</p>
      <details className="sa-ops-preview"><summary>文件清单</summary><pre>{preview.files?.map(file => `${file.path}  ${Math.ceil(file.size / 1024)}KB`).join('\n')}</pre></details>
      <div className="sa-ops-form">
        <label>安装范围<select value={scope} onChange={event => setScope(event.target.value as WorkSkillScope)}><option value="project">当前项目</option><option value="global">全局（所有项目）</option></select></label>
        {scope === 'project' && <label>项目<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
      </div>
      {scope === 'project' && !projects.length && <p className="sa-inline-note">还没有导入项目，请先切到全局或导入一个文件夹。</p>}
      {!preview.catalog && <label className="sa-ops-actions"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认这个 GitHub 来源可信，并了解技能说明可能让 Agent 执行命令</label>}
      {error && <p className="sa-inline-note is-error">{error}</p>}
      {conflict && <p className="sa-inline-note is-error">已经存在同名技能。可以覆盖，或改名安装。</p>}
      <div className="sa-ops-actions">
        <button type="button" className="sa-button sa-primary" disabled={busy === 'install' || (scope === 'project' && !projectId) || (!preview.catalog && !confirmed)} onClick={() => void install()}>{busy === 'install' ? '安装中…' : '安装'}</button>
        {conflict && <button type="button" className="sa-button" disabled={busy === 'install'} onClick={() => void install('overwrite')}>覆盖安装</button>}
        {conflict && <button type="button" className="sa-button" disabled={busy === 'install'} onClick={() => void install('rename')}>改名安装</button>}
      </div>
    </>}
  </div>;

  const categories = [...new Set(catalog.map(entry => entry.category))];
  return <div className="sa-ops-section">
    <div className="sa-ops-form"><label className="sa-ops-wide">从 GitHub 安装<input value={url} placeholder="owner/repo 或 https://github.com/owner/repo/tree/main/skills/xxx" onChange={event => setUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && url.trim()) { event.preventDefault(); void startPreview({ url: url.trim() }); } }} /></label></div>
    <div className="sa-ops-actions"><button type="button" className="sa-button sa-primary" disabled={!url.trim() || busy === 'preview'} onClick={() => void startPreview({ url: url.trim() })}>{busy === 'preview' ? <Spinner size={14} /> : <Download size={14} />}预览并安装</button></div>
    {error && <p className="sa-inline-note is-error">{error}</p>}
    {categories.map(category => <div key={category}>
      <div className="sa-section-head"><h3>{CATEGORY_NAMES[category] || category}</h3></div>
      <div className="sa-ops-list">{catalog.filter(entry => entry.category === category).map(entry => {
        const installed = skills.some(skill => skill.name === entry.name);
        return <div className="sa-ops-row" key={entry.id}><div><strong>{entry.title} · {entry.name}</strong><span>{entry.description}</span><span>{entry.repo} · {entry.path === '.' ? '仓库根目录' : entry.path} · {entry.license}</span></div><button type="button" className="sa-button" disabled={busy === 'preview'} onClick={() => void startPreview({ catalogId: entry.id })}>{installed ? '重新安装' : '安装'}</button></div>;
      })}</div>
    </div>)}
  </div>;
}

function PluginMarket({ plugins, notify, busy, setBusy, reload }: { plugins: WorkPlugins | null; notify: Notify; busy: string; setBusy: (value: string) => void; reload: (refresh?: boolean) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [details, setDetails] = useState('');
  if (!plugins) return <p className="sa-empty">正在读取插件市场…</p>;
  if (!plugins.available) return <div className="sa-ops-section"><p className="sa-empty">{plugins.reason || '本机没有可用的 Claude Code CLI。'}</p><p className="sa-inline-note">安装并登录 Claude Code 后，这里会显示官方插件市场。</p></div>;
  const installedNames = new Set(plugins.installed.map(plugin => pluginId(plugin)));
  const installPlugin = async (id: string, name: string, marketplace: string) => {
    setBusy(id);
    try {
      try { await api.workPluginInstall(name, { marketplace }); }
      catch (cause) {
        // 带安装命令的插件会让 CLI 要求 --accept-command <sha256>；把决定权交还给用户。
        const message = (cause as Error).message || '';
        const acceptCommand = /--accept-command\s+([a-f0-9]{64})/i.exec(message)?.[1];
        if (!acceptCommand || !confirm(`这个插件带有安装命令：\n\n${message}\n\n确认执行并继续安装？`)) throw cause;
        await api.workPluginInstall(name, { marketplace, acceptCommand });
      }
      notify('插件已安装。');
      await reload();
    } catch (cause) { notify((cause as Error).message || '插件安装失败', true); }
    finally { setBusy(''); }
  };
  const filtered = plugins.catalog.filter(plugin => {
    const value = `${pluginId(plugin)} ${pluginDescription(plugin)} ${String(plugin.description || '')}`.toLowerCase();
    return !query.trim() || value.includes(query.trim().toLowerCase());
  }).slice(0, 40);
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>已配置市场</dt><dd>{plugins.marketplaces.map(market => market.name || market.repo || market.source).join('、') || '无'}</dd></div><div><dt>安全提示</dt><dd>插件可以包含 hooks 与安装命令；安装前请先看详情并确认来源。</dd></div></dl>
    <div className="sa-ops-actions"><input value={query} placeholder="搜索插件名称或说明" onChange={event => setQuery(event.target.value)} /><button type="button" className="sa-button" disabled={busy === 'refresh'} onClick={() => void reload(true)}>{busy === 'refresh' ? <Spinner size={14} /> : <RefreshCw size={14} />}刷新市场</button></div>
    <div className="sa-ops-list">{filtered.map(plugin => {
      const id = pluginId(plugin);
      const name = pluginName(plugin);
      const marketplace = pluginMarketplace(plugin);
      const installed = installedNames.has(id) || installedNames.has(name);
      return <div className="sa-ops-row" key={id}>
        <div><strong>{name}{installed ? ' · 已安装' : ''}</strong><span>{pluginDescription(plugin)}</span><span>{marketplace}{typeof plugin.installCount === 'number' ? ` · ${plugin.installCount} 次安装` : ''}</span></div>
        <div className="sa-ops-row-actions">
          {installed && <button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { const result = await api.workPluginDetails(name); setDetails(result.text || '没有详情'); })}>详情</button>}
          {installed
            ? <><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workPluginEnable(name); notify('插件已启用。'); await reload(); })}>启用</button><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { await api.workPluginDisable(name); notify('插件已停用。'); await reload(); })}>停用</button><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { if (!confirm(`卸载插件 ${name}？`)) return; await api.workPluginUninstall(name); notify('插件已卸载。'); await reload(); })}>卸载</button></>
            : <button type="button" className="sa-button" disabled={busy === id} onClick={() => void installPlugin(id, name, marketplace)}>{busy === id ? '安装中…' : '安装'}</button>}
        </div>
      </div>;
    })}</div>
    {!filtered.length && <p className="sa-inline-note">没有匹配的插件。</p>}
    {details && <details className="sa-ops-preview" open><summary>插件详情</summary><pre>{details}</pre></details>}
  </div>;
}

function SourcesPanel({ plugins, notify, reload }: { plugins: WorkPlugins | null; notify: Notify; reload: (refresh?: boolean) => Promise<void> }) {
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState('');
  const marketplaces: WorkPluginMarketplace[] = plugins?.marketplaces || [];
  return <div className="sa-ops-section">
    <dl className="sa-ops-facts"><div><dt>内置技能清单</dt><dd>anthropics/skills（只读推荐，安装时固定 commit）</dd></div><div><dt>插件市场</dt><dd>官方 anthropics/claude-plugins-official + 你添加的 GitHub marketplace</dd></div></dl>
    <div className="sa-ops-form"><label className="sa-ops-wide">添加 GitHub marketplace<input value={source} placeholder="owner/repo 或 https://github.com/owner/repo" onChange={event => setSource(event.target.value)} /></label></div>
    <div className="sa-ops-actions"><button type="button" className="sa-button sa-primary" disabled={!source.trim() || busy === 'add'} onClick={() => void attempt(notify, async () => { setBusy('add'); await api.workPluginAddMarketplace(source.trim()); setSource(''); notify('插件市场已添加。'); await reload(true); }).finally(() => setBusy(''))}>{busy === 'add' ? '添加中…' : '添加市场'}</button></div>
    <div className="sa-ops-list">{marketplaces.map(market => <div className="sa-ops-row" key={String(market.name || market.repo || market.source)}><div><strong>{String(market.name || market.repo || market.source)}</strong><span>{String(market.repo || market.source || '')}{market.installLocation ? ` · ${market.installLocation}` : ''}</span></div><button type="button" className="sa-link" onClick={() => void attempt(notify, async () => { if (!confirm(`移除 marketplace ${String(market.name)}？已安装的插件不会被删除。`)) return; await api.workPluginRemoveMarketplace(String(market.name)); notify('已移除。'); await reload(true); })}>移除</button></div>)}</div>
    {!marketplaces.length && <p className="sa-inline-note">还没有配置 marketplace。</p>}
  </div>;
}
