import { wireEvent } from './run-events.js';

// 游标优先级：after_seq（手机重连显式带）> Last-Event-ID（浏览器 EventSource 自动带）。
export function parseEventCursor(req) {
  const pick = value => Array.isArray(value) ? value[0] : value;
  const query = pick(req?.query?.after_seq ?? req?.query?.afterSeq);
  if (query !== undefined && query !== null && query !== '') {
    const seq = Number(query);
    if (Number.isSafeInteger(seq) && seq >= 0) return seq;
  }
  const header = pick(req?.headers?.['last-event-id'] ?? req?.headers?.['Last-Event-ID']);
  if (header !== undefined && header !== null && header !== '') {
    const seq = Number(header);
    if (Number.isSafeInteger(seq) && seq >= 0) return seq;
  }
  return null;
}

function frame(event) {
  return `id: ${event.seq}\ndata: ${JSON.stringify(wireEvent(event))}\n\n`;
}

function resetFrame(reset) {
  // 给 reset 也带 id：浏览器 EventSource 下次重连会用它作为 Last-Event-ID，避免再次落到旧游标。
  const id = Number.isSafeInteger(reset.latestSeq) ? `id: ${reset.latestSeq}\n` : '';
  return `event: reset\n${id}data: ${JSON.stringify(reset)}\n\n`;
}

/**
 * SSE v2：带 id 的可重放事件流。
 * - 有游标：按 seq 补发；超出保留窗口或缺口过大时先发 reset，让客户端重拉投影。
 * - 无游标：只收新事件，保持旧客户端行为。
 * - 线上帧不写 event:（旧客户端只监听 onmessage），事件类型放在 data.eventType。
 */
export function createRunEventStream({
  log,
  heartbeatMs = 15000,
  replayLimit = 500,
  retryMs = 3000,
  ownerId = null
} = {}) {
  if (!log) throw new TypeError('SSE v2 需要 run-event 日志');
  const clients = new Set();
  // WebSocket 等其它传输层通过 subscribe 接同一份事件；SSE 仍是默认通道。
  const subscribers = new Set();
  const visible = event => !ownerId || !event?.ownerId || event.ownerId === ownerId;

  function send(client, event) {
    if (!visible(event)) { client.lastSeq = Math.max(client.lastSeq, event.seq || 0); return; }
    if (!Number.isSafeInteger(event?.seq)) {
      // 实时观察帧等没有 seq 的事件：只直播，不参与补发。
      try { client.res.write(`data: ${JSON.stringify(event)}\n\n`); }
      catch { drop(client); }
      return;
    }
    if (event.seq <= client.lastSeq) return;
    if (!client.ready) { client.buffer.push(event); return; }
    try {
      client.res.write(frame(event));
      client.lastSeq = event.seq;
    } catch { drop(client); }
  }

  function drop(client) {
    if (client.timer) clearInterval(client.timer);
    client.timer = null;
    clients.delete(client);
  }

  function writeReset(client, reason, oldestSeq, latestSeq) {
    try { client.res.write(resetFrame({ reason, oldestSeq, latestSeq })); }
    catch { drop(client); return false; }
    // reset 后客户端会重拉整份 thread；游标直接推进到最新，避免补发重复。
    if (Number.isSafeInteger(latestSeq)) client.lastSeq = latestSeq;
    return true;
  }

  return {
    publish(event) {
      for (const client of [...clients]) send(client, event);
      for (const subscriber of [...subscribers]) {
        if (!visible(event)) continue;
        try { subscriber(event); } catch { subscribers.delete(subscriber); }
      }
    },

    // 订阅原始事件（已按 ownerId 过滤），返回取消函数。补发与 reset 由订阅方自己处理。
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    connect(req, res, isSessionValid) {
      if (isSessionValid && !isSessionValid(req)) {
        if (typeof res.status === 'function') return res.status(401).json({ error: '登录已失效，请重新登录' });
        res.statusCode = 401;
        res.setHeader?.('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: '登录已失效，请重新登录' }));
      }
      if (typeof res.set === 'function') {
        res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      } else {
        res.setHeader?.('Content-Type', 'text/event-stream');
        res.setHeader?.('Cache-Control', 'no-cache, no-transform');
        res.setHeader?.('Connection', 'keep-alive');
        res.setHeader?.('X-Accel-Buffering', 'no');
      }
      res.flushHeaders?.();
      res.write(`retry: ${retryMs}\n\n`);
      res.write(': connected\n\n');

      const cursor = parseEventCursor(req);
      const client = { res, lastSeq: cursor ?? 0, ready: false, buffer: [], timer: null };
      clients.add(client);

      if (cursor !== null) {
        const oldest = log.oldestSeq({ ownerId });
        const latest = log.latestSeq({ ownerId });
        if (latest !== null && cursor > latest) {
          if (!writeReset(client, 'cursor_ahead', oldest, latest)) return;
        } else if (oldest !== null && cursor < oldest - 1) {
          if (!writeReset(client, 'retention', oldest, latest)) return;
        } else if (latest !== null && latest - cursor > replayLimit) {
          if (!writeReset(client, 'gap', oldest, latest)) return;
        } else {
          for (const event of log.listAfter(cursor, replayLimit, { ownerId })) {
            if (event.seq <= client.lastSeq) continue;
            if (!visible(event)) { client.lastSeq = event.seq; continue; }
            try {
              res.write(frame(event));
              client.lastSeq = event.seq;
            } catch { drop(client); return; }
          }
        }
      }

      client.ready = true;
      for (const event of client.buffer.sort((left, right) => left.seq - right.seq)) send(client, event);
      client.buffer = [];

      client.timer = setInterval(() => {
        if (isSessionValid && !isSessionValid(req)) { drop(client); res.end(); return; }
        try { res.write(': heartbeat\n\n'); }
        catch { drop(client); res.end(); }
      }, heartbeatMs);
      client.timer.unref?.();
      res.on?.('close', () => drop(client));
    },

    close() {
      subscribers.clear();
      for (const client of [...clients]) {
        drop(client);
        try { client.res.end(); } catch { /* 已断开 */ }
      }
      clients.clear();
    },

    clientCount() { return clients.size; }
  };
}
