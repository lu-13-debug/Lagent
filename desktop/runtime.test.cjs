const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { desktopPaths, allowedNavigation, safeExternalUrl } = require('./runtime.cjs');

test('desktop runtime stores database under userData instead of installed program', () => {
  const p = desktopPaths('C:\\Users\\Test\\AppData\\Roaming\\Lagent');
  assert.equal(p.data, path.join('C:\\Users\\Test\\AppData\\Roaming\\Lagent', 'storage'));
  assert.equal(p.logs, path.join('C:\\Users\\Test\\AppData\\Roaming\\Lagent', 'logs'));
});
test('desktop navigation is limited to the exact local service origin', () => {
  const origin = 'http://127.0.0.1:32145';
  assert.equal(allowedNavigation(origin + '/api/health', origin), true);
  assert.equal(allowedNavigation('http://127.0.0.1:32146', origin), false);
  assert.equal(allowedNavigation('https://example.com', origin), false);
  assert.equal(allowedNavigation('javascript:alert(1)', origin), false);
  assert.equal(allowedNavigation('file:///C:/Windows/system.ini', origin), false);
});
test('external links cannot launch system protocols or credential-bearing URLs', () => {
  assert.equal(safeExternalUrl('https://example.com/docs'), 'https://example.com/docs');
  for (const value of ['file:///C:/a.exe', 'ms-settings:privacy', 'javascript:alert(1)', 'https://user:pass@example.com']) assert.equal(safeExternalUrl(value), null);
});

test('反馈诊断仅包含版本、规范服务 origin 与日志目录', () => {
  const { buildSupportDiagnostic } = require('./runtime.cjs');
  const output = buildSupportDiagnostic({ version: '1.1.0', origin: 'https://service.example', logs: 'C:\\Lagent\\logs', apiKey: 'secret', account: 'private', rawRows: 'player', logBody: 'hidden' });
  assert.deepEqual(JSON.parse(output), { version: '1.1.0', serverOrigin: 'https://service.example', logDirectory: 'C:\\Lagent\\logs' });
  assert.doesNotMatch(output, /secret|private|player|hidden/);
  assert.equal(JSON.parse(buildSupportDiagnostic({ version: '1.1.0', origin: 'https://user:password@service.example/path?token=secret', logs: 'logs' })).serverOrigin, '未连接');
  assert.equal(JSON.parse(buildSupportDiagnostic({ version: '1.1.0', origin: null, logs: 'logs' })).serverOrigin, '未连接');
});

test('本机服务连接只接受 localhost，并兼容 local/cloud 两种模式', async () => {
  const { isLocalServerUrl, probeLocalServer } = require('./runtime.cjs');
  assert.equal(isLocalServerUrl('http://127.0.0.1:3001'), true);
  assert.equal(isLocalServerUrl('http://localhost:3001'), true);
  assert.equal(isLocalServerUrl('https://example.com'), false);

  const respond = runtime => async () => ({ ok: true, json: async () => runtime });
  const local = await probeLocalServer('http://127.0.0.1:3001', respond({ mode: 'local', serviceName: 'Lagent' }));
  assert.deepEqual(local, { origin: 'http://127.0.0.1:3001', mode: 'local' });
  const cloud = await probeLocalServer('http://127.0.0.1:3001', respond({ mode: 'cloud', authRequired: true, serviceName: 'Lagent' }));
  assert.equal(cloud.mode, 'cloud');
  await assert.rejects(() => probeLocalServer('http://127.0.0.1:3001', respond({ mode: 'local', serviceName: 'Other' })), /不是 Lagent/);
  await assert.rejects(() => probeLocalServer('https://example.com', respond({ mode: 'local', serviceName: 'Lagent' })), /localhost/);
});

test('保存本机连接写入无注释的 serverUrl 配置', async () => {
  const { saveLocalConnection } = require('./runtime.cjs');
  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lagent-connection-'));
  try {
    const file = path.join(dir, 'connection.json');
    const fakeFetch = async () => ({ ok: true, json: async () => ({ mode: 'local', serviceName: 'Lagent' }) });
    const origin = await saveLocalConnection(file, 'http://127.0.0.1:3001', fakeFetch);
    assert.equal(origin, 'http://127.0.0.1:3001');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { serverUrl: 'http://127.0.0.1:3001' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
