import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { createBackupService } from './work/backup.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-work-backup-'));
  const store = new Store(dir);
  const engine = {
    policy: () => ({ mode: 'personal', acceptMode: 'explicit', permission: 'workspace' }),
    profilesActive: () => ({ effective: null })
  };
  const backup = createBackupService({ store, engine, dataDir: dir, version: 'test' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, backup };
}

test('加密备份：口令校验、错误口令拒绝、往返恢复', async t => {
  const { store, backup } = fixture(t);
  store.config('backup-marker', { hello: '世界' });
  await assert.rejects(backup.exportBundle({ passphrase: 'short' }), { status: 400 });
  await assert.rejects(backup.exportBundle({}), { status: 400 });

  const bundle = await backup.exportBundle({ passphrase: 'correct horse battery' });
  assert.match(bundle.filename, /^lagent-backup-.*\.lagentbackup$/);
  assert.equal(bundle.bytes.subarray(0, 15).toString(), 'LAGENT-BACKUP-1');
  assert.ok(bundle.size > 100);
  assert.doesNotMatch(bundle.bytes.toString('utf8'), /backup-marker|世界/);

  await assert.rejects(backup.restoreBundle(bundle.bytes, { passphrase: 'wrong passphrase' }), { status: 400, message: '备份口令错误，或备份文件已损坏' });
  assert.deepEqual(store.config('backup-marker'), { hello: '世界' });

  store.config('backup-marker', { changed: true });
  const restored = await backup.restoreBundle(bundle.bytes, { passphrase: 'correct horse battery' });
  assert.equal(restored.restoredAt.length, 24);
  assert.deepEqual(store.config('backup-marker'), { hello: '世界' });
  const log = backup.listBackups();
  assert.equal(log[0].kind, 'restore');
  assert.equal(log[1].kind, 'export');
});

test('加密备份：可排除凭据密文，诊断包不包含密钥值', async t => {
  const { store, backup } = fixture(t);
  store.config('credential-vault-v1:default', { ciphertext: 'vault-ciphertext', wrapped: 'wrapped-key' });
  store.config('theme', 'dark');
  const noCredentials = await backup.exportBundle({ passphrase: 'correct horse battery', includeCredentials: false });
  store.config('credential-vault-v1:default', { ciphertext: 'changed' });
  await backup.restoreBundle(noCredentials.bytes, { passphrase: 'correct horse battery' });
  assert.equal(store.config('credential-vault-v1:default'), null);
  assert.equal(store.config('theme'), 'dark');

  store.config('credential-vault-v1:default', { ciphertext: 'vault-ciphertext' });
  const withCredentials = await backup.exportBundle({ passphrase: 'correct horse battery' });
  await backup.restoreBundle(withCredentials.bytes, { passphrase: 'correct horse battery' });
  assert.equal(store.config('credential-vault-v1:default').ciphertext, 'vault-ciphertext');

  process.env.LAGENT_TEST_DIAGNOSTIC_TOKEN = 'do-not-leak-this-value';
  t.after(() => { delete process.env.LAGENT_TEST_DIAGNOSTIC_TOKEN; });
  const diagnostics = backup.diagnostics();
  const serialized = JSON.stringify(diagnostics);
  assert.doesNotMatch(serialized, /do-not-leak-this-value/);
  assert.ok(diagnostics.environment.includes('LAGENT_TEST_DIAGNOSTIC_TOKEN'));
  assert.equal(diagnostics.app.version, 'test');
  assert.equal(diagnostics.data.bytes > 0, true);
  assert.equal(diagnostics.policy.permission, 'workspace');
  assert.doesNotMatch(serialized, /vault-ciphertext|wrapped-key/);
});

test('加密备份：拒绝损坏文件与伪 SQLite 内容', async t => {
  const { backup } = fixture(t);
  await assert.rejects(backup.restoreBundle(Buffer.from('not a backup'), { passphrase: 'correct horse battery' }), { status: 400 });
  await assert.rejects(backup.restoreBundle(Buffer.alloc(0), { passphrase: 'correct horse battery' }), { status: 400 });
  // 用合法格式包住一段非 SQLite 内容：解密成功但内容校验失败。
  const bundle = await backup.exportBundle({ passphrase: 'correct horse battery' });
  const text = bundle.bytes.toString('utf8');
  const lines = text.split('\n');
  const pasted = `${lines[0]}\n${lines[1]}\n${Buffer.from('not sqlite').toString('base64')}`;
  await assert.rejects(backup.restoreBundle(Buffer.from(pasted), { passphrase: 'correct horse battery' }), { status: 400 });
});
