import copy from '../src/completeness-copy.json' with { type: 'json' };
export { copy as completenessCopy };
export function normalizeCompleteness(input, { now = new Date(), legacyAt, strict = false } = {}) {
 if (typeof input === 'string') { try { input = JSON.parse(input); } catch { if (strict) throw new Error('completeness 须为有效 JSON 对象'); input = undefined; } }
 const valid = input && typeof input === 'object' && !Array.isArray(input) && ['full','partial','unknown'].includes(input.declared);
 if (strict && input !== undefined && !valid) throw new Error('完整性声明须为 full、partial 或 unknown');
 if (strict && input?.shardNote !== undefined && (typeof input.shardNote !== 'string' || input.shardNote.length > 1000)) throw new Error('分片说明须为不超过 1000 字的文本');
 return { declared: valid ? input.declared : 'unknown', source: strict && valid ? 'user' : valid && input.source === 'user' ? 'user' : 'default', ...(valid && typeof input.shardNote === 'string' ? { shardNote: input.shardNote.trim().slice(0,1000) } : {}), declaredAt: !strict && valid && Number.isFinite(Date.parse(input.declaredAt)) ? input.declaredAt : new Date(legacyAt || now).toISOString() };
}
