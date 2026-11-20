import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { workError } from '../domain.js';

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function safeSkillName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!SAFE_NAME.test(name)) throw workError('技能名称只能包含字母、数字、点、下划线和短横线，且不能以符号开头', 400);
  return name;
}

export function skillsRootFor({ scope, projectPath, home }) {
  if (scope === 'global') return path.join(home, '.claude', 'skills');
  if (!projectPath) throw workError('安装到项目需要先导入项目', 400);
  return path.join(projectPath, '.claude', 'skills');
}

export function skillTarget({ scope, projectPath, home, name }) {
  const root = skillsRootFor({ scope, projectPath, home });
  const target = path.join(root, safeSkillName(name));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw workError('技能安装路径越界', 400);
  return { root, target };
}

function backupRootFor(target) {
  const skillsRoot = path.dirname(target);
  const scopeRoot = path.dirname(path.dirname(skillsRoot));
  return path.join(scopeRoot, '.lagent', 'skill-backups');
}

export function existsTarget(target) {
  try { return statSync(target).isDirectory(); } catch { return false; }
}

export function backupTarget(target, name) {
  if (!existsTarget(target)) return '';
  const root = backupRootFor(target);
  mkdirSync(root, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = path.join(root, `${name}-${stamp}-${randomUUID().slice(0, 8)}`);
  renameSync(target, destination);
  return destination;
}

function copyFiles(sourceDir, files, staging) {
  for (const file of files) {
    const from = path.join(sourceDir, file.path);
    const to = path.join(staging, file.path);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
    const digest = createHash('sha256').update(readFileSync(to)).digest('hex');
    if (digest !== file.sha256) throw workError(`文件校验失败：${file.path}`, 409);
  }
}

/**
 * 原子安装：先写 staging，再备份旧目录，最后 rename。
 * staging 放在目标同级目录，保证 rename 不跨盘。
 */
export function installSkillFiles({ sourceDir, files, target, name }) {
  const staging = path.join(path.dirname(target), `.${name}.lagent-${randomUUID()}`);
  let backup = '';
  try {
    mkdirSync(staging, { recursive: true });
    copyFiles(sourceDir, files, staging);
    if (existsTarget(target)) backup = backupTarget(target, name);
    else mkdirSync(path.dirname(target), { recursive: true });
    renameSync(staging, target);
    return { target, backup };
  } catch (error) {
    try { rmSync(staging, { recursive: true, force: true }); } catch { /* 清理失败可忽略 */ }
    if (backup && !existsSync(target)) {
      try { renameSync(backup, target); } catch { /* 恢复失败时保留备份路径给用户 */ }
    }
    throw error;
  }
}

export function removeSkillFiles({ target, name }) {
  try {
    if (!existsSync(target)) return { removed: false, backup: '' };
    if (!statSync(target).isDirectory()) throw workError('技能目标不是目录，拒绝删除', 409);
  } catch (error) {
    if (error?.status) throw error;
    return { removed: false, backup: '' };
  }
  const backup = backupTarget(target, name);
  return { removed: true, backup };
}
