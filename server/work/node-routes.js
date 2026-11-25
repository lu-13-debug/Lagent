import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { signNodeToken, verifyNodeToken } from './node-hub.js';

/**
 * 本机执行节点的 HTTP 入口。挂在应用根部（/api/node），
 * 本地模式没有登录概念，云端模式用会话注册、用节点令牌做后续请求。
 */
export function registerNodeRoutes(mount, { resolveHub, authenticate, secret, now = Date.now } = {}) {
  if (typeof resolveHub !== 'function') throw new TypeError('节点路由需要 resolveHub');
  if (typeof authenticate !== 'function') throw new TypeError('节点路由需要 authenticate');
  if (typeof secret !== 'string' || secret.length < 16) throw new TypeError('节点路由需要至少 16 位的密钥');

  const router = express.Router();
  router.use(express.json({ limit: '2mb' }));

  const bearer = req => {
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  };

  // 校验节点令牌，并把请求绑到对应账号的工作区；节点被清理后要求重新注册。
  const nodeContext = (req, res) => {
    const claims = verifyNodeToken(secret, bearer(req), now());
    if (!claims) {
      res.status(401).json({ error: '节点令牌无效或已过期', code: 'NODE_TOKEN_INVALID' });
      return null;
    }
    const hub = resolveHub(claims.userId);
    if (!hub) {
      res.status(401).json({ error: '节点令牌无效或已过期', code: 'NODE_TOKEN_INVALID' });
      return null;
    }
    const known = hub.listNodes().some(node => node.nodeId === claims.nodeId);
    if (!known) {
      res.status(409).json({ error: '节点已下线，请重新注册', code: 'NODE_UNKNOWN' });
      return null;
    }
    return { hub, ...claims };
  };

  router.post('/register', async (req, res, next) => {
    try {
      const userId = await authenticate(req);
      const hub = resolveHub(userId);
      if (!hub) return res.status(503).json({ error: '工作区暂不可用' });
      const nodeId = randomUUID();
      const result = hub.registerNode({ nodeId, userId, agents: req.body?.agents, detected: req.body?.detected, features: req.body?.features });
      const token = signNodeToken(secret, { nodeId, userId, now: now() });
      res.status(201).json({ nodeId, token, agents: result.agents });
    } catch (error) { next(error); }
  });

  router.get('/next', async (req, res, next) => {
    try {
      const context = nodeContext(req, res);
      if (!context) return;
      const wait = Number(req.query.wait);
      const kind = req.query.kind === 'file' || req.query.kind === 'agent' ? req.query.kind : undefined;
      const job = await context.hub.nextJob(context.nodeId, Number.isFinite(wait) ? wait * 1000 : 25_000, kind);
      if (!job) return res.status(204).end();
      res.json(job);
    } catch (error) { next(error); }
  });

  router.post('/jobs/:id', (req, res, next) => {
    try {
      const context = nodeContext(req, res);
      if (!context) return;
      const result = context.hub.updateJob(context.nodeId, req.params.id, req.body || {});
      if (!result) return res.status(404).json({ error: '任务不存在' });
      res.json(result);
    } catch (error) { next(error); }
  });

  // 文件回传：节点把原始字节 POST 上来，落盘成临时文件，再交给等待中的手机预览/下载请求。
  router.post('/files/:id', express.raw({ type: 'application/octet-stream', limit: '80mb' }), async (req, res, next) => {
    let dir = '';
    try {
      const context = nodeContext(req, res);
      if (!context) return;
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!body.length) return res.status(400).json({ error: '文件内容为空' });
      dir = await mkdtemp(path.join(tmpdir(), 'lagent-node-file-'));
      const file = path.join(dir, 'payload');
      await writeFile(file, body, { mode: 0o600 });
      let name = '';
      try { name = decodeURIComponent(String(req.headers['x-lagent-name'] || '')); } catch { name = ''; }
      const mime = String(req.headers['x-lagent-mime'] || 'application/octet-stream');
      const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
      const delivered = context.hub.deliverFile(context.nodeId, req.params.id, {
        path: file,
        name: name.slice(0, 200) || 'file',
        mime: mime.slice(0, 200),
        size: body.length
      }, cleanup);
      if (!delivered) {
        await cleanup();
        return res.status(404).json({ error: '文件请求不存在或已过期' });
      }
      res.json({ ok: true, size: body.length });
    } catch (error) { next(error); }
  });

  router.delete('/register', (req, res) => {
    const context = nodeContext(req, res);
    if (!context) return;
    context.hub.unregisterNode(context.nodeId);
    res.json({ ok: true });
  });

  mount.use(router);
  return router;
}
