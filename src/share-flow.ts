export const validShareToken = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
export interface ShareReaderState<T> { token: string; visitorToken: string; report: T | null; status: 'loading' | 'ready' | 'unavailable' }
export function createShareReader<T>(options: { makeVisitor: () => string; read: (token: string) => Promise<T>; visit: (token: string, visitor: string) => unknown; publish: (state: ShareReaderState<T>) => void }) {
  let current: string | undefined; let generation = 0;
  return {
    open(token: string) {
      if (token === current) return;
      current = token; const revision = ++generation;
      let visitorToken = '';
      try { if (validShareToken(token)) visitorToken = options.makeVisitor(); } catch { /* no secure random source */ }
      if (!validShareToken(token) || !validShareToken(visitorToken)) { options.publish({token, visitorToken: '', report: null, status: 'unavailable'}); return; }
      options.publish({token, visitorToken, report: null, status: 'loading'});
      void options.read(token).then(report => {
        if (revision !== generation) return;
        options.publish({token, visitorToken, report, status: 'ready'});
        try { void Promise.resolve(options.visit(token, visitorToken)).catch(() => {}); } catch { /* visit is optional */ }
      }).catch(() => { if (revision === generation) options.publish({token, visitorToken, report: null, status: 'unavailable'}); });
    },
    dispose() { generation++; current = undefined; }
  };
}
