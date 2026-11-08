import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { codexExecutor, parseCodexOutput } from './work/executors/codex.js';
import { claudeCodeExecutor, parseClaudeOutput } from './work/executors/claude-code.js';

async function waitFor(predicate, message = '等待条件超时', timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dataagent-cli-'));
  const binary = join(dir, 'fake-cli.exe');
  writeFileSync(binary, '');
  if (process.platform !== 'win32') chmodSync(binary, 0o755);
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, binary, store };
}

function fakeCliChild({ chunks = [], stderr = '', code = 0, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    child.killSignal = signal;
    queueMicrotask(() => child.emit('close', null, signal || 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => {
    for (const chunk of chunks) child.stdout.emit('data', Buffer.from(chunk));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (!hang) child.emit('close', code, null);
  });
  return child;
}

const jsonl = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('E2 CLI 可用性只接受显式可执行文件并校验输入边界', t => {
  const { dir, binary, store } = fixture(t);
  const missing = codexExecutor({ store, cwd: dir, binary: join(dir, 'missing.exe'), spawnImpl: () => fakeCliChild() });
  const relative = claudeCodeExecutor({ store, cwd: dir, binary: 'claude.exe', spawnImpl: () => fakeCliChild() });
  const codex = codexExecutor({ store, cwd: dir, binary, spawnImpl: () => fakeCliChild() });
  assert.equal(missing.available, false);
  assert.equal(relative.available, false);
  assert.equal(codex.available, true);
  assert.deepEqual(codex.validateInput({ prompt: '  只读检查  ', maxTurns: 3 }), { prompt: '只读检查', maxTurns: 3 });
  assert.throws(() => codex.validateInput({ prompt: '' }), { status: 400 });
  assert.throws(() => codex.validateInput({ prompt: '检查', maxTurns: 0 }), { status: 400 });
  assert.throws(() => codex.validateInput({ prompt: '检查', maxTurns: 21 }), { status: 400 });
  assert.throws(() => codex.validateInput({ prompt: 'x'.repeat(17 * 1024) }), { status: 400 });
  assert.throws(() => relative.start({ command: 'x' }, { id: 'a' }, { prompt: 'x' }), { status: 503 });
});

test('E2 Codex 固定 argv、环境过滤、JSONL 脱敏与 artifact 统计', async t => {
  const { dir, binary, store } = fixture(t);
  const stdout = jsonl([
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'private chain of thought' } },
    { type: 'item.completed', item: { type: 'command_execution', command: 'git status', exit_code: 0 } },
    { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'report/summary.md' }, { path: '../secret.txt' }, { path: 'C:\\outside.txt' }] } },
    { type: 'item.completed', item: { type: 'agent_message', text: '只读检查完成；token=sk-supersecretvalue' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7, private_hint: 'drop-me' } }
  ]);
  let invocation;
  const executor = codexExecutor({
    store,
    cwd: dir,
    binary,
    environment: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      DATAAGENT_CREDENTIAL_MASTER_KEY: 'must-not-leak'
    },
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      return fakeCliChild({ chunks: [stdout.slice(0, 80), stdout.slice(80)] });
    }
  });
  const task = executor.start(
    { id: 'ticket-codex', command: '检查仓库' },
    { id: 'assignment-codex', ticketId: 'ticket-codex', executor: 'codex' },
    { prompt: '检查; $(whoami) && echo no', maxTurns: 4 }
  );
  await waitFor(() => store.get('task', task.id)?.status === 'completed');
  const saved = store.get('task', task.id);
  assert.equal(invocation.executable, resolve(binary));
  assert.deepEqual(invocation.args.slice(0, 6), ['exec', '--json', '--sandbox', 'read-only', '-C', resolve(dir)]);
  assert.equal(invocation.args.length, 7);
  assert.match(invocation.args[6], /只读分析模式/);
  assert.match(invocation.args[6], /不得启动子智能体/);
  assert.match(invocation.args[6], /检查; \$\(whoami\) && echo no/);
  assert.equal(invocation.options.cwd, resolve(dir));
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(invocation.options.env.DATAAGENT_CREDENTIAL_MASTER_KEY, undefined);
  assert.equal(saved.artifacts.cli.summary.includes('private chain of thought'), false);
  assert.match(saved.artifacts.cli.summary, /\[REDACTED\]/);
  assert.deepEqual(saved.artifacts.cli.usage, { input_tokens: 12, output_tokens: 7 });
  assert.deepEqual(saved.artifacts.cli.artifacts, ['report/summary.md']);
  assert.equal(saved.artifacts.cli.stats.commands, 1);
  assert.equal(saved.artifacts.cli.stats.fileChanges, 1);
  assert.doesNotMatch(JSON.stringify(saved.artifacts), /reasoning|private chain of thought|OPENAI_API_KEY|sk-supersecretvalue/);
});

