import { randomUUID } from 'node:crypto';
import { defaultPolicy, normalizePolicy, PERMISSIONS, WORK_POLICY_ID } from './policy.js';
import { workError } from './domain.js';

// 工作区配置档：把「模型 / 思考强度 / 权限 / 预算 / 允许的执行器 / Library」存成命名快照。
// 配置档不复制凭据本身，只引用模型配置 id；这样换 Key、换机器都不会把密钥写进配置档。
export const PROFILE_LIMIT = 20;
const NAME_MAX = 60;
const DEFAULT_ID = 'default';

const text = (value, label, max) => {
  if (typeof value !== 'string') throw workError(`${label}必须是字符串`, 400);
  const result = value.replace(/\s+/g, ' ').trim();
  if (!result) throw workError(`${label}不能为空`, 400);
  if (result.length > max) throw workError(`${label}最长 ${max} 个字符`, 400);
  return result;
};

// 对话级设置与 engine 的 normalizeCommandSettings 保持同一套字段和校验，
// 避免配置档能存进去、执行时却被拒绝。
export function normalizeProfileSettings(value) {
  if (value === undefined || value === null || value === '') return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workError('配置档 settings 必须是对象', 400);
  const unknown = Object.keys(value).filter(key => !['profileId', 'model', 'effort', 'permission'].includes(key));
  if (unknown.length) throw workError(`配置档 settings 包含未知字段：${unknown.join('、')}`, 400);
  const profileId = typeof value.profileId === 'string' ? value.profileId.trim() : '';
  if (profileId && !/^[A-Za-z0-9._:-]{1,100}$/.test(profileId)) throw workError('配置档 profileId 无效', 400);
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (model && !/^[A-Za-z0-9._:/-]{1,120}$/.test(model)) throw workError('配置档 model 无效', 400);
  const effort = typeof value.effort === 'string' ? value.effort.trim() : '';
  if (effort && !/^[a-z]{2,10}$/.test(effort)) throw workError('配置档 effort 无效', 400);
  if (value.permission !== undefined && !PERMISSIONS.includes(value.permission)) throw workError('配置档 permission 仅支持 read/workspace/full', 400);
  return {
    ...(profileId ? { profileId } : {}),
    ...(model ? { model } : {}),
    ...(effort && effort !== 'default' ? { effort } : {}),
    ...(value.permission ? { permission: value.permission } : {})
  };
}

// Library 集合先按名称登记；真正写回各 Agent 原生上下文属于后续的 Library 同步能力。
export function normalizeLibrary(value) {
  if (value === undefined || value === null) return { skills: [], mcpServers: [], instructions: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workError('配置档 library 必须是对象', 400);
  const unknown = Object.keys(value).filter(key => !['skills', 'mcpServers', 'instructions'].includes(key));
  if (unknown.length) throw workError(`配置档 library 包含未知字段：${unknown.join('、')}`, 400);
  const list = (items, label) => {
    if (items === undefined) return [];
    if (!Array.isArray(items) || items.length > 100) throw workError(`${label}必须是不超过 100 项的数组`, 400);
    return [...new Set(items.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean).map(item => item.slice(0, 200)))];
  };
  return {
    skills: list(value.skills, 'library.skills'),
    mcpServers: list(value.mcpServers, 'library.mcpServers'),
    instructions: list(value.instructions, 'library.instructions')
  };
}

