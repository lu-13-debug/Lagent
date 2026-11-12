#!/usr/bin/env node
// 运行确定性 eval：node scripts/eval.mjs
// 每个任务在临时目录里跑，不污染真实项目；失败返回非零退出码，可用于 CI。
import { runEval } from '../server/eval/runner.js';

const { results, summary } = await runEval();
for (const result of results) {
  const mark = result.passed ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${result.id.padEnd(18)} ${result.name.padEnd(12)} ${String(result.durationMs).padStart(6)}ms${result.error ? `  — ${result.error}` : result.status ? `  (${result.status})` : ''}`);
}
console.log(`\n${summary.passed}/${summary.total} passed · passRate ${summary.passRate}`);
process.exitCode = summary.failed ? 1 : 0;
