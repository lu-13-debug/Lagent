import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFingerprint, canReuseArtifact, deriveDataset, restoreReusableArtifacts } from './artifact-lifecycle.js';
import { generateDemo } from './datasets.js';
import { analyzeForTask } from './workflow.js';
import { buildAnalysisContract } from './stage-contracts.js';

const dataset = { id: 'd1', records: { users: [{ name: ' A\r\nB ' }] }, timezone: 'UTC' };
const input = { stageId: 'quality', dataset, contract: { scope: ['activity'] }, stage: { skill: { version: 2, content: 'read' }, model: 'm', maxTokens: 100 }, upstream: {}, toolVersion: '1' };
test('fingerprint tracks every semantic input and ignores identity and timestamps', () => {
  const base = artifactFingerprint(input);
  assert.deepEqual(base, artifactFingerprint({ ...input, dataset: { ...dataset, id: 'new', createdAt: 'later' } }));
  for (const change of [ { dataset: { ...dataset, records: { users: [] } } }, { contract: { scope: [] } }, { stage: { ...input.stage, maxTokens: 200 } }, { stage: { ...input.stage, skill: { version: 3, content: 'read' } } }, { toolVersion: '2' }, { upstream: { plan: { deliverable: { goal: 'new' } } } } ]) assert.notDeepEqual(base, artifactFingerprint({ ...input, ...change }));
});
test('only completed verified artifacts with all hashes can be reused', () => {
  const fingerprint = artifactFingerprint(input);
  const artifact = { status: 'completed', validation: { status: 'verified' }, fingerprint };
  assert.equal(canReuseArtifact(artifact, fingerprint), true);
  for (const patch of [{ status: 'running' }, { validation: { status: 'legacy' } }, { fingerprint: {} }, { scopeInvalidated: true }]) assert.equal(canReuseArtifact({ ...artifact, ...patch }, fingerprint), false);
});
test('normalization is non-destructive, deterministic and rejects unsupported operations', () => {
  const original = structuredClone(dataset);
  const result = deriveDataset(dataset, ['trim_strings', 'normalize_newlines']);
  assert.equal(result.dataset.records.users[0].name, 'A\nB');
  assert.deepEqual(dataset, original);
  assert.deepEqual(result, deriveDataset(dataset, ['trim_strings', 'normalize_newlines']));
  assert.notEqual(result.receipt.inputVersion, result.receipt.outputVersion);
  assert.notEqual(result.dataset.id, dataset.id);
  assert.equal(result.dataset.sourceDatasetId, dataset.id);
  assert.equal(result.receipt.changedCells, 1);
  assert.throws(() => deriveDataset(dataset, ['drop_rows']), /不支持/);
});
test('resume rejects legacy artifacts and leaves candidate reset', () => {
  const candidate = { steps: [{ id: 'quality', status: 'pending' }], artifacts: {}, currentStep: 0, derivedDatasetId: 'stale' };
  assert.equal(restoreReusableArtifacts({ artifacts: { quality: { summary: 'old' } } }, candidate, dataset), candidate);
  assert.deepEqual(candidate.artifacts, {});
  assert.equal(candidate.derivedDatasetId, undefined);
});
test('resume restores a verified prefix, invalidates changed settings and dependent artifacts', () => {
  const data = generateDemo(new Date('2026-10-01T00:00:00Z'));
  const candidate = { id: 'new', steps: ['quality', 'plan'].map(id => ({ id, status: 'pending' })), workflowSnapshot: { stages: { quality: input.stage, plan: input.stage } } };
  const contract = buildAnalysisContract(candidate, data, analyzeForTask(data, candidate));
  const artifacts = {};
  for (const step of candidate.steps) {
    const fingerprint = artifactFingerprint({ stageId: step.id, dataset: data, contract, stage: { ...input.stage, id: step.id }, upstream: artifacts });
    artifacts[step.id] = { status: 'completed', validation: { status: 'verified' }, fingerprint, summary: step.id };
  }
  const source = { id: 'source', artifacts };
  restoreReusableArtifacts(source, candidate, data);
  assert.equal(candidate.artifacts.plan.reusedFrom, 'source');
  assert.deepEqual(candidate.steps.map(s => s.status), ['completed', 'completed']);
  candidate.workflowSnapshot.stages.quality = { ...input.stage, maxTokens: 999 };
  restoreReusableArtifacts(source, candidate, data);
  assert.deepEqual(candidate.artifacts, {});
  assert.deepEqual(candidate.steps.map(s => s.status), ['pending', 'pending']);
});
test('record identifiers and record timestamps are semantic data', () => {
  const base = { ...dataset, records: { users: [{ id: 'a', createdAt: 'today' }] } };
  for (const row of [{ id: 'b', createdAt: 'today' }, { id: 'a', createdAt: 'tomorrow' }]) assert.notEqual(artifactFingerprint({ ...input, dataset: base }).inputVersion, artifactFingerprint({ ...input, dataset: { ...base, records: { users: [row] } } }).inputVersion);
});
test('PDF retries rerun report-producing stages without an exact verified report snapshot', () => {
  const data = generateDemo(new Date('2026-10-01T00:00:00Z'));
  const ids = ['quality', 'charts', 'insights', 'report', 'verify', 'pdf'];
  const candidate = { id: 'retry', report: { verified: true, charts: ['stale'] }, steps: ids.map(id => ({ id, status: 'pending' })), workflowSnapshot: { stages: Object.fromEntries(ids.map(id => [id, input.stage])) } };
  const contract = buildAnalysisContract(candidate, data, analyzeForTask(data, candidate));
  const artifacts = {};
  for (const id of ids) artifacts[id] = { status: 'completed', validation: { status: 'verified' }, summary: id, fingerprint: artifactFingerprint({ stageId: id, dataset: data, contract, stage: { ...input.stage, id }, upstream: artifacts }) };
  restoreReusableArtifacts({ id: 'failed-pdf', artifacts, report: { verified: true, charts: ['source-chart'] } }, candidate, data);
  assert.deepEqual(Object.keys(candidate.artifacts), ['quality']);
  assert.deepEqual(candidate.steps.map(s => s.status), ['completed', 'pending', 'pending', 'pending', 'pending', 'pending']);
  assert.equal(candidate.currentStep, 1);
  assert.equal(candidate.report, undefined);
});
