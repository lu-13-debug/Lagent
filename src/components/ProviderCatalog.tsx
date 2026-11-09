import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { groupedProviders, type ModelProviderPreset } from '../model-providers';

export function ProviderCatalog({ onPick, allowed, disabled, compact = false }: {
  onPick: (preset: ModelProviderPreset) => void;
  allowed?: (preset: ModelProviderPreset) => boolean;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupedProviders(query), [query]);

  if (compact) {
    const all = groupedProviders('');
    return <label className="field provider-compact">
      <span>从供应商目录填充</span>
      <select aria-label="从供应商目录选择" defaultValue="" disabled={disabled}
        onChange={event => {
          const preset = all.flatMap(group => group.items).find(item => item.id === event.target.value);
          event.target.value = '';
          if (preset) onPick(preset);
        }}>
        <option value="">选择常用供应商（可选）</option>
        {all.map(group => <optgroup key={group.region} label={group.label}>
          {group.items.map(preset => <option key={preset.id} value={preset.id} disabled={allowed ? !allowed(preset) : false}>{preset.name}</option>)}
        </optgroup>)}
      </select>
      <small className="field-help">选中后会填入供应商名称、地址与协议；API Key 仍需自己填写。</small>
    </label>;
  }

  return <div className="provider-catalog">
    <label className="provider-search">
      <Search size={14} aria-hidden="true" />
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索供应商或模型，例如 通义、deepseek、gemini" aria-label="搜索供应商" disabled={disabled} />
    </label>
    {groups.length === 0 && <p className="provider-empty">没有匹配的供应商，可以直接在下方手填地址。</p>}
    {groups.map(group => <div className="provider-group" key={group.region}>
      <h4>{group.label}<span>{group.items.length}</span></h4>
      <div className="provider-items">
        {group.items.map(preset => {
          const permitted = allowed ? allowed(preset) : true;
          return <button type="button" className="provider-item" key={preset.id} disabled={disabled || !permitted}
            title={preset.note || preset.baseUrl}
            onClick={() => onPick(preset)}>
            <strong>{preset.name}</strong>
            <small>{preset.models[0] || preset.baseUrl}</small>
            {!permitted && <em>未开放</em>}
          </button>;
        })}
      </div>
    </div>)}
  </div>;
}
