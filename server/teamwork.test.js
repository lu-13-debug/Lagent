import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Store } from './store.js';
import { createWorkEngine } from './work/engine.js';
import { createExecutorRegistry } from './work/executors/index.js';
import { claudeCodeExecutor } from './work/executors/claude-code.js';
import { codexExecutor } from './work/executors/codex.js';

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'teamwork-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const projectDir = join(root, 'demo-game');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(projectDir, 'README.md'), '# demo\n');
  const store = new Store(join(home, 'db.sqlite'));
  const spawned = [];
  const fake = () => {
    const child = new EventTarget();
    child.stdout = { on: () => {} };
    child.stderr = { on: () => {} };
    child.kill = () => true;
    return child;
  };
  const claude = claudeCodeExecutor({ store, cwd: root, binary: process.execPath, spawnImpl: (...args) => { spawned.push(args); return fake(); } });
  const codex = codexExecutor({ store, cwd: root, binary: process.execPath, spawnImpl: (...args) => { spawned.push(args); return fake(); } });
  const engine = createWorkEngine(store, createExecutorRegistry([claude, codex]), () => {}, {
    policy: { allowedExecutors: ['claude-code', 'codex'] },
    env: { ...process.env, DATAAGENT_ALLOW_EXTERNAL_EXTERNAL: '1', DATAAGENT_ALLOW_EXTERNAL_EXECUTORS: '1' },
    home
  });
  t.after(() => {
    engine.close();
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const project = engine.importProject({ path: projectDir }).project;
  return { engine, project, projectDir, spawned };
}

const PART_SOURCE = {
  rules: `window.Coop = window.Coop || {};\nCoop.rules = { init(world){ world.phase = 'ready'; }, update(world, input, dt){ if (input.pressed.Space) world.phase = 'playing'; world.score += 1; } };\n`,
  view: `window.Coop = window.Coop || {};\nCoop.view = { draw(ctx, world){ ctx.fillStyle = '#111'; ctx.fillRect(0, 0, world.w, world.h); } };\n`,
  hud: `window.Coop = window.Coop || {};\nCoop.hud = { draw(ctx, world){ ctx.fillStyle = '#fff'; ctx.fillText('得分 ' + world.score, 24, 32); } };\n`
};

test('协作任务：拆成三部分、分给不同 Agent、各自一个会话', t => {
  const { engine, project, projectDir } = harness(t);
  const result = engine.teamworkStart(project.id, { goal: '做一个打砖块小游戏', executorIds: ['claude-code', 'codex'] });
  assert.equal(result.teamwork.parts.length, 3);
  assert.deepEqual(result.teamwork.parts.map(part => part.id), ['rules', 'view', 'hud']);
  assert.deepEqual(result.teamwork.parts.map(part => part.executorId), ['claude-code', 'codex', 'claude-code']);
  assert.equal(result.tickets.length, 3);
  assert.ok(result.tickets.every(ticket => ticket.status === 'awaiting_review'));
  const chats = engine.getProject(project.id).chats;
  assert.ok(chats.some(chat => chat.title === '协作 · 玩法规则'));
  assert.ok(existsSync(join(projectDir, 'coop', 'contract.md')));
  assert.ok(existsSync(join(projectDir, 'coop', 'skeleton.js')));
  assert.equal(engine.teamworkList(project.id).length, 1);
  assert.equal(engine.teamworkGet(result.teamwork.id).parts[0].fileExists, false);
});

test('协作任务：文件没写齐时拒绝组装，并逐条说明缺什么', t => {
  const { engine, project, projectDir } = harness(t);
  const { teamwork } = engine.teamworkStart(project.id, { goal: '做一个贪吃蛇', executorIds: ['claude-code'] });
  const blocked = engine.teamworkAssemble(teamwork.id);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.problems.length, 3);
  assert.match(blocked.problems[0].message, /缺少 coop\/rules\.js/);
  assert.equal(existsSync(join(projectDir, 'coop', 'index.html')), false);
  assert.equal(engine.teamworkGet(teamwork.id).status, 'blocked');
});

test('协作任务：三份都合格时组装成单文件游戏', t => {
  const { engine, project, projectDir } = harness(t);
  const { teamwork } = engine.teamworkStart(project.id, { goal: '做一个打砖块', executorIds: ['claude-code', 'codex'] });
  mkdirSync(join(projectDir, 'coop'), { recursive: true });
  writeFileSync(join(projectDir, 'coop', 'rules.js'), PART_SOURCE.rules, 'utf8');
  writeFileSync(join(projectDir, 'coop', 'view.js'), PART_SOURCE.view, 'utf8');
  writeFileSync(join(projectDir, 'coop', 'hud.js'), PART_SOURCE.hud, 'utf8');
  const assembled = engine.teamworkAssemble(teamwork.id);
  assert.equal(assembled.ok, true);
  assert.equal(assembled.relativePath, 'coop/index.html');
  const html = readFileSync(join(projectDir, 'coop', 'index.html'), 'utf8');
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Coop.rules ='));
  assert.ok(html.includes('Coop.view ='));
  assert.ok(html.includes('Coop.hud ='));
  assert.ok(html.includes('window.Coop.ready = true'));
  assert.equal(/<script[^>]+src=/i.test(html), false);
  const view = engine.teamworkGet(teamwork.id);
  assert.equal(view.status, 'assembled');
  assert.ok(view.bytes > 2000);
  assert.ok(view.parts.every(part => part.fileExists && part.fileSize > 100));
});

test('协作任务：某份文件没定义约定的全局时点名拒绝', t => {
  const { engine, project, projectDir } = harness(t);
  const { teamwork } = engine.teamworkStart(project.id, { goal: '做一个打砖块', executorIds: ['codex'] });
  mkdirSync(join(projectDir, 'coop'), { recursive: true });
  writeFileSync(join(projectDir, 'coop', 'rules.js'), PART_SOURCE.rules, 'utf8');
  writeFileSync(join(projectDir, 'coop', 'view.js'), `${'// 画布表现：只画背景与实体，不改世界状态。\n'.repeat(4)}window.Coop = window.Coop || {};\nCoop.draw = { draw(ctx, world){ ctx.fillRect(0, 0, world.w, world.h); } };\n`, 'utf8');
  writeFileSync(join(projectDir, 'coop', 'hud.js'), PART_SOURCE.hud, 'utf8');
  const blocked = engine.teamworkAssemble(teamwork.id);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.problems.some(problem => problem.part === 'view' && /没有定义 Coop\.view/.test(problem.message)));
  assert.equal(dirname(join(projectDir, 'coop', 'index.html')), join(projectDir, 'coop'));
  assert.equal(existsSync(join(projectDir, 'coop', 'index.html')), false);
});
