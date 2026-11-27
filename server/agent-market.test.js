import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { workStore } from './work/store.js';
import { createWorkProfiles } from './work/profiles.js';
import { createAgentMarket } from './work/agent-market.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-market-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const profiles = createWorkProfiles(workStore(store, () => {}), { store });
  const market = createAgentMarket({ store, profiles, listExecutors: () => ['model', 'claude-code'] });
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
