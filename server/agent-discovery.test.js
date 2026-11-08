import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodexBinary, findClaudeCodeCli } from './work/executors/discover.js';

test('自动发现显式 Codex 路径与 npm 版 Claude 可执行文件', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const codex = join(dir, 'codex.exe');
  writeFileSync(codex, '');
  assert.equal(findCodexBinary({ DATAAGENT_CODEX_CLI: codex }), codex);
  assert.equal(findCodexBinary({ DATAAGENT_CODEX_CLI: join(dir, 'missing.exe') }), null);

  const claude = join(dir, 'claude.exe');
  writeFileSync(claude, '');
  assert.deepEqual(findClaudeCodeCli({ DATAAGENT_CLAUDE_CLI: claude }), { binary: claude, prefix: [] });
  assert.equal(findClaudeCodeCli({ APPDATA: dir }), null);
});
