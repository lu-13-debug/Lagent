import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { createProviderRegistry, resolveLocalCommand, withNodeProviders } from './work/providers.js';

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

test('Provider 把运行中的 Codex 桌面版识别为桌面执行器', async () => {
  const registry = createProviderRegistry({
    env: { PATH: '', PATHEXT: '.EXE' },
    spawnImpl: fakeSpawn().spawnImpl,
    desktopProbe: async () => [{ id: '2', handle: 7, pid: 88, process: 'Codex', title: 'Codex' }],
    now: () => 1000
  });
  const rows = await registry.snapshots({ force: true });
  const desktop = rows.find(item => item.id === 'codex-desktop');
  assert.equal(desktop.installed, true);
  assert.equal(desktop.kind, 'desktop');
  assert.equal(desktop.status, 'ready');
  assert.equal(desktop.command, 'Codex');
  assert.match(desktop.message, /Codex 桌面版/);
  assert.ok(desktop.capabilities.includes('window'));
});

test('未运行 Codex 桌面版时仍按桌面类型提示，不误报为 CLI', async () => {
  const registry = createProviderRegistry({
    env: { PATH: '', PATHEXT: '.EXE' },
    spawnImpl: fakeSpawn().spawnImpl,
    desktopProbe: async () => []
  });
  const rows = await registry.snapshots({ force: true });
  const desktop = rows.find(item => item.id === 'codex-desktop');
  assert.equal(desktop.installed, false);
  assert.equal(desktop.status, 'not_installed');
  assert.equal(desktop.kind, 'desktop');
  assert.match(desktop.message, /桌面版窗口/);
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

test('云端探测结果并入本机节点 Agent：能执行的不能标成未安装', () => {
  const providers = [
    { id: 'claude-code', name: 'Claude Code CLI', executorId: 'claude-code', installed: false, status: 'not_installed' },
    { id: 'gemini', name: 'Gemini CLI', executorId: 'gemini', installed: false, status: 'not_installed' }
  ];
  const executors = [
    { id: 'claude-code', name: 'Claude Code CLI（本机）', kind: 'cli', nodeBacked: true, capabilities: [] },
    // 第二台电脑的同名 Agent 带节点前缀，探测清单里没有对应条目。
    { id: 'node-1a2b3c4d-codex', name: 'Codex CLI（本机）', kind: 'cli', nodeBacked: true, capabilities: [] },
    { id: 'analysis', name: '数据分析', kind: 'analysis', nodeBacked: false }
  ];
  const merged = withNodeProviders(providers, executors);
  const claude = merged.find(item => item.id === 'claude-code');
  assert.equal(claude.installed, true);
  assert.equal(claude.status, 'ready');
  assert.match(claude.message, /本机执行节点/);
  const codex = merged.find(item => item.id === 'node-1a2b3c4d-codex');
  assert.equal(codex.installed, true, '第二台电脑的 Agent 也要出现在列表里');
  assert.equal(codex.executorId, 'node-1a2b3c4d-codex');
  assert.equal(merged.find(item => item.id === 'gemini').installed, false, '没连上节点的 Agent 照旧是未安装');
  assert.equal(merged.filter(item => item.id === 'claude-code').length, 1, '同一个 Agent 不能出现两行');
});

test('节点本机探测到的产品并入清单：WorkBuddy 这类只识别、不给开关', () => {
  const providers = [
    { id: 'workbuddy', name: 'WorkBuddy', executorId: 'workbuddy', installed: false, status: 'not_installed' },
    { id: 'gemini', name: 'Gemini CLI', executorId: 'gemini', installed: false, status: 'not_installed' },
    { id: 'trae-agent', name: 'Trae Agent（字节）', executorId: null, installed: false, status: 'not_installed' }
  ];
  const executors = [
    { id: 'analysis', name: '数据分析', kind: 'analysis', nodeBacked: false },
    { id: 'gemini', name: 'Gemini CLI（本机）', kind: 'cli', nodeBacked: true, capabilities: [] }
  ];
  const nodes = [{
    nodeId: 'n1',
    detected: [
      { id: 'workbuddy', name: 'WorkBuddy', kind: 'desktop', version: '1.0.0', command: 'D:\\workbuddy\\WorkBuddy.exe', status: 'ready', executorId: '' },
      { id: 'trae-agent', name: 'Trae Agent（字节）', kind: 'cli', version: '0.2.0', command: 'C:\\Trae\\trae.exe', status: 'ready', executorId: '' }
    ]
  }];
  const merged = withNodeProviders(providers, executors, nodes);
  const workbuddy = merged.find(item => item.id === 'workbuddy');
  assert.equal(workbuddy.installed, true, '装了 WorkBuddy 就必须识别出来');
  assert.equal(workbuddy.executorId, null, '没有可调用适配器时不能给开关');
  assert.equal(workbuddy.kind, 'desktop');
  assert.match(workbuddy.message, /执行节点识别/);
  const trae = merged.find(item => item.id === 'trae-agent');
  assert.equal(trae.installed, true);
  assert.equal(trae.command, 'C:\\Trae\\trae.exe');
  // 节点能调起来的 CLI 仍然挂在运行中的执行器上。
  assert.equal(merged.find(item => item.id === 'gemini').executorId, 'gemini');
});
