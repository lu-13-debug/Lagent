import { createHash } from 'node:crypto';
import { analyzeForTask } from './workflow.js';
import { buildAnalysisContract } from './stage-contracts.js';

// Operational identifiers and timestamps do not describe analysis semantics.
const volatile = new Set(['taskId', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'generatedAt', 'timestamp', 'reused', 'reusedFrom']);
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => !volatile.has(key) && value[key] !== undefined).map(key => [key, semantic(value[key])]));
  return value;
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const semanticHash = value => hash(semantic(value));
function datasetVersion(dataset) {
  return hash({ records: canonical(dataset?.records || {}), domain: dataset?.domain, timezone: canonical(dataset?.timezone), completeness: canonical(dataset?.completeness), fieldPresence: canonical(dataset?.fieldPresence) });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function upstreamSemantics(upstream = {}) {
  return Object.fromEntries(Object.entries(upstream).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, { deliverable: value.deliverable, fingerprint: value.fingerprint, summary: value.summary }]));
}

export function artifactFingerprint({ stageId, dataset, contract, stage, upstream, toolVersion = '1' }) {
  return { stageId, inputVersion: datasetVersion(dataset), contractHash: semanticHash(contract || {}), stageConfigHash: semanticHash(stage || {}), upstreamHash: semanticHash(upstreamSemantics(upstream)), toolVersion: String(toolVersion) };
}

export function canReuseArtifact(artifact, fingerprint) {
  const fields = ['stageId', 'inputVersion', 'contractHash', 'stageConfigHash', 'upstreamHash', 'toolVersion'];
  return Boolean(artifact?.status === 'completed' && artifact.validation?.status === 'verified' && !artifact.scopeInvalidated && fields.every(key => typeof fingerprint?.[key] === 'string' && fingerprint[key].length > 0 && artifact.fingerprint?.[key] === fingerprint[key]));
}

export function deriveDataset(dataset, operations = []) {
  if (!Array.isArray(operations)) throw new Error('标准化操作必须为数组');
  const names = operations.map(op => typeof op === 'string' ? op : op?.type || op?.operation || op?.name);
  for (const name of names) if (!['trim_strings', 'normalize_newlines'].includes(name)) throw new Error(`不支持的数据处理操作：${name}`);
  const derived = structuredClone(dataset);
  let changedCells = 0;
  for (const rows of Object.values(derived.records || {})) for (const row of rows) for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;
    let next = value;
    for (const name of names) next = name === 'trim_strings' ? next.trim() : next.replace(/\r\n?/g, '\n');
    if (next !== value) { row[key] = next; changedCells++; }
  }
  const inputVersion = datasetVersion(dataset), outputVersion = datasetVersion(derived);
  derived.id = `derived-${outputVersion}`;
  derived.sourceDatasetId = dataset.sourceDatasetId || dataset.id;
  derived.version = outputVersion;
  derived.parentVersion = inputVersion;
  const receipt = { operations: names, inputVersion, outputVersion, changedCells };
  return { dataset: derived, receipt };
}

export function restoreReusableArtifacts(source, candidate, dataset) {
  let contract;
  delete candidate.derivedDatasetId;
  // Stage fingerprints do not authenticate the mutable report snapshot. Rebuild
  // every stage that materializes or verifies that snapshot before exporting.
  delete candidate.report;
  candidate.artifacts = {};
  let prefix = true;
  for (const step of candidate.steps || []) {
    const artifact = source.artifacts?.[step.id];
    const stage = candidate.workflowSnapshot?.stages?.[step.id];
    if (!prefix || !stage || ['charts', 'insights', 'report', 'verify', 'pdf'].includes(step.id)) { prefix = false; step.status = 'pending'; continue; }
    contract = buildAnalysisContract(candidate, dataset, analyzeForTask(dataset, candidate));
    const fingerprint = artifactFingerprint({ stageId: step.id, dataset, contract, stage: { ...stage, id: step.id }, upstream: candidate.artifacts });
    if (!canReuseArtifact(artifact, fingerprint)) { prefix = false; step.status = 'pending'; continue; }
    candidate.artifacts[step.id] = { ...structuredClone(artifact), reused: true, reusedFrom: source.id };
    step.status = 'completed'; step.summary = artifact.summary;
    if (step.id === 'preprocess' && artifact.deliverable?.operations) dataset = deriveDataset(dataset, artifact.deliverable.operations).dataset;
  }
  candidate.currentStep = Math.max(0, candidate.steps?.findIndex(step => step.status !== 'completed') ?? 0);
  candidate.progress = candidate.steps?.length ? Math.round(candidate.currentStep * 100 / candidate.steps.length) : 0;
  return candidate;
}
