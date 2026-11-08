export function workEvents({heartbeatMs = 15000} = {}) {
  const clients = new Set();
  return {
    publish({type,ticketId,payload}) { for (const res of clients) res.write(`data: ${JSON.stringify({type,ticketId,payload})}\n\n`); },
    connect(req,res,isSessionValid) {
      if (isSessionValid && !isSessionValid(req)) return res.status(401).json({ error: '登录已失效，请重新登录' });
      res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});
      res.flushHeaders(); res.write(': connected\n\n'); clients.add(res);
      const timer=setInterval(()=>{if(isSessionValid&&!isSessionValid(req)){res.end();return;}res.write(': heartbeat\n\n');},heartbeatMs);timer.unref();
      res.on('close',()=>{clearInterval(timer);clients.delete(res);});
    },
    close(){for(const res of clients)res.end();clients.clear();}
  };
}