test('E2 Claude Code 固定 stream-json argv 并只投影摘要/usage/错误', async t => {
  const { dir, binary, store } = fixture(t);
  const stdout = jsonl([
    { type: 'system', subtype: 'init', session_id: 'private-session' },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private chain' }, { type: 'tool_use', name: 'Read', input: { file_path: 'secret.txt' } }], usage: { input_tokens: 3 } } },
    { type: 'result', subtype: 'success', is_error: false, result: '只读摘要', usage: { input_tokens: 10, output_tokens: 4, total_cost_usd: 0.01 }, num_turns: 2, duration_ms: 50 }
  ]);
  let invocation;
  const executor = claudeCodeExecutor({
    store,
    cwd: dir,
    binary,
    spawnImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      return fakeCliChild({ chunks: [stdout] });
    }
  });
  const task = executor.start(
    { id: 'ticket-claude', command: '检查仓库' },
    { id: 'assignment-claude', ticketId: 'ticket-claude', executor: 'claude-code' },
    { prompt: '只检查已有文件', maxTurns: 7 }
  );
  await waitFor(() => store.get('task', task.id)?.status === 'completed');
  const saved = store.get('task', task.id);
  assert.equal(invocation.executable, resolve(binary));
  assert.deepEqual(invocation.args.slice(0, 6), ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '7']);
  assert.deepEqual(invocation.args.slice(6, 8), ['--permission-mode', 'plan']);
  assert.equal(invocation.args.length, 9);
  assert.match(invocation.args[8], /不得修改、创建、删除或重命名文件/);
  assert.equal(saved.artifacts.cli.summary, '只读摘要');
  assert.deepEqual(saved.artifacts.cli.usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_cost_usd: 0.01,
    num_turns: 2,
    duration_ms: 50
  });
  assert.equal(saved.artifacts.cli.stats.tools, 1);
  assert.doesNotMatch(JSON.stringify(saved.artifacts), /private chain|private-session|secret\.txt/);
});

test('E2 CLI 截断、超时、非零退出与 Abort', async t => {
  const { dir, binary, store } = fixture(t);
  const truncated = codexExecutor({
    store,
    cwd: dir,
    binary,
    maxOutputBytes: 32,
    spawnImpl: () => fakeCliChild({ chunks: ['x'.repeat(64)] })
  });
  const task = truncated.start({ command: 'truncate' }, { id: 'assignment-truncate' }, { prompt: '检查' });
  await waitFor(() => store.get('task', task.id)?.status === 'completed');
  assert.equal(store.get('task', task.id).artifacts.cli.truncated, true);
  assert.equal(store.get('task', task.id).artifacts.cli.stats.stdoutBytes, 64);

  const timed = codexExecutor({
    store,
    cwd: dir,
    binary,
    timeoutMs: 10,
    spawnImpl: () => fakeCliChild({ hang: true })
  });
  const timeoutTask = timed.start({ command: 'timeout' }, { id: 'assignment-timeout' }, { prompt: '检查' });
  await waitFor(() => store.get('task', timeoutTask.id)?.status === 'failed');
  assert.equal(store.get('task', timeoutTask.id).artifacts.cli.timedOut, true);

  const failed = claudeCodeExecutor({
    store,
    cwd: dir,
    binary,
    spawnImpl: () => fakeCliChild({ stderr: 'permission denied', code: 9 })
  });
  const failedTask = failed.start({ command: 'fail' }, { id: 'assignment-fail' }, { prompt: '检查' });
  await waitFor(() => store.get('task', failedTask.id)?.status === 'failed');
  assert.equal(store.get('task', failedTask.id).artifacts.cli.exitCode, 9);
  assert.match(store.get('task', failedTask.id).artifacts.cli.error, /permission denied/);

  const abortChild = fakeCliChild({ hang: true });
  const abort = codexExecutor({ store, cwd: dir, binary, spawnImpl: () => abortChild });
  const abortTask = abort.start({ command: 'abort' }, { id: 'assignment-abort' }, { prompt: '检查' });
  abort.stop(abortTask);
  assert.ok(abortChild.killSignal);
  assert.equal(store.get('task', abortTask.id).status, 'cancelled');
  assert.equal(store.get('task', abortTask.id).artifacts.cli.cancelled, true);
});

test('E2 输出解析器不保留 reasoning/thinking 或原始事件', () => {
  const codex = parseCodexOutput({
    stdout: jsonl([
      { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '最终摘要' } },
      { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }
    ]),
    stderr: '',
    exitCode: 0
  });
  const claude = parseClaudeOutput({
    stdout: jsonl([
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private thinking' }, { type: 'text', text: '过程文本' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: '最终结果', usage: { input_tokens: 2, output_tokens: 1 } }
    ]),
    stderr: '',
    exitCode: 0
  });
  assert.equal(codex.summary, '最终摘要');
  assert.deepEqual(codex.stats, { events: 3, malformedLines: 0, agentMessages: 1, commands: 0, fileChanges: 0, tools: 0 });
  assert.equal(claude.summary, '最终结果');
  assert.doesNotMatch(JSON.stringify({ codex, claude }), /private reasoning|private thinking/);
});
