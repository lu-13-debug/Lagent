import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWindowBridge } from './window-bridge.js';

function fakeSpawn(output, { code = 0, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    if (!hang) queueMicrotask(() => {
      if (output !== undefined) child.stdout.emit('data', Buffer.from(typeof output === 'string' ? output : JSON.stringify(output)));
      child.emit('close', code);
    });
    return child;
  };
  return { spawnImpl, calls };
}

function sequencedSpawn(outputs) {
  let index = 0;
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const output = outputs[Math.min(index++, outputs.length - 1)];
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(typeof output === 'string' ? output : JSON.stringify(output)));
      child.emit('close', 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

test('窗口桥列出并清洗允许窗口', async () => {
  const fake = fakeSpawn([{ pid: 12, process: 'Codex', title: 'Codex\n窗口', handle: 42 }, { pid: 0, process: '', title: '', handle: 0 }]);
  const bridge = createWindowBridge({ spawnImpl: fake.spawnImpl, scriptPath: 'C:\\bridge.ps1', timeoutMs: 1000 });
  const windows = await bridge.listWindows();
  assert.deepEqual(windows, [{ id: '42', handle: 42, pid: 12, process: 'Codex', title: 'Codex 窗口' }]);
  assert.equal(fake.calls[0].command, 'powershell.exe');
  assert.ok(fake.calls[0].args.includes('-Allow'));
  assert.ok(fake.calls[0].args.join(' ').includes('codex'));
  assert.equal(JSON.stringify(windows).includes('bridge.ps1'), false);
});

test('窗口桥发送与读取校验参数并解析结果', async () => {
  const sent = fakeSpawn({ ok: true, process: 'Codex', submitted: true });
  const bridge = createWindowBridge({ spawnImpl: sent.spawnImpl, scriptPath: 'C:\\bridge.ps1' });
  await assert.rejects(() => bridge.sendToWindow(0, 'hello'), { status: 400 });
  await assert.rejects(() => bridge.sendToWindow(42, '   '), { status: 400 });
  const result = await bridge.sendToWindow(42, '继续处理', { submit: true });
  assert.deepEqual(result, { ok: true, process: 'Codex', submitted: true, handle: 42, relocated: false });
  const args = sent.calls[0].args;
  assert.ok(args.includes('-Handle') && args.includes('42'));
  assert.ok(args.includes('-Text') && args.includes('继续处理'));
  assert.ok(args.includes('-Submit'));

  const read = fakeSpawn({ text: '终端输出' });
  const reader = createWindowBridge({ spawnImpl: read.spawnImpl, scriptPath: 'C:\\bridge.ps1' });
  assert.deepEqual(await reader.readWindow(42), { text: '终端输出', handle: 42, relocated: false });
});

test('窗口句柄漂移时按进程与标题刷新并重试一次', async () => {
  const seq = sequencedSpawn([
    { ok: false, error: { code: 'window_not_found' } },
    [{ handle: 99, pid: 5, process: 'Codex', title: 'Codex 窗口' }],
    { ok: true, process: 'Codex', submitted: true }
  ]);
  const bridge = createWindowBridge({ spawnImpl: seq.spawnImpl, scriptPath: 'C:\\bridge.ps1' });
  const result = await bridge.sendToWindow(42, '继续', { submit: true, process: 'Codex', title: 'Codex 窗口' });
  assert.deepEqual(result, { ok: true, process: 'Codex', submitted: true, handle: 99, relocated: true });
  assert.ok(seq.calls[2].args.includes('99'));

  const ambiguous = sequencedSpawn([
    { ok: false, error: { code: 'window_not_found' } },
    [{ handle: 7, pid: 5, process: 'Codex', title: 'A' }, { handle: 8, pid: 6, process: 'Codex', title: 'B' }]
  ]);
  const ambiguousBridge = createWindowBridge({ spawnImpl: ambiguous.spawnImpl, scriptPath: 'C:\\bridge.ps1' });
  await assert.rejects(() => ambiguousBridge.sendToWindow(42, '继续', { submit: true, process: 'Codex' }), { status: 404 });
});

test('窗口桥拒绝坏 JSON、超时与非零退出', async () => {
  const bad = createWindowBridge({ spawnImpl: fakeSpawn('not json').spawnImpl, scriptPath: 'C:\\bridge.ps1' });
  await assert.rejects(() => bad.listWindows(), { status: 502 });
  const failed = createWindowBridge({ spawnImpl: fakeSpawn('', { code: 1 }).spawnImpl, scriptPath: 'C:\\bridge.ps1' });
  await assert.rejects(() => failed.listWindows(), { status: 502 });
  const hang = createWindowBridge({ spawnImpl: fakeSpawn('', { hang: true }).spawnImpl, scriptPath: 'C:\\bridge.ps1', timeoutMs: 20 });
  await assert.rejects(() => hang.listWindows(), { status: 504 });
});
