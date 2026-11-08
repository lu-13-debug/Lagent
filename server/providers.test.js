import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createProviderRegistry, resolveLocalCommand } from './work/providers.js';

function fakeSpawn(version = '1.2.3') {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (args.includes('--version')) child.stdout.emit('data', Buffer.from(`tool ${version}`));
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('Provider 按 PATH、PATHEXT 解析 Windows 命令', t => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'agent.CMD'), '');
  const resolved = resolveLocalCommand('agent', { PATH: dir, PATHEXT: '.EXE;.CMD' });
  assert.equal(resolved.command.toLowerCase(), join(dir, 'agent.CMD').toLowerCase());
  assert.equal(resolved.shell, true);
  assert.equal(resolveLocalCommand('missing', { PATH: dir, PATHEXT: '.EXE;.CMD' }), null);
});

test('Provider 解析 npm 垫片里的 node 入口，绕开 cmd 代码页问题', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, 'node_modules', '@scope', 'pkg', 'dist', 'cli.js');
  mkdirSync(join(entry, '..'), { recursive: true });
  writeFileSync(entry, '');
  writeFileSync(join(dir, 'agent.CMD'), '@ECHO off\r\nendLocal & "%_prog%" "%dp0%\\node_modules\\@scope\\pkg\\dist\\cli.js" %*\r\n');
  const resolved = resolveLocalCommand('agent', { PATH: dir, PATHEXT: '.CMD' });
  assert.equal(resolved.shell, false);
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.args, [entry]);
  assert.ok(resolved.via.toLowerCase().endsWith('agent.cmd'));
});

test('Provider 把运行中的桌面版 DeepSeek Harness 识别为已安装', async () => {
  const registry = createProviderRegistry({
    env: { PATH: '', PATHEXT: '.EXE' },
    spawnImpl: fakeSpawn().spawnImpl,
    desktopProbe: async () => [{ id: '1', handle: 1, pid: 42, process: 'DeepSeek Harness', title: 'DSH' }],
    now: () => 1000
  });
  const rows = await registry.snapshots({ force: true });
  const dsh = rows.find(item => item.id === 'dsh');
  assert.equal(dsh.installed, true);
  assert.equal(dsh.status, 'ready');
  assert.equal(dsh.kind, 'desktop');
  assert.equal(dsh.command, 'DeepSeek Harness');
  assert.match(dsh.message, /桌面版/);
  const acp = rows.find(item => item.id === 'dsh-acp');
  assert.equal(acp.installed, false);
  assert.equal(acp.status, 'not_installed');
  assert.match(acp.message, /已检出桌面版/);
  assert.doesNotMatch(acp.message, /undefined/);
});

test('Provider 忽略桌面探测失败，其余探测保持正常', async () => {
  const registry = createProviderRegistry({
    env: { PATH: '', PATHEXT: '.EXE' },
    spawnImpl: fakeSpawn().spawnImpl,
    desktopProbe: async () => { throw new Error('窗口桥不可用'); }
  });
  const rows = await registry.snapshots({ force: true });
  const dsh = rows.find(item => item.id === 'dsh');
  assert.equal(dsh.installed, false);
  assert.equal(dsh.status, 'not_installed');
});

test('Provider 探测版本、登录状态并缓存', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'dsh.exe'), '');
  const fake = fakeSpawn('9.8.7');
  let clock = 1000;
  const registry = createProviderRegistry({ env: { PATH: dir, PATHEXT: '.EXE' }, spawnImpl: fake.spawnImpl, now: () => clock });
  const first = await registry.snapshots({ force: true });
  const dsh = first.find(item => item.id === 'dsh');
  assert.equal(dsh.installed, true);
  assert.equal(dsh.version, '9.8.7');
  assert.equal(dsh.status, 'ready');
  const callCount = fake.calls.length;
  clock += 1000;
  await registry.snapshots();
  assert.equal(fake.calls.length, callCount);
  await registry.snapshots({ force: true });
  assert.ok(fake.calls.length > callCount);
});
