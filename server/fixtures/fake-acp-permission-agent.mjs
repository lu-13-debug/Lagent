// 测试用 ACP Agent：主动向客户端请求文件写入权限，等客户端回答后再继续。
// 行为：收到 session/prompt 后发 session/request_permission，并把结果写进最终消息。
const newline = String.fromCharCode(10);
let buffer = '';
let nextId = 1000;
const pending = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + newline);
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ jsonrpc: '2.0', id, method, params });
});
process.stdin.on('data', chunk => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf(newline)) >= 0) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    } else if (message.method === 'session/new') {
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-permission' } });
    } else if (message.method === 'session/prompt') {
      void (async () => {
        let outcome = 'no-request';
        try {
          const result = await request('session/request_permission', {
            sessionId: 'session-permission',
            toolCall: {
              toolCallId: 'call-permission',
              title: '写入 out/permission.txt',
              kind: 'edit',
              status: 'pending',
              locations: [{ path: 'out/permission.txt' }]
            },
            options: [
              { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
              { optionId: 'deny', name: '拒绝', kind: 'reject_once' }
            ]
          });
          outcome = result?.outcome?.outcome === 'selected' ? `permission=${result.outcome.optionId}` : 'permission=cancelled';
        } catch (error) {
          outcome = `permissionError=${error.message}`;
        }
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-permission', update: { type: 'agent_message_chunk', content: { type: 'text', text: outcome } } } });
        send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      })();
    } else if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || 'error'));
      else entry.resolve(message.result);
    }
  }
});
process.stdin.resume();
