import { randomUUID } from 'node:crypto';
import { workError } from './domain.js';

const KIND = 'work-team-template';
const MODES = ['auto', 'plan', 'review'];
const PERMISSIONS = ['read', 'workspace', 'full'];
const LIMITS = { name: 80, role: 40, roles: 8, executor: 60 };

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clip = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function normalizeTeamTemplate(input = {}) {
  if (!isObject(input)) throw workError('团队模板必须是对象');
  const allowed = ['id', 'name', 'roles', 'defaultMode', 'projectId'];
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));
  if (unknown.length) throw workError(`团队模板包含未知字段：${unknown.join('、')}`);
  const name = clip(input.name, LIMITS.name);
  if (!name) throw workError('团队模板需要名称');
  if (!Array.isArray(input.roles) || input.roles.length < 1 || input.roles.length > LIMITS.roles) {
    throw workError(`团队模板需要 1–${LIMITS.roles} 个角色`);
  }
  const roles = input.roles.map((role, index) => {
    if (!isObject(role)) throw workError(`第 ${index + 1} 个角色必须是对象`);
    const unknownRole = Object.keys(role).filter(key => !['role', 'executorId', 'permissions'].includes(key));
    if (unknownRole.length) throw workError(`第 ${index + 1} 个角色包含未知字段：${unknownRole.join('、')}`);
    const label = clip(role.role, LIMITS.role);
    const executorId = clip(role.executorId, LIMITS.executor);
    if (!label) throw workError(`第 ${index + 1} 个角色缺少名称`);
    if (!executorId) throw workError(`第 ${index + 1} 个角色缺少执行器`);
    const permissions = role.permissions === undefined ? 'workspace' : role.permissions;
    if (!PERMISSIONS.includes(permissions)) throw workError(`第 ${index + 1} 个角色的权限只能是 read/workspace/full`);
    return { role: label, executorId, permissions };
  });
  const defaultMode = input.defaultMode === undefined ? 'plan' : input.defaultMode;
  if (!MODES.includes(defaultMode)) throw workError('defaultMode 只能是 auto/plan/review');
  const projectId = clip(input.projectId, 100);
  return { name, roles, defaultMode, ...(projectId ? { projectId } : {}) };
}

export function teamTemplateService(db, { now = () => new Date().toISOString(), audit = () => {} } = {}) {
  const list = projectId => db.list(KIND)
    .filter(template => !projectId || template.projectId === projectId)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

  function save(input) {
    const body = normalizeTeamTemplate(input);
    const id = typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID();
    const prior = db.get(KIND, id);
    const stamp = now();
    const record = {
      id,
      ...body,
      createdAt: prior?.createdAt || stamp,
      updatedAt: stamp
    };
    db.put(KIND, record);
    audit(id, 'team-template/save', record.roles.map(role => role.executorId).join(','), 'saved', record.name);
    return record;
  }

  function remove(id) {
    const record = db.get(KIND, id);
    if (!record) throw workError('团队模板不存在', 404);
    db.delete(KIND, id);
    audit(id, 'team-template/delete', '', 'deleted', record.name);
    return { id };
  }

  return { kind: KIND, list, save, remove };
}
