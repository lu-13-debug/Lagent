const newline = String.fromCharCode(10);
let buffer = '';
const send = value => process.stdout.write(JSON.stringify(value) + newline);
process.stdin.on('data', chunk => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf(newline)) >= 0) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
    else if (message.method === 'session/new') send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-large' } });
    else if (message.method === 'session/prompt') {
      // 单条事件 300KiB，旧实现会直接判「ACP 输出超过上限」。
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-large', update: { type: 'agent_message_chunk', content: { type: 'text', text: 'X'.repeat(300 * 1024) } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-large', update: { type: 'agent_message_chunk', content: { type: 'text', text: '大事件之后仍能继续' } } } });
      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    }
  }
});
process.stdin.resume();
