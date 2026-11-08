import { spawn } from 'node:child_process';
import process from 'node:process';

// 开发时默认打开 Agent 工作台接口；显式传 DATAAGENT_WORK_ENABLED=0 可关掉。
const env = { ...process.env };
if (env.DATAAGENT_WORK_ENABLED === undefined || env.DATAAGENT_WORK_ENABLED === '') env.DATAAGENT_WORK_ENABLED = '1';

const children = [
  spawn(process.execPath, ['--watch', 'server/index.js'], { stdio: 'inherit', env }),
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
