import './env.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3001);
const app = createApp();
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Lagent 已启动：http://127.0.0.1:${port}`);
  console.log(`事件流：SSE /api/work/events，WebSocket ws://127.0.0.1:${port}/api/work/events/ws`);
});
// 独立服务进程同时提供 WS 事件流；桌面壳和云端仍可继续用 SSE。
const detachSocket = app.locals.attachWorkEventSocket?.(server);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  detachSocket?.();
  server.close(() => { app.locals.close(); process.exit(0); });
  setTimeout(() => { app.locals.close(); process.exit(0); }, 5000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
