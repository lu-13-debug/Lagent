import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { workStore } from './work/store.js';
import { createWorkProfiles } from './work/profiles.js';
import { createAgentMarket } from './work/agent-market.js';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-market-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const profiles = createWorkProfiles(workStore(store, () => {}), { store });
  const market = createAgentMarket({ store, profiles, listExecutors: () => ['model', 'claude-code'], ...options });
  return { store, profiles, market };
}

test('Agent 市场：内置清单安装成配置档', t => {
  const { profiles, market } = fixture(t);
  const listings = market.list();
  assert.ok(listings.length >= 5);
  assert.equal(listings.every(item => item.builtin && !item.installed), true);

  const result = market.install('builtin:code-review');
  assert.equal(result.profile.name, '代码审查');
  assert.equal(result.profile.settings.permission, 'read');
  assert.equal(result.profile.library.instructions.length, 3);
  assert.equal(profiles.list().length, 1);
  assert.equal(market.list().find(item => item.id === 'builtin:code-review').installed, true);

  assert.throws(() => market.install('builtin:code-review'), /已存在/);
});

test('Agent 市场：自定义配置可发布、安装、删除，执行器需可用', t => {
  const { market } = fixture(t);
  const listing = market.publish({
    name: '夜间巡检', description: '每天检查一次', executorId: 'model',
    permission: 'read', instructions: ['只看不改'], skills: ['release-notes']
  });
  assert.equal(listing.builtin, false);
  assert.equal(market.list().some(item => item.id === listing.id), true);

  const installed = market.install(listing.id);
  assert.equal(installed.profile.name, '夜间巡检');
  assert.deepEqual(installed.profile.library.skills, ['release-notes']);

  assert.throws(() => market.publish({ name: '代码审查', executorId: 'model' }), /重复/);
  assert.throws(() => market.publish({ name: '坏配置', executorId: 'not-installed' }), /执行器不可用/);

  market.remove(listing.id);
  assert.equal(market.list().some(item => item.id === listing.id), false);
  assert.throws(() => market.remove('builtin:code-review'), /只能删除自己发布的配置/);
});

test('Agent 市场：远程静态清单可列出并安装，导出清单不含本机信息', async t => {
  const remoteRows = [{
    id: 'team:audit', name: '团队审计', description: '只读审计当前改动',
    executorId: 'model', permission: 'read', instructions: ['只看不改', '按风险排序'], skills: ['release-notes']
  }];
  const fetchImpl = async url => {
    assert.match(String(url), /^https:\/\/example\.com\/market\.json$/);
    return { ok: true, json: async () => ({ version: 1, listings: remoteRows }) };
  };
  const { store, market } = fixture(t, { remoteUrl: 'https://example.com/market.json', fetchImpl });
  assert.equal(market.remoteConfigured(), true);

  const remote = await market.remoteList();
  assert.equal(remote.configured, true);
  assert.equal(remote.listings.length, 1);
  assert.equal(remote.listings[0].id, 'remote:team:audit');
  assert.equal(remote.listings[0].remote, true);
  assert.equal(remote.listings[0].permission, 'read');

  const installed = await market.installAny('remote:team:audit');
  assert.equal(installed.profile.name, '团队审计');
  assert.deepEqual(installed.profile.library.skills, ['release-notes']);
  assert.equal(market.list().filter(item => !item.builtin).length, 0, '远程配置不会自动变成本地发布项');
  assert.equal((await market.remoteList()).listings[0].installed, true);

  const manifest = market.manifest();
  assert.equal(manifest.version, 1);
  assert.equal(JSON.stringify(manifest).includes('example.com'), false);
  assert.equal(store.list('agent-listing').length, 0);
  assert.throws(() => market.remove('remote:team:audit'), /只能删除自己发布的配置/);
});

test('Agent 市场：远程不可用时只报错，不影响本地安装', async t => {
  const offline = fixture(t, {
    remoteUrl: 'http://plain.example.com/market.json',
    fetchImpl: async () => { throw new Error('network down'); }
  });
  assert.equal(offline.market.remoteConfigured(), false, '默认只允许 https');

  const online = fixture(t, {
    remoteUrl: 'https://example.com/market.json',
    fetchImpl: async () => { throw new Error('network down'); }
  });
  const result = await online.market.remoteList();
  assert.equal(result.configured, true);
  assert.match(result.error, /network down/);
  assert.equal(online.market.install('builtin:code-review').profile.name, '代码审查');
  await assert.rejects(() => online.market.installAny('remote:missing'), /远程市场读取失败/);
});
