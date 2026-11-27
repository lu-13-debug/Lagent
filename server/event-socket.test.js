import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { workEvents } from './work/effects.js';
import { attachWorkEventSocket } from './work/event-socket.js';

// 从连接建立那一刻就开始收消息：补发帧可能在 open 回调之前就到了。
function collector(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', raw => {
    let message = null;
    try { message = JSON.parse(String(raw)); } catch { return; }
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });
  return predicate => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('等待 WebSocket 消息超时'));
      }, 3000) };
      waiters.push(waiter);
    });
  };
}

test('WebSocket 事件流：按 after_seq 补发，再接收实时事件', async t => {
  const events = workEvents({});
  const rows = [
    { seq: 2, type: 'ticket', payload: { id: 't2' } },
    { seq: 3, type: 'ticket', payload: { id: 't3' } }
  ];
  const log = {
    latestSeq: () => 3,
    oldestSeq: () => 1,
    listAfter: (after, limit) => rows.filter(row => row.seq > after).slice(0, limit)
  };
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const detach = attachWorkEventSocket(server, { events, log, heartbeatMs: 1000 });
  t.after(() => { detach(); events.close(); server.close(); });

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/work/events/ws?after_seq=1`);
  const next = collector(ws);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  assert.equal((await next(message => message.seq === 2)).type, 'ticket');
  assert.equal((await next(message => message.seq === 3)).payload.id, 't3');
  const hello = await next(message => message.type === 'hello');
  assert.equal(hello.lastSeq, 3);
  assert.equal(hello.latestSeq, 3);

  events.publish({ seq: 4, type: 'ticket', payload: { id: 't4' } });
  assert.equal((await next(message => message.seq === 4)).payload.id, 't4');
});

test('WebSocket 事件流：游标落在保留窗口之前时下发 reset，并推进到最新', async t => {
  const events = workEvents({});
  const log = { latestSeq: () => 50, oldestSeq: () => 40, listAfter: () => [] };
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const detach = attachWorkEventSocket(server, { events, log });
  t.after(() => { detach(); events.close(); server.close(); });

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/work/events/ws?after_seq=1`);
  const next = collector(ws);
  t.after(() => ws.close());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

  const reset = await next(message => message.type === 'reset');
  assert.equal(reset.reason, 'retention');
  assert.equal(reset.latestSeq, 50);
});

test('WebSocket 事件流：只接管约定路径，其它升级请求不被处理', async t => {
  const events = workEvents({});
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const detach = attachWorkEventSocket(server, { events });
  t.after(() => { detach(); events.close(); server.close(); });

  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/other`);
  const failed = await new Promise(resolve => {
    ws.once('error', () => resolve(true));
    ws.once('open', () => resolve(false));
  });
  assert.equal(failed, true, '未注册的路径不会被 WS 处理器接管');
});
