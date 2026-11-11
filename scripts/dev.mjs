import { spawn } from 'node:child_process';
import process from 'node:process';
import { adoptLegacyEnv } from '../server/env.js';

// 旧前缀（DATAAGENT_）的变量先搬过来，再判断默认值。
adoptLegacyEnv();

// 开发时默认打开 Agent 工作台接口；显式传 LAGENT_WORK_ENABLED=0 可关掉。
const env = { ...process.env };
if (env.LAGENT_WORK_ENABLED === undefined || env.LAGENT_WORK_ENABLED === '') env.LAGENT_WORK_ENABLED = '1';

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
