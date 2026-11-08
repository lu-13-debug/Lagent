import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseFiles } from '../server/datasets.js';
import { Store } from '../server/store.js';

const DEFAULT_SIZES = [10000, 50000, 200000, 500000, 1000000];
const sizesFrom = value => String(value).split(',').map(Number).filter(size => Number.isSafeInteger(size) && size > 0);
const args = Object.fromEntries(process.argv.slice(2).map(argument => {
  const [key, value] = argument.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));

function buildFiles(rows) {
  const users = Math.max(1, Math.round(rows * 0.2));
  const payments = users;
  const activity = Math.max(1, rows - users - payments);
  const day = index => `2026-09-${String(25 + (index % 6)).padStart(2, '0')}`;
  const userCsv = 'user_id,registered_at,channel\n' + Array.from({ length: users }, (_, index) => `u${index},${day(index)}T10:00:00+08:00,${index % 2 ? '自然' : '买量'}`).join('\n');
  const activityCsv = 'user_id,event_time\n' + Array.from({ length: activity }, (_, index) => `u${index % users},${day(index)}T${String(9 + index % 12).padStart(2, '0')}:00:00+08:00`).join('\n');
  const paymentCsv = 'order_id,user_id,paid_at,amount,currency,status\n' + Array.from({ length: payments }, (_, index) => `o${index},u${index},${day(index)}T18:30:00+08:00,${6 + index % 5},CNY,paid`).join('\n');
  return [
    { originalname: 'users.csv', buffer: Buffer.from(userCsv) },
    { originalname: 'activity.csv', buffer: Buffer.from(activityCsv) },
    { originalname: 'payments.csv', buffer: Buffer.from(paymentCsv) },
  ];
}

async function measure(rows, onStart = async () => {}, onEnd = () => {}) {
  const generationStarted = performance.now();
  const files = buildFiles(rows);
  const generateMs = performance.now() - generationStarted;
  const bytes = files.reduce((total, file) => total + file.buffer.length, 0);
  await onStart();
  const started = performance.now();
  let dataset;
  try { dataset = await parseFiles(files, { timezone: 'Asia/Shanghai', completeness: { declared: 'full' }, maxRows: rows + 10, maxBytes: Number.MAX_SAFE_INTEGER }); }
  finally { await onEnd(); }
  const parseMs = Math.round(performance.now() - started);
  const directory = mkdtempSync(path.join(tmpdir(), 'dataagent-bench-'));
  let dbBytes = 0;
  let storeMs = 0, checkpointMs = 0, statMs = 0;
  try {
    const store = new Store(directory);
    const writeStarted = performance.now();
    store.put('dataset', dataset);
    storeMs = performance.now() - writeStarted;
    const checkpointStarted = performance.now();
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    checkpointMs = performance.now() - checkpointStarted;
    const statStarted = performance.now();
    dbBytes = statSync(path.join(directory, 'dataagent.sqlite')).size;
    statMs = performance.now() - statStarted;
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
  return { rows, csvMb: Math.round(bytes / 104857.6) / 10, generateMs, parseMs, storeMs, checkpointMs, statMs, maxRssMb: process.resourceUsage().maxRSS / 1024, dbMb: Math.round(dbBytes / 104857.6) / 10 };
}

async function runSize(rows) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { workerSize: rows } });
  const messages = [];
  let deliver;
  const received = new Promise(resolve => { deliver = resolve; });
  worker.on('message', message => {
    if (message?.type === 'ready') messages.push(message);
    else if (message?.type === 'parsed') { messages.push(message); }
    else { messages.push(message); deliver(message); }
  });
  await new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (messages.some(message => message.type === 'ready')) { clearInterval(poll); resolve(); } }, 5);
    worker.once('error', error => { clearInterval(poll); reject(error); });
  });
  const baseline = (await worker.getHeapStatistics()).used_heap_size;
  let heapPeak = baseline;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try { heapPeak = Math.max(heapPeak, (await worker.getHeapStatistics()).used_heap_size); }
      catch { break; }
      await new Promise(resolve => setTimeout(resolve, 5));
      if (messages.some(message => message.type === 'parsed')) { worker.postMessage('store'); break; }
    }
  })();
  worker.postMessage('start');
  const message = await received;
  sampling = false;
  await sampler;
  await worker.terminate();
  if (message.type === 'error') return { rows, error: message.error };
  return {
    ...message.result,
    heapBaselineMb: baseline / 1048576,
    heapPeakMb: Math.round(heapPeak / 1048576),
    heapDeltaMb: Math.round((heapPeak - baseline) / 1048576),
  };
}

