import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workError } from '../domain.js';
import { catalogEntry, cleanupSource, fetchSkillSource, parseSkillSource, readCatalog } from './sources.js';
import { existsTarget, installSkillFiles, removeSkillFiles, safeSkillName, skillTarget } from './installer.js';
import { reviewSkill } from './review.js';

const KIND = 'work-skill';
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_SKILL_BODY = 32 * 1024;

const publicSource = info => ({
  type: info.catalogId ? 'catalog' : 'github',
  repo: info.repo,
  ...(info.catalogId ? { catalogId: info.catalogId } : {}),
  ...(info.localPath ? { localPath: info.localPath } : {}),
  path: info.path,
  ref: info.ref || '',
  commit: info.commit,
});

// 推荐清单里的技能有中文说明；SKILL.md 里的 description 是英文，装完就换成中文。
const withChineseDescription = info => {
  if (!info?.catalogId) return info;
  const entry = catalogEntry(info.catalogId);
  return entry ? { ...info, description: entry.description || info.description } : info;
};

const publicSkill = row => ({
  id: row.id,
  name: row.name,
  description: row.description || '',
  scope: row.scope,
  projectId: row.projectId || null,
  source: row.source,
  targetPath: row.targetPath,
  files: row.files || [],
  enabled: row.enabled !== false,
  missing: row.missing === true,
  ...(row.review ? { review: { risk: row.review.risk, summary: row.review.summary } } : {}),
  ...(row.permissions ? { permissions: row.permissions } : {}),
  ...(row.provenance ? { provenance: row.provenance } : {}),
  installedAt: row.installedAt,
  updatedAt: row.updatedAt,
});

const reviewFor = info => reviewSkill({
  root: info.skillDir || info.tempDir,
  files: info.files,
  provenance: { repo: info.repo, ref: info.ref, commit: info.commit, path: info.path, digest: info.digest }
});

const publicPreview = (info, token) => ({
  token,
  name: info.name,
  description: info.description,
  repo: info.repo,
  path: info.path,
  ref: info.ref || '',
  commit: info.commit,
  catalog: Boolean(info.catalogId),
  license: info.license || '',
  files: info.files,
  digest: info.digest,
  bytes: info.bytes,
});

