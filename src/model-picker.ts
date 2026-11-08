import type { ModelOption } from './types';

export const MODEL_PICKER_LIMIT = 50;

export interface ModelMatches { items: ModelOption[]; total: number }

export function filterModels(models: ModelOption[], query: string, limit = MODEL_PICKER_LIMIT): ModelMatches {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return { items: models.slice(0, limit), total: models.length };
  const ranked: { model: ModelOption; rank: number }[] = [];
  for (const model of models) {
    const id = model.id.toLowerCase();
    const name = model.name.toLowerCase();
    const rank = id === keyword || name === keyword ? 0
      : id.startsWith(keyword) || name.startsWith(keyword) ? 1
        : id.includes(keyword) || name.includes(keyword) ? 2 : -1;
    if (rank >= 0) ranked.push({ model, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.model.id.localeCompare(b.model.id));
  return { items: ranked.slice(0, limit).map(item => item.model), total: ranked.length };
}
