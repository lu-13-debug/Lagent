import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const filename = new URL('./upload.ts', import.meta.url);
const code = ts.transpileModule(fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').replace(/import inputContract[^;]+;/, 'const inputContract = ' + fs.readFileSync(new URL('./input-contract.json', import.meta.url), 'utf8') + ';') : '', { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
function transport() {
  return { upload: {}, open(method, path) { this.method = method; this.path = path; }, send(body) { this.body = body; }, abort() { this.onabort?.(); }, status: 201, responseText: '{"dataset":{"id":"test-data"}}' };
}
test('upload exposes real transport progress, uses credentials and parses response', async () => {
  assert.equal(typeof module.uploadFiles, 'function');
  const xhr = transport(), progress = [];
  const promise = module.uploadFiles([new File(['csv'], 'users.csv')], { onProgress: value => progress.push(value) }, () => xhr);
  xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 }); xhr.upload.onload(); xhr.onload();
  assert.deepEqual(progress, [50, 100]); assert.equal(xhr.path, '/api/datasets/upload'); assert.equal(xhr.withCredentials, true);
  assert.equal((await promise).dataset.id, 'test-data');
});
test('abort cancels upload without reporting a network error or success', async () => {
  assert.equal(typeof module.uploadFiles, 'function');
  const xhr = transport(), controller = new AbortController();
  const promise = module.uploadFiles([new File(['csv'], 'users.csv')], { signal: controller.signal }, () => xhr);
  controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
});
test('HTTP failure keeps the server reason and 401 reaches session handler', async () => {
  assert.equal(typeof module.uploadFiles, 'function');
  let expired = 0; const xhr = transport(); xhr.status = 401; xhr.responseText = '{"error":"登录已过期"}';
  const promise = module.uploadFiles([new File(['csv'], 'users.csv')], { onUnauthorized: () => expired++ }, () => xhr);
  xhr.onload(); await assert.rejects(promise, /登录已过期/); assert.equal(expired, 1);
});
test('upload estimates rows and parse time from CSV size before sending', () => {
  assert.equal(typeof module.estimateUpload, 'function');
  const estimate = module.estimateUpload([{ name: 'activity.csv', size: 36 * 200000 }]);
  assert.equal(estimate.rows, 200000);
  assert.equal(estimate.seconds, 7);
  assert.equal(estimate.overRows, false);
  assert.equal(estimate.overBytes, false);
  const large = module.estimateUpload([{ name: 'activity.csv', size: 36 * 260000 }]);
  assert.equal(large.overRows, true);
  const workbook = module.estimateUpload([{ name: 'analytics.xlsx', size: 1024 }]);
  assert.equal(workbook.rows, null);
  assert.equal(workbook.overRows, false);
});
test('oversized upload is rejected before transport with a split hint', async () => {
  let requests = 0;
  await assert.rejects(module.uploadFiles([{ name: 'activity.csv', size: 21 * 1024 * 1024, type: 'text/csv' }], {}, () => { requests++; return transport(); }), /20MB.*拆分/);
  await assert.rejects(module.uploadFiles(Array.from({ length: 21 }, (_, i) => new File(['a'], `${i}.csv`)), {}, () => { requests++; return transport(); }), /最多上传 3 个文件/);
  assert.equal(requests, 0);
});
