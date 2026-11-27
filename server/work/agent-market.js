import { randomUUID } from 'node:crypto';

// Agent 市场：把「执行器 + 权限 + 思考强度 + 指令 + 技能」打包成一套可安装的配置。
// 不下载代码、不装依赖；安装 = 在本地生成一个配置档（work-profile），
// 市场和配置档共用同一套字段，避免出现两份真话。
const MAX_LISTINGS = 50;
const PERMISSIONS = ['read', 'workspace', 'full'];

const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';
const linesOf = value => (Array.isArray(value)
  ? [...new Set(value.map(item => typeof item === 'string' ? item.trim().slice(0, 200) : '').filter(Boolean))].slice(0, 20)
  : []);

function marketError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// 内置清单只是一个起点：全部以配置档形式落地，安装后能改、能删。
export const BUILTIN_BUNDLES = Object.freeze([
  {
    id: 'builtin:code-review',
    name: '代码审查',
    description: '按风险优先级审查改动，指出具体文件与行，不直接改代码。',
    executorId: 'claude-code',
    permission: 'read',
    effort: 'medium',
    instructions: ['先跑 git diff 看范围', '按风险排序输出，指出文件与行', '不要修改工作区'],
    skills: []
  },
  {
    id: 'builtin:release-check',
    name: '发布检查',
    description: '核对版本号、CHANGELOG、构建与关键路径，产出可执行的发布清单。',
    executorId: 'model',
    permission: 'read',
    effort: 'high',
    instructions: ['检查 package.json 与 CHANGELOG 是否一致', '列出阻塞发布的问题', '给出发布前必须执行的命令'],
    skills: []
  },
  {
    id: 'builtin:refactor',
    name: '小步重构',
    description: '在保持行为不变的前提下拆分长函数、收敛重复代码，每步可回滚。',
    executorId: 'claude-code',
    permission: 'workspace',
    effort: 'medium',
    instructions: ['一次只改一个关注点', '每步后跑现有测试', '不顺手改无关文件'],
    skills: []
  },
  {
    id: 'builtin:doc-writer',
    name: '文档整理',
    description: '把散落的实现与决定整理成 README、设计说明或变更记录。',
    executorId: 'model',
    permission: 'workspace',
    effort: 'medium',
    instructions: ['先读现有文档再动笔', '只写能验证的事实', '保留原文风格'],
    skills: []
  },
  {
    id: 'builtin:data-check',
    name: '数据核对',
    description: '对比两份数据或两份报表，指出差异来源与不可解释的部分。',
    executorId: 'model',
    permission: 'read',
    effort: 'low',
    instructions: ['先确认字段与口径', '差异逐项归因', '无法解释的单独列出'],
    skills: []
  }
]);

function normalizeBundle(input, { listExecutors = () => [] } = {}) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const name = text(body.name, 60);
  if (!name) throw marketError('配置名称不能为空');
  const description = text(body.description, 400);
  const executorId = text(body.executorId, 60);
  if (!executorId) throw marketError('请指定执行器');
  const known = listExecutors();
  if (known.length && !known.includes(executorId)) throw marketError(`执行器不可用：${executorId}`);
  const permission = PERMISSIONS.includes(body.permission) ? body.permission : 'workspace';
  const effort = /^[a-z]{2,10}$/.test(String(body.effort || '')) ? String(body.effort) : 'default';
  return {
    name,
    description,
    executorId,
    permission,
    effort,
    instructions: linesOf(body.instructions),
    skills: linesOf(body.skills)
  };
}

