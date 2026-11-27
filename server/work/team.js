import { workError } from './domain.js';
import { safeTeamEvent, safeTeamProposal } from '../team-runtime.js';

const NODE_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'accepted', 'blocked', 'cancelled']);
const LIMIT_KEYS = ['maxDepth', 'maxNodes', 'maxConcurrent', 'maxCalls', 'maxTokens', 'timeoutMs', 'maxSubtasks'];
const EVENT_LIMIT = 100;

const cleanText = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  : '';
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

function safeLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const limits = {};
  for (const key of LIMIT_KEYS) {
    if (!positiveInteger(value[key])) return null;
    limits[key] = value[key];
  }
  return limits;
}

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = {};
  for (const key of ['calls', 'totalTokens', 'reservedTokens']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return null;
    usage[key] = value[key];
  }
  return usage;
}

function safeProposalList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(safeTeamProposal).filter(proposal => {
    if (!proposal || seen.has(proposal.id)) return false;
    seen.add(proposal.id);
    return true;
  }).slice(-20);
}

function safeNode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = cleanText(value.id, 120);
  const name = cleanText(value.name, 100);
  const status = NODE_STATUSES.has(value.status) ? value.status : '';
  if (!id || !name || !status || !positiveInteger(value.depth)) return null;
  const parentId = value.parentId == null ? null : cleanText(value.parentId, 120);
  if (value.parentId != null && !parentId) return null;
  const dependsOn = Array.isArray(value.dependsOn)
    ? [...new Set(value.dependsOn.map(item => cleanText(item, 120)).filter(Boolean))].slice(0, 3)
    : [];
  return {
    id,
    parentId,
    depth: value.depth,
    name,
    status,
    dependsOn,
    retries: Number.isSafeInteger(value.retries) && value.retries >= 0 ? value.retries : 0,
    proposals: safeProposalList(value.proposals)
  };
}

export function projectTeamTask(task) {
  const artifact = task?.artifacts?.team;
  const snapshot = artifact?.team;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || !Array.isArray(snapshot.nodes)) return null;
  const limits = safeLimits(snapshot.limits);
  const usage = safeUsage(snapshot.usage);
  if (!limits || !usage || typeof snapshot.cancelled !== 'boolean') return null;
  const nodes = snapshot.nodes.map(safeNode).filter(Boolean);
  if (!nodes.length || !nodes.some(node => node.parentId === null)) return null;
  const events = (Array.isArray(artifact.events) ? artifact.events : [])
    .map(safeTeamEvent).filter(Boolean).slice(-EVENT_LIMIT);
  return {
    limits,
    usage,
    cancelled: snapshot.cancelled,
    revision: Number.isSafeInteger(artifact.revision) && artifact.revision > 0 ? artifact.revision : 1,
    updatedAt: cleanText(artifact.updatedAt, 40) || null,
    events,
    nodes
  };
}

export function teamEventKey(task, team) {
  return team ? `${task.id}:${team.revision}:${team.updatedAt || ''}` : null;
}

function editableTeam(task) {
  const artifact = task?.artifacts?.team;
  const snapshot = artifact?.team;
  if (!artifact || !snapshot || !Array.isArray(snapshot.nodes) || typeof snapshot.cancelled !== 'boolean') {
    throw workError('团队尚未开始或快照不可用', 409);
  }
  return structuredClone(artifact);
}

function touch(artifact) {
  artifact.revision = (Number.isSafeInteger(artifact.revision) && artifact.revision > 0 ? artifact.revision : 0) + 1;
  artifact.updatedAt = new Date().toISOString();
}

function appendEvent(artifact, event) {
  const events = Array.isArray(artifact.events) ? artifact.events : [];
  const previousSeq = events.reduce((max, item) => Math.max(max, Number.isSafeInteger(item?.seq) ? item.seq : 0), 0);
  const next = safeTeamEvent({ ...event, seq: previousSeq + 1, createdAt: new Date().toISOString() });
  if (next) artifact.events = [...events, next].slice(-EVENT_LIMIT);
}

export function reviewTeamNode(task, nodeId, decision) {
  if (decision !== 'accept' && decision !== 'reject') throw workError('decision 必须为 accept 或 reject');
  const artifact = editableTeam(task);
  const node = artifact.team.nodes.find(item => item?.id === nodeId);
  if (!node) throw workError('团队节点不存在', 404);
  if (node.parentId == null) throw workError('根节点不能验收', 403);
  if (!['completed', 'failed'].includes(node.status)) throw workError('团队节点尚不可验收', 409);
  if (decision === 'reject') {
    if ((Number.isSafeInteger(node.retries) ? node.retries : 0) >= 1) throw workError('团队节点拒绝重试最多一次', 409);
    node.retries = (Number.isSafeInteger(node.retries) ? node.retries : 0) + 1;
    node.status = 'pending';
  } else node.status = 'accepted';
  touch(artifact);
  appendEvent(artifact, { type: 'node.reviewed', nodeId, status: node.status });
  task.artifacts.team = artifact;
  return projectTeamTask(task);
}

export function decideTeamProposal(task, nodeId, proposalId, decision) {
  if (decision !== 'accept' && decision !== 'reject') throw workError('decision 必须为 accept 或 reject');
  const artifact = editableTeam(task);
  const node = artifact.team.nodes.find(item => item?.id === nodeId);
  if (!node) throw workError('团队节点不存在', 404);
  const proposal = Array.isArray(node.proposals) ? node.proposals.find(item => item?.id === proposalId) : null;
  if (!proposal) throw workError('团队提案不存在', 404);
  if (!['proposed', 'needsApproval'].includes(proposal.status)) throw workError('团队提案已完成决策', 409);
  proposal.status = decision === 'accept' ? 'accepted' : 'rejected';
  touch(artifact);
  appendEvent(artifact, { type: 'proposal.updated', nodeId, status: node.status, proposal: safeTeamProposal(proposal) });
  task.artifacts.team = artifact;
  return projectTeamTask(task);
}
