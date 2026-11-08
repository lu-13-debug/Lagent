import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ModelOption } from '../types';
import { filterModels } from '../model-picker';

export function ModelPicker({ id = 'model-name', models, value, onChange, disabled, loading, placeholder = '请选择模型' }: {
  id?: string; models: ModelOption[]; value: string; onChange: (id: string) => void; disabled?: boolean; loading?: boolean; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = `${id}-options`;
  const { items, total } = filterModels(models, query);
  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  function openList() { if (disabled) return; setOpen(true); setQuery(''); setActive(items.findIndex(item => item.id === value)); }
  function choose(model: ModelOption) { onChange(model.id); setOpen(false); setQuery(''); setActive(-1); }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { if (open) { event.stopPropagation(); setOpen(false); setQuery(''); } return; }
    if (event.key === 'Tab') { setOpen(false); return; }
    if (!open) { if (event.key === 'ArrowDown' || event.key === 'Enter') { event.preventDefault(); openList(); } return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(items.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); const item = items[active]; if (item) choose(item); }
  }

  return <div className="model-combobox" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(''); } }}>
    <input id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
      value={open ? query : value} placeholder={open ? '输入名称或 ID 筛选模型' : placeholder} disabled={disabled}
      onChange={event => { setOpen(true); setQuery(event.target.value); setActive(0); }}
      onFocus={openList} onClick={() => { if (!open) openList(); }} onKeyDown={onKeyDown} />
    {open && <ul id={listId} role="listbox" aria-label="可用模型" ref={listRef} className="model-options">
      {loading && <li className="model-options-empty" role="option" aria-selected="false" aria-disabled="true">正在检测模型…</li>}
      {!loading && items.map((item, index) => <li key={item.id} id={optionId(index)} role="option" aria-selected={item.id === value}
        className={index === active ? 'is-active' : undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}>
        <span>{item.name === item.id ? item.id : item.name}</span>{item.name !== item.id && <small>{item.id}</small>}
      </li>)}
      {!loading && !items.length && <li className="model-options-empty" role="option" aria-selected="false" aria-disabled="true">{query.trim() ? '没有匹配的模型，可切换到手动填写' : '尚未获取到可用模型'}</li>}
      {!loading && total > items.length && <li className="model-options-note" aria-hidden="true">共 {total} 个，显示前 {items.length} 个，继续输入以缩小范围</li>}
    </ul>}
  </div>;
}
