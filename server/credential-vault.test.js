import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from './store.js';
const module = await import('./credential-vault.js').catch(() => ({}));
const masterKey = Buffer.alloc(32, 7).toString('base64');
const input = { name: '工作凭据', provider: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'responses', apiKey: 'fake-secret-key-1234' };
function setup(t) {
  assert.equal(typeof module.CredentialVault, 'function', '必须提供加密凭据库');
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-test-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, restart() { store.close(); store = new Store(dir); return store; } };
}
test('凭据密文持久保存，重启可解密且公开数据不含秘密', t => {
  const env = setup(t); const vault = new module.CredentialVault({ store: env.store, ownerId: 'alice', masterKey });
  const one = vault.create(input), two = vault.create({ ...input, apiKey: 'another-fake-key-5678' });
  assert.notEqual(one.id, two.id); assert.equal(one.keyHint, '1234'); assert.equal(one.hasKey, true);
  assert.equal(vault.decrypt(one.id), input.apiKey); assert.equal(vault.list().length, 2);
  const stored = JSON.stringify(env.store.db.prepare('SELECT body FROM config').all());
  assert.equal(stored.includes(input.apiKey), false); assert.equal(stored.includes('another-fake-key-5678'), false);
  assert.equal(JSON.stringify(vault.list()).includes('ciphertext'), false);
  const restarted = new module.CredentialVault({ store: env.restart(), ownerId: 'alice', masterKey });
  assert.equal(restarted.decrypt(one.id), input.apiKey); assert.equal(restarted.decrypt(two.id), 'another-fake-key-5678');
});
test('账号隔离、错误主密钥和认证数据修改均拒绝解密', t => {
  const env = setup(t); const vault = new module.CredentialVault({ store: env.store, ownerId: 'alice', masterKey });
  const one = vault.create(input);
  const bob = new module.CredentialVault({ store: env.store, ownerId: 'bob', masterKey });
  assert.deepEqual(bob.list(), []); assert.throws(() => bob.decrypt(one.id), /不存在|凭据/);
  const wrong = new module.CredentialVault({ store: env.store, ownerId: 'alice', masterKey: Buffer.alloc(32, 8).toString('base64') });
  assert.throws(() => wrong.decrypt(one.id), error => /无法解密/.test(error.message) && !error.message.includes(input.apiKey));
  const row = env.store.db.prepare("SELECT key,body FROM config WHERE key LIKE 'credential-vault%'").get();
  const data = JSON.parse(row.body); data[0].baseUrl = 'https://other.example/v1'; env.store.config(row.key, data);
  assert.throws(() => vault.decrypt(one.id), /无法解密/);
});
test('无主密钥禁用写入但不触碰现有密文，非法主密钥明确禁用', t => {
  const env = setup(t);
  for (const masterKey of [undefined, 'not-base64']) {
    const vault = new module.CredentialVault({ store: env.store, ownerId: 'alice', masterKey });
    assert.equal(vault.status().enabled, false); assert.match(vault.status().reason, /主密钥/);
    assert.throws(() => vault.create(input), /主密钥/); assert.deepEqual(vault.list(), []);
  }
});
test('修改接口或协议需重新输入Key，版本失效与删除即时生效', t => {
  const env = setup(t); const vault = new module.CredentialVault({ store: env.store, ownerId: 'alice', masterKey });
  const one = vault.create(input);
  assert.throws(() => vault.update(one.id, { baseUrl: 'https://other.example/v1' }), /重新.*Key/);
  assert.throws(() => vault.update(one.id, { protocol: 'chat-completions' }), /重新.*Key/);
  const next = vault.update(one.id, { baseUrl: 'https://other.example/v1', apiKey: 'new-fake-secret' });
  assert.equal(next.version, 2); assert.equal(vault.decrypt(one.id, 2), 'new-fake-secret');
  assert.throws(() => vault.decrypt(one.id, 1), /变更|版本/);
  vault.delete(one.id); assert.throws(() => vault.decrypt(one.id), /不存在/);
});
test('复制密文到另一账号或另一凭据ID会被AAD拒绝，nonce每次保存随机', t => {
  const env = setup(t); const alice = new module.CredentialVault({ store: env.store, ownerId: 'alice', masterKey });
  const one = alice.create(input), two = alice.create(input);
  const rows = env.store.config('credential-vault-v1:alice');
  assert.notEqual(rows[0].encrypted.nonce, rows[1].encrypted.nonce);
  env.store.config('credential-vault-v1:bob', [rows[0]]);
  const bob = new module.CredentialVault({ store: env.store, ownerId: 'bob', masterKey });
  assert.throws(() => bob.decrypt(one.id), /无法解密/);
  rows[1].encrypted = rows[0].encrypted; env.store.config('credential-vault-v1:alice', rows);
  assert.throws(() => alice.decrypt(two.id), /无法解密/);
});
