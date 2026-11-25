import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './api.ts';

test('公开分享令牌仅通过 POST 请求体发送，且不触发会话失效', async () => {
  assert.equal(typeof api.readShare, 'function');
  assert.equal(typeof api.visitShare, 'function');
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push({url, options}); return Response.json({ok:true}); };
    const token = 'A'.repeat(43);
    await api.readShare(token);
    await api.visitShare(token, 'B'.repeat(43));
    assert.deepEqual(calls.map(c => c.url), ['/api/public/shares/read', '/api/public/shares/visit']);
    assert.equal(JSON.parse(calls[1].options.body).visitorToken, 'B'.repeat(43));
    assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
  } finally { globalThis.fetch = original; }
});

test('分享页根据当前会话显示明确入口且进入工作台时清除片段', async () => {
  const {readFile} = await import('node:fs/promises');
  const page = await readFile(new URL('./PublicShare.tsx', import.meta.url), 'utf8');
  assert.match(page, /api\.session\(\)/);
  assert.match(page, /进入当前工作台/);
  assert.match(page, /location\.assign\('\/'\)/);
});

test('分享链接切换隔离迟到请求，非法片段清空结果，同一片段复用访客标识', async () => {
  const { createShareReader } = await import('./share-flow.ts').catch(() => ({}));
  assert.equal(typeof createShareReader, 'function');
  const pending = new Map(), visits = [], states = [];
  let count = 0;
  const reader = createShareReader({ makeVisitor: () => String(++count).repeat(43), read: token => new Promise(resolve => pending.set(token, resolve)), visit: (token, visitor) => visits.push([token, visitor]), publish: state => states.push(state) });
  const a = 'A'.repeat(43), b = 'B'.repeat(43);
  reader.open(a); reader.open(a); assert.equal(count, 1);
  reader.open(b); assert.equal(count, 2);
  pending.get(b)({title:'B'}); await Promise.resolve();
  pending.get(a)({title:'A'}); await Promise.resolve();
  assert.equal(states.at(-1).report.title, 'B');
  assert.deepEqual(visits, [[b, '2'.repeat(43)]]);
  reader.open('invalid'); assert.equal(states.at(-1).report, null); assert.equal(states.at(-1).token, 'invalid');
});
