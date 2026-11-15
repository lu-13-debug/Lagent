import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { api } from './api';
import { useAuth } from './auth-context';
import { setDesktopState } from './desktop-tray';
import type { Settings } from './types';
import { Logo, Spinner } from './components/ui';

// 主界面只有指挥台：数据分析能力仍在服务端与接口层，网页入口已不再提供。
const SuperAgentShell = lazy(() => import('./components/SuperAgentShell').then(module => ({ default: module.SuperAgentShell })));

const noop = () => {};

export default function App() {
  const { runtime, user } = useAuth();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    setError('');
    try {
      const next = await api.bootstrap(signal);
      if (signal?.aborted) return;
      setSettings(next.settings);
    } catch (cause) {
      if (!signal?.aborted) setError((cause as Error).message);
    }
  }, []);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useEffect(() => { if (settings) setDesktopState(window.lagentDesktop, 'ready'); }, [Boolean(settings)]);

  if (!settings || error) {
    return <div className="app-loading">
      <div className="loading-brand"><Logo /><strong>Lagent.</strong></div>
      {error
        ? <><h2>连接 Lagent 服务时遇到问题</h2><p role="alert">{error}</p><button className="button primary" onClick={() => void load()}><RefreshCw size={15} />重试连接</button><small>{runtime.mode === 'cloud' ? '请检查网络；若问题持续，请联系本服务管理员。' : '开发环境请运行 npm run dev；生产环境请运行 npm start。'}</small></>
        : <><Spinner size={24} /><p role="status">正在载入指挥台…</p></>}
    </div>;
  }

  if (!runtime.capabilities?.superagent) {
    return <div className="app-loading">
      <div className="loading-brand"><Logo /><strong>Lagent.</strong></div>
      <ShieldAlert size={26} aria-hidden="true" />
      <h2>指挥服务未启用</h2>
      <p role="status">当前服务没有注册指挥台接口。请移除 <code>LAGENT_WORK_ENABLED=0</code>（或设为 1）后重启，或改用云端账号版。</p>
    </div>;
  }

  return <Suspense fallback={<div className="app-loading"><div className="loading-brand"><Logo /><strong>Lagent.</strong></div><Spinner size={24} /><p role="status">正在载入指挥台…</p></div>}>
    <SuperAgentShell user={user} runtime={runtime} settings={settings} onSettingsSaved={setSettings} notify={noop} />
  </Suspense>;
}
