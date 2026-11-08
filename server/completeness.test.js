import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from './analytics.js';
import { createDataset, publicDataset } from './datasets.js';
const now = new Date('2026-10-10T00:00:00Z');
const records = () => ({ users: [1,2,3].map(n => ({ user_id: String(n), registered_at: `2026-10-0${n}`, channel: '自然' })), activity: [1,2,3].flatMap(n => Array.from({length:n}, (_,i) => ({user_id:String(i+1), event_time:`2026-10-0${n}`}))), payments: [1,2,3].map(n => ({order_id:String(n), user_id:String(n), paid_at:`2026-10-0${n}`, amount:10, currency:'CNY', status:'success'})) });
const dataset = declared => createDataset(records(), { now, completeness: { declared } });
test('partial excludes boundary dates, money and cohorts and hides every change', () => {
 const r = analyze(dataset('partial'), {now});
 assert.ok(r.metrics.every(m => m.change === null));
 assert.ok(!r.daily.some(d => d.date === '2026-10-03'));
 assert.equal(r.metrics.find(m => m.id === 'revenue').value,20);
 assert.ok(!r.retention.some(d => d.date === '2026-10-03'));
 assert.match(r.quality.issues.join(' '), /数据为分片，边界日已排除/);
 assert.match(r.methodology.join(' '), /分片/);
 assert.deepEqual(r.dataCompleteness.affectedDates,['2026-10-03']);
});
test('unknown and legacy keep boundary but hide comparisons and explain why', () => {
 for (const d of [dataset('unknown'), {name:'历史',records:records()}]) {
 const r = analyze(d,{now});
 assert.ok(r.metrics.every(m => m.change === null));
 assert.ok(r.daily.some(day => day.date === '2026-10-03'));
 assert.match(r.quality.issues.join(' '),/数据完整性未声明，已隐藏环比比较/);
 assert.match(r.methodology.join(' '), /完整性未验证/);
 assert.equal(publicDataset(d).completeness.declared,'unknown');
 }
});
test('full preserves numerical behavior including DAU day-over-day', () => {
 const r = analyze(dataset('full'), {now});
 assert.equal(r.metrics.find(m => m.id === 'dau').change,50);
 assert.equal(r.metrics.find(m => m.id === 'revenue').value,30);
 assert.equal(r.daily.length,3);
});
import { normalizeCompleteness } from './completeness.js';
import { parseFiles } from './datasets.js';
import { computeExploration } from './report-explore.js';
test('declarations validate input and ignore forged source/time', () => {
 assert.throws(() => normalizeCompleteness('{', {strict:true}));
 assert.throws(() => normalizeCompleteness({declared:'bad'}, {strict:true}));
 const c = normalizeCompleteness({declared:'partial',source:'default',declaredAt:'1900-01-01',shardNote:'1/68'}, {strict:true,now});
 assert.equal(c.source,'user'); assert.equal(c.declaredAt,now.toISOString()); assert.equal(c.shardNote,'1/68');
});
test('upload parsing persists declaration and defaults undeclared uploads to unknown', async () => {
 const files = [{originalname:'activity.csv',buffer:Buffer.from('user_id,event_time\na,2026-10-01\nb,2026-10-02')}];
 assert.equal((await parseFiles(files)).completeness.declared,'unknown');
 const d = await parseFiles(files,{completeness:JSON.stringify({declared:'partial',shardNote:'1/68'})});
 assert.equal(d.completeness.declared,'partial'); assert.equal(d.completeness.source,'user');
 assert.equal(publicDataset(d).completeness.shardNote,'1/68');
});
test('period exploration hides every comparison for unknown and partial', () => {
 for (const declared of ['unknown','partial']) {
 const d = dataset(declared);
 const task = {status:'completed',title:'test',report:analyze(d,{now})};
 const result = computeExploration(d,task,{start:'2026-10-02',end:'2026-10-02',comparePrevious:true});
 assert.ok(result.comparison.metrics.every(m => !m.comparable && m.absoluteChange === null && m.percentChange === null));
 }
});
import { createApp } from './app.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('HTTP upload and declaration persist, legacy reads work, invalid declarations return 400', async t => {
 const dir = await mkdtemp(path.join(os.tmpdir(),'completeness-'));
 const app = createApp({dataDir:dir}); const server = app.listen(0,'127.0.0.1');
 await new Promise(resolve => server.once('listening',resolve));
 t.after(async () => { await new Promise(resolve=>server.close(resolve)); app.locals.close(); await rm(dir,{recursive:true,force:true}); });
 const base = `http://127.0.0.1:${server.address().port}`;
 const form = new FormData(); form.append('files',new Blob(['user_id,event_time\na,2026-10-01\nb,2026-10-02']),'activity.csv');
 form.append('completeness',JSON.stringify({declared:'partial',shardNote:'1/68'}));
 const upload = await fetch(base+'/api/datasets/upload',{method:'POST',body:form}); assert.equal(upload.status,201);
 const {dataset:d} = await upload.json(); assert.equal(d.completeness.declared,'partial'); assert.equal(d.completeness.shardNote,'1/68');
 const url = base+`/api/datasets/${d.id}/completeness`;
 assert.equal((await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({declared:'bad'})})).status,400);
 const response = await fetch(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({declared:'full'})}); assert.equal(response.status,200);
 assert.equal((await response.json()).dataset.completeness.source,'user');
 assert.equal((await (await fetch(base+`/api/datasets/${d.id}`)).json()).dataset.completeness.declared,'full');
});
test('partial report period never includes the excluded boundary day', () => {
 const r = analyze(dataset('partial'), { now });
 assert.equal(r.daily.at(-1).date, '2026-10-02');
 assert.equal(r.period, `2026-10-01 至 ${r.daily.at(-1).date}`);
 assert.equal(r.summary.includes('2026-10-03'), false);
});
test('partial data with only boundary days is rejected with an actionable message', () => {
 const single = createDataset({ activity: [{ user_id: 'a', event_time: '2026-10-09' }] }, { now, completeness: { declared: 'partial' } });
 assert.throws(() => analyze(single, { now }), /分片声明排除了各表边界日期后没有可分析的数据/);
});
test('exploration rejects dates beyond the shard boundary and reports adjusted coverage', () => {
 const d = dataset('partial');
 const task = { status: 'completed', title: '测试', report: analyze(d, { now }) };
 assert.throws(() => computeExploration(d, task, { start: '2026-10-03', end: '2026-10-03' }), /分片数据仅可探索至 2026-10-02/);
 const result = computeExploration(d, task, { start: '2026-10-02', end: '2026-10-02' });
 assert.equal(result.scope.coverage.activity.end, '2026-10-02');
});
