import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('./model-providers.json', import.meta.url), 'utf8'));
const providers = catalog.providers;
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const hostOf = preset => new URL(preset.baseUrl).hostname.toLowerCase();

test('供应商目录覆盖国内外主流服务，且条目结构完整', () => {
  assert.equal(catalog.version, 1);
  assert.ok(Array.isArray(providers));
  assert.ok(providers.length >= 28, `至少 28 个供应商，当前 ${providers.length}`);
  for (const preset of providers) {
    assert.match(preset.id, /^[a-z0-9-]+$/, `id 不合法：${preset.id}`);
    assert.ok(preset.name && preset.name.length <= 40, `名称缺失或过长：${preset.id}`);
    assert.ok(['cn', 'global', 'local'].includes(preset.region), `region 不合法：${preset.id}`);
    assert.ok(['chat-completions', 'anthropic'].includes(preset.protocol), `protocol 不合法：${preset.id}`);
    assert.ok(Array.isArray(preset.models) && preset.models.length > 0, `缺少示例模型：${preset.id}`);
    for (const model of preset.models) assert.ok(typeof model === 'string' && model.trim(), `模型名为空：${preset.id}`);
  }
});

test('供应商 id 与接口地址互不重复', () => {
  const ids = providers.map(preset => preset.id);
  assert.equal(new Set(ids).size, ids.length, '存在重复 id');
  const endpoints = providers.map(preset => new URL(preset.baseUrl).origin + new URL(preset.baseUrl).pathname.replace(/\/+$/, ''));
  assert.equal(new Set(endpoints).size, endpoints.length, `存在重复接口地址：${endpoints.filter((item, index) => endpoints.indexOf(item) !== index).join('、')}`);
});

test('地址均为 https，只有本机服务允许 http', () => {
  for (const preset of providers) {
    const url = new URL(preset.baseUrl);
    if (url.protocol === 'https:') continue;
    assert.equal(url.protocol, 'http:', `${preset.id} 协议不合法`);
    assert.ok(loopback.has(url.hostname), `${preset.id} 只有本机地址可以用 http`);
    assert.equal(preset.region, 'local', `${preset.id} 非本机服务不能用 http`);
    assert.ok(!url.search && !url.hash && !url.username, `${preset.id} 地址不能带查询串或账号`);
  }
});

test('Messages 协议只用于 Anthropic 官方域名', () => {
  for (const preset of providers) {
    if (preset.protocol !== 'anthropic') continue;
    assert.equal(hostOf(preset), 'api.anthropic.com', `${preset.id} 不能用 anthropic 协议`);
  }
});

test('用户点名的供应商都在目录里', () => {
  const ids = new Set(providers.map(preset => preset.id));
  for (const id of ['deepseek', 'openai', 'anthropic', 'opencode-go', 'zhipu', 'qwen', 'moonshot', 'doubao', 'hunyuan', 'siliconflow', 'gemini', 'xai', 'mistral', 'groq']) {
    assert.ok(ids.has(id), `缺少供应商 ${id}`);
  }
  const regions = new Set(providers.map(preset => preset.region));
  assert.ok(regions.has('cn') && regions.has('global') && regions.has('local'));
});

test('可选字段格式正确', () => {
  for (const preset of providers) {
    if (preset.keyUrl) assert.match(preset.keyUrl, /^https:\/\//, `keyUrl 必须 https：${preset.id}`);
    if (preset.note) assert.ok(preset.note.length <= 120, `备注过长：${preset.id}`);
  }
});
