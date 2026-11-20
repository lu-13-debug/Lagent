import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { CredentialVault } from './credential-vault.js';
import { createProviderPool } from './provider-pool.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-pool-'));
  const store = new Store(dir);
  let time = Date.parse('2026-11-14T08:00:00.000Z');
  const vault = new CredentialVault({ store, ownerId: 'alice', masterKey: Buffer.alloc(32, 7) });
  const pool = createProviderPool({ store, vault, ownerId: 'alice', now: () => time });
  const make = name => vault.create({ name, provider: 'OpenAI 兼容', baseUrl: 'https://api.example.com/v1', protocol: 'chat-completions', apiKey: `${name}-${'x'.repeat(20)}` });
  const a = make('key-a');
  const b = make('key-b');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, vault, pool, a, b, advance: ms => { time += ms; }, now: () => time };
}

const response = status => new Response('', { status });

test('Key 池要求成员接口一致，并可保存权重、优先级与配额', t => {
  const f = fixture(t);
  const other = f.vault.create({ name: 'key-c', provider: 'Anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic', apiKey: 'y'.repeat(24) });
  assert.throws(() => f.pool.save({ name: '混合池', members: [f.a.id, other.id] }), { message: /相同的提供商/ });
  const saved = f.pool.save({
    name: '主池', strategy: 'priority', maxAttempts: 3,
    members: [{ credentialId: f.a.id, priority: 2, weight: 1, dailyCalls: 10, costPer1k: 0.01 }, { credentialId: f.b.id, priority: 1, weight: 3, dailyCalls: 0, costPer1k: 0.02 }]
  });
  assert.equal(saved.members.length, 2);
  assert.equal(saved.provider, 'OpenAI 兼容');
  assert.equal(saved.version, 1);
  assert.equal(f.pool.list().length, 1);
});

test('按优先级选 Key，429 后换 Key 并进入冷却', async t => {
  const f = fixture(t);
  const saved = f.pool.save({ name: '主池', strategy: 'priority', cooldownMs: 60000, maxAttempts: 3, members: [{ credentialId: f.a.id, priority: 2 }, { credentialId: f.b.id, priority: 1 }] });
  const tried = [];
  const result = await f.pool.execute(saved.id, async ({ key }) => {
    tried.push(key);
    return tried.length === 1 ? response(429) : response(200);
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.result.status, 200);
  assert.equal(tried[0], f.vault.decrypt(f.b.id));
  assert.equal(tried[1], f.vault.decrypt(f.a.id));
  const routes = f.store.list('model-route');
  assert.equal(routes.length, 2);
  assert.equal(routes[0].credentialId, f.a.id);
  assert.equal(routes[0].ok, true);
  assert.equal(routes[1].status, 429);
  const routing = f.pool.explain(saved.id);
  assert.equal(routing.members.find(row => row.credentialId === f.b.id).status, 'cooling');
  assert.equal(routing.ready, 1);
  // 冷却结束后恢复。
  f.advance(61_000);
  assert.equal(f.pool.explain(saved.id).members.find(row => row.credentialId === f.b.id).status, 'ready');
});

test('401 隔离 Key，400 不切换', async t => {
  const f = fixture(t);
  const saved = f.pool.save({ name: '主池', strategy: 'priority', maxAttempts: 3, members: [{ credentialId: f.a.id, priority: 1 }, { credentialId: f.b.id, priority: 2 }] });
  let calls = 0;
  const result = await f.pool.execute(saved.id, async () => { calls++; return calls === 1 ? response(401) : response(200); });
  assert.equal(result.attempts, 2);
  assert.equal(result.result.status, 200);
  assert.equal(f.pool.explain(saved.id).members.find(row => row.credentialId === f.a.id).status, 'cooling');

  const saved2 = f.pool.save({ name: '主池2', strategy: 'priority', maxAttempts: 3, members: [f.a.id, f.b.id] });
  let calls2 = 0;
  await assert.rejects(f.pool.execute(saved2.id, async () => { calls2++; return response(400); }), { status: 400 });
  assert.equal(calls2, 1);
});

test('每日配额耗尽后跳过该 Key，全部耗尽时报 429', async t => {
  const f = fixture(t);
  const saved = f.pool.save({ name: '配额池', strategy: 'priority', maxAttempts: 3, members: [{ credentialId: f.a.id, priority: 1, dailyCalls: 1 }, { credentialId: f.b.id, priority: 2, dailyCalls: 1 }] });
  assert.equal((await f.pool.execute(saved.id, async () => response(200))).attempts, 1);
  assert.equal((await f.pool.execute(saved.id, async () => response(200))).attempts, 1);
  await assert.rejects(f.pool.execute(saved.id, async () => response(200)), { status: 429 });
});

test('每日配额跨重启累计，跨天自动清零', async t => {
  const f = fixture(t);
  const saved = f.pool.save({ name: '配额池', strategy: 'priority', maxAttempts: 1, members: [{ credentialId: f.a.id, priority: 1, dailyCalls: 2 }] });
  assert.equal((await f.pool.execute(saved.id, async () => response(200))).attempts, 1);

  // 模拟进程重启：新的池实例仍应看到今天已用掉的 1 次配额。
  const restarted = createProviderPool({ store: f.store, vault: f.vault, ownerId: 'alice', now: f.now });
  assert.equal(restarted.explain(saved.id).members[0].usedToday, 1);
  assert.equal((await restarted.execute(saved.id, async () => response(200))).attempts, 1);
  await assert.rejects(restarted.execute(saved.id, async () => response(200)), { status: 429 });

  // 跨天后重新计数。
  const nextDay = createProviderPool({ store: f.store, vault: f.vault, ownerId: 'alice', now: () => f.now() + 24 * 60 * 60 * 1000 });
  assert.equal(nextDay.explain(saved.id).members[0].usedToday, 0);
  assert.equal((await nextDay.execute(saved.id, async () => response(200))).attempts, 1);
});

test('缓存亲和优先复用上次成功的 Key，cheapest 选择成本最低', async t => {
  const f = fixture(t);
  const saved = f.pool.save({ name: '亲和张', strategy: 'round-robin', maxAttempts: 2, members: [{ credentialId: f.a.id, weight: 1, costPer1k: 0.03 }, { credentialId: f.b.id, weight: 1, costPer1k: 0.01 }] });
  const first = await f.pool.execute(saved.id, async () => response(200), { affinity: 'session-1' });
  const second = await f.pool.execute(saved.id, async () => response(200), { affinity: 'session-1' });
  assert.equal(first.lease.credentialId, second.lease.credentialId);
  assert.equal(second.lease.reason, '复用缓存亲和 Key');

  const cheap = f.pool.save({ id: saved.id, strategy: 'cheapest', members: saved.members });
  const leased = await f.pool.execute(cheap.id, async () => response(200));
  assert.equal(leased.lease.credentialId, f.b.id);
  assert.equal(leased.lease.reason, '按每千 Token 成本选择');
  assert.equal(f.pool.explain(cheap.id).reason, '在可用 Key 中选择每千 Token 成本最低的');
});
