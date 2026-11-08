import { useEffect, useRef, useState } from 'react';
import { activeTocId } from '../report-toc';
import type { ReportTocItem } from '../report-toc';
import '../report-toc.css';

function stickyBottom(): number {
  let bottom = 0;
  for (const selector of ['.topbar', '.page-toolbar']) {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const style = getComputedStyle(element);
    if (style.position !== 'sticky' && style.position !== 'fixed') continue;
    bottom = Math.max(bottom, (parseFloat(style.top) || 0) + element.getBoundingClientRect().height);
  }
  return bottom;
}

export function ReportToc({ items }: { items: ReportTocItem[] }) {
  const [active, setActive] = useState(items[0]?.id || '');
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let frame = 0;
    function update() {
      frame = 0;
      const offset = stickyBottom();
      navRef.current?.style.setProperty('--toc-top', `${offset}px`);
      const tops: Record<string, number> = {};
      for (const item of items) {
        const element = document.getElementById(item.id);
        if (element) tops[item.id] = element.getBoundingClientRect().top;
      }
      const next = activeTocId(items, tops, offset + 24);
      setActive(current => current === next ? current : next);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(update); }
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items]);
  function jump(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    const offset = stickyBottom() + 16;
    window.scrollTo({ top: Math.max(0, window.scrollY + target.getBoundingClientRect().top - offset), behavior: 'smooth' });
    target.focus({ preventScroll: true });
  }
  return <nav ref={navRef} className="report-toc no-print" aria-label="报告目录">
    <span className="report-toc-label">目录</span>
    <ol>{items.map((item, index) => <li key={item.id}><button type="button" className={item.id === active ? 'is-active' : undefined} aria-current={item.id === active ? 'location' : undefined} onClick={() => jump(item.id)}><span aria-hidden="true">{index + 1}</span>{item.label}</button></li>)}</ol>
  </nav>;
}