export function createAgentMarket({
  store,
  profiles,
  now = () => new Date().toISOString(),
  listExecutors = () => [],
  fetchImpl = globalThis.fetch,
  remoteUrl = (process.env.LAGENT_MARKET_URL || '').trim(),
  remoteToken = (process.env.LAGENT_MARKET_TOKEN || '').trim(),
  timeoutMs = Number(process.env.LAGENT_MARKET_TIMEOUT_MS) > 0 ? Number(process.env.LAGENT_MARKET_TIMEOUT_MS) : 8000,
  allowHttp = (process.env.LAGENT_MARKET_ALLOW_HTTP || '').trim() === '1'
} = {}) {
  if (!store?.put || !profiles?.save || !profiles?.list) throw new TypeError('Agent 市场需要 Store 与配置档服务');

  function customRows() {
    return (store.list('agent-listing') || []).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }

  function listingOf(row) {
    return { ...row, builtin: false, installed: profiles.list().some(profile => profile.name === row.name) };
  }

  function list() {
    const installedNames = new Set(profiles.list().map(profile => profile.name));
    const builtin = BUILTIN_BUNDLES.map(bundle => ({
      ...bundle,
      builtin: true,
      installed: installedNames.has(bundle.name)
    }));
    return [...builtin, ...customRows().map(listingOf)];
  }

  function find(id) {
    const key = text(id, 100);
    const builtin = BUILTIN_BUNDLES.find(bundle => bundle.id === key);
    if (builtin) return { ...builtin, builtin: true };
    const custom = customRows().find(row => row.id === key);
    if (custom) return listingOf(custom);
    throw marketError('配置不存在', 404);
  }

  function publish(input) {
    const bundle = normalizeBundle(input, { listExecutors });
    if (customRows().length >= MAX_LISTINGS) throw marketError(`最多发布 ${MAX_LISTINGS} 套配置`, 429);
    if (BUILTIN_BUNDLES.some(item => item.name === bundle.name)) throw marketError('名称与内置配置重复', 409);
    const stamp = now();
    const row = { id: randomUUID(), ...bundle, createdAt: stamp, updatedAt: stamp };
    store.put('agent-listing', row);
    return listingOf(row);
  }

  function remove(id) {
    const row = customRows().find(item => item.id === id);
    if (!row) throw marketError('只能删除自己发布的配置', 400);
    store.delete('agent-listing', row.id);
    return { id: row.id, removed: true };
  }

  // 安装 = 生成配置档。名称冲突时明确告诉用户改名或删掉已有配置，不静默覆盖。
  function installBundle(bundle) {
    const profile = profiles.save({
      name: bundle.name,
      description: bundle.description,
      settings: { permission: bundle.permission, ...(bundle.effort && bundle.effort !== 'default' ? { effort: bundle.effort } : {}) },
      library: { instructions: bundle.instructions, skills: bundle.skills }
    });
    return { listing: { ...bundle, installed: true }, profile };
  }

  function install(id) {
    return installBundle(find(id));
  }

  // ── 远程市场 ────────────────────────────────────────────────────────────
  // 远程清单是一份 JSON：可以是 `{ listings: [...] }`，也可以是裸数组。
  // 只取配置字段，不下载代码、不执行远程内容；安装前仍走与本地一致的执行器校验。
  function remoteBase() {
    if (!remoteUrl) return '';
    let url = null;
    try { url = new URL(remoteUrl); } catch { return ''; }
    if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return '';
    return url.toString();
  }

  function remoteListing(row) {
    const rawId = text(row?.id, 120);
    if (!rawId) return null;
    const name = text(row?.name, 60);
    const executorId = text(row?.executorId, 60);
    if (!name || !executorId) return null;
    const remoteId = rawId.replace(/^remote:/, '');
    return {
      id: `remote:${remoteId}`,
      remoteId,
      name,
      description: text(row?.description, 400),
      executorId,
      permission: PERMISSIONS.includes(row?.permission) ? row.permission : 'workspace',
      effort: /^[a-z]{2,10}$/.test(String(row?.effort || '')) ? String(row.effort) : 'default',
      instructions: linesOf(row?.instructions),
      skills: linesOf(row?.skills),
      builtin: false,
      remote: true,
      installed: profiles.list().some(profile => profile.name === name)
    };
  }

  async function remoteList() {
    const base = remoteBase();
    if (!base) return { configured: false, url: '', listings: [] };
    if (typeof fetchImpl !== 'function') return { configured: true, url: base, listings: [], error: '当前环境不支持远程市场请求' };
    try {
      const response = await fetchImpl(base, {
        headers: { accept: 'application/json', ...(remoteToken ? { authorization: `Bearer ${remoteToken}` } : {}) },
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
      });
      if (!response.ok) return { configured: true, url: base, listings: [], error: `远程市场返回 ${response.status}` };
      const body = await response.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body?.listings) ? body.listings : [];
      return { configured: true, url: base, listings: rows.slice(0, MAX_LISTINGS).map(remoteListing).filter(Boolean) };
    } catch (error) {
      return { configured: true, url: base, listings: [], error: `远程市场读取失败：${error?.message || error}` };
    }
  }

  async function remoteInstall(id) {
    const key = text(id, 200).replace(/^remote:/, '');
    const { configured, listings, error } = await remoteList();
    if (!configured) throw marketError('未配置远程市场（LAGENT_MARKET_URL）', 409);
    if (error) throw marketError(error, 502);
    const listing = listings.find(item => item.remoteId === key || item.id === id);
    if (!listing) throw marketError('远程配置不存在', 404);
    const known = listExecutors();
    if (known.length && !known.includes(listing.executorId)) throw marketError(`执行器不可用：${listing.executorId}`);
    return installBundle(listing);
  }

  async function installAny(id) {
    return text(id, 200).startsWith('remote:') ? remoteInstall(id) : install(id);
  }

  // 导出成可托管的静态清单：放到任意 HTTPS 静态站点，别人把
  // LAGENT_MARKET_URL 指过来就能看到这些配置。不含任何密钥或本机路径。
  function manifest() {
    return {
      version: 1,
      generatedAt: now(),
      listings: customRows().map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        executorId: row.executorId,
        permission: row.permission,
        effort: row.effort,
        instructions: row.instructions,
        skills: row.skills
      }))
    };
  }

  return { list, find, publish, install, installAny, remove, remoteList, remoteInstall, manifest, remoteConfigured: () => Boolean(remoteBase()) };
}
