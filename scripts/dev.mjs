import { spawn } from 'node:child_process';
import process from 'node:process';
import { adoptLegacyEnv } from '../server/env.js';

// 旧前缀（DATAAGENT_）的变量先搬过来，再判断默认值。
adoptLegacyEnv();

// 开发时默认打开 Agent 工作台接口；显式传 LAGENT_WORK_ENABLED=0 可关掉。
const env = { ...process.env };
if (env.LAGENT_WORK_ENABLED === undefined || env.LAGENT_WORK_ENABLED === '') env.LAGENT_WORK_ENABLED = '1';
// 本地开发默认允许外部执行器（Claude Code、Codex、opencode…），否则策略里勾选了也会被
// 服务级开关挡回 403。真正能不能用仍由「设置 → 执行器策略」的白名单决定；
// 不需要时显式传 LAGENT_ALLOW_EXTERNAL_EXECUTORS=0 关闭。
if (env.LAGENT_ALLOW_EXTERNAL_EXECUTORS === undefined || env.LAGENT_ALLOW_EXTERNAL_EXECUTORS === '') env.LAGENT_ALLOW_EXTERNAL_EXECUTORS = '1';
// 长时间运行的 Agent 任务放进 outbox：服务重启后会重新排队，而不是直接判失败。
// 「启动 Lagent.cmd」原本就开着，开发模式对齐它，避免改代码触发 --watch 重启时把任务打断。
if (env.LAGENT_WORK_OUTBOX === undefined || env.LAGENT_WORK_OUTBOX === '') env.LAGENT_WORK_OUTBOX = '1';

// 只盯 server/：默认的 --watch 会被数据库写入（data/*.sqlite、data/orchestrator.db）
// 反复触发，后端起来又重启，前端只会看到一堆 ECONNREFUSED。
const watch = process.platform === 'win32' || process.platform === 'darwin'
  ? ['--watch', '--watch-path=server', 'server/index.js']
  : ['--watch', 'server/index.js'];

const children = [
  spawn(process.execPath, watch, { stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit', env }),
];
let closing = false;
function close(code = 0) {
  if (closing) return;
  closing = true;
  children.forEach(child => child.kill());
  process.exitCode = code;
}
for (const child of children) child.on('exit', code => close(code ?? 0));
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
