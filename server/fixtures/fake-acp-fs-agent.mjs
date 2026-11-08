// 测试用 ACP Agent：验证客户端是否在项目目录内提供 fs/read 与 fs/write。
// 行为：收到 session/prompt 后读取 .agent-input.txt、写入 .agent-output.txt，再回报。
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
      send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'session-fs' } });
    } else if (message.method === 'session/prompt') {
      void (async () => {
        const notes = [];
        try {
          const read = await request('fs/read_text_file', { path: '.agent-input.txt', line: 1, limit: 50 });
          notes.push(`read=${String(read?.content || '').trim()}`);
        } catch (error) { notes.push(`readError=${error.message}`); }
        try {
          await request('fs/write_text_file', { path: 'out/.agent-output.txt', content: 'written by acp' });
          notes.push('write=ok');
        } catch (error) { notes.push(`writeError=${error.message}`); }
        try {
          await request('fs/write_text_file', { path: '../escaped.txt', content: 'should not exist' });
          notes.push('escape=ok');
        } catch { notes.push('escape=blocked'); }
        const text = notes.join(' ');
        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-fs', update: { type: 'agent_message_chunk', content: { type: 'text', text } } } });
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
