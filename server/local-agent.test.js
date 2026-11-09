import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import {
  LOCAL_AGENT_IDS,
  LOCAL_AGENT_PROFILES,
  localAgentExecutor,
  localAgentExecutors,
  parseTextOutput
} from './work/executors/local-agent.js';

async function waitFor(predicate, message = '等待条件超时', timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-local-agent-'));
  const binary = join(dir, 'fake-agent.exe');
  writeFileSync(binary, '');
  if (process.platform !== 'win32') chmodSync(binary, 0o755);
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, binary, store };
}

function fakeChild({ chunks = [], stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit('close', null, 'SIGTERM')); return true; };
  queueMicrotask(() => {
    for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code, null);
  });
  return child;
}

test('L1 九个本机 Agent 档位按写入开关拼参数', () => {
  assert.deepEqual(LOCAL_AGENT_IDS, ['opencode', 'gemini', 'qwen', 'cursor-agent', 'dsh', 'codebuddy', 'qoder', 'iflow', 'kimi']);

  assert.deepEqual(
    LOCAL_AGENT_PROFILES.opencode.buildArgs({ prompt: '读一下 README' }, 'C:\\proj'),
    ['run', '--dir', 'C:\\proj', '读一下 README']
  );
  assert.deepEqual(
    LOCAL_AGENT_PROFILES.opencode.buildArgs({ prompt: '改一下 README', write: true }, 'C:\\proj'),
    ['run', '--auto', '--dir', 'C:\\proj', '改一下 README']
  );
  assert.deepEqual(
    LOCAL_AGENT_PROFILES.gemini.buildArgs({ prompt: '看看仓库' }, 'x'),
    ['-p', '看看仓库', '--output-format', 'text']
  );
  assert.deepEqual(
    LOCAL_AGENT_PROFILES.gemini.buildArgs({ prompt: '改文件', write: true }, 'x'),
    ['-p', '改文件', '--output-format', 'text', '--yolo']
  );
  assert.deepEqual(
    LOCAL_AGENT_PROFILES.qwen.buildArgs({ prompt: 'p', write: true }, 'x'),
    ['-p', 'p', '--output-format', 'text', '--yolo']
  );
  assert.deepEqual(
    LOCAL_AGENT_PROFILES['cursor-agent'].buildArgs({ prompt: 'p', write: true }, 'x'),
    ['-p', 'p', '--output-format', 'text', '--force']
  );
  assert.deepEqual(LOCAL_AGENT_PROFILES.dsh.buildArgs({ prompt: 'p' }, 'x'), ['--profile', 'headless', 'p']);
});

test('L2 纯文本输出把 stdout 当结论，非零退出同时给出错误', () => {
  const ok = parseTextOutput({ stdout: '  两个字母：OK\n', stderr: '', exitCode: 0 });
  assert.equal(ok.summary, '两个字母：OK');
  assert.equal(ok.error, '');

  // DeepSeek Harness 会把推理写进 stderr：退出码为 0 时不能判失败。
  const noisy = parseTextOutput({ stdout: 'OK\n', stderr: 'reasoning: 用户只想让我回复 OK。', exitCode: 0 });
  assert.equal(noisy.summary, 'OK');
  assert.equal(noisy.error, '');

  const failed = parseTextOutput({ stdout: '', stderr: 'Missing environment variable: OPENCODE_API_KEY.', exitCode: 1 });
  assert.equal(failed.summary, '');
  assert.match(failed.error, /OPENCODE_API_KEY/);

  const inlineError = parseTextOutput({
    stdout: '{"type":"error","error":{"data":{"message":"This API key has expired."}}}',
    stderr: '',
    exitCode: 1
  });
  assert.match(inlineError.summary, /expired/);
  assert.match(inlineError.error, /expired/);
});

test('L3 缺少可执行文件时不可用，存在时可跑通并落产物', async t => {
  const { dir, binary, store } = fixture(t);
  const missing = localAgentExecutor('opencode', { store, cwd: dir, binary: join(dir, 'nope.exe'), spawnImpl: () => fakeChild() });
  assert.equal(missing.available, false);
  assert.throws(() => missing.start({ command: 'x' }, { id: 'a' }, { prompt: 'x' }), { status: 503 });

  let invocation;
  const executor = localAgentExecutor('opencode', {
    store,
    cwd: dir,
    binary,
    environment: { PATH: process.env.PATH, OPENCODE_API_KEY: 'must-not-leak' },
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      return fakeChild({ chunks: ['只读检查完成：README 说明如何启动。'] });
    }
  });
  assert.equal(executor.available, true);
  const task = executor.start(
    { id: 'ticket-local', command: '读一下 README' },
    { id: 'assignment-local', ticketId: 'ticket-local', executor: 'opencode' },
    { prompt: '读一下 README' }
  );
  await waitFor(() => store.get('task', task.id)?.status === 'completed');
  const saved = store.get('task', task.id);
  assert.deepEqual(invocation.args.slice(0, 3), ['run', '--dir', dir]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.OPENCODE_API_KEY, undefined);
  assert.match(saved.artifacts.cli.summary, /README 说明如何启动/);
  assert.equal(saved.artifacts.cli.executorId, 'opencode');
});

test('L4 批量装配只生成 5 个本机 Agent 执行器', () => {
  const { dir, binary, store } = fixtureForBatch();
  const executors = localAgentExecutors({ store, cwd: dir, binary, spawnImpl: () => fakeChild() });
  assert.deepEqual(executors.map(item => item.id), [...LOCAL_AGENT_IDS]);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function fixtureForBatch() {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-local-batch-'));
  const binary = join(dir, 'fake-agent.exe');
  writeFileSync(binary, '');
  return { dir, binary, store: new Store(dir) };
}
