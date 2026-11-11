import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
for (const [mode,flag,expected] of [['production','1',3],['development','',3],['development','1',20]]) {
 test(`upload limits ${mode} explicit=${flag||'off'}`,()=>{
  const output=execFileSync(process.execPath,['--input-type=module','-e',"import {DATASET_LIMITS} from './server/datasets.js';console.log(JSON.stringify(DATASET_LIMITS))"],{cwd:process.cwd(),env:{...process.env,NODE_ENV:mode,LAGENT_ENABLE_MULTI_SHARD:flag},encoding:'utf8'});
  assert.deepEqual(JSON.parse(output),{maxRows:200000,maxBytes:20971520,maxFiles:expected});
 });
}
