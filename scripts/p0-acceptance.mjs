#!/usr/bin/env node
// P0.5 验收与回滚演练。
// 用法：npm run p0:acceptance
// 做什么：用临时数据目录起两次服务，先确认默认关闭时旧接口不受影响，
// 再打开 LAGENT_APPROVALS / LAGENT_THREAD_API / LAGENT_RUN_EVENTS 验证新接口，
// 最后在同一份数据上关掉开关，演练「关开关即回滚」。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'lagent-p0-'));
let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer(flags, port) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LAGENT_DATA_DIR: dataDir,
      LAGENT_RUN_DB: ':memory:',
      LAGENT_WORK_ROUTINES: '0',
      ...flags
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdout.on('data', () => {});
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`服务提前退出（${child.exitCode}）：${stderr.slice(-800)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/work/bootstrap`);
      if (response.ok) return { child, port };
    } catch { /* 尚未监听，继续等。 */ }
    await sleep(250);
  }
  await stopServer(child);
  throw new Error(`服务 30 秒内未就绪：${stderr.slice(-800)}`);
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(5000).then(() => false)
  ]);
  if (!exited) child.kill('SIGKILL');
}

async function probe(port, route, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, init);
  const type = response.headers.get('content-type') || '';
  let body = null;
  if (type.includes('application/json')) body = await response.json().catch(() => null);
  return { status: response.status, type, body, headers: response.headers };
}

async function probeSse(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/work/events`, {
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': '0' },
      signal: controller.signal
    });
    return { status: response.status, type: response.headers.get('content-type') || '', cache: response.headers.get('cache-control') || '' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  console.log(`P0 验收（临时数据目录：${dataDir}）`);
  console.log('\n[1/3] 默认关闭：旧接口与回滚基线');
  {
    const { child, port } = await startServer({
      LAGENT_RUN_EVENTS: '0',
      LAGENT_SSE_V2: '0',
      LAGENT_APPROVALS: '0',
      LAGENT_THREAD_API: '0'
    }, 4311);
    try {
      const bootstrap = await probe(port, '/api/work/bootstrap');
      check('bootstrap 200', bootstrap.status === 200, String(bootstrap.status));
      check('bootstrap 不带 approvals', bootstrap.body && !('approvals' in bootstrap.body));
      const approvals = await probe(port, '/api/work/approvals');
      check('审批路由未注册（404）', approvals.status === 404, String(approvals.status));
      const threads = await probe(port, '/api/work/threads');
      check('thread 路由未注册（404）', threads.status === 404, String(threads.status));
      const sse = await probeSse(port);
      check('旧 SSE 仍可连接', sse.status === 200 && sse.type.includes('text/event-stream'), `${sse.status} ${sse.type}`);
    } finally {
      await stopServer(child);
    }
  }

  console.log('\n[2/3] 打开 P0 开关：审批与 thread 投影');
  {
    const { child, port } = await startServer({
      LAGENT_RUN_EVENTS: '1',
      LAGENT_SSE_V2: '1',
      LAGENT_APPROVALS: '1',
      LAGENT_THREAD_API: '1'
    }, 4312);
    try {
      const bootstrap = await probe(port, '/api/work/bootstrap');
      check('bootstrap 带 approvals', bootstrap.status === 200 && Array.isArray(bootstrap.body?.approvals));
      const approvals = await probe(port, '/api/work/approvals?status=all');
      check('审批列表 200 且为空', approvals.status === 200 && Array.isArray(approvals.body?.approvals) && approvals.body.approvals.length === 0);
      const threads = await probe(port, '/api/work/threads');
      check('thread 列表 200', threads.status === 200 && Array.isArray(threads.body?.threads));
      const missingThread = await probe(port, '/api/work/threads/not-a-thread');
      check('不存在的 thread 返回 404', missingThread.status === 404, String(missingThread.status));
      const missingDecision = await probe(port, '/api/work/approvals/not-an-approval/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow_once' })
      });
      check('不存在的审批决议返回 404', missingDecision.status === 404, String(missingDecision.status));
      const badDecision = await probe(port, '/api/work/approvals/not-an-approval/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow_always' })
      });
      check('非法选项被拒绝（400/404）', [400, 404, 409].includes(badDecision.status), String(badDecision.status));
      const sse = await probeSse(port);
      check('SSE v2 仍可连接', sse.status === 200 && sse.type.includes('text/event-stream'), `${sse.status} ${sse.type}`);
    } finally {
      await stopServer(child);
    }
  }

  console.log('\n[3/3] 回滚演练：同一份数据上关闭开关');
  {
    const { child, port } = await startServer({
      LAGENT_RUN_EVENTS: '0',
      LAGENT_SSE_V2: '0',
      LAGENT_APPROVALS: '0',
      LAGENT_THREAD_API: '0'
    }, 4313);
    try {
      const bootstrap = await probe(port, '/api/work/bootstrap');
      check('回滚后 bootstrap 200', bootstrap.status === 200, String(bootstrap.status));
      check('回滚后 bootstrap 不再带 approvals', bootstrap.body && !('approvals' in bootstrap.body));
      const approvals = await probe(port, '/api/work/approvals?status=all');
      check('回滚后审批路由 404', approvals.status === 404, String(approvals.status));
      const threads = await probe(port, '/api/work/threads');
      check('回滚后 thread 路由 404', threads.status === 404, String(threads.status));
      const legacy = await probe(port, '/api/work/usage?days=1');
      check('旧 /usage 接口可用', legacy.status === 200, String(legacy.status));
    } finally {
      await stopServer(child);
    }
  }

  console.log('\n双写观察（真实数据目录上手动执行）：');
  console.log("  node -e \"const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/lagent.sqlite');console.log(db.prepare(\\\"select kind,count(*) n from entities where kind in ('work-event','run-event') group by kind\\\").all())\"");
  console.log('  预期：run-event 行数随使用增长，work-event 不减少；关掉 LAGENT_RUN_EVENTS 后 run-event 停止增长。');
  console.log('\n结果：' + `${passed} passed, ${failed} failed`);
}

try {
  await main();
} catch (error) {
  failed += 1;
  console.error(`\n验收脚本异常：${error?.stack || error}`);
} finally {
  try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows 上偶发占用，忽略。 */ }
  process.exitCode = failed ? 1 : 0;
}