const publicProfile = row => ({
  id: row.id,
  name: row.name,
  description: row.description || '',
  settings: { ...(row.settings || {}) },
  policy: row.policy ? JSON.parse(JSON.stringify(row.policy)) : null,
  library: row.library ? JSON.parse(JSON.stringify(row.library)) : { skills: [], mcpServers: [], instructions: [] },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export function createWorkProfiles(db, { store, now = () => new Date().toISOString() } = {}) {
  const defaultsKey = 'work-defaults';
  const projectKey = 'work-project-defaults';

  const rows = () => db.list('work-profile').sort((left, right) => String(left.name).localeCompare(String(right.name), 'zh-CN'));
  const find = id => {
    if (typeof id !== 'string' || !id.trim()) throw workError('配置档 id 无效', 400);
    const row = db.get('work-profile', id.trim());
    if (!row) throw workError('配置档不存在', 404);
    return row;
  };
  const nameTaken = (name, exceptId) => rows().some(row => row.id !== exceptId && String(row.name).toLowerCase() === name.toLowerCase());

  function save(input = {}) {
    if (rows().length >= PROFILE_LIMIT) throw workError(`最多保存 ${PROFILE_LIMIT} 个配置档，请先删除不再使用的配置档`, 429);
    const name = text(input.name, '配置档名称', NAME_MAX);
    if (nameTaken(name)) throw workError('配置档名称已存在', 409);
    const timestamp = now();
    const row = {
      id: randomUUID(),
      name,
      description: typeof input.description === 'string' ? input.description.trim().slice(0, 400) : '',
      settings: normalizeProfileSettings(input.settings),
      // 保存时把策略规范化成完整快照，应用时不会被当时的全局策略悄悄带偏。
      policy: normalizePolicy(input.policy || defaultPolicy(), defaultPolicy()),
      library: normalizeLibrary(input.library),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    db.put('work-profile', row);
    return publicProfile(row);
  }

  function update(id, input = {}) {
    const current = find(id);
    const next = { ...current, updatedAt: now() };
    if (input.name !== undefined) {
      const name = text(input.name, '配置档名称', NAME_MAX);
      if (nameTaken(name, current.id)) throw workError('配置档名称已存在', 409);
      next.name = name;
    }
    if (input.description !== undefined) next.description = typeof input.description === 'string' ? input.description.trim().slice(0, 400) : '';
    if (input.settings !== undefined) next.settings = normalizeProfileSettings(input.settings);
    if (input.policy !== undefined) next.policy = normalizePolicy(input.policy, current.policy || defaultPolicy());
    if (input.library !== undefined) next.library = normalizeLibrary(input.library);
    db.put('work-profile', next);
    return publicProfile(next);
  }

  function remove(id) {
    const current = find(id);
    db.delete('work-profile', current.id);
    // 删掉正在生效的配置档时顺手清掉引用，避免界面显示一个已经不存在的配置档。
    const global = store.get('work-defaults', DEFAULT_ID);
    if (global?.profileId === current.id) store.delete('work-defaults', DEFAULT_ID);
    for (const record of store.list('work-project-defaults')) if (record.profileId === current.id) store.delete('work-project-defaults', record.id);
    return { id: current.id };
  }

  function defaultsFor(projectId) {
    if (projectId) return store.get('work-project-defaults', String(projectId)) || null;
    return store.get('work-defaults', DEFAULT_ID) || null;
  }

  function effectiveFor(projectId) {
    const project = projectId ? defaultsFor(projectId) : null;
    return project || defaultsFor() || null;
  }

  function apply(id, { projectId } = {}) {
    const profile = find(id);
    const timestamp = now();
    const scopeId = projectId ? String(projectId) : DEFAULT_ID;
    const record = {
      id: scopeId,
      profileId: profile.id,
      settings: { ...profile.settings },
      library: JSON.parse(JSON.stringify(profile.library)),
      appliedAt: timestamp
    };
    if (projectId) {
      // 项目级只覆盖工作方式，不悄悄改全局策略；权限由 engine 在创建项目工单时读取。
      store.put('work-project-defaults', record);
    } else {
      store.put('work-defaults', record);
    }
    return { profile: publicProfile(profile), scope: projectId ? 'project' : 'global', projectId: projectId || null, appliedAt: timestamp };
  }

  function reset({ projectId } = {}) {
    if (projectId) store.delete('work-project-defaults', String(projectId));
    else store.delete('work-defaults', DEFAULT_ID);
    return { scope: projectId ? 'project' : 'global', projectId: projectId || null };
  }

  function active(projectId) {
    const global = defaultsFor();
    const project = projectId ? defaultsFor(projectId) : null;
    const enrich = record => record ? {
      profileId: record.profileId,
      profile: (() => { try { return publicProfile(find(record.profileId)); } catch { return null; } })(),
      settings: { ...(record.settings || {}) },
      library: record.library ? JSON.parse(JSON.stringify(record.library)) : normalizeLibrary(),
      appliedAt: record.appliedAt || null
    } : null;
    return { global: enrich(global), project: enrich(project), effective: enrich(project || global) };
  }

  // 项目对话创建工单时读取：项目覆盖优先于全局配置档，再回退到全局策略。
  function permissionForProject(projectId) {
    const record = effectiveFor(projectId);
    const permission = record?.settings?.permission;
    return PERMISSIONS.includes(permission) ? permission : '';
  }

  function settingsFor(projectId) {
    return effectiveFor(projectId)?.settings || {};
  }

  return {
    list: () => rows().map(publicProfile),
    get: id => publicProfile(find(id)),
    save,
    update,
    remove,
    apply,
    reset,
    active,
    defaultsFor,
    effectiveFor,
    permissionForProject,
    settingsFor,
    policyId: WORK_POLICY_ID
  };
}
