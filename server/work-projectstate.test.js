import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { projectStateOf, registerWork } from './work/routes.js';
import { createExecutorRegistry } from './work/executors/index.js';

// 模型 Agent 需要在不读整个文件的前提下知道「这个目录最近被谁改过」。
// 这条链路横跨 routes（登记引擎）→ engine（按路径反查项目）→ projectStateBrief，
// 所以用一个真实端口的 app 来验证，而不是只测纯函数。
test('执行器按工作目录能拿到项目最近改动，包含文件名', async t => {
  const root = mkdtempSync(join(tmpdir(), 'stateof-'));
  const projectDir = join(root, 'proj');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'README.md'), '# proj\n');

  const store = new Store(join(root, 'store'));
  const app = express();
  app.use(express.json());
  const registry = createExecutorRegistry([{
    id: 'probe', name: '探针执行器', kind: 'cli', available: true, capabilities: ['code'],
    start: () => ({ status: 'completed' })
  }]);
  const close = registerWork(app, store, registry, { workspace: root });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    return response.json();
  };

  t.after(() => {
    server.close();
    try { close?.(); } catch { /* 关闭失败不影响断言 */ }
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const { project } = await call('POST', '/api/work/projects', { path: projectDir, name: 'proj' });
  await call('POST', `/api/work/projects/${project.id}/changes`, {
    ticketId: 'ticket-x',
    title: '加了输入处理',
    summary: '新增 input.js，接好了方向键',
    files: ['input.js'],
    executorId: 'claude-code',
    status: 'completed'
  });

  const brief = projectStateOf(projectDir);
  assert.match(brief, /项目现状/);
  assert.match(brief, /input\.js/, '改动清单里要能看到文件名');
  assert.match(brief, /不必通读|只读相关段落/, '要提示别整篇重读');
  assert.equal(projectStateOf(join(root, 'no-such-project')), '', '没有对应项目时返回空字符串');
});