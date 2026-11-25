export interface DesktopBridge {
  setTheme?: (theme: 'light' | 'dark' | 'system') => unknown;
  onSystemThemeChanged?: (callback: (dark: boolean) => void) => unknown;
  setTaskSummaries?: (summaries: { id: string; title: string; status: 'running' | 'awaiting_approval' }[]) => unknown;
  onNewAnalysis?: (callback: () => void) => unknown;
  setTrayState?: (state: 'login' | 'ready') => unknown;
  showWindow?: () => unknown;
  pickFolder?: () => Promise<string | null>;
}
declare global { interface Window { lagentDesktop?: DesktopBridge } }
// Old clients may expose only some methods. Treat the bridge as optional UI assistance.
function settle(value: unknown) { void Promise.resolve(value).catch(() => {}); }
export function setDesktopState(bridge: DesktopBridge | undefined, state: 'login' | 'ready') {
  try { if (typeof bridge?.setTrayState === 'function') settle(bridge.setTrayState(state)); } catch {}
}
export function setDesktopSummaries(bridge: DesktopBridge | undefined, summaries: { id: string; title: string; status: 'running' | 'awaiting_approval' }[]) {
  try { if (typeof bridge?.setTaskSummaries === 'function') settle(bridge.setTaskSummaries(summaries)); } catch {}
}
export function showDesktopWindow(bridge: DesktopBridge | undefined) {
  try { if (typeof bridge?.showWindow === 'function') settle(bridge.showWindow()); } catch {}
}
export function subscribeDesktopNew(bridge: DesktopBridge | undefined, callback: () => void): () => void {
  try {
    if (typeof bridge?.onNewAnalysis !== 'function') return () => {};
    const unsubscribe = bridge.onNewAnalysis(callback);
    if (typeof unsubscribe === 'function') return () => { try { settle(unsubscribe()); } catch {} };
    settle(unsubscribe);
  } catch {}
  return () => {};
}
