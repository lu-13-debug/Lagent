import { createHash } from 'node:crypto';
function canonical(value) { if(Array.isArray(value)) return value.map(canonical); if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])); return value; }
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function buildProvenance(dataset = {}) {
 const mappings=(dataset.inspection?.mappings || dataset.mappings || []).map(m=>Object.fromEntries(['table','source','field','sourceColumn','origin','required'].filter(k=>m[k]!==undefined).map(k=>[k,m[k]])));
 const tables=Object.entries(dataset.records || {}).map(([name,rows])=>({name,rowCount:rows.length}));
 if(!tables.length) for(const table of dataset.tables || []) tables.push({name:table.type || table.name,rowCount:table.rowCount || 0});
 const manifest=(dataset.shardManifest || []).map(s=>({name:s.source,table:s.table,rowCount:s.rowCount,start:s.start || null,end:s.end || null}));
 const files=manifest.length ? manifest : [...new Set(mappings.map(m=>m.source).filter(Boolean))].map(name=>({name}));
 const result={version:1,source:dataset.source || 'unknown',demo:dataset.source==='demo',domain:dataset.domain || 'game',files,tables,rowCount:tables.reduce((n,t)=>n+t.rowCount,0),mappings,completeness:dataset.completeness?.declared || 'unknown',timezone:dataset.timezone?.name || null};
 return {...result,hash:hash({metadata:result,records:dataset.records || null})};
}
