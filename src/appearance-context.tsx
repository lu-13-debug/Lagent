import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { readAppearance, resolveAppearance, saveAppearance, readRail, resolveRail, saveRail } from './appearance';
import type { Appearance, ThemePreference } from './appearance';

type ContextValue = Appearance & { railCollapsed: boolean; setRailCollapsed: (value: boolean) => void; setTheme: (value: ThemePreference) => void };
const AppearanceContext = createContext<ContextValue | null>(null);
const systemDark = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
export function AppearanceProvider({ children, userId }: { children: ReactNode; userId?: string }) {
  const origin = window.location.origin;
  const [preference, setPreference] = useState(() => {
    try { return readAppearance(localStorage, origin, userId); } catch { return { theme: 'system' as const, view: 'concise' as const }; }
  });
  const [dark, setDark] = useState(systemDark);
  const [railPreference, setRailPreference] = useState<boolean | null>(() => { try { return readRail(localStorage, origin, userId); } catch { return null; } });
  const current = useMemo(() => resolveAppearance(preference, dark), [preference, dark]);
  const railCollapsed = resolveRail(railPreference, current.view);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = (event: MediaQueryListEvent) => setDark(event.matches);
    setDark(media.matches); media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    try {
      const bridge = window.lagentDesktop;
      if (typeof bridge?.onSystemThemeChanged !== 'function') return;
      const unsubscribe = bridge.onSystemThemeChanged(value => setDark(Boolean(value)));
      return () => { if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch { /* 旧客户端可继续工作。 */ } } };
    } catch { /* 桌面桥不可用时使用浏览器系统设置。 */ }
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = current.resolvedTheme; root.dataset.view = current.view;
    if (current.theme === 'system') delete root.dataset.themeFix; else root.dataset.themeFix = '';
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', current.resolvedTheme === 'dark' ? '#0b0d0c' : '#f3f1ea');
    root.dataset.appearanceReady = '';
    try { saveAppearance(localStorage, origin, userId, preference); localStorage.setItem('lagent:appearance:boot:v1', JSON.stringify(preference)); } catch { /* 存储不可用时仍可切换。 */ }
    try { window.lagentDesktop?.setTheme?.(current.theme); } catch { /* 旧客户端仍使用页面主题。 */ }
  }, [current, origin, preference, userId]);
  const setTheme = useCallback((theme: ThemePreference) => setPreference(previous => ({ ...previous, theme })), []);
  const setRailCollapsed = useCallback((value: boolean) => { setRailPreference(value); try { saveRail(localStorage, origin, userId, value); } catch { /* 当前会话仍可使用。 */ } }, [origin, userId]);
  return <AppearanceContext.Provider value={{ ...current, railCollapsed, setRailCollapsed, setTheme }}>{children}</AppearanceContext.Provider>;
}
export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('外观设置需要 AppearanceProvider。');
  return value;
}
