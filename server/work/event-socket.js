import { WebSocketServer } from 'ws';

// WebSocket 版事件流：和 SSE 共用同一个 publish / run-event 日志。
// 适用场景：桌面壳或本地服务端需要双向心跳、避免 EventSource 的数量上限；
// 浏览器仍可继续用 /api/work/events（SSE），两条通道可以同时存在。
export const WORK_EVENT_SOCKET_PATH = '/api/work/events/ws';

function parseAfter(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const value = Number(url.searchParams.get('after_seq') ?? url.searchParams.get('afterSeq'));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把 WS 端点挂到已有的 http.Server 上。
 * 只接管指定路径，其它 upgrade 请求原样留给别的处理器。
 * 返回 detach：停机时移除监听并断开所有连接。
 */
export function attachWorkEventSocket(server, {
  events,
  log = null,
  isSessionValid = null,
  ownerId = null,
  path = WORK_EVENT_SOCKET_PATH,
  replayLimit = 500,
  heartbeatMs = 15000
} = {}) {
  if (!server || typeof server.on !== 'function' || !events?.subscribe) return () => {};
  const wss = new WebSocketServer({ noServer: true });
  const visible = event => !ownerId || !event?.ownerId || event.ownerId === ownerId;

  const onUpgrade = (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { return; }
    if (pathname !== path) {
      // 只加了一个 upgrade 监听器时，Node 不会自动销毁不认识的升级请求；
      // 没有别的处理器接手就明确断开，避免半开连接把进程挂住。
      const others = server.listeners('upgrade').filter(listener => listener !== onUpgrade);
      if (!others.length) socket.destroy();
      return;
    }
    if (typeof isSessionValid === 'function' && !isSessionValid(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  };
  server.on('upgrade', onUpgrade);

  wss.on('connection', (ws, req) => {
    const after = parseAfter(req);
    let lastSeq = after ?? 0;
    let ready = false;
    const pending = [];
    const timer = setInterval(() => {
      try { ws.ping(); } catch { /* 已断开 */ }
    }, heartbeatMs);
    timer.unref?.();

    const send = event => {
      if (!visible(event)) {
        if (Number.isSafeInteger(event?.seq)) lastSeq = Math.max(lastSeq, event.seq);
        return;
      }
      if (Number.isSafeInteger(event?.seq)) {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
      }
      if (ws.readyState !== ws.OPEN) return;
      try { ws.send(JSON.stringify(event)); } catch { /* 连接已断，close 会清理 */ }
    };

    // 先订阅再补发：补发期间的新事件先入队，避免「补发完 → 订阅生效」之间的空档。
    const unsubscribe = events.subscribe(event => {
      if (ready) send(event);
      else pending.push(event);
    });

    if (log) {
      const latest = log.latestSeq({ ownerId });
      const oldest = log.oldestSeq({ ownerId });
      if (after !== null && latest !== null && (after > latest || (oldest !== null && after < oldest - 1))) {
        const reset = { type: 'reset', reason: after > latest ? 'cursor_ahead' : 'retention', oldestSeq: oldest, latestSeq: latest };
        try { ws.send(JSON.stringify(reset)); } catch { /* 断开 */ }
        lastSeq = latest ?? lastSeq;
      } else if (after !== null) {
        try {
          for (const event of log.listAfter(after, replayLimit, { ownerId })) send(event);
        } catch { /* 日志读取失败时仍继续直播 */ }
      }
    }

    ready = true;
    for (const event of pending.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0))) send(event);
    pending.length = 0;
    try {
      ws.send(JSON.stringify({ type: 'hello', lastSeq, latestSeq: log?.latestSeq({ ownerId }) ?? null }));
    } catch { /* 断开 */ }

    ws.on('message', raw => {
      let message = null;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message?.type === 'ping') {
        try { ws.send(JSON.stringify({ type: 'pong', at: Date.now(), lastSeq })); } catch { /* 断开 */ }
      }
    });

    const cleanup = () => {
      clearInterval(timer);
      unsubscribe();
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return function detach() {
    server.off?.('upgrade', onUpgrade);
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch { /* 忽略 */ }
    }
    wss.close();
  };
}
