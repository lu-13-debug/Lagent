import catalog from './model-providers.json';

export type ModelProviderRegion = 'cn' | 'global' | 'local';
export type ModelProviderProtocol = 'chat-completions' | 'anthropic';

export interface ModelProviderPreset {
  id: string;
  name: string;
  region: ModelProviderRegion;
  baseUrl: string;
  protocol: ModelProviderProtocol;
  models: string[];
  keyUrl?: string;
  note?: string;
}

export const regionLabels: Record<ModelProviderRegion, string> = {
  cn: '国产模型',
  global: '国外模型',
  local: '本地服务',
};

export const regionOrder: ModelProviderRegion[] = ['cn', 'global', 'local'];

export const modelProviders: ModelProviderPreset[] = (catalog.providers as ModelProviderPreset[]).slice();

export function providerHost(preset: ModelProviderPreset): string {
  try { return new URL(preset.baseUrl).hostname.toLowerCase(); } catch { return ''; }
}

export function providerByHost(host: string): ModelProviderPreset | undefined {
  const target = host.toLowerCase();
  return modelProviders.find(preset => providerHost(preset) === target);
}

// 同一域名可能有多个端点（如 OpenCode 的 Go / Zen），按路径前缀取最长匹配。
export function providerByUrl(baseUrl: string): ModelProviderPreset | undefined {
  let target: URL;
  try { target = new URL(baseUrl); } catch { return undefined; }
  const host = target.hostname.toLowerCase();
  const path = target.pathname.replace(/\/+$/, '').toLowerCase();
  const scored = modelProviders
    .filter(preset => providerHost(preset) === host)
    .map(preset => ({ preset, prefix: new URL(preset.baseUrl).pathname.replace(/\/+$/, '').toLowerCase() }))
    .filter(item => path === item.prefix || path.startsWith(`${item.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return scored[0]?.preset || providerByHost(host);
}

export function groupedProviders(query = ''): { region: ModelProviderRegion; label: string; items: ModelProviderPreset[] }[] {
  const needle = query.trim().toLowerCase();
  const matched = needle
    ? modelProviders.filter(preset => `${preset.name} ${preset.baseUrl} ${preset.models.join(' ')}`.toLowerCase().includes(needle))
    : modelProviders;
  return regionOrder
    .map(region => ({ region, label: regionLabels[region], items: matched.filter(preset => preset.region === region) }))
    .filter(group => group.items.length > 0);
}

export const protocolLabel = (protocol: ModelProviderProtocol) => (protocol === 'anthropic' ? 'Messages · 文本对话' : 'Chat Completions · 文本对话');
