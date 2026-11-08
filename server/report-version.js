import { createHash } from 'node:crypto';
export function reportContentHash(report) {
  const { pdf, qualityReceipts, ...content } = report || {};
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return createHash('sha256').update(JSON.stringify(stable(content))).digest('hex');
}