export function createSkillService(db, { projects, home = os.homedir(), now = () => new Date().toISOString(), env = process.env } = {}) {
  if (!db || !projects) throw new TypeError('技能服务需要数据库与项目服务');
  const previews = new Map();

  const projectPath = projectId => {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    if (!id) return '';
    const project = projects.getProject(id);
    return project?.path || '';
  };

  const rows = () => db.list(KIND).map(publicSkill).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const findRow = id => {
    const value = typeof id === 'string' ? id.trim() : '';
    if (!value) throw workError('技能 id 无效', 400);
    const row = db.get(KIND, value);
    if (!row) throw workError('技能不存在', 404);
    return row;
  };

  const reconcile = row => {
    const missing = !existsSync(path.join(row.targetPath, 'SKILL.md'));
    if (missing !== (row.missing === true)) {
      const next = { ...row, ...(missing ? { missing: true } : { missing: undefined }), updatedAt: now() };
      if (!missing) delete next.missing;
      db.put(KIND, next);
      return publicSkill(next);
    }
    return publicSkill(row);
  };

  function list() {
    return rows().map(row => reconcile(row));
  }

  function catalog() {
    const installed = new Map(list().map(skill => [`${skill.scope}:${skill.name}`, skill]));
    return readCatalog().map(entry => ({
      ...entry,
      installedProject: installed.has(`project:${entry.name}`),
      installedGlobal: installed.has(`global:${entry.name}`),
    }));
  }

  // 预览会克隆仓库；过期的临时目录必须回收，否则客户端超时或放弃时会一直占空间。
  function sweepPreviews() {
    for (const [token, value] of previews) {
      if (value.expiresAt < Date.now()) {
        previews.delete(token);
        cleanupSource(value.info);
      }
    }
  }

  function remember(info) {
    sweepPreviews();
    const token = randomUUID();
    previews.set(token, { info, expiresAt: Date.now() + PREVIEW_TTL_MS });
    return token;
  }

  function takePreview(token) {
    const value = typeof token === 'string' ? token.trim() : '';
    const cached = value ? previews.get(value) : null;
    if (!cached) throw workError('安装预览已过期，请重新预览', 409);
    if (cached.expiresAt < Date.now()) {
      previews.delete(value);
      cleanupSource(cached.info);
      throw workError('安装预览已过期，请重新预览', 409);
    }
    return { token: value, ...cached };
  }

  async function preview(input = {}) {
    const source = input?.token ? null : parseSkillSource(input?.source ?? input);
    if (!source) throw workError('请重新填写技能来源', 400);
    const info = withChineseDescription(await fetchSkillSource(source));
    if (!info.ok) {
      cleanupSource(info);
      return { candidates: info.candidates, repo: info.repo, ref: info.ref || '', commit: info.commit };
    }
    const token = remember(info);
    return publicPreview(info, token);
  }

  function nextAvailableName(base, root) {
    for (let index = 2; index <= 20; index += 1) {
      const candidate = `${base}-${index}`;
      if (!existsTarget(path.join(root, candidate))) return candidate;
    }
    throw workError('同名技能过多，请先清理不再使用的版本', 409);
  }

  function install(input = {}) {
    const cached = takePreview(input.token);
    const info = cached.info;
    if (input.commit && String(input.commit).toLowerCase() !== String(info.commit).toLowerCase()) throw workError('安装来源与预览不一致，请重新预览', 409);
    if (input.digest && input.digest !== info.digest) throw workError('技能内容已变化，请重新预览', 409);
    if (!info.catalogId && input.confirmed !== true) throw workError('安装任意 GitHub 技能前需要确认来源可信', 403);

    const scope = input.scope === 'global' ? 'global' : 'project';
    const projectId = scope === 'project' ? String(input.projectId || '').trim() : '';
    const projectDir = scope === 'project' ? projectPath(projectId) : '';
    if (scope === 'project' && !projectDir) throw workError('安装到项目需要先选择项目', 400);
    let name = safeSkillName(input.name || info.name);
    let { root, target } = skillTarget({ scope, projectPath: projectDir, home, name });
    if (existsTarget(target) && input.onConflict !== 'overwrite') {
      if (input.onConflict === 'rename') {
        name = nextAvailableName(name, root);
        ({ root, target } = skillTarget({ scope, projectPath: projectDir, home, name }));
      } else {
        throw Object.assign(workError(`已经存在同名技能「${name}」`, 409), { code: 'skill_exists', conflict: { name, scope, projectId: projectId || null } });
      }
    }

    // 安装前先审一遍权限：高风险技能默认不启用，用户必须显式打开。
    const review = reviewFor(info);
    const result = installSkillFiles({ sourceDir: info.skillDir || info.tempDir, files: info.files, target, name });
    const stamp = now();
    const previous = rows().find(row => path.resolve(row.targetPath) === path.resolve(target));
    const record = {
      ...(previous || {}),
      id: previous?.id || randomUUID(),
      name,
      description: info.description,
      scope,
      ...(projectId ? { projectId } : {}),
      source: publicSource(info),
      targetPath: target,
      files: info.files,
      enabled: previous ? previous.enabled !== false : review.enabledByDefault,
      review: { risk: review.risk, summary: review.summary },
      permissions: review.permissions,
      provenance: review.provenance,
      missing: undefined,
      installedAt: previous?.installedAt || stamp,
      updatedAt: stamp,
    };
    delete record.missing;
    db.put(KIND, record);
    previews.delete(cached.token);
    cleanupSource(info);
    return { skill: publicSkill(record), backup: result.backup || '' };
  }

  async function update(id, input = {}) {
    const row = findRow(id);
    const catalog = row.source.catalogId ? catalogEntry(row.source.catalogId) : null;
    const info = withChineseDescription(await fetchSkillSource(catalog
      ? { catalogId: catalog.id }
      : { repo: row.source.repo, path: row.source.path, ref: row.source.ref, ...(row.source.localPath ? { localPath: row.source.localPath } : {}) }));
    if (!info.ok) {
      cleanupSource(info);
      throw workError('这个来源里已经找不到技能目录，请检查仓库结构', 409);
    }
    const scope = row.scope === 'global' ? 'global' : 'project';
    const projectId = scope === 'project' ? row.projectId : '';
    const projectDir = scope === 'project' ? projectPath(projectId) : '';
    if (scope === 'project' && !projectDir) throw workError('项目已不存在，无法更新技能', 409);
    const { target } = skillTarget({ scope, projectPath: projectDir, home, name: row.name });
    const review = reviewFor(info);
    const result = installSkillFiles({ sourceDir: info.skillDir || info.tempDir, files: info.files, target, name: row.name });
    const next = {
      ...row,
      description: info.description,
      source: { ...publicSource(info), type: row.source?.type || publicSource(info).type },
      targetPath: target,
      files: info.files,
      // 更新可能引入新的联网/执行代码：风险升高时先停用，交回用户确认。
      enabled: review.risk === 'high' ? false : row.enabled !== false,
      review: { risk: review.risk, summary: review.summary },
      permissions: review.permissions,
      provenance: review.provenance,
      missing: undefined,
      updatedAt: now(),
      ...(input?.confirmed === false ? {} : {}),
    };
    delete next.missing;
    db.put(KIND, next);
    cleanupSource(info);
    return { skill: publicSkill(next), backup: result.backup || '' };
  }

  function enable(id) {
    const row = findRow(id);
    const next = { ...row, enabled: true, updatedAt: now() };
    db.put(KIND, next);
    return { skill: publicSkill(next) };
  }

  function disable(id) {
    const row = findRow(id);
    const next = { ...row, enabled: false, updatedAt: now() };
    db.put(KIND, next);
    return { skill: publicSkill(next) };
  }

  function remove(id) {
    const row = findRow(id);
    const result = removeSkillFiles({ target: row.targetPath, name: row.name });
    db.delete(KIND, row.id);
    return { id: row.id, removed: result.removed, backup: result.backup };
  }

  function enabledForProject(projectId) {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    const picked = new Map();
    for (const row of rows()) {
      if (row.enabled === false || row.missing === true) continue;
      if (row.scope === 'project' && row.projectId !== id) continue;
      if (!existsSync(path.join(row.targetPath, 'SKILL.md'))) continue;
      const current = picked.get(row.name);
      if (!current || row.scope === 'project') picked.set(row.name, row);
    }
    return [...picked.values()].map(row => ({
      id: row.id,
      name: row.name,
      description: row.description || '',
      path: path.join(row.targetPath, 'SKILL.md'),
      scope: row.scope,
    }));
  }

  function read(projectId, name) {
    const target = enabledForProject(projectId).find(skill => skill.name === name);
    if (!target) throw workError(`没有找到已启用的技能「${name}」`, 404);
    const skillDir = path.dirname(target.path);
    let file;
    let dir;
    try {
      file = realpathSync(target.path);
      dir = realpathSync(skillDir);
    } catch {
      throw workError('技能文件已经不存在，请重新安装', 409);
    }
    if (!file.startsWith(dir + path.sep)) throw workError('技能路径越界，已拒绝读取', 403);
    const stat = statSync(file);
    if (!stat.isFile()) throw workError('技能正文不是普通文件', 400);
    const content = readFileSync(file, 'utf8');
    const truncated = content.length > MAX_SKILL_BODY;
    return {
      name: target.name,
      path: target.path,
      content: truncated ? content.slice(0, MAX_SKILL_BODY) : content,
      ...(truncated ? { truncated: true, hint: '技能正文过长，已截断到 32KB。' } : {}),
    };
  }

  function pendingPreviewCount() {
    sweepPreviews();
    return previews.size;
  }

  return {
    list,
    catalog,
    preview,
    install,
    update,
    enable,
    disable,
    remove,
    enabledForProject,
    read,
    pendingPreviewCount,
    catalogEntry,
    // 测试与诊断用
    _rows: rows,
  };
}
