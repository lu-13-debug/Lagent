import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localCredentialKey, credentialKeyPath } from './local-key.js';
import { CredentialVault } from './credential-vault.js';
import { Store } from './store.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'datagent-key-'));

test('本机密钥是 32 字节 base64，重复调用保持同一把', () => {
  const home = dir();
  const key = localCredentialKey(home);
  assert.match(key, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(key, 'base64').length, 32);
  assert.equal(localCredentialKey(home), key, '第二次调用必须读回同一把密钥');
  assert.equal(readFileSync(credentialKeyPath(home), 'utf8').trim(), key);
  if (process.platform !== 'win32') assert.equal(statSync(credentialKeyPath(home)).mode & 0o777, 0o600);
});

test('损坏的密钥文件会被替换成新的有效密钥', () => {
  const home = dir();
  const first = localCredentialKey(home);
  writeFileSync(credentialKeyPath(home), 'not-a-key\n');
  const second = localCredentialKey(home);
  assert.match(second, /^[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(second, first);
});

test('生成的密钥能直接启用凭据库并完成加解密', () => {
  const home = dir();
  const store = new Store(path.join(home, 'data'));
  const vault = new CredentialVault({ store, ownerId: 'local', masterKey: localCredentialKey(home) });
  assert.equal(vault.status().available, true);
  assert.equal(vault.status().reason, null);
  const saved = vault.create({ name: '工作账号', provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', protocol: 'chat-completions', apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' });
  assert.equal(vault.decrypt(saved.id), 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789');
});
