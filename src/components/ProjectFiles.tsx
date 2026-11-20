import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Download, FileText, Lock, RefreshCw, Search } from 'lucide-react';
import { api } from '../api';
import type { WorkProject, WorkProjectFileEntry } from '../superagent';
import { FileKindIcon, FILE_KIND_LABELS, FilePreviewBody, formatFileSize, formatFileTime, useProjectFilePreview } from './ProjectFilePreview';

type Props = { project: WorkProject; notify: (text: string, error?: boolean) => void };

export function ProjectFiles({ project, notify }: Props) {
  const [tree, setTree] = useState<Record<string, WorkProjectFileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState('');
  const [loadingDir, setLoadingDir] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<WorkProjectFileEntry[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [version, setVersion] = useState(0);
  const searchSeq = useRef(0);
  const { preview, loading: loadingPreview, error: previewError } = useProjectFilePreview(project.id, locked ? null : selected, version);

  const loadDir = async (dir: string) => {
    setLoadingDir(dir);
    try {
      const result = await api.workProjectFiles(project.id, dir);
      setTree(current => ({ ...current, [dir]: result.entries }));
      return result;
    } catch (cause) {
      setTree(current => ({ ...current, [dir]: [] }));
      setError((cause as Error).message);
      notify((cause as Error).message, true);
      return null;
    } finally {
      setLoadingDir(current => current === dir ? '' : current);
    }
  };

  const openPath = (filePath: string, isLocked = false) => {
    setSelected(filePath);
    setLocked(isLocked);
    setError('');
  };

  useEffect(() => {
    searchSeq.current += 1;
    setTree({}); setExpanded(new Set()); setSelected(null); setLocked(false); setError('');
    setQuery(''); setSearch(null); setSearching(false);
    void loadDir('').then(result => {
      if (!result) return;
      const readme = result.entries.find(entry => entry.type === 'file' && entry.previewable && /^readme(\.|$)/i.test(entry.name));
      if (readme) openPath(readme.path);
    });
    // 只跟随项目切换；loadDir/openPath 依赖当前 project.id。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setSearch(null); setSearching(false); return; }
    const seq = ++searchSeq.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api.workProjectFileSearch(project.id, text)
        .then(result => { if (seq === searchSeq.current) setSearch(result.entries); })
        .catch(() => { if (seq === searchSeq.current) setSearch([]); })
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [project.id, query]);

  const toggleDir = (entry: WorkProjectFileEntry) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!tree[entry.path] && loadingDir !== entry.path) void loadDir(entry.path);
  };

  const refresh = () => {
    setTree({}); setExpanded(new Set()); setSearch(null);
    setVersion(value => value + 1);
    void loadDir('');
  };

  const openEntry = (entry: WorkProjectFileEntry) => {
    if (entry.type === 'dir') toggleDir(entry);
    else openPath(entry.path, Boolean(entry.locked));
  };

  const renderTree = (dir: string, depth: number) => (tree[dir] || []).map(entry => {
    const open = entry.type === 'dir' && expanded.has(entry.path);
    return <div className="pjf-branch" key={entry.path}>
      <button
        type="button"
        className={`pjf-node${selected === entry.path ? ' is-active' : ''}${entry.locked ? ' is-locked' : ''}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={entry.locked ? `${entry.path}（敏感文件，不提供预览）` : entry.path}
        onClick={() => openEntry(entry)}
      >
        {entry.type === 'dir' ? <ChevronRight size={12} className={`pjf-caret${open ? ' is-open' : ''}`} /> : <span className="pjf-caret-space" />}
        <span className={`pjf-icon kind-${entry.kind}`}><FileKindIcon kind={entry.kind} open={open} /></span>
        <span className="pjf-name">{entry.name}</span>
        {entry.locked && <Lock size={11} className="pjf-lock" />}
        {entry.type === 'dir' && loadingDir === entry.path && <span className="pjf-spinner" />}
      </button>
      {open && <div>{tree[entry.path] ? renderTree(entry.path, depth + 1) : <p className="pjf-tree-empty" style={{ paddingLeft: `${30 + depth * 14}px` }}>{loadingDir === entry.path ? '读取中…' : '空文件夹'}</p>}</div>}
    </div>;
  });

  const shownError = locked ? '这是敏感文件，出于安全考虑不提供预览。' : (error || previewError);

  const renderPreview = () => {
    if (!selected) return <div className="pjf-empty pjf-empty-preview"><FileText size={28} /><strong>选择一个文件开始预览</strong><span>左侧文件树支持 Markdown、PDF、Word、PPT、HTML、表格、图片与代码。</span></div>;
    if (loadingPreview) return <div className="pjf-empty pjf-empty-preview"><RefreshCw size={22} className="pjf-spin" /><span>正在读取文件…</span></div>;
    if (shownError) return <div className="pjf-alert" role="alert">{shownError}</div>;
    if (!preview) return <div className="pjf-empty pjf-empty-preview"><span>还没有可显示的内容。</span></div>;
    return <FilePreviewBody projectId={project.id} preview={preview} />;
  };

  const selectedMeta = preview
    ? `${FILE_KIND_LABELS[preview.kind] || preview.kind} · ${formatFileSize(preview.size)}${preview.modifiedAt ? ` · ${formatFileTime(preview.modifiedAt)}` : ''}`
    : selected || '';
  const searchingNow = query.trim().length >= 2;

  return <div className="pjf-layout">
    <aside className="pjf-sidebar" aria-label="项目文件">
      <div className="pjf-side-head">
        <div><strong>项目文件</strong><span>{project.name}</span></div>
        <button type="button" className="pjf-icon-button" aria-label="刷新文件列表" title="刷新文件列表" onClick={refresh}><RefreshCw size={14} /></button>
      </div>
      <label className="pjf-search">
        <Search size={13} />
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件" aria-label="搜索项目文件" />
      </label>
      <div className="pjf-tree" role="tree">
        {searchingNow
          ? searching
            ? <p className="pjf-tree-empty">正在搜索…</p>
            : (search || []).length
              ? <div className="pjf-results">{search!.map(entry => <button type="button" key={entry.path} className={`pjf-node${selected === entry.path ? ' is-active' : ''}`} onClick={() => openPath(entry.path, Boolean(entry.locked))} title={entry.path}>
                <span className="pjf-caret-space" />
                <span className={`pjf-icon kind-${entry.kind}`}><FileKindIcon kind={entry.kind} /></span>
                <span className="pjf-name">{entry.name}<em>{entry.path}</em></span>
                {entry.locked && <Lock size={11} className="pjf-lock" />}
              </button>)}</div>
              : <p className="pjf-tree-empty">没有匹配的文件。</p>
          : tree[''] === undefined
            ? <p className="pjf-tree-empty">正在读取项目文件…</p>
            : tree['']?.length
              ? renderTree('', 0)
              : <p className="pjf-tree-empty">这个项目还没有文件。</p>}
      </div>
    </aside>
    <section className="pjf-preview" aria-live="polite">
      <header className="pjf-preview-head">
        <div className="pjf-preview-title">
          <span className="pjf-preview-icon">{preview ? <FileKindIcon kind={preview.kind} /> : <FileText size={15} />}</span>
          <div><strong>{preview?.name || selected?.split('/').pop() || '文件预览'}</strong><span>{selectedMeta || '从左侧选择文件'}</span></div>
        </div>
        {preview && <div className="pjf-preview-actions">
          <a className="pj-btn" href={api.workProjectFileUrl(project.id, preview.path, true)} download><Download size={13} />下载</a>
        </div>}
      </header>
      <div className="pjf-preview-body">{renderPreview()}</div>
    </section>
  </div>;
}
