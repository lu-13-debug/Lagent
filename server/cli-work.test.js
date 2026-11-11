import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { codexExecutor } from './work/executors/codex.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';

async function waitFor(predicate, message = '等待条件超时', timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 5));
  }
  assert.fail(message);
}

function fakeCliChild(stdout) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = signal => {
    child.killSignal = signal;
    queueMicrotask(() => child.emit('close', null, signal || 'SIGTERM'));
    return true;
  };
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0, null);
  });
  return child;
}

const jsonl = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';

test('E2 Work CLI approval freezes input and projects sanitized report/SSE', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-cli-work-'));
  const store = new Store(dir);
  const spawned = { codex: [], 'claude-code': [] };
  const events = [];
  const environment = {
    PATH: process.env.PATH,
    OPENAI_API_KEY: 'must-not-leak',
    ANTHROPIC_API_KEY: 'must-not-leak',
    LAGENT_CREDENTIAL_MASTER_KEY: 'must-not-leak'
  };
  const codex = codexExecutor({
    store,
    cwd: dir,
    binary: process.execPath,
    environment,
    spawnImpl: (_executable, args, options) => {
      spawned.codex.push({ args, options });
      return fakeCliChild(jsonl([
        { type: 'item.completed', item: { type: 'agent_message', text: 'codex 安全摘要' } },
        { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }
      ]));
    }
  });
  const claude = claudeCodeExecutor({
    store,
    cwd: dir,
    binary: process.execPath,
    environment,
    spawnImpl: (_executable, args, options) => {
      spawned['claude-code'].push({ args, options });
      return fakeCliChild(jsonl([
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'claude 安全摘要',
          usage: { input_tokens: 7, output_tokens: 3 },
          num_turns: 1,
          duration_ms: 20
        }
      ]));
    }
  });
  const engine = createWorkEngine(store, createExecutorRegistry([codex, claude]), event => events.push(event), { policy: { allowedExecutors: ['codex', 'claude-code'], requireApproval: true }, env: { ...process.env, LAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' } });
  t.after(() => {
    engine.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const codexTicket = engine.command({
    text: '检查仓库',
    clientRequestId: 'cli-once',
    executorId: 'codex',
    executorInput: { prompt: 'FROZEN_CODEX_PROMPT', maxTurns: 2 }
  });
  assert.equal(codexTicket.executor, 'codex');
  assert.equal(codexTicket.stage, 'approval');
  assert.equal(spawned.codex.length, 0);
  assert.doesNotMatch(JSON.stringify(codexTicket), /executorInput|FROZEN_CODEX_PROMPT/);
  assert.equal(engine.command({
    text: '检查仓库',
    clientRequestId: 'cli-once',
    executorId: 'codex',
    executorInput: { prompt: 'FROZEN_CODEX_PROMPT', maxTurns: 2 }
  }).id, codexTicket.id);
  assert.throws(() => engine.command({
    text: '检查仓库',
    clientRequestId: 'cli-once',
    executorId: 'claude-code',
    executorInput: { prompt: 'FROZEN_CODEX_PROMPT', maxTurns: 2 }
  }), { status: 409 });

  const claudeTicket = engine.command({
    text: '检查文档',
    clientRequestId: 'claude-once',
    executorId: 'claude-code',
    executorInput: { prompt: 'FROZEN_CLAUDE_PROMPT', maxTurns: 1 }
  });
  assert.equal(spawned['claude-code'].length, 0);

  assert.equal(engine.action(codexTicket.id, 'approve', {
    executorInput: { prompt: 'TAMPERED_CODEX_PROMPT', maxTurns: 20 }
  }).stage, 'cli');
  assert.equal(engine.action(claudeTicket.id, 'approve', {
    executorInput: { prompt: 'TAMPERED_CLAUDE_PROMPT', maxTurns: 20 }
  }).stage, 'cli');
  await waitFor(() => engine.detail(codexTicket.id).ticket.status === 'completed', 'codex 未完成');
  await waitFor(() => engine.detail(claudeTicket.id).ticket.status === 'completed', 'claude 未完成');

  assert.equal(spawned.codex.length, 1);
  assert.equal(spawned['claude-code'].length, 1);
  assert.match(spawned.codex[0].args.at(-1), /FROZEN_CODEX_PROMPT/);
  assert.doesNotMatch(spawned.codex[0].args.at(-1), /TAMPERED_CODEX_PROMPT/);
  assert.match(spawned['claude-code'][0].args.at(-1), /FROZEN_CLAUDE_PROMPT/);
  assert.doesNotMatch(spawned['claude-code'][0].args.at(-1), /TAMPERED_CLAUDE_PROMPT/);
  for (const invocation of [spawned.codex[0], spawned['claude-code'][0]]) {
    assert.equal(invocation.options.cwd, resolve(dir));
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
    assert.equal(invocation.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(invocation.options.env.LAGENT_CREDENTIAL_MASTER_KEY, undefined);
  }

  const codexDetail = engine.detail(codexTicket.id);
  const claudeDetail = engine.detail(claudeTicket.id);
  assert.equal(codexDetail.assignments[0].executor, 'codex');
  assert.equal(claudeDetail.assignments[0].executor, 'claude-code');
  assert.equal(codexDetail.team, null);
  assert.equal(claudeDetail.team, null);
  assert.equal(codexDetail.reports.find(report => report.kind === 'ready').artifacts.cli.summary, 'codex 安全摘要');
  const claudeReport = claudeDetail.reports.find(report => report.kind === 'ready').artifacts.cli;
  assert.equal(claudeReport.summary, 'claude 安全摘要');
  assert.deepEqual(claudeReport.usage, {
    input_tokens: 7,
    output_tokens: 3,
    num_turns: 1,
    duration_ms: 20
  });
  assert.deepEqual(new Set(events.map(event => event.type)), new Set(['ticket', 'assignment', 'report']));
  assert.doesNotMatch(JSON.stringify({ codexDetail, claudeDetail, events }), /FROZEN_|TAMPERED_|must-not-leak|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
});