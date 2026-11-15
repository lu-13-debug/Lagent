import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { workStore } from './work/store.js';
import { createLibrarySync } from './work/library-sync.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'lagent-library-'));
  const projectPath = join(dir, 'project');
  const store = new Store(join(dir, 'data'));
  const db = workStore(store, () => {});
  const changes = [];
  const project = { id: 'p1', name: '演示项目', path: projectPath, gitBranch: 'main' };
  const projects = {
    getProject: id => { if (id !== project.id) throw Object.assign(new Error('项目不存在'), { status: 404 }); return project; },
    getBrief: () => ({ projectId: 'p1', goal: '把上下文同步给 Agent', summary: '已接通 Library', keyPoints: ['只改托管块'], decisions: [], constraints: ['不覆盖手写内容'], openQuestions: [], nextSteps: [], verifyCommands: [] }),
    recordChange: (id, input, meta) => { changes.push({ id, input, meta }); return input; }
  };
  const state = { digest: '项目记忆：上次改过同步器。' };
  const memory = { digest: () => state.digest };
  const library = createLibrarySync(db, { projects, memory, now: () => Date.parse('2026-11-14T09:00:00.000Z') });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, projectPath, store, db, library, changes, state };
}

test('Library 预览只生成托管块，保留已有手写内容', t => {
  const f = fixture(t);
  const preview = f.library.preview('p1');
  assert.deepEqual(preview.targets.map(row => row.id), ['claude', 'agents', 'cursor']);
  assert.equal(preview.targets[0].exists, false);
  assert.match(preview.targets[0].after, /lagent:begin/);
  assert.match(preview.targets[0].after, /把上下文同步给 Agent/);
  assert.doesNotMatch(preview.targets[0].after, /项目路径/);
});

test('Library 应用、幂等与回滚', t => {
  const f = fixture(t);
  mkdirSync(f.projectPath, { recursive: true });
  writeFileSync(join(f.projectPath, 'CLAUDE.md'), '# 手写规则\n\n始终运行测试。\n');
  const first = f.library.apply('p1').sync;
  assert.equal(first.changed, 3);
  const claude = readFileSync(join(f.projectPath, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# 手写规则/);
  assert.match(claude, /始终运行测试/);
  assert.match(claude, /lagent:begin/);
  assert.match(readFileSync(join(f.projectPath, '.cursor/rules/lagent.mdc'), 'utf8'), /alwaysApply: true/);
  assert.equal(f.changes.length, 1);
  assert.equal(f.changes[0].meta.source, 'auto');

  const second = f.library.apply('p1').sync;
  assert.equal(second.changed, 0);
  assert.equal(f.changes.length, 1);

  writeFileSync(join(f.projectPath, 'CLAUDE.md'), '# 手写规则\n\n始终运行测试。\n\n<!-- lagent:begin -->\n旧内容\n<!-- lagent:end -->\n');
  const third = f.library.apply('p1').sync;
  assert.equal(third.changed, 1);
  assert.match(readFileSync(join(f.projectPath, 'CLAUDE.md'), 'utf8'), /把上下文同步给 Agent/);

  const rolled = f.library.rollback('p1', third.id);
  assert.ok(rolled.restored.includes('CLAUDE.md'));
  assert.match(readFileSync(join(f.projectPath, 'CLAUDE.md'), 'utf8'), /旧内容/);

  const firstRollback = f.library.rollback('p1', first.id);
  assert.ok(firstRollback.restored.includes('.cursor/rules/lagent.mdc'));
  assert.equal(existsSync(join(f.projectPath, '.cursor/rules/lagent.mdc')), false);
  assert.equal(readFileSync(join(f.projectPath, 'CLAUDE.md'), 'utf8'), '# 手写规则\n\n始终运行测试。\n');
});

test('Library MCP 目标需要地址，预览不泄露令牌，同步记录不存令牌', t => {
  const f = fixture(t);
  const missing = f.library.preview('p1', { targets: ['mcp'] });
  assert.match(missing.targets[0].error, /MCP 地址/);
  const preview = f.library.preview('p1', { targets: ['mcp'], mcpUrl: 'http://127.0.0.1:8787/api/mcp', mcpToken: 'lagent_mcp_secret' });
  assert.doesNotMatch(JSON.stringify(preview), /lagent_mcp_secret/);
  assert.match(preview.targets[0].after, /Bearer \*\*\*/);
  const sync = f.library.apply('p1', { targets: ['mcp'], mcpUrl: 'http://127.0.0.1:8787/api/mcp', mcpToken: 'lagent_mcp_secret' }).sync;
  const config = JSON.parse(readFileSync(join(f.projectPath, '.mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.lagent.url, 'http://127.0.0.1:8787/api/mcp');
  assert.match(config.mcpServers.lagent.headers.Authorization, /^Bearer lagent_mcp_secret$/);
  assert.doesNotMatch(JSON.stringify(sync), /lagent_mcp_secret/);
  assert.doesNotMatch(JSON.stringify(f.db.list('library-sync')), /lagent_mcp_secret/);
});

test('Library 拒绝项目外路径', t => {
  const f = fixture(t);
  assert.throws(() => f.library.preview('p1', { targets: ['../../etc/passwd'] }), { status: 400 });
});

test('Library 写入配置档约定，并按 Agent 分节', t => {
  const f = fixture(t);
  const preview = f.library.preview('p1', {
    library: {
      instructions: ['先跑测试', '[codex] 只改 server/**', '[claude-code] 用 TypeScript'],
      skills: ['review'],
      mcpServers: ['github'],
    },
  });
  const claude = preview.targets.find(row => row.id === 'claude').after;
  assert.match(claude, /### 工作区配置/);
  assert.match(claude, /先跑测试/);
  assert.match(claude, /#### 给 codex 的约定/);
  assert.match(claude, /只改 server/);
  assert.match(claude, /#### 给 claude-code 的约定/);
  assert.match(claude, /用 TypeScript/);
  assert.match(claude, /登记技能/);
  assert.match(claude, /MCP 服务/);
});

test('Library 只在手动同步过之后自动刷新，且不记项目变更', t => {
  const f = fixture(t);
  assert.equal(f.library.shouldAutoSync('p1'), false);
  f.library.apply('p1');
  assert.equal(f.library.shouldAutoSync('p1'), true);
  const before = f.changes.length;
  f.state.digest = '项目记忆：新增了一条结论。';
  const refreshed = f.library.autoApply('p1');
  assert.ok(refreshed);
  assert.equal(refreshed.sync.changed, 3);
  assert.equal(f.changes.length, before);
  assert.match(readFileSync(join(f.projectPath, 'CLAUDE.md'), 'utf8'), /新增了一条结论/);
});
