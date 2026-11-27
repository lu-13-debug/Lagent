import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// 行窗口：只渲染视口附近的会话行，其余用占位高度撑住滚动条。
// 行高不固定，首次用估算值，渲染后用 ResizeObserver 实测并回填；
// 实测导致上方偏移变化时补偿 scrollTop，避免阅读位置跳动。
export interface VirtualRow {
  key: string;
  node: ReactNode;
  className?: string;
}

const TAIL_ROWS = 24;

export function VirtualRows({ rows, scrollRef, resetKey = '', estimate = 220, overscan = 640 }: {
  rows: VirtualRow[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  resetKey?: string;
  estimate?: number;
  overscan?: number;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<string, number>());
  const observed = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const [tick, setTick] = useState(0);
  const [range, setRange] = useState(() => ({ start: Math.max(0, rows.length - TAIL_ROWS), end: rows.length }));
  const stick = useRef(true);

  const metrics = useMemo(() => {
    const offsets = new Array<number>(rows.length + 1);
    offsets[0] = 0;
    for (let index = 0; index < rows.length; index += 1) {
      offsets[index + 1] = offsets[index] + (heights.current.get(rows[index].key) ?? estimate);
    }
    return { offsets, total: offsets[rows.length] };
    // tick 在测量后递增，用来触发重算；heights 是 ref，不作为依赖。
  }, [rows, estimate, tick]);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const previousMetrics = useRef(metrics);

  const recalc = useCallback((toTail = false) => {
    const node = scrollRef.current;
    const list = listRef.current;
    const current = rowsRef.current;
    if (!node || !list || !current.length) {
      setRange({ start: 0, end: current.length });
      return;
    }
    const { offsets, total } = metricsRef.current;
    if (toTail) {
      setRange({ start: Math.max(0, current.length - TAIL_ROWS), end: current.length });
      return;
    }
    const listTop = list.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop;
    const viewTop = node.scrollTop - listTop;
    const viewBottom = viewTop + node.clientHeight;
    let start = 0;
    while (start < current.length - 1 && offsets[start + 1] < viewTop - overscan) start += 1;
    let end = start;
    while (end < current.length && offsets[end] < viewBottom + overscan) end += 1;
    end = Math.min(current.length, Math.max(end, start + 1));
    setRange(previous => previous.start === start && previous.end === end ? previous : { start, end });
    // total 只在读 metrics 时用到；保留解构让意图更清楚。
    void total;
  }, [overscan, scrollRef]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      recalc(false);
    };
    const onResize = () => recalc(false);
    node.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    recalc(false);
    return () => {
      node.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [recalc, scrollRef]);

  // 切换会话：无论之前读到哪，都从最新一轮开始。
  const lastReset = useRef(resetKey);
  useLayoutEffect(() => {
    if (lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    stick.current = true;
    recalc(true);
    const node = scrollRef.current;
    requestAnimationFrame(() => { if (node) node.scrollTop = node.scrollHeight; });
  }, [resetKey, recalc, scrollRef]);

  // 新会话或追加新行时：原本停在底部就继续贴底，否则保持阅读位置。
  const signature = `${rows.length}:${rows[0]?.key || ''}:${rows[rows.length - 1]?.key || ''}`;
  const lastSignature = useRef(signature);
  useLayoutEffect(() => {
    if (lastSignature.current === signature) return;
    lastSignature.current = signature;
    const node = scrollRef.current;
    if (!node) return;
    if (stick.current) {
      recalc(true);
      requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
    } else {
      recalc(false);
    }
  }, [signature, recalc, scrollRef]);

  // 观察当前渲染出来的行；行高变化后回填并重算。
  useEffect(() => {
    const ro = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const key = element.dataset.rowKey || '';
        if (!key) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
        if (!Number.isFinite(height)) continue;
        const previous = heights.current.get(key);
        if (previous === undefined || Math.abs(previous - height) > 0.5) {
          heights.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setTick(value => value + 1);
    });
    observer.current = ro;
    return () => { ro.disconnect(); observer.current = null; };
  }, []);

  // 每次渲染后同步观察集合（只处理当前窗口内的行）。
  useLayoutEffect(() => {
    const ro = observer.current;
    const list = listRef.current;
    if (!ro || !list) return;
    const present = new Set<string>();
    for (const element of Array.from(list.querySelectorAll<HTMLElement>('[data-row-key]'))) {
      const key = element.dataset.rowKey || '';
      if (!key) continue;
      present.add(key);
      if (!observed.current.has(key)) {
        observed.current.set(key, element);
        ro.observe(element);
      }
    }
    for (const [key, element] of [...observed.current]) {
      if (!present.has(key) || !element.isConnected) {
        ro.unobserve(element);
        observed.current.delete(key);
      }
    }
  });

  // 停在底部时，新内容把行撑高后继续贴底。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && stick.current) node.scrollTop = node.scrollHeight;
  }, [tick, scrollRef]);

  // 实测高度改变时，如果变化发生在当前窗口上方，补偿滚动位置。
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const before = previousMetrics.current;
    previousMetrics.current = metrics;
    if (!node || stick.current || before === metrics) return;
    const index = rangeRef.current.start;
    const delta = (metrics.offsets[index] ?? 0) - (before.offsets[index] ?? 0);
    if (Math.abs(delta) > 1) node.scrollTop += delta;
  }, [metrics, scrollRef]);

  const start = Math.min(range.start, rows.length);
  const end = Math.min(range.end, rows.length);
  const topSpace = metrics.offsets[start] ?? 0;
  const bottomSpace = Math.max(0, metrics.total - (metrics.offsets[end] ?? metrics.total));

  return <div className="sa-thread-rows" ref={listRef}>
    {topSpace > 0 && <div className="sa-thread-spacer" style={{ height: topSpace }} aria-hidden="true" />}
    {rows.slice(start, end).map(row => <div key={row.key} data-row-key={row.key} className={`sa-thread-row${row.className ? ` ${row.className}` : ''}`}>{row.node}</div>)}
    {bottomSpace > 0 && <div className="sa-thread-spacer" style={{ height: bottomSpace }} aria-hidden="true" />}
  </div>;
}
