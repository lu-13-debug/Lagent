export function workEvents({ store = null, heartbeatMs = 15000 } = {}) {
  const clients = new Set();
  return {
    publish(event) {
      const payload = JSON.stringify(event);
      for (const res of clients) {
        try { res.write(`data: ${payload}\n\n`); }
        catch { /* 客户端已断开 */ }
      }
    },
    connect(req, res, isSessionValid) {
      if (isSessionValid && !isSessionValid(req)) return res.status(401).json({ error: '登录已失效，请重新登录' });
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
      res.flushHeaders(); res.write(': connected\n\n');
      // 断线重连：按 Last-Event-ID 补发该时间之后的事件（最多 200 条）。
      const lastEventId = req.headers?.['last-event-id'];
      if (store && lastEventId) {
        const after = String(lastEventId);
        const missed = store.list('work-event')
          .filter(item => String(item.createdAt || '') > after)
          .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
          .slice(-200);
        for (const item of missed) {
          try { res.write(`data: ${JSON.stringify({ type: item.type, ticketId: item.ticketId, payload: item.payload, createdAt: item.createdAt })}\n\n`); }
          catch { break; }
        }
      }
      clients.add(res);
      const timer=setInterval(()=>{if(isSessionValid&&!isSessionValid(req)){res.end();return;}res.write(': heartbeat\n\n');},heartbeatMs);timer.unref();
      res.on('close',()=>{clearInterval(timer);clients.delete(res);});
    },
    close(){for(const res of clients)res.end();clients.clear();}
  };
}
