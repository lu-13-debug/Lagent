import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { catalogEntry, parseSkillSource } from './work/skills/sources.js';

const catalog = JSON.parse(readFileSync(new URL('./work/skills/catalog.json', import.meta.url), 'utf8'));
const CATEGORIES = new Set(['code', 'design', 'backend', 'context', 'docs', 'data', 'ops']);

test('推荐技能目录的必填字段、id 唯一性与仓库格式', () => {
  assert.ok(Array.isArray(catalog) && catalog.length > 0, '目录应为非空数组');
  const ids = new Set();
  const names = new Set();
  for (const entry of catalog) {
    for (const field of ['id', 'name', 'title', 'description', 'category', 'repo', 'path', 'ref', 'license']) {
      assert.equal(typeof entry[field], 'string', `${entry.id || '(缺少 id)'} 缺少字段 ${field}`);
      assert.ok(entry[field].trim(), `${entry.id || '(缺少 id)'} 的 ${field} 不能为空`);
    }
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]*$/, `${entry.id} 的 id 只能是小写字母、数字和连字符`);
    assert.equal(entry.id, entry.name, `${entry.id} 的 id 与 name 应保持一致`);
    assert.equal(entry.ref, 'main', `${entry.id} 固定跟随 main 分支`);
    assert.match(entry.repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, `${entry.id} 的 repo 必须是 owner/repo`);
    assert.ok(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'), `${entry.id} 的 path 不能越界`);
    assert.ok(CATEGORIES.has(entry.category), `${entry.id} 的 category 不合法：${entry.category}`);
    assert.ok(!ids.has(entry.id), `id 重复：${entry.id}`);
    assert.ok(!names.has(entry.name), `name 重复：${entry.name}`);
    ids.add(entry.id);
    names.add(entry.name);
  }
});

test('新增的设计、后端与上下文技能可直接按 id 解析', () => {
  const expected = {
    unslop: { repo: 'heydamir/unslop', path: 'skills/unslop', category: 'design' },
    'backend-patterns': { repo: 'xu-xiang/everything-claude-code-zh', path: 'skills/backend-patterns', category: 'backend' },
    'context-compression': { repo: 'muratcankoylan/Agent-Skills-for-Context-Engineering', path: 'skills/context-compression', category: 'context' },
    handoff: { repo: 'ToolMonsters/handoff-skill', path: '.', category: 'context' },
  };
  for (const [id, source] of Object.entries(expected)) {
    const entry = catalogEntry(id);
    assert.ok(entry, `目录中缺少 ${id}`);
    assert.equal(entry.repo, source.repo);
    assert.equal(entry.path, source.path);
    assert.equal(entry.category, source.category);
    assert.ok(entry.license.includes('MIT') || entry.license.includes('CC BY'), `${id} 必须标注可再分发的许可证`);
  }
  // 仓库根目录按空路径处理，避免 sparse-checkout 把根目录本身排除掉。
  assert.equal(parseSkillSource({ catalogId: 'handoff' }).path, '');
});