if (!isMainThread && workerData?.workerSize) {
  try { parentPort.postMessage({ type: 'result', result: await measure(Number(workerData.workerSize), () => new Promise(resolve => { parentPort.once('message', resolve); parentPort.postMessage({ type: 'ready' }); }), () => new Promise(resolve => { parentPort.once('message', resolve); parentPort.postMessage({ type: 'parsed' }); })) }); }
  catch (error) { parentPort.postMessage({ type: 'error', error: error.message }); }
} else if (args.child) {
  try { process.send(await runSize(Number(args.child))); }
  catch (error) { process.send({ rows: Number(args.child), error: error.message }); }
  process.disconnect();
} else {
  // 5ms asynchronous worker heap snapshots can miss transient peaks. GC varies between runs.
  // Heap excludes other threads/native buffers; maxRSS is the isolated child process high-water mark.
  // Each size/repetition gets a fresh process. Report median and range over three runs.
  const sizes = args.sizes ? sizesFrom(args.sizes) : DEFAULT_SIZES;
  const repeat = Number(args.repeat || 1);
  if (!sizes.length || !Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('无效 sizes / repeat');
  const results = [];
  for (const rows of sizes) for (let run = 1; run <= repeat; run++) {
    const result = await new Promise(resolve => {
      const child = fork(fileURLToPath(import.meta.url), [`--child=${rows}`], { silent: true });
      let message; let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
      child.on('message', value => { message = value; });
      const timer = setTimeout(() => { child.kill(); }, Number(args['timeout-ms'] || 180000));
      child.once('error', error => { clearTimeout(timer); resolve({ rows, error: error.message }); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve(message || { rows, error: `子进程退出 code=${code}, signal=${signal}; OOM/超时详情：${stderr}` }); });
    });
    results.push({ ...result, run });
    console.error(`完成 ${rows} 行，第 ${run}/${repeat} 次：${result.error || result.parseMs + 'ms'}`);
  }
  console.table(results.map(r => ({ 行数:r.rows, 次数:r.run, CSV_MB:r.csvMb, 生成_ms:r.generateMs, 解析_ms:r.parseMs, 入库_ms:r.storeMs, checkpoint_ms:r.checkpointMs, stat_ms:r.statMs, 堆峰值_MB:r.heapPeakMb, 堆增量_MB:r.heapDeltaMb, 库_MB:r.dbMb, maxRSS_MB:r.maxRssMb, 错误:r.error })));
  const summaries = sizes.map(rows => {
    const runs = results.filter(r => r.rows === rows && !r.error);
    const summarize = key => { const values = runs.map(r => r[key]).sort((a,b)=>a-b); return values.length ? { median: values.length % 2 ? values[(values.length-1)/2] : (values[values.length/2-1]+values[values.length/2])/2, min:values[0], max:values.at(-1), range:values.at(-1)-values[0] } : null; };
    return { rows, successful:runs.length, parseMs:summarize('parseMs'), heapDeltaMb:summarize('heapDeltaMb') };
  });
  console.log(JSON.stringify({ method:{sampleMs:5,repeat,productionLimitsUnchanged:true},results,summaries },null,2));
}
